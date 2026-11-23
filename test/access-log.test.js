import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execRaw, execute, query, queryOne } from '../src/db/index.js';
import { DATA_MIGRATIONS } from '../src/db/migrations.js';
import { today } from '../src/domain/dates.js';
import { deviceLabel, purgeOldAccessLogs } from '../src/services/access-log.js';
import { purgeExpiredSessions } from '../src/services/auth.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Histórico de acessos (melhoria pedida pelo usuário em 23/11/2026): login, falha, bloqueio, saída e fim da sessão, com
 * IP e navegador; consulta só do ADMIN; retenção de 1 ano; limpeza periódica das sessões vencidas (antes, nenhuma
 * rotina a chamava).
 */

let server;
const CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function loginAs(email, password = DEMO_PASSWORD) {
  const c = new Client(server.url);
  await c.get('/api/saude');
  const r = await c.request('POST', '/api/auth/login', { email, password }, { headers: { 'User-Agent': CHROME } });
  return { c, r };
}

const eventsOf = (email) => query(
  'SELECT event, detail, occurred_at, ip, user_agent FROM access_logs WHERE email = ? ORDER BY occurred_at, id', email);

async function admin() {
  const { c } = await loginAs('admin@demo.local');
  return c;
}

test('Login, senha incorreta, e-mail inexistente e saída entram no histórico; só o ADMIN consulta', async () => {
  const wrong = await loginAs('comercial@demo.local', 'Senha#Errada1');
  assert.equal(wrong.r.status, 401);
  const unknown = await loginAs('ninguem@demo.local', 'Senha#Errada1');
  assert.equal(unknown.r.status, 401);
  assert.equal(unknown.r.data.detail, wrong.r.data.detail, 'a tela não revela se o e-mail existe');
  const { c, r } = await loginAs('comercial@demo.local');
  assert.equal(r.status, 200);
  assert.equal((await c.post('/api/auth/logout')).status, 204);

  const events = await eventsOf('comercial@demo.local');
  assert.deepEqual(events.slice(-3).map((e) => [e.event, e.detail]),
    [['LOGIN_FAILED', 'Senha incorreta'], ['LOGIN', null], ['LOGOUT', null]]);
  assert.deepEqual((await eventsOf('ninguem@demo.local')).map((e) => [e.event, e.detail]),
    [['LOGIN_FAILED', 'E-mail não cadastrado']]);

  const adm = await admin();
  const list = await adm.get('/api/users/access-logs?event=LOGOUT');
  assert.equal(list.status, 200);
  const logout = list.data.items.find((a) => a.email === 'comercial@demo.local');
  assert.equal(logout.userName.startsWith('Carla'), true);
  assert.equal(logout.device, 'Chrome · Windows');
  assert.ok(logout.ip);
  assert.ok(list.data.items.every((a) => a.event === 'LOGOUT'));
  assert.equal(list.data.retentionDays, 365);

  const users = await adm.get('/api/users');
  assert.ok(users.data.find((u) => u.email === 'comercial@demo.local').lastLoginAt, 'último acesso na lista de usuários');

  const { c: commercial } = await loginAs('comercial@demo.local');
  assert.equal((await commercial.get('/api/users/access-logs')).status, 403);
  assert.equal((await adm.get('/api/users/access-logs?event=QUALQUER')).status, 422);
  assert.equal((await adm.get(`/api/users/access-logs?from=${today()}&to=2000-01-01`)).status, 422);
  const todayOnly = await adm.get(`/api/users/access-logs?from=${today()}&to=${today()}`);
  assert.ok(todayOnly.data.total > 0);
});

test('Bloqueio na 5ª senha incorreta e tentativa durante o bloqueio', async () => {
  for (let i = 0; i < 5; i += 1) await loginAs('rh@demo.local', 'Senha#Errada1');
  const blocked = await loginAs('rh@demo.local');
  assert.equal(blocked.r.status, 401);
  const events = (await eventsOf('rh@demo.local')).map((e) => [e.event, e.detail]);
  assert.deepEqual(events.slice(-2), [
    ['LOCKED', 'Bloqueado por 15 min após 5 senhas incorretas seguidas'],
    ['LOGIN_FAILED', 'Usuário bloqueado temporariamente'],
  ]);
  await execute("UPDATE users SET lockout_end = NULL, failed_attempts = 0 WHERE email = 'rh@demo.local'");
});

test('Sessão vencida: a limpeza periódica registra o vencimento (no instante em que venceu) uma única vez', async () => {
  const { c } = await loginAs('nacc@demo.local');
  const { c: other } = await loginAs('nacc@demo.local');
  const user = await queryOne("SELECT id FROM users WHERE email = 'nacc@demo.local'");
  const lastAccess = new Date(Date.now() - 45 * 60_000).toISOString();
  await execute('UPDATE sessions SET last_access = ? WHERE user_id = ?', lastAccess, user.id);

  // Uma das sessões é usada depois de vencida: a requisição encerra e registra.
  assert.equal((await c.get('/api/positions')).status, 401);
  await purgeExpiredSessions();
  await purgeExpiredSessions();
  assert.equal((await other.get('/api/positions')).status, 401);
  const expired = (await eventsOf('nacc@demo.local')).filter((e) => e.event === 'SESSION_EXPIRED');
  assert.equal(expired.length, 2, 'uma por sessão, sem duplicar');
  const expectedAt = new Date(Date.parse(lastAccess) + 30 * 60_000).toISOString();
  assert.ok(expired.every((e) => e.occurred_at === expectedAt && /inatividade/.test(e.detail)));
  assert.equal((await query('SELECT 1 FROM sessions WHERE user_id = ?', user.id)).length, 0);
});

test('Redefinição de senha pelo ADMIN encerra as sessões com o motivo', async () => {
  const { r } = await loginAs('admissoes@demo.local');
  assert.equal(r.status, 200);
  const adm = await admin();
  const target = (await adm.get('/api/users')).data.find((u) => u.email === 'admissoes@demo.local');
  assert.equal((await adm.post(`/api/users/${target.id}/reset-password`, { passwordMode: 'GENERATE' })).status, 200);
  const last = (await eventsOf('admissoes@demo.local')).at(-1);
  assert.deepEqual([last.event, last.detail], ['SESSION_ENDED', 'Senha redefinida pelo administrador']);
});

test('Retenção de 1 ano e logins recuperados das sessões abertas antes do histórico, sem duplicar', async () => {
  const user = await queryOne("SELECT id FROM users WHERE email = 'gestor.rh@demo.local'");
  const old = new Date(Date.now() - 400 * 86_400_000).toISOString();
  const recent = new Date(Date.now() - 300 * 86_400_000).toISOString();
  for (const [id, at] of [['antigo-1', old], ['recente-1', recent]]) {
    await execute("INSERT INTO access_logs (id, occurred_at, event, user_id) VALUES (?, ?, 'LOGIN', ?)", id, at, user.id);
  }
  await purgeOldAccessLogs();
  const kept = (await query("SELECT id FROM access_logs WHERE id IN ('antigo-1', 'recente-1')")).map((r) => r.id);
  assert.deepEqual(kept, ['recente-1']);

  // Sessão anterior ao histórico (sem o LOGIN): a migração cria o login com o instante da sessão, uma vez só.
  const created = new Date(Date.now() - 5 * 60_000).toISOString();
  await execute(`INSERT INTO sessions (token_hash, user_id, created_at, last_access, ip, user_agent)
    VALUES ('${'a'.repeat(64)}', ?, ?, ?, '198.51.100.9', ?)`, user.id, created, created, CHROME);
  for (let i = 0; i < 2; i += 1) for (const statement of DATA_MIGRATIONS) await execRaw(statement);
  const recovered = await query("SELECT * FROM access_logs WHERE user_id = ? AND occurred_at = ? AND event = 'LOGIN'", user.id, created);
  assert.equal(recovered.length, 1);
  assert.equal(recovered[0].ip, '198.51.100.9');
  assert.match(recovered[0].detail, /antes do histórico/);
  // Logins novos não são recuperados de novo (o evento tem o mesmo instante da sessão).
  await loginAs('gestor.rh@demo.local');
  for (const statement of DATA_MIGRATIONS) await execRaw(statement);
  const logins = await query("SELECT occurred_at FROM access_logs WHERE user_id = ? AND event = 'LOGIN'", user.id);
  assert.equal(new Set(logins.map((l) => l.occurred_at)).size, logins.length);
});

test('Navegador e sistema resumidos a partir do User-Agent', () => {
  assert.equal(deviceLabel(CHROME), 'Chrome · Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (Windows NT 10.0) AppleWebKit/537.36 Chrome/130.0 Safari/537.36 Edg/130.0'), 'Edge · Windows');
  assert.equal(deviceLabel('Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1'), 'Safari · iOS');
  assert.equal(deviceLabel('Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/130.0 Mobile Safari/537.36'), 'Chrome · Android');
  assert.equal(deviceLabel(null), null);
});

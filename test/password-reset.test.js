import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { passwordErrors } from '../src/services/auth.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Redefinição de senha pelo administrador (melhoria de 19/10/2026): senha gerada (padrão) ou definida com
 * confirmação, mostrada uma única vez, sessões do usuário encerradas, troca obrigatória no próximo acesso, histórico
 * de quem redefiniu de quem e quando — sem a senha nem o hash em lugar nenhum além da tabela de usuários.
 */

let server;
const clients = new Map();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function as(user, password = DEMO_PASSWORD) {
  const key = `${user}:${password}`;
  if (clients.has(key)) return clients.get(key);
  const c = new Client(server.url);
  const r = await c.login(`${user}@demo.local`, password);
  assert.equal(r.status, 200, `login de ${user}`);
  clients.set(key, c);
  return c;
}

const idOf = async (email) => (await queryOne('SELECT id FROM users WHERE email = ?', email)).id;

test('senha gerada: 12 caracteres na política, sem cache, sessões encerradas, troca exigida e histórico sem a senha', async () => {
  const admin = await as('admin');
  const victim = await as('dp');
  const dpId = await idOf('dp@demo.local');

  const r = await admin.post(`/api/users/${dpId}/reset-password`, { passwordMode: 'GENERATE' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.headers.get('cache-control'), 'no-store');
  const { temporaryPassword, userName, mustChangePassword } = r.data;
  assert.equal(temporaryPassword.length, 12);
  assert.deepEqual(passwordErrors(temporaryPassword), []);
  assert.equal(userName, 'Davi DP (demo)');
  assert.equal(mustChangePassword, true);

  assert.equal((await victim.get('/api/positions')).status, 401, 'a sessão aberta do usuário foi encerrada');
  const fresh = new Client(server.url);
  const login = await fresh.login('dp@demo.local', temporaryPassword);
  assert.equal(login.status, 200);
  assert.equal(login.data.mustChangePassword, true, 'troca obrigatória no próximo acesso');
  assert.equal((await fresh.get('/api/positions')).status, 403, 'com senha provisória, só a troca de senha');

  const adminId = await idOf('admin@demo.local');
  const log = await queryOne(
    "SELECT user_id, occurred_at, field, new_value FROM audit_logs WHERE entity = 'User' AND entity_id = ? AND action = 'RESET_PASSWORD' AND field = 'Password'",
    dpId);
  assert.equal(log.user_id, adminId, 'quem redefiniu');
  assert.ok(log.occurred_at, 'quando');
  assert.equal(log.new_value, 'Senha provisória gerada automaticamente');
  const hash = (await queryOne('SELECT password_hash FROM users WHERE id = ?', dpId)).password_hash;
  const leaks = await query('SELECT id FROM audit_logs WHERE old_value LIKE ? OR new_value LIKE ? OR new_value LIKE ? OR justification LIKE ?',
    `%${temporaryPassword}%`, `%${temporaryPassword}%`, `%${hash.slice(-20)}%`, `%${temporaryPassword}%`);
  assert.equal(leaks.length, 0, 'nem a senha nem o hash no histórico');
});

test('senha definida: exige confirmação igual e a política; não volta na resposta', async () => {
  const admin = await as('admin');
  const naccId = await idOf('nacc@demo.local');
  const mismatch = await admin.post(`/api/users/${naccId}/reset-password`,
    { passwordMode: 'MANUAL', temporaryPassword: 'Provisoria#1', passwordConfirmation: 'Provisoria#2' });
  assert.equal(mismatch.status, 422);
  assert.ok(mismatch.data.campos.passwordConfirmation);
  const weak = await admin.post(`/api/users/${naccId}/reset-password`,
    { passwordMode: 'MANUAL', temporaryPassword: 'fraca', passwordConfirmation: 'fraca' });
  assert.equal(weak.status, 422);
  assert.ok(weak.data.campos.temporaryPassword);

  const ok = await admin.post(`/api/users/${naccId}/reset-password`,
    { passwordMode: 'MANUAL', temporaryPassword: 'Combinada#2026', passwordConfirmation: 'Combinada#2026' });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.temporaryPassword, null, 'quem definiu já conhece a senha');
  assert.equal((await new Client(server.url).login('nacc@demo.local', 'Combinada#2026')).status, 200);
  const log = await queryOne("SELECT new_value FROM audit_logs WHERE entity_id = ? AND action = 'RESET_PASSWORD' AND field = 'Password'", naccId);
  assert.equal(log.new_value, 'Senha provisória definida pelo administrador');
});

test('só o administrador redefine; o novo usuário também pode ter a senha gerada', async () => {
  const gestor = await as('gestor');
  assert.equal((await gestor.post(`/api/users/${await idOf('dp@demo.local')}/reset-password`, { passwordMode: 'GENERATE' })).status, 403);

  const admin = await as('admin');
  const created = await admin.post('/api/users', { name: 'Pessoa Gerada', email: 'pessoa.gerada@teste.invalid', roles: ['DP'], passwordMode: 'GENERATE' });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.equal(created.headers.get('cache-control'), 'no-store');
  assert.deepEqual(passwordErrors(created.data.temporaryPassword), []);
  assert.equal(created.data.mustChangePassword, true);
  assert.equal((await new Client(server.url).login('pessoa.gerada@teste.invalid', created.data.temporaryPassword)).status, 200);
});

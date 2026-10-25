import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, query, queryOne } from '../src/db/index.js';
import { today as todayDate } from '../src/domain/dates.js';
import { resolveRecipients } from '../src/services/notifications.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Correções da etapa 1 da revisão geral de 25/10/2026:
 *   SEG1  a consulta automática da tela (contador de notificações) não renova a sessão; sessão com 12 h acaba;
 *   C1    usuário desativado não recebe avisos nem e-mails, mesmo sendo analista do pedido ou responsável comercial;
 *   S2    a busca de posições encontra o candidato ativo pelo nome, antes do 1º dia.
 */

let server;
const today = todayDate();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function signIn(email) {
  const c = new Client(server.url);
  assert.equal((await c.login(email, DEMO_PASSWORD)).status, 200, `login de ${email}`);
  return c;
}

const ago = (minutes) => new Date(Date.now() - minutes * 60_000).toISOString();
const background = { headers: { 'X-Background-Request': '1' } };

/** A sessão do cliente (pelo usuário: o teste abre uma sessão por usuário). */
const sessionOf = (email) => queryOne(
  'SELECT s.token_hash, s.last_access FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = ? ORDER BY s.created_at DESC LIMIT 1', email);

test('SEG1: a consulta automática não renova a sessão; parada há mais de 30 min, expira mesmo com a aba aberta', async () => {
  const c = await signIn('comercial@demo.local');
  const { token_hash: hash } = await sessionOf('comercial@demo.local');

  // 20 min parada: o contador automático responde, mas não renova.
  await execute('UPDATE sessions SET last_access = ? WHERE token_hash = ?', ago(20), hash);
  assert.equal((await c.request('GET', '/api/notifications/unread-count', undefined, background)).status, 200);
  const kept = (await sessionOf('comercial@demo.local')).last_access;
  assert.ok(Date.now() - Date.parse(kept) > 19 * 60_000, 'a consulta automática não renovou');

  // Uma ação do usuário renova.
  assert.equal((await c.get('/api/orders')).status, 200);
  assert.ok(Date.now() - Date.parse((await sessionOf('comercial@demo.local')).last_access) < 60_000, 'a ação renovou');

  // Parada há 31 min: o contador automático recebe 401 (a tela volta ao login).
  await execute('UPDATE sessions SET last_access = ? WHERE token_hash = ?', ago(31), hash);
  assert.equal((await c.request('GET', '/api/notifications/unread-count', undefined, background)).status, 401);
});

test('SEG1: a sessão termina 12 h depois do login, mesmo em uso', async () => {
  const c = await signIn('dp@demo.local');
  const { token_hash: hash } = await sessionOf('dp@demo.local');
  await execute('UPDATE sessions SET created_at = ?, last_access = ? WHERE token_hash = ?', ago(12 * 60 + 1), ago(1), hash);
  assert.equal((await c.get('/api/orders')).status, 401);
});

test('C1: usuário desativado não recebe avisos, mesmo indicado como analista ou responsável', async () => {
  const [rh] = await query("SELECT id FROM users WHERE email = 'rh@demo.local'");
  const [nacc] = await query("SELECT id FROM users WHERE email = 'nacc@demo.local'");
  assert.ok((await resolveRecipients({ userIds: [rh.id, nacc.id] })).has(rh.id));
  await execute('UPDATE users SET active = 0 WHERE id = ?', rh.id);
  try {
    const recipients = await resolveRecipients({ userIds: [rh.id, nacc.id] });
    assert.deepEqual([...recipients.keys()], [nacc.id], 'só o ativo');
  } finally {
    await execute('UPDATE users SET active = 1 WHERE id = ?', rh.id);
  }
});

test('S2: a busca de posições acha o candidato pelo nome antes do 1º dia', async () => {
  const grh = await signIn('gestor.rh@demo.local');
  const [p] = await query(
    "SELECT p.id FROM positions p JOIN orders o ON o.id = p.order_id WHERE p.status = 'RECRUITING' AND o.approval_status = 'APPROVED' LIMIT 1");
  const approved = await grh.post(`/api/positions/${p.id}/candidate-approval`, {
    date: today, fullName: 'Zuleica Antunes Busca', phone: '(11) 95555-1212', sex: 'FEMALE',
  });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  const found = (await grh.get('/api/positions?search=zuleica')).data;
  assert.deepEqual((found.items ?? found).map((x) => x.id), [p.id]);

  // Candidato que desistiu sai da busca.
  await grh.post(`/api/positions/${p.id}/candidate-withdrawal`, { justification: null });
  const gone = (await grh.get('/api/positions?search=zuleica')).data;
  assert.equal((gone.items ?? gone).length, 0);
});

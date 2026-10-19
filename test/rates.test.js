import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Valores por cargo entre o Comercial e a Controladoria (seção 4 e 10.1): avisos de pendente, corrigido, rejeitado
 * e validado — este último a pedido do usuário, fora da SPEC — e a segregação de quem cadastra ou corrige.
 * Nos dados de demonstração, comercial@ é Comercial, controladoria@ é Controladoria e todos@ tem todos os perfis.
 */

let server;
const clients = new Map();
let rateId;
let userIds;

before(async () => {
  server = await startServer({ demo: true });
  userIds = Object.fromEntries((await query('SELECT id, email FROM users')).map((u) => [u.email.split('@')[0], u.id]));
});

after(async () => {
  await server?.close();
});

async function as(user) {
  if (clients.has(user)) return clients.get(user);
  const c = new Client(server.url);
  const r = await c.login(`${user}@demo.local`, DEMO_PASSWORD);
  assert.equal(r.status, 200, `login de ${user}`);
  clients.set(user, c);
  return c;
}

/** Notificações do tipo para este valor, por destinatário (apelido do e-mail), na ordem de criação. */
async function notified(type) {
  const rows = await query(
    `SELECT u.email, n.message FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = ? AND n.entity_id = ? ORDER BY n.created_at, u.email`, type, rateId);
  return rows.map((r) => ({ to: r.email.split('@')[0], message: r.message }));
}

const recipients = async (type) => [...new Set((await notified(type)).map((n) => n.to))].sort();

test('cadastro avisa a Controladoria com cargo, contrato, valor e vigência', async () => {
  const comercial = await as('comercial');
  const contract = (await comercial.get('/api/contracts')).data.find((c) => !c.modalities.every((m) => m === 'RS'));
  const jobRole = (await comercial.get('/api/catalogs/job-roles')).data[0];
  const r = await comercial.post('/api/contract-rates', {
    contractId: contract.id, jobRoleId: jobRole.id, monthlyValue: 3000, feeValue: null, validFrom: '2026-11-01',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  rateId = r.data.id;

  assert.deepEqual(await recipients('RATE_PENDING'), ['controladoria', 'todos']);
  const [{ message }] = await notified('RATE_PENDING');
  // O formatador de moeda separa "R$" do número com espaço não separável (U+00A0): não quebra a linha no e-mail.
  // O formatador de moeda separa "R$" do número com espaço não separável (U+00A0): não quebra a linha no e-mail.
  assert.equal(message.replace(/\s/g, ' '), `Novo valor de ${jobRole.name} no contrato ${contract.name} (R$ 3.000,00 mensais, `
    + 'vigência a partir de 01/11/2026) aguarda validação da Controladoria.');
});

test('rejeição avisa quem cadastrou, com o motivo', async () => {
  const r = await (await as('controladoria')).post(`/api/contract-rates/${rateId}/reject`, { reason: 'Valor acima da proposta' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual(await recipients('RATE_REJECTED'), ['comercial']);
  assert.match((await notified('RATE_REJECTED'))[0].message, /foi rejeitado pela Controladoria\. Motivo: Valor acima da proposta$/);
});

test('correção depois da rejeição é avisada como correção, não como valor novo', async () => {
  const todos = await as('todos');
  const current = (await todos.get('/api/contract-rates')).data.find((x) => x.id === rateId);
  const r = await todos.put(`/api/contract-rates/${rateId}`, {
    contractId: current.contractId, jobRoleId: current.jobRoleId, monthlyValue: 2800, feeValue: null, validFrom: '2026-11-01',
  });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const last = (await notified('RATE_PENDING')).at(-1);
  assert.match(last.message, /^O valor de .* \(R\$\s2\.800,00 mensais, vigência a partir de 01\/11\/2026\) foi corrigido depois da rejeição e aguarda nova validação da Controladoria\.$/);
  const email = await queryOne("SELECT subject, html_body FROM email_messages WHERE subject LIKE '%corrigido, aguardando%' LIMIT 1");
  assert.match(email.subject, /^\[Controle de Vagas\] Valor por cargo corrigido, aguardando validação · CT-/);
  // Modelo padrão: título, situação, quadro com os campos do valor, providência e botão para a validação.
  for (const part of ['Pendente de validação', 'Valor mensal', 'R$', 'Início da vigência', '01/11/2026', 'O que fazer:', 'Acessar validação']) {
    assert.ok(email.html_body.includes(part), `e-mail com "${part}"`);
  }
});

test('quem corrigiu não valida nem rejeita, mesmo tendo o perfil Controladoria (segregação)', async () => {
  const todos = await as('todos');
  const validate = await todos.post(`/api/contract-rates/${rateId}/validate`);
  assert.equal(validate.status, 403);
  assert.match(validate.data.detail, /Quem cadastrou ou corrigiu o valor não pode validá-lo nem rejeitá-lo/);
  assert.equal((await todos.post(`/api/contract-rates/${rateId}/reject`, { reason: 'x' })).status, 403);
});

test('rejeição da correção avisa também quem corrigiu por último', async () => {
  await (await as('controladoria')).post(`/api/contract-rates/${rateId}/reject`, { reason: 'Ainda acima' });
  const last = await query(
    "SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.type = 'RATE_REJECTED' AND n.entity_id = ? AND n.message LIKE '%Ainda acima'",
    rateId);
  assert.deepEqual(last.map((x) => x.email.split('@')[0]).sort(), ['comercial', 'todos']);
});

test('correção de valor pendente diz "corrigido", sem "depois da rejeição"', async () => {
  const comercial = await as('comercial');
  const body = (monthlyValue) => ({ contractId: undefined, jobRoleId: undefined, monthlyValue, feeValue: null, validFrom: '2026-11-01' });
  const current = (await comercial.get('/api/contract-rates')).data.find((x) => x.id === rateId);
  for (const value of [2700, 2650]) {
    const r = await comercial.put(`/api/contract-rates/${rateId}`, { ...body(value), contractId: current.contractId, jobRoleId: current.jobRoleId });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  const messages = (await notified('RATE_PENDING')).map((n) => n.message);
  assert.ok(messages.some((m) => /2\.700,00.*foi corrigido depois da rejeição/.test(m)));
  assert.ok(messages.some((m) => /2\.650,00 mensais, vigência a partir de 01\/11\/2026\) foi corrigido e aguarda nova validação/.test(m)));
});

test('validação avisa quem cadastrou (e quem corrigiu por último, se for outra pessoa)', async () => {
  const r = await (await as('controladoria')).post(`/api/contract-rates/${rateId}/validate`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.status, 'VALIDATED');
  // A última correção foi do próprio comercial@, que também cadastrou: um aviso só.
  assert.deepEqual(await recipients('RATE_VALIDATED'), ['comercial']);
  assert.match((await notified('RATE_VALIDATED'))[0].message,
    /^O valor de .* \(R\$\s2\.650,00 mensais, vigência a partir de 01\/11\/2026\) foi validado pela Controladoria e passa a entrar nos totais de faturamento perdido e postergado\.$/);
  const email = await queryOne(
    "SELECT to_address FROM email_messages WHERE subject LIKE '[Controle de Vagas] Valor por cargo validado · %'");
  assert.equal(email.to_address, 'comercial@demo.local');
  assert.ok(userIds.comercial);
});

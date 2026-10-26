import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Cargo e valores comerciais no próprio pedido, com a validação da Controladoria (melhoria de 26/10/2026): valor
 * novo ou alterado leva o pedido a "Aguardando aprovação da Controladoria", que valida ou devolve com motivo; o
 * Comercial ajusta cargo e valores e reenvia a mesma solicitação. Valor igual ao validado segue direto para o cliente.
 */

let server;
const clients = new Map();
const today = todayDate();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function as(user) {
  if (clients.has(user)) return clients.get(user);
  const c = new Client(server.url);
  assert.equal((await c.login(`${user}@demo.local`, DEMO_PASSWORD)).status, 200, `login de ${user}`);
  clients.set(user, c);
  return c;
}

/** Contrato com unidade contratante e um cargo com valor validado vigente nele. */
async function contractWithRate() {
  const row = await queryOne(
    `SELECT c.id AS contract_id, c.contracting_unit_id, c.modalities, r.job_role_id FROM contracts c
       JOIN contract_rates r ON r.contract_id = c.id AND r.status = 'VALIDATED' AND r.valid_from <= ?
      WHERE c.status = 'ACTIVE' AND c.contracting_unit_id IS NOT NULL AND c.modalities NOT IN ('RS') LIMIT 1`, today);
  const rate = (await (await as('comercial')).get(
    `/api/contract-rates/current?contractId=${row.contract_id}&jobRoleId=${row.job_role_id}&date=${today}`)).data;
  return { ...row, rate };
}

/** Cargo ativo sem nenhum valor no contrato. */
const roleWithoutRate = async (contractId) => (await queryOne(
  'SELECT id, name FROM job_roles WHERE active = 1 AND id NOT IN (SELECT job_role_id FROM contract_rates WHERE contract_id = ?) LIMIT 1',
  contractId));

const orderBody = (c, jobRoleId, extra = {}) => ({
  contractId: c.contract_id, modality: c.modalities.split(',')[0], jobRoleId, quantity: 2,
  workLocationId: c.contracting_unit_id, clientRequestDate: addDays(today, -1), desiredStartDate: addDays(today, 10),
  termType: 'INDEFINITE', ...extra,
});

const notices = (type, orderId) => query(
  'SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.type = ? AND n.entity_id = ?', type, orderId);

test('valor igual ao validado: o pedido segue direto para a aprovação do cliente, sem a Controladoria', async () => {
  const c = await contractWithRate();
  assert.ok(c.rate, 'o valor validado vigente vem para preencher o pedido');
  assert.equal((await (await as('rh')).get(
    `/api/contract-rates/current?contractId=${c.contract_id}&jobRoleId=${c.job_role_id}&date=${today}`)).status, 403);

  const created = await (await as('comercial')).post('/api/orders', orderBody(c, c.job_role_id, {
    monthlyValue: c.rate.monthlyValue, feeValue: c.rate.feeValue, rateValidFrom: c.rate.validFrom }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
  assert.equal(created.data.controllership, null);
  assert.equal(created.data.values.rateId, c.rate.id, 'o pedido guarda o valor usado');
  assert.ok((await notices('ORDER_CREATED', created.data.summary.id)).length > 1, 'todos avisados na criação');
  assert.equal((await query('SELECT 1 FROM contract_rates WHERE order_id = ?', created.data.summary.id)).length, 0, 'sem versão nova');
});

test('valor novo: Controladoria devolve com motivo, Comercial ajusta e reenvia, Controladoria valida', async () => {
  const c = await contractWithRate();
  const role = await roleWithoutRate(c.contract_id);
  const comercial = await as('comercial');
  const controladoria = await as('controladoria');

  // Sem valor e sem vigência: recusado, com o motivo.
  const missing = await comercial.post('/api/orders', orderBody(c, role.id));
  assert.equal(missing.status, 422);
  assert.match(missing.data.mensagem ?? missing.data.message ?? JSON.stringify(missing.data), /Informe o valor mensal e o início da vigência/);

  const created = await comercial.post('/api/orders', orderBody(c, role.id, {
    monthlyValue: 3100, feeValue: 450, rateValidFrom: addDays(today, -1) }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.summary.id;
  assert.equal(created.data.summary.approvalStatus, 'AWAITING_CONTROLLERSHIP');
  assert.equal(created.data.controllership.status, 'PENDING');
  assert.deepEqual(created.data.controllership.history.map((h) => h.action), ['SUBMITTED']);
  assert.deepEqual([created.data.values.monthlyValue, created.data.values.feeValue, created.data.values.status], [3100, 450, 'PENDING']);

  // Avisos: só a Controladoria; o pedido novo não chega aos demais antes da validação.
  assert.deepEqual((await notices('ORDER_REVIEW_PENDING', id)).map((n) => n.email).sort(),
    (await query("SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.active = 1 AND r.role = 'CONTROLLERSHIP'"))
      .map((r) => r.email).sort());
  assert.equal((await notices('ORDER_CREATED', id)).length, 0);
  const mail = await queryOne("SELECT html_body FROM email_messages WHERE to_address = 'controladoria@demo.local' AND subject LIKE ?",
    `%Pedido aguardando validação da Controladoria · Pedido ${created.data.summary.number}`);
  for (const text of [role.name, 'Validar pedido']) assert.ok(mail.html_body.includes(text), text);
  assert.match(mail.html_body, /R\$(\s|&nbsp;)3\.100,00/);

  // A versão pendente aparece em Valores por cargo, vinculada ao pedido; validar ou corrigir por lá é recusado.
  const rates = (await controladoria.get(`/api/contract-rates?contractId=${c.contract_id}`)).data;
  const proposed = rates.find((r) => r.order?.id === id);
  assert.deepEqual([proposed.status, proposed.order.inReview, proposed.jobRoleId], ['PENDING', true, role.id]);
  assert.equal((await controladoria.post(`/api/contract-rates/${proposed.id}/validate`)).status, 422);
  assert.equal((await comercial.put(`/api/contract-rates/${proposed.id}`, {
    contractId: c.contract_id, jobRoleId: role.id, monthlyValue: 1, feeValue: null, validFrom: today })).status, 422);

  // Antes da validação: sem aprovação do cliente e sem atendimento do RH.
  assert.equal((await comercial.post(`/api/orders/${id}/approval`, { date: today })).status, 422);
  const gestorRh = await as('gestor.rh');
  assert.equal((await gestorRh.post(`/api/orders/${id}/jobconvo`, { published: false, justification: 'x' })).status, 422);
  const detailRh = (await gestorRh.get(`/api/orders/${id}`)).data;
  assert.equal(detailRh.values, null, 'o RH não vê os valores');
  assert.deepEqual([detailRh.canAssignRh, detailRh.summary.awaitingRhAssignment], [false, false]);

  // Devolução: motivo obrigatório; o valor proposto fica rejeitado; o Comercial é avisado.
  assert.equal((await comercial.post(`/api/orders/${id}/controllership-return`, { reason: 'x' })).status, 403);
  assert.equal((await controladoria.post(`/api/orders/${id}/controllership-return`, { reason: ' ' })).status, 422);
  const returned = await controladoria.post(`/api/orders/${id}/controllership-return`, { reason: 'Fee acima da tabela.' });
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.deepEqual([returned.data.controllership.status, returned.data.controllership.reason, returned.data.values.status],
    ['RETURNED', 'Fee acima da tabela.', 'REJECTED']);
  assert.deepEqual((await notices('ORDER_REVIEW_RETURNED', id)).map((n) => n.email), ['comercial@demo.local']);
  assert.equal((await controladoria.post(`/api/orders/${id}/controllership-validation`)).status, 422, 'aguarda o reenvio');

  // Reenvio: a mesma versão é corrigida (sem cadastro duplicado) e volta para a Controladoria.
  const resent = await comercial.post(`/api/orders/${id}/controllership-resubmission`, {
    jobRoleId: role.id, monthlyValue: 3100, feeValue: 300, rateValidFrom: addDays(today, -1) });
  assert.equal(resent.status, 200, JSON.stringify(resent.data));
  assert.deepEqual([resent.data.controllership.status, resent.data.values.rateId, resent.data.values.feeValue, resent.data.values.status],
    ['PENDING', proposed.id, 300, 'PENDING']);
  assert.equal((await comercial.post(`/api/orders/${id}/controllership-resubmission`, {
    jobRoleId: role.id, monthlyValue: 3100, feeValue: 300, rateValidFrom: addDays(today, -1) })).status, 422, 'já está com a Controladoria');

  // Validação: o valor entra em Valores por cargo e o pedido segue para o cliente; todos são avisados.
  const validated = await controladoria.post(`/api/orders/${id}/controllership-validation`);
  assert.equal(validated.status, 200, JSON.stringify(validated.data));
  assert.deepEqual([validated.data.summary.approvalStatus, validated.data.controllership.status, validated.data.values.status],
    ['AWAITING_CLIENT_APPROVAL', 'VALIDATED', 'VALIDATED']);
  assert.deepEqual(validated.data.controllership.history.map((h) => [h.action, h.userName, h.reason ?? null, h.feeValue]), [
    ['SUBMITTED', 'Carla Comercial (demo)', null, 450],
    ['RETURNED', 'Clara Controladoria (demo)', 'Fee acima da tabela.', 450],
    ['RESUBMITTED', 'Carla Comercial (demo)', null, 300],
    ['VALIDATED', 'Clara Controladoria (demo)', null, 300],
  ]);
  assert.ok((await notices('ORDER_CREATED', id)).some((n) => n.email === 'rh@demo.local'), 'o RH é avisado na validação');
  const rate = (await comercial.get(`/api/contract-rates?contractId=${c.contract_id}`)).data.find((r) => r.id === proposed.id);
  assert.deepEqual([rate.status, rate.order.inReview, rate.monthlyValue, rate.feeValue], ['VALIDATED', false, 3100, 300]);
  const position = (await comercial.get(`/api/positions/${validated.data.positions[0].id}`)).data;
  assert.deepEqual([position.metrics.moneyStatus, position.metrics.dailyValue], ['VALIDATED', 103.33]);

  // Aprovação do cliente separada, com o próprio responsável e data.
  const approved = await comercial.post(`/api/orders/${id}/approval`, { date: today });
  assert.equal(approved.status, 200, JSON.stringify(approved.data));
  assert.equal(approved.data.summary.approvalStatus, 'APPROVED');
  assert.equal(approved.data.approvalRecordedByName, 'Carla Comercial (demo)');
  assert.equal(approved.data.controllership.status, 'VALIDATED');

  // Um novo pedido do mesmo cargo com o valor agora validado segue direto para o cliente.
  const next = await comercial.post('/api/orders', orderBody(c, role.id, { monthlyValue: 3100, feeValue: 300, rateValidFrom: addDays(today, -1) }));
  assert.equal(next.data.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
});

test('valor alterado vira nova versão; mesma vigência de um valor validado diferente é recusada', async () => {
  const c = await contractWithRate();
  const comercial = await as('comercial');
  const clash = await comercial.post('/api/orders', orderBody(c, c.job_role_id, {
    monthlyValue: Number(c.rate.monthlyValue) + 10, feeValue: c.rate.feeValue, rateValidFrom: c.rate.validFrom }));
  assert.equal(clash.status, 422);
  assert.ok(clash.data.campos?.rateValidFrom, JSON.stringify(clash.data));

  const created = await comercial.post('/api/orders', orderBody(c, c.job_role_id, {
    monthlyValue: Number(c.rate.monthlyValue) + 10, feeValue: c.rate.feeValue, rateValidFrom: today }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.summary.approvalStatus, 'AWAITING_CONTROLLERSHIP');
  assert.notEqual(created.data.values.rateId, c.rate.id);
  // A versão anterior continua validada (histórico preservado).
  assert.equal((await queryOne('SELECT status FROM contract_rates WHERE id = ?', c.rate.id)).status, 'VALIDATED');

  // Devolvido, o Comercial pode trocar o cargo: o valor do cargo anterior fica rejeitado, o novo vai para validação.
  await (await as('controladoria')).post(`/api/orders/${created.data.summary.id}/controllership-return`, { reason: 'Cargo errado.' });
  const role = await roleWithoutRate(c.contract_id);
  const resent = await comercial.post(`/api/orders/${created.data.summary.id}/controllership-resubmission`, {
    jobRoleId: role.id, monthlyValue: 2800, feeValue: null, rateValidFrom: today });
  assert.equal(resent.status, 200, JSON.stringify(resent.data));
  assert.deepEqual([resent.data.summary.jobRoleName, resent.data.values.jobRoleName, resent.data.values.status],
    [role.name, role.name, 'PENDING']);
  for (const p of resent.data.positions) {
    assert.equal((await queryOne('SELECT rate_id FROM positions WHERE id = ?', p.id)).rate_id, resent.data.values.rateId);
  }
  assert.equal((await queryOne('SELECT status FROM contract_rates WHERE id = ?', created.data.values.rateId)).status, 'REJECTED');
});

test('segregação: quem criou o pedido não valida nem devolve, mesmo tendo o perfil da Controladoria', async () => {
  const c = await contractWithRate();
  const todos = await as('todos');
  const created = await todos.post('/api/orders', orderBody(c, c.job_role_id, {
    monthlyValue: 2500, feeValue: null, rateValidFrom: addDays(today, -2) }));
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.controllership.canDecide, created.data.controllership.authorBlocked], [false, true]);
  assert.equal((await todos.post(`/api/orders/${created.data.summary.id}/controllership-validation`)).status, 403);
  assert.equal((await todos.post(`/api/orders/${created.data.summary.id}/controllership-return`, { reason: 'x' })).status, 403);
  const other = (await (await as('controladoria')).get(`/api/orders/${created.data.summary.id}`)).data;
  assert.equal(other.controllership.canDecide, true);
});

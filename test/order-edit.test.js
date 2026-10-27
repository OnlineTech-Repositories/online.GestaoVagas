import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Edição administrativa do pedido (ADMIN; melhoria de 26/10/2026): prévia com antes e depois, justificativa
 * obrigatória, posições em aberto atualizadas (preenchidas ficam), histórico permanente e revalidação de cargo e
 * valores pela Controladoria sem parar o pedido.
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

/** Pedido aprovado com posição em aberto e posição preenchida. */
async function approvedOrder() {
  const row = await queryOne(
    `SELECT o.id FROM orders o WHERE o.approval_status = 'APPROVED' AND o.is_legacy = 0
        AND EXISTS (SELECT 1 FROM positions p WHERE p.order_id = o.id AND p.status IN ('OPEN', 'RECRUITING') AND p.demand_type = 'NEW')
        AND EXISTS (SELECT 1 FROM positions p WHERE p.order_id = o.id AND p.status = 'FILLED')
      ORDER BY o.number LIMIT 1`);
  return (await (await as('admin')).get(`/api/orders/${row.id}`)).data;
}

/** Corpo da edição com os dados atuais do pedido (o formulário vem preenchido assim). */
const bodyOf = (o, extra = {}) => ({
  modality: o.summary.modality, jobRoleId: o.jobRoleId, workLocationId: o.workLocationId,
  clientRequestDate: o.summary.clientRequestDate, desiredStartDate: o.summary.desiredStartDate, registeredAt: o.summary.registeredAt,
  clientDecisionDate: o.summary.clientDecisionDate, termType: o.termType, termEndDate: o.termEndDate, termDurationDays: o.termDurationDays,
  notes: o.notes, jobDescription: o.jobDescription, monthlyValue: o.adminEdit.values?.monthlyValue ?? null,
  feeValue: o.adminEdit.values?.feeValue ?? null, rateValidFrom: o.adminEdit.values?.validFrom ?? null, ...extra,
});

test('prévia, justificativa e gravação: posições em aberto atualizadas, preenchidas intactas, histórico permanente', async () => {
  const admin = await as('admin');
  const o = await approvedOrder();
  const id = o.summary.id;
  assert.ok(o.adminEdit, 'o ADMIN tem a edição');
  assert.equal((await (await as('comercial')).get(`/api/orders/${id}`)).data.adminEdit, null);
  assert.equal((await (await as('comercial')).post(`/api/orders/${id}/admin-edit/preview`, bodyOf(o))).status, 403);

  const same = await admin.post(`/api/orders/${id}/admin-edit/preview`, bodyOf(o));
  assert.deepEqual([same.status, same.data.detail], [422, 'Nenhuma alteração em relação aos dados atuais do pedido.']);

  const newStart = addDays(o.summary.desiredStartDate, 3);
  const change = bodyOf(o, { desiredStartDate: newStart, notes: 'Cliente pediu início três dias depois.' });
  const preview = await admin.post(`/api/orders/${id}/admin-edit/preview`, change);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.changes.map((c) => c.label).sort(), ['Início desejado', 'Observações']);
  const start = preview.data.changes.find((c) => c.label === 'Início desejado');
  assert.equal(start.after, newStart.split('-').reverse().join('/'));
  assert.ok(preview.data.impacts.some((t) => /posição\(ões\) em aberto atualizada/.test(t)));
  assert.equal((await queryOne('SELECT desired_start_date FROM orders WHERE id = ?', id)).desired_start_date, o.summary.desiredStartDate,
    'a prévia não grava');

  assert.ok((await admin.post(`/api/orders/${id}/admin-edit`, change)).data.campos?.justification, 'justificativa obrigatória');
  const saved = await admin.post(`/api/orders/${id}/admin-edit`, { ...change, justification: 'Correção pedida pelo cliente por e-mail.' });
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.summary.desiredStartDate, newStart);
  assert.equal(saved.data.summary.approvalStatus, 'APPROVED', 'o pedido não volta às etapas iniciais');

  const positions = await query('SELECT status, desired_start_date FROM positions WHERE order_id = ? AND demand_type = ?', id, 'NEW');
  for (const p of positions.filter((x) => ['OPEN', 'RECRUITING'].includes(x.status))) assert.equal(p.desired_start_date, newStart);
  assert.ok(positions.filter((x) => x.status === 'FILLED').every((x) => x.desired_start_date !== newStart), 'preenchidas ficam');

  const [edit] = saved.data.adminEdits;
  assert.deepEqual([edit.userName, edit.justification, edit.revalidation], ['Alice Administradora (demo)', 'Correção pedida pelo cliente por e-mail.', false]);
  assert.ok(edit.occurredAt);
  assert.deepEqual(edit.changes.find((c) => c.label === 'Observações').after, 'Cliente pediu início três dias depois.');
  const log = await queryOne("SELECT justification FROM audit_logs WHERE entity_id = ? AND action = 'ADMIN_EDIT_ORDER' LIMIT 1", id);
  assert.equal(log.justification, 'Correção pedida pelo cliente por e-mail.');
  // Todos os perfis do pedido consultam o histórico.
  assert.equal((await (await as('rh')).get(`/api/orders/${id}`)).data.adminEdits.length, 1);
});

test('valores alterados num pedido validado: revalidação pela Controladoria sem parar o pedido', async () => {
  const admin = await as('admin');
  const controladoria = await as('controladoria');
  const o = await approvedOrder();
  const id = o.summary.id;
  const oldValue = Number(o.adminEdit.values.monthlyValue);
  const positionsBefore = await query('SELECT id, status, rate_id FROM positions WHERE order_id = ?', id);

  const change = bodyOf(o, { monthlyValue: oldValue + 250, rateValidFrom: today, justification: 'Reajuste acordado com o cliente.' });
  const preview = await admin.post(`/api/orders/${id}/admin-edit/preview`, change);
  assert.equal(preview.data.revalidation, true);
  assert.ok(preview.data.changes.some((c) => c.label === 'Valor mensal' && c.money));
  const saved = await admin.post(`/api/orders/${id}/admin-edit`, change);
  assert.equal(saved.status, 200, JSON.stringify(saved.data));
  assert.equal(saved.data.summary.approvalStatus, 'APPROVED');
  assert.equal(saved.data.controllership.status, 'PENDING');
  assert.equal(saved.data.controllership.revalidation.monthlyValue, oldValue + 250);
  assert.equal(Number(saved.data.values?.monthlyValue ?? oldValue), oldValue, 'o pedido segue com o valor atual');
  assert.deepEqual((await query('SELECT id, status, rate_id FROM positions WHERE order_id = ?', id)), positionsBefore, 'posições intactas');
  assert.ok((await query("SELECT 1 FROM notifications WHERE type = 'ORDER_REVIEW_PENDING' AND entity_id = ?", id)).length);
  // Nova alteração de valores enquanto a anterior aguarda: recusada.
  assert.equal((await admin.post(`/api/orders/${id}/admin-edit/preview`, bodyOf(saved.data, { monthlyValue: oldValue + 1, rateValidFrom: addDays(today, 1) }))).status, 422);
  // A RH vê o histórico sem os valores em R$.
  const asRh = (await (await as('rh')).get(`/api/orders/${id}`)).data;
  assert.equal(asRh.adminEdits[0].changes.find((c) => c.label === 'Valor mensal').after, '(restrito)');

  const validated = await controladoria.post(`/api/orders/${id}/controllership-validation`);
  assert.equal(validated.status, 200, JSON.stringify(validated.data));
  assert.deepEqual([validated.data.summary.approvalStatus, validated.data.controllership.status, validated.data.controllership.revalidation],
    ['APPROVED', 'VALIDATED', null]);
  assert.equal(validated.data.values.monthlyValue, oldValue + 250);
  assert.deepEqual(validated.data.controllership.history.map((h) => h.action).slice(-2), ['REVALIDATION_REQUESTED', 'VALIDATED']);
  const rateId = validated.data.values.rateId;
  for (const p of await query('SELECT status, rate_id FROM positions WHERE order_id = ?', id)) {
    if (['OPEN', 'RECRUITING', 'CANDIDATE_APPROVED', 'IN_ADMISSION', 'AWAITING_FIRST_DAY', 'PAUSED'].includes(p.status)) assert.equal(p.rate_id, rateId);
    if (p.status === 'FILLED') assert.notEqual(p.rate_id, rateId, 'preenchida fica com o valor que tinha');
  }
  assert.ok((await query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.type = 'ORDER_REVIEW_VALIDATED' AND n.entity_id = ? AND u.email = 'admin@demo.local'", id)).length);

  // Nova alteração devolvida: o pedido segue com o cargo e o valor validados.
  const again = (await admin.get(`/api/orders/${id}`)).data;
  await admin.post(`/api/orders/${id}/admin-edit`, bodyOf(again, { monthlyValue: oldValue + 900, rateValidFrom: addDays(today, 1), justification: 'Teste.' }));
  const returned = await controladoria.post(`/api/orders/${id}/controllership-return`, { reason: 'Sem respaldo contratual.' });
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.deepEqual([returned.data.values.monthlyValue, returned.data.controllership.status, returned.data.controllership.revalidation],
    [oldValue + 250, 'VALIDATED', null]);
});

test('pedido em validação pela Controladoria: cargo e valores não mudam pela edição administrativa', async () => {
  const admin = await as('admin');
  const comercial = await as('comercial');
  const c = await queryOne(
    `SELECT c.id, c.contracting_unit_id, c.modalities, r.job_role_id FROM contracts c JOIN contract_rates r ON r.contract_id = c.id
      WHERE c.status = 'ACTIVE' AND c.contracting_unit_id IS NOT NULL AND r.status = 'VALIDATED' LIMIT 1`);
  const created = await comercial.post('/api/orders', {
    contractId: c.id, modality: c.modalities.split(',')[0], jobRoleId: c.job_role_id, quantity: 1, workLocationId: c.contracting_unit_id,
    clientRequestDate: today, desiredStartDate: addDays(today, 5), termType: 'INDEFINITE',
    monthlyValue: 9999, feeValue: null, rateValidFrom: addDays(today, 2) });
  assert.equal(created.data.summary.approvalStatus, 'AWAITING_CONTROLLERSHIP');
  const o = (await admin.get(`/api/orders/${created.data.summary.id}`)).data;
  const blocked = await admin.post(`/api/orders/${o.summary.id}/admin-edit/preview`, bodyOf(o, { monthlyValue: 8888 }));
  assert.equal(blocked.status, 422);
  assert.ok(blocked.data.campos?.jobRoleId);
  // Os demais dados podem ser corrigidos.
  const notes = await admin.post(`/api/orders/${o.summary.id}/admin-edit/preview`, bodyOf(o, { notes: 'Ajuste.' }));
  assert.equal(notes.status, 200, JSON.stringify(notes.data));
});

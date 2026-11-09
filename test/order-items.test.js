import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Vários cargos no mesmo pedido (melhoria de 06/11/2026): itens com cargo, quantidade, descrição e valores próprios;
 * posições ligadas ao item; uma validação da Controladoria para o pedido inteiro; acréscimo num cargo do pedido ou num
 * cargo novo; edição administrativa por cargo; os pedidos anteriores viraram pedidos de um item.
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

/** Contrato A da demonstração: Estoquista (R$ 3.000) e Operador de empilhadeira (R$ 4.500) validados. */
async function setup() {
  const contract = await queryOne("SELECT id, contracting_unit_id FROM contracts WHERE name LIKE 'CT-%-CD-01-%' LIMIT 1");
  const role = async (name) => queryOne('SELECT id FROM job_roles WHERE name = ?', name);
  const comercial = await as('comercial');
  const current = async (jobRoleId) => (await comercial.get(
    `/api/contract-rates/current?contractId=${contract.id}&jobRoleId=${jobRoleId}&date=${today}`)).data;
  const stockist = await role('Estoquista');
  const forklift = await role('Operador de empilhadeira');
  return { contract, stockist, forklift, stockistRate: await current(stockist.id), forkliftRate: await current(forklift.id) };
}

const header = (c) => ({
  contractId: c.contract.id, modality: 'MOT', workLocationId: c.contract.contracting_unit_id,
  clientRequestDate: addDays(today, -1), desiredStartDate: addDays(today, 7), termType: 'INDEFINITE',
});
const item = (jobRoleId, quantity, rate, extra = {}) => ({
  jobRoleId, quantity, monthlyValue: rate?.monthlyValue ?? null, feeValue: rate?.feeValue ?? null, rateValidFrom: rate?.validFrom ?? null,
  ...extra,
});

test('cinco Estoquistas e três Operadores: um pedido, dois cargos e oito posições ligadas ao cargo', async () => {
  const c = await setup();
  const comercial = await as('comercial');
  const created = await comercial.post('/api/orders', {
    ...header(c),
    items: [
      item(c.stockist.id, 5, c.stockistRate, { jobDescription: 'Repor gôndolas.' }),
      item(c.forklift.id, 3, c.forkliftRate, { jobDescription: 'Operar empilhadeira elétrica.' }),
    ],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const o = created.data;
  assert.equal(o.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL', 'valores validados: direto para o cliente');
  assert.equal(o.summary.quantity, 8);
  assert.equal(o.summary.jobRoleName, 'Estoquista, Operador de empilhadeira');
  assert.deepEqual(o.items.map((i) => [i.sequence, i.jobRoleName, i.quantity, i.open, i.jobDescription]), [
    [1, 'Estoquista', 5, 5, 'Repor gôndolas.'],
    [2, 'Operador de empilhadeira', 3, 3, 'Operar empilhadeira elétrica.'],
  ]);
  assert.equal(o.positions.length, 8);
  assert.deepEqual(o.positions.map((p) => p.jobRoleName), [...Array(5).fill('Estoquista'), ...Array(3).fill('Operador de empilhadeira')]);
  assert.deepEqual(o.positions.map((p) => p.slotNumber), [1, 2, 3, 4, 5, 6, 7, 8]);
  // Cada posição guarda o item e o valor do próprio cargo; a descrição da posição é a do cargo.
  const rows = await query('SELECT p.order_item_id, p.rate_id, i.job_role_id FROM positions p JOIN order_items i ON i.id = p.order_item_id WHERE p.order_id = ?',
    o.summary.id);
  assert.equal(rows.length, 8);
  assert.ok(rows.every((r) => r.rate_id === (r.job_role_id === c.stockist.id ? c.stockistRate.id : c.forkliftRate.id)));
  const position = (await comercial.get(`/api/positions/${o.positions[6].id}`)).data;
  assert.deepEqual([position.summary.jobRoleName, position.jobDescription], ['Operador de empilhadeira', 'Operar empilhadeira elétrica.']);
  // Filtro de posições por cargo.
  const filtered = (await comercial.get(`/api/positions?orderId=${o.summary.id}&jobRoleId=${c.forklift.id}`)).data;
  assert.equal(filtered.total, 3);
});

test('regras dos itens: cargo repetido, quantidade e erro marcado no cargo certo', async () => {
  const c = await setup();
  const comercial = await as('comercial');
  const repeated = await comercial.post('/api/orders', {
    ...header(c), items: [item(c.stockist.id, 2, c.stockistRate), item(c.stockist.id, 1, c.stockistRate)],
  });
  assert.equal(repeated.status, 422);
  assert.match(repeated.data.campos?.['jobRoleId-1'] ?? '', /Cargo 2: O cargo Estoquista já está no pedido/);
  const quantity = await comercial.post('/api/orders', { ...header(c), items: [item(c.stockist.id, 0, c.stockistRate)] });
  assert.ok(quantity.data.campos?.['quantity-0'], JSON.stringify(quantity.data));
  const empty = await comercial.post('/api/orders', { ...header(c), items: [] });
  assert.ok(empty.data.campos?.items);
});

test('valor novo num dos cargos: o pedido inteiro vai à Controladoria, que devolve e valida tudo junto', async () => {
  const c = await setup();
  const comercial = await as('comercial');
  const controladoria = await as('controladoria');
  const created = await comercial.post('/api/orders', {
    ...header(c),
    items: [item(c.stockist.id, 2, c.stockistRate), item(c.forklift.id, 1, { monthlyValue: 4700, feeValue: null, validFrom: today })],
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const id = created.data.summary.id;
  assert.equal(created.data.summary.approvalStatus, 'AWAITING_CONTROLLERSHIP');
  assert.deepEqual(created.data.itemValues.map((i) => [i.jobRoleName, i.monthlyValue, i.status]),
    [['Estoquista', 3000, 'VALIDATED'], ['Operador de empilhadeira', 4700, 'PENDING']]);
  assert.deepEqual(created.data.controllership.history.map((h) => [h.action, h.itemSequence]), [['SUBMITTED', 1], ['SUBMITTED', 2]]);

  const returned = await controladoria.post(`/api/orders/${id}/controllership-return`, { reason: 'Empilhadeira acima da tabela.' });
  assert.equal(returned.status, 200, JSON.stringify(returned.data));
  assert.deepEqual(returned.data.itemValues.map((i) => i.status), ['VALIDATED', 'REJECTED']);

  const items = returned.data.itemValues;
  const resent = await comercial.post(`/api/orders/${id}/controllership-resubmission`, {
    items: [
      { itemId: items[0].itemId, jobRoleId: c.stockist.id, monthlyValue: 3000, feeValue: null, rateValidFrom: c.stockistRate.validFrom },
      { itemId: items[1].itemId, jobRoleId: c.forklift.id, monthlyValue: 4600, feeValue: null, rateValidFrom: today },
    ],
  });
  assert.equal(resent.status, 200, JSON.stringify(resent.data));
  assert.deepEqual(resent.data.itemValues.map((i) => [i.monthlyValue, i.status]), [[3000, 'VALIDATED'], [4600, 'PENDING']]);

  const validated = await controladoria.post(`/api/orders/${id}/controllership-validation`);
  assert.equal(validated.status, 200, JSON.stringify(validated.data));
  assert.equal(validated.data.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
  assert.deepEqual(validated.data.itemValues.map((i) => i.status), ['VALIDATED', 'VALIDATED']);
  assert.deepEqual(validated.data.controllership.history.filter((h) => h.action === 'VALIDATED').map((h) => h.itemSequence), [1, 2]);
});

test('acréscimo num cargo do pedido ou num cargo novo; cargo novo com valor novo vira revalidação', async () => {
  const c = await setup();
  const comercial = await as('comercial');
  const created = (await comercial.post('/api/orders', {
    ...header(c), items: [item(c.stockist.id, 1, c.stockistRate), item(c.forklift.id, 1, c.forkliftRate)],
  })).data;
  const id = created.summary.id;
  assert.equal((await comercial.post(`/api/orders/${id}/approval`, { date: today })).status, 200);
  assert.equal((await comercial.post(`/api/orders/${id}/positions`, { quantity: 1, desiredStartDate: addDays(today, 7) })).status, 422,
    'com vários cargos, é preciso escolher o cargo');

  const more = await comercial.post(`/api/orders/${id}/positions`, { itemId: created.items[1].id, quantity: 2, desiredStartDate: addDays(today, 9) });
  assert.equal(more.status, 200, JSON.stringify(more.data));
  assert.deepEqual(more.data.items.map((i) => i.quantity), [1, 3]);
  assert.equal(more.data.summary.quantity, 4);

  const cleaner = await queryOne("SELECT id FROM job_roles WHERE name = 'Auxiliar de limpeza'");
  const fresh = await comercial.post(`/api/orders/${id}/positions`, {
    jobRoleId: cleaner.id, quantity: 2, desiredStartDate: addDays(today, 9), monthlyValue: 2900, feeValue: null, rateValidFrom: today,
    jobDescription: 'Limpeza do CD.',
  });
  assert.equal(fresh.status, 200, JSON.stringify(fresh.data));
  assert.deepEqual(fresh.data.items.map((i) => i.jobRoleName), ['Estoquista', 'Operador de empilhadeira', 'Auxiliar de limpeza']);
  assert.equal(fresh.data.summary.approvalStatus, 'APPROVED', 'o pedido não para');
  assert.equal(fresh.data.controllership.status, 'PENDING');
  assert.equal(fresh.data.controllership.revalidation.length, 1);
  const validated = await (await as('controladoria')).post(`/api/orders/${id}/controllership-validation`);
  assert.equal(validated.status, 200, JSON.stringify(validated.data));
  assert.equal(validated.data.itemValues[2].status, 'VALIDATED');
  assert.equal(validated.data.summary.quantity, 6);
});

test('edição administrativa por cargo e pedidos anteriores como pedido de um item', async () => {
  const c = await setup();
  const comercial = await as('comercial');
  const admin = await as('admin');
  const created = (await comercial.post('/api/orders', {
    ...header(c), items: [item(c.stockist.id, 1, c.stockistRate), item(c.forklift.id, 1, c.forkliftRate)],
  })).data;
  const o = (await admin.get(`/api/orders/${created.summary.id}`)).data;
  const body = {
    modality: o.summary.modality, workLocationId: o.workLocationId, clientRequestDate: o.summary.clientRequestDate,
    desiredStartDate: o.summary.desiredStartDate, registeredAt: o.summary.registeredAt, clientDecisionDate: null,
    termType: o.termType, termEndDate: o.termEndDate, termDurationDays: o.termDurationDays, notes: o.notes,
    items: o.adminEdit.items.map((i) => ({
      itemId: i.itemId, jobRoleId: i.jobRoleId, jobDescription: i.jobDescription,
      monthlyValue: i.values.monthlyValue, feeValue: i.values.feeValue, rateValidFrom: i.values.validFrom,
    })),
  };
  body.items[1].jobDescription = 'Nova descrição do operador.';
  const preview = await admin.post(`/api/orders/${o.summary.id}/admin-edit/preview`, body);
  assert.equal(preview.status, 200, JSON.stringify(preview.data));
  assert.deepEqual(preview.data.changes.map((ch) => ch.label), ['Cargo 2 — descrição da vaga']);

  // Todo pedido tem item e todas as posições ligadas a um item do próprio pedido (a migração dos pedidos anteriores
  // cria o item com o id do pedido; é conferida contra um banco anterior à melhoria).
  const legacy = await query(
    `SELECT o.id, i.id AS item_id, (SELECT COUNT(*) FROM positions p WHERE p.order_id = o.id AND p.order_item_id = i.id) AS linked,
            (SELECT COUNT(*) FROM positions p WHERE p.order_id = o.id) AS total
       FROM orders o JOIN order_items i ON i.order_id = o.id WHERE o.number <= 5`);
  assert.ok(legacy.length >= 5);
  assert.ok(legacy.every((r) => Number(r.linked) === Number(r.total)), JSON.stringify(legacy));
});

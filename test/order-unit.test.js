import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Local de trabalho cadastrado pelo Comercial durante a criação do pedido (melhoria de 26/10/2026): unidade do
 * cliente com código, nome e CNPJ, as regras do cadastro do cliente, aviso de nome repetido e a unidade contratante
 * dos contratos intacta.
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

/** CNPJ válido a partir de 12 dígitos (dígitos verificadores calculados). */
function cnpjOf(base12) {
  const digits = base12.split('').map(Number);
  for (const weights of [[5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2], [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]]) {
    const sum = weights.reduce((s, w, i) => s + w * digits[i], 0);
    digits.push(sum % 11 < 2 ? 0 : 11 - (sum % 11));
  }
  return digits.join('');
}

/** Cliente sem unidades e contrato no cliente principal (sem unidade contratante), criados pelo Comercial. */
let main = null;
async function mainContract() {
  if (main) return main;
  const comercial = await as('comercial');
  const client = await comercial.post('/api/clients', {
    legalName: 'Cliente Sem Unidades (teste)', cnpj: cnpjOf('661234560001'), active: true, hasMultipleUnits: false, units: [] });
  assert.equal(client.status, 200, JSON.stringify(client.data));
  const group = await queryOne('SELECT id FROM group_entities LIMIT 1');
  const owner = await queryOne("SELECT id FROM users WHERE email = 'comercial@demo.local'");
  const contract = await comercial.post('/api/contracts', {
    clientId: client.data.id, contractingUnitId: null, groupEntityId: group.id, modalities: ['MOT'], startDate: addDays(today, -30),
    endDate: null, commercialOwnerId: owner.id, slaNewDays: null, slaReplacementDays: null });
  assert.equal(contract.status, 200, JSON.stringify(contract.data));
  const role = await queryOne('SELECT id FROM job_roles WHERE active = 1 LIMIT 1');
  main = { id: contract.data.id, client_id: client.data.id, modalities: 'MOT', job_role_id: role.id };
  return main;
}

test('o Comercial cadastra a unidade no pedido e ela é usada no pedido e nos próximos', async () => {
  const contract = await mainContract();
  assert.ok(contract, 'há contrato do cliente principal nos dados de demonstração');
  const comercial = await as('comercial');
  const path = `/api/clients/${contract.client_id}/units`;

  // Campos obrigatórios e CNPJ válido.
  assert.equal((await comercial.post(path, { code: 'L-90', name: 'Loja Centro', cnpj: '' })).data.campos?.cnpj, 'Informe o CNPJ da unidade.');
  assert.ok((await comercial.post(path, { code: 'L-90', name: 'Loja Centro', cnpj: '11.111.111/1111-11' })).data.campos?.cnpj);
  assert.ok((await comercial.post(path, { code: '', name: 'Loja Centro', cnpj: cnpjOf('551234560001') })).data.campos?.code);
  assert.equal((await (await as('rh')).post(path, { code: 'L-90', name: 'Loja Centro', cnpj: cnpjOf('551234560001') })).status, 403);

  const created = await comercial.post(path, { code: 'L-90', name: 'Loja Centro', cnpj: cnpjOf('551234560001') });
  assert.equal(created.status, 200, JSON.stringify(created.data));
  assert.deepEqual([created.data.code, created.data.name, created.data.clientId], ['L-90', 'Loja Centro', contract.client_id]);
  const log = await queryOne("SELECT user_id, occurred_at FROM audit_logs WHERE entity = 'WorkLocation' AND entity_id = ? AND action = 'CREATE_UNIT' LIMIT 1",
    created.data.id);
  assert.equal(log.user_id, (await queryOne("SELECT id FROM users WHERE email = 'comercial@demo.local'")).id, 'quem cadastrou e quando');
  assert.ok(log.occurred_at);

  // Disponível nos locais e no cadastro do cliente; a unidade contratante do contrato não muda.
  assert.ok((await comercial.get('/api/catalogs/work-locations')).data.some((l) => l.id === created.data.id));
  const client = (await comercial.get('/api/clients')).data.find((c) => c.id === contract.client_id);
  assert.equal(client.hasMultipleUnits, true);
  assert.ok(client.units.some((u) => u.id === created.data.id));
  const contractDto = (await comercial.get(`/api/contracts/${contract.id}`)).data;
  assert.equal(contractDto.contractingUnitId, null);
  // O contrato do cliente principal continua editável depois que o cliente ganhou unidades.
  const edited = await comercial.put(`/api/contracts/${contract.id}`, {
    clientId: contractDto.clientId, contractingUnitId: null, groupEntityId: contractDto.groupEntityId, modalities: contractDto.modalities,
    startDate: contractDto.startDate, endDate: contractDto.endDate, commercialOwnerId: contractDto.commercialOwnerId,
    slaNewDays: contractDto.slaNewDays, slaReplacementDays: contractDto.slaReplacementDays, status: contractDto.status,
  });
  assert.equal(edited.status, 200, JSON.stringify(edited.data));

  // O pedido usa a unidade nova.
  const order = await comercial.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities.split(',')[0], jobRoleId: contract.job_role_id, quantity: 1,
    workLocationId: created.data.id, clientRequestDate: addDays(today, -1), desiredStartDate: addDays(today, 5), termType: 'INDEFINITE',
    monthlyValue: 2900, feeValue: null, rateValidFrom: today,
  });
  assert.equal(order.status, 201, JSON.stringify(order.data));
  assert.equal(order.data.workLocationId, created.data.id);
});

test('duplicidade: código e CNPJ repetidos são recusados; nome igual pede confirmação', async () => {
  const contract = await mainContract();
  const comercial = await as('comercial');
  const path = `/api/clients/${contract.client_id}/units`;
  await comercial.post(path, { code: 'L-91', name: 'Loja Norte', cnpj: cnpjOf('551234560002') });

  const code = await comercial.post(path, { code: 'l-91', name: 'Outra', cnpj: cnpjOf('551234560003') });
  assert.match(code.data.campos?.code ?? '', /já tem a unidade de código "L-91"/);
  const ownCnpj = await comercial.post(path, { code: 'L-92', name: 'Outra', cnpj: cnpjOf('551234560002') });
  assert.match(ownCnpj.data.campos?.cnpj ?? '', /já é o da unidade "L-91 — Loja Norte"/);
  // CNPJ de unidade de outro cliente: a regra do cadastro do cliente (único no sistema).
  const other = await queryOne('SELECT cnpj, code FROM work_locations WHERE client_id <> ? AND cnpj IS NOT NULL AND removed_at IS NULL LIMIT 1',
    contract.client_id);
  if (other) {
    const foreign = await comercial.post(path, { code: 'L-93', name: 'Outra', cnpj: other.cnpj });
    assert.match(foreign.data.campos?.cnpj ?? '', /já é o da unidade/);
  }

  const warned = await comercial.request('POST', path, { code: 'L-94', name: 'loja norte', cnpj: cnpjOf('551234560004') }, { confirm: false });
  assert.equal(warned.status, 422);
  assert.deepEqual(warned.data.avisos.map((a) => a.tipo), ['DUPLICATE']);
  assert.equal((await query("SELECT 1 FROM work_locations WHERE code = 'L-94'")).length, 0, 'nada gravado sem confirmar');
  const confirmed = await comercial.post(path, { code: 'L-94', name: 'loja norte', cnpj: cnpjOf('551234560004') });
  assert.equal(confirmed.status, 200, JSON.stringify(confirmed.data));
});

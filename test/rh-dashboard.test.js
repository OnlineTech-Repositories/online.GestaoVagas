import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query } from '../src/db/index.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Painel de RH pela API real com os dados de demonstração: acesso por perfil, consistência dos totais (cada pedido e
 * cada vaga uma vez), filtros, pedidos compartilhados, reposições na vaga de origem e o drill-down para a lista de
 * posições — a contagem de um segmento é a mesma da lista que ele abre.
 */

let server;
const clients = new Map();

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

const qs = (params) => (Object.keys(params).length ? `?${new URLSearchParams(params)}` : '');
async function dashboard(user, params = {}) {
  const r = await (await as(user)).get(`/api/dashboard/rh${qs(params)}`);
  assert.equal(r.status, 200, `painel de RH (${user}): ${JSON.stringify(r.data)}`);
  return r.data;
}
async function positionsTotal(user, params) {
  const r = await (await as(user)).get(`/api/positions${qs({ pageSize: 500, ...params })}`);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.total;
}

const STAGES = ['AWAITING_CLIENT', 'OPEN', 'RECRUITING', 'CANDIDATE_APPROVED', 'IN_ADMISSION', 'AWAITING_FIRST_DAY', 'PAUSED', 'FILLED'];
const SLA = ['ON_TIME', 'AT_RISK', 'OVERDUE', 'NO_TARGET', 'NOT_STARTED'];
const sum = (obj, keys) => keys.reduce((s, k) => s + obj[k], 0);

/** Os contadores de uma linha fecham: etapas = vagas, preenchidas + pendentes = vagas, SLA = pendentes. */
function assertConsistent(row, label) {
  assert.equal(sum(row.stages, STAGES), row.positions, `${label}: etapas somam as vagas`);
  assert.equal(row.filled, row.stages.FILLED, `${label}: preenchidas`);
  assert.equal(row.filled + row.pending, row.positions, `${label}: preenchidas + pendentes`);
  assert.equal(sum(row.sla, SLA), row.pending, `${label}: SLA das pendentes`);
}

test('acesso: gestão vê a equipe, o Analista de RH só os seus pedidos, os demais perfis não acessam', async () => {
  for (const user of ['comercial', 'nacc', 'dp', 'controladoria']) {
    assert.equal((await (await as(user)).get('/api/dashboard/rh')).status, 403, user);
  }
  const team = await dashboard('gestor.rh');
  assert.equal(team.analystLocked, false);
  for (const user of ['gestor', 'admin']) {
    assert.deepEqual((await dashboard(user)).totals, team.totals, `${user} vê o mesmo consolidado do Gestor de RH`);
  }

  const mine = await dashboard('rh');
  const me = (await (await as('rh')).get('/api/auth/me')).data;
  assert.equal(mine.analystLocked, true);
  assert.equal(mine.filters.rh, me.id);
  assert.deepEqual(mine.options.analysts, [], 'sem lista de analistas para quem não escolhe');
  assert.ok(mine.orders.length > 0 && mine.orders.length < team.orders.length);
  for (const o of mine.orders) assert.ok(o.analysts.includes(me.name), `pedido ${o.number} é do analista`);
  assert.deepEqual(mine.analysts.map((a) => a.id), [me.id], 'só a própria linha, sem "Sem analista"');

  // O filtro de analista vindo da URL não abre os pedidos dos outros.
  const other = team.analysts.find((a) => a.id !== me.id && a.id !== 'UNASSIGNED');
  const forced = await dashboard('rh', { rh: other.id });
  assert.deepEqual(forced.totals, mine.totals);
  assert.deepEqual((await dashboard('rh', { rh: 'UNASSIGNED' })).totals, mine.totals);
});

test('consistência: totais, pedidos e analistas fecham; cada pedido e vaga contam uma vez', async () => {
  const d = await dashboard('gestor.rh');
  const t = d.totals;
  assertConsistent(t, 'total');
  assert.equal(t.orders, d.orders.length);
  for (const o of d.orders) {
    assertConsistent(o, `pedido ${o.number}`);
    assert.ok(o.pending > 0, `pedido ${o.number} em andamento tem vaga pendente`);
    assert.equal(o.shared, o.analysts.length > 1);
  }
  for (const k of STAGES) assert.equal(t.stages[k], d.orders.reduce((s, o) => s + o.stages[k], 0), `etapa ${k}`);
  assert.equal(t.unassigned, d.orders.filter((o) => o.analysts.length === 0).length);
  assert.equal(t.sharedOrders, d.orders.filter((o) => o.shared).length);
  assert.ok(t.sharedOrders > 0, 'a demonstração tem pedido compartilhado');

  // Pedido compartilhado entra em cada analista; o total não duplica.
  for (const a of d.analysts) assertConsistent(a, `analista ${a.name}`);
  const shared = d.orders.find((o) => o.shared);
  const withShared = d.analysts.filter((a) => shared.analysts.includes(a.name));
  assert.equal(withShared.length, shared.analysts.length);
  for (const a of withShared) assert.ok(a.sharedOrders >= 1);
  assert.ok(d.analysts.reduce((s, a) => s + a.positions, 0) > t.positions, 'a soma das linhas passa do total');
  assert.equal(d.analysts.reduce((s, a) => s + a.orders, 0), t.orders + d.orders.reduce((s, o) => s + Math.max(0, o.analysts.length - 1), 0));
  const unassigned = d.analysts.find((a) => a.id === 'UNASSIGNED');
  assert.equal(unassigned.orders, t.unassigned);

  // Etapas próprias: pausa e espera pelo cliente são pendentes; "não iniciado" e "sem meta" à parte.
  assert.ok(t.stages.PAUSED > 0 && t.stages.AWAITING_CLIENT > 0);
  assert.ok(t.sla.NOT_STARTED > 0, 'vagas sem contagem de SLA');
  assert.equal(t.awaitingApproval, d.orders.filter((o) => o.approvalStatus === 'AWAITING_CLIENT_APPROVAL').length);
});

test('reposição ocupa a vaga de origem: o pedido conta vagas, não ciclos', async () => {
  const d = await dashboard('gestor.rh', { includeConcluded: 'true' });
  const rows = await query(
    `SELECT p.order_id, COUNT(*) AS total, COUNT(DISTINCT p.slot_number) AS slots FROM positions p
      JOIN orders o ON o.id = p.order_id
      WHERE o.is_legacy = 0 AND p.status NOT IN ('CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED')
      GROUP BY p.order_id`);
  const withReplacement = rows.filter((r) => Number(r.total) > Number(r.slots));
  assert.ok(withReplacement.length > 0, 'a demonstração tem reposição');
  for (const r of withReplacement) {
    const order = d.orders.find((o) => o.orderId === r.order_id);
    assert.equal(order.positions, Number(r.slots), `pedido ${order.number}: uma linha por vaga`);
  }
});

test('drill-down: cada etapa e situação do SLA bate com a lista de posições que o clique abre', async () => {
  const all = await dashboard('gestor.rh', { includeConcluded: 'true' });
  for (const k of STAGES) {
    assert.equal(await positionsTotal('gestor.rh', { stage: k }), all.totals.stages[k], `etapa ${k}`);
  }
  const d = await dashboard('gestor.rh');
  const order = d.orders.find((o) => o.shared) ?? d.orders[0];
  for (const k of STAGES.filter((s) => order.stages[s] > 0)) {
    assert.equal(await positionsTotal('gestor.rh', { orderId: order.orderId, stage: k }), order.stages[k], `pedido ${order.number}, ${k}`);
  }
  const notStarted = await positionsTotal('gestor.rh', { slaSituation: 'NOT_STARTED', onlyOpen: 'true' });
  assert.equal(notStarted, all.totals.sla.NOT_STARTED, 'vagas pendentes sem contagem de SLA');
  assert.equal((await (await as('gestor.rh')).get('/api/positions?stage=XYZ')).status, 400);
});

test('filtros valem para tudo: etapa, SLA, cliente, unidade, analista e período', async () => {
  const base = await dashboard('gestor.rh');

  const stage = await dashboard('gestor.rh', { stage: 'RECRUITING' });
  assert.equal(stage.totals.positions, base.totals.stages.RECRUITING);
  assert.ok(stage.orders.every((o) => o.positions === o.stages.RECRUITING));

  const overdue = await dashboard('gestor.rh', { sla: 'OVERDUE' });
  assert.equal(overdue.totals.positions, base.totals.sla.OVERDUE);
  assert.ok(overdue.analysts.every((a) => a.pending === a.sla.OVERDUE));
  const order = overdue.orders[0];
  assert.equal(await positionsTotal('gestor.rh', { orderId: order.orderId, slaSituation: 'OVERDUE', onlyOpen: 'true' }), order.positions,
    'o clique no pedido com filtro de SLA abre as mesmas vagas');

  const client = base.options.clients[0];
  const byClient = await dashboard('gestor.rh', { clientId: client.value });
  assert.ok(byClient.orders.length > 0 && byClient.orders.every((o) => o.client === client.label));

  for (const unit of base.options.units) {
    const byUnit = await dashboard('gestor.rh', { unit: unit.value });
    assert.ok(byUnit.orders.every((o) => o.unit === unit.label), unit.label);
  }

  const analyst = base.analysts.find((a) => a.id !== 'UNASSIGNED');
  const byAnalyst = await dashboard('gestor.rh', { rh: analyst.id });
  assert.equal(byAnalyst.totals.positions, analyst.positions);
  assert.equal(byAnalyst.totals.orders, analyst.orders);
  const unassigned = await dashboard('gestor.rh', { rh: 'UNASSIGNED' });
  assert.equal(unassigned.totals.orders, base.totals.unassigned);
  assert.ok(unassigned.orders.every((o) => o.analysts.length === 0));

  const dates = base.orders.map((o) => o.clientRequestDate).sort();
  const latest = dates.at(-1);
  const period = await dashboard('gestor.rh', { from: latest, to: latest });
  assert.ok(period.orders.length > 0 && period.orders.every((o) => o.clientRequestDate === latest));

  const concluded = await dashboard('gestor.rh', { includeConcluded: 'true' });
  assert.ok(concluded.totals.orders >= base.totals.orders);

  const c = await as('gestor.rh');
  assert.equal((await c.get(`/api/dashboard/rh?from=${latest}&to=2000-01-01`)).status, 422);
  assert.equal((await c.get('/api/dashboard/rh?rh=qualquer')).status, 422);
  assert.equal((await c.get('/api/dashboard/rh?stage=XYZ')).status, 400);
  assert.equal((await c.get('/api/dashboard/rh?sla=XYZ')).status, 400);
  assert.equal((await c.get('/api/dashboard/rh?unit=XYZ')).status, 422);
});

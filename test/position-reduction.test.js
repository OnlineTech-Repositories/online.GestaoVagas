import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Redução do quadro do pedido pelo ADMIN (melhoria de 22/10/2026): só posições sem candidato, admissão ou
 * colaborador; encerradas como "Cancelada por redução do quadro" com data efetiva, justificativa e evidência; a
 * quantidade vigente cai e a solicitada fica; perda até a data efetiva, como no cancelamento; histórico completo.
 */

let server;
const clients = new Map();
const today = todayDate();
let order;

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

const base = () => `/api/orders/${order.summary.id}`;
const PDF = Buffer.from('%PDF-1.7 e-mail do cliente reduzindo o quadro');

function reduce(user, fields, { evidence = null, confirm = true } = {}) {
  const form = new FormData();
  form.append('positionIds', JSON.stringify(fields.positionIds));
  if (fields.date) form.append('date', fields.date);
  if (fields.justification !== undefined) form.append('justification', fields.justification);
  if (evidence) form.append('evidence', new Blob([evidence]), 'reducao.pdf');
  return as(user).then((c) => c.request('POST', `${base()}/position-reductions`, undefined, { form, confirm }));
}

test('só o ADMIN vê e executa a redução; as posições elegíveis são as sem candidato, admissão ou colaborador', async () => {
  const admin = await as('admin');
  const { data: orders } = await admin.get('/api/orders');
  for (const o of orders.items ?? orders) {
    const detail = (await admin.get(`/api/orders/${o.id}`)).data;
    if (detail.headcountReduction?.eligible.length >= 3) {
      order = detail;
      break;
    }
  }
  assert.ok(order, 'a demonstração tem um pedido aprovado com posições abertas');
  const statuses = new Set(order.headcountReduction.eligible.map((e) => e.status));
  for (const s of statuses) assert.ok(['OPEN', 'RECRUITING', 'PAUSED'].includes(s), s);

  assert.equal((await (await as('comercial')).get(base())).data.headcountReduction, null);
  const [first] = order.headcountReduction.eligible;
  const forbidden = await reduce('gestor', { positionIds: [first.positionId], date: today, justification: 'Cliente pediu.' });
  assert.equal(forbidden.status, 403);
});

test('recusa: sem justificativa, posição com candidato e mais posições do que as elegíveis', async () => {
  const [a] = order.headcountReduction.eligible;
  const noReason = await reduce('admin', { positionIds: [a.positionId], date: today, justification: '' });
  assert.equal(noReason.status, 422);
  assert.ok(noReason.data.campos.justification);

  // Com candidato selecionado, a posição não pode sair do quadro.
  const grh = await as('gestor.rh');
  const recruiting = order.headcountReduction.eligible.find((e) => e.status === 'RECRUITING');
  await grh.post(`/api/positions/${recruiting.positionId}/candidate-approval`, {
    date: today, fullName: 'Candidata Reservada', birthDate: '1990-01-01', sex: 'FEMALE', cpf: '111.444.777-35',
  });
  const withCandidate = await reduce('admin', { positionIds: [recruiting.positionId], date: today, justification: 'Cliente pediu.' });
  assert.equal(withCandidate.status, 422);
  assert.match(withCandidate.data.detail, /não pode ser retirada do quadro/);

  order = (await (await as('admin')).get(base())).data;
  const all = order.headcountReduction.eligible.map((e) => e.positionId);
  const tooMany = await reduce('admin', { positionIds: [...all, recruiting.positionId], date: today, justification: 'Cliente pediu.' });
  assert.equal(tooMany.status, 422);
});

test('redução: encerra as escolhidas, mantém registros, baixa a quantidade vigente e registra tudo no histórico', async () => {
  const admin = await as('admin');
  const before = order.summary;
  const [a, b, c] = order.headcountReduction.eligible;
  const done = await reduce('admin', { positionIds: [a.positionId, b.positionId], date: today, justification: 'Cliente reduziu o quadro por e-mail.' },
    { evidence: PDF });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const after = done.data.summary;
  assert.equal(after.quantity, before.quantity, 'a solicitada (registro + acréscimos) fica');
  assert.equal(after.currentQuantity, before.currentQuantity - 2);
  assert.equal(after.reducedQuantity, before.reducedQuantity + 2);

  for (const p of [a, b]) {
    const row = { ...(await queryOne('SELECT status, closed_at, cancellation_reason FROM positions WHERE id = ?', p.positionId)) };
    assert.deepEqual(row, { status: 'CLOSED_HEADCOUNT_REDUCED', closed_at: today, cancellation_reason: 'Cliente reduziu o quadro por e-mail.' });
  }
  assert.notEqual((await queryOne('SELECT status FROM positions WHERE id = ?', c.positionId)).status, 'CLOSED_HEADCOUNT_REDUCED');

  // Evidência vinculada a cada posição retirada, num arquivo só; aparece no detalhe da posição.
  const evidences = await query("SELECT position_id, storage_key FROM position_evidences WHERE kind = 'HEADCOUNT_REDUCTION'");
  assert.equal(evidences.length, 2);
  assert.equal(new Set(evidences.map((e) => e.storage_key)).size, 1);
  const detail = (await admin.get(`/api/positions/${a.positionId}`)).data;
  assert.equal(detail.reductionEvidence.fileName, 'reducao.pdf');
  assert.equal(detail.summary.status, 'CLOSED_HEADCOUNT_REDUCED');

  // Histórico: quem, quando, data efetiva, posições e quantidades antes e depois; justificativa em cada posição.
  const adminId = (await queryOne("SELECT id FROM users WHERE email = 'admin@demo.local'")).id;
  const summary = await queryOne("SELECT user_id, occurred_at, new_value FROM audit_logs WHERE entity_id = ? AND action = 'REDUCE_POSITIONS' AND field = 'Summary'", order.summary.id);
  assert.equal(summary.user_id, adminId);
  const data = JSON.parse(summary.new_value);
  assert.deepEqual([data.effectiveDate, data.quantityBefore, data.quantityAfter, data.positions.length, data.evidence],
    [today, before.currentQuantity, before.currentQuantity - 2, 2, 'reducao.pdf']);
  assert.ok((await query("SELECT 1 FROM audit_logs WHERE entity_id = ? AND action = 'REDUCE_POSITIONS' AND justification = 'Cliente reduziu o quadro por e-mail.'", a.positionId)).length);

  // Fora da demanda vigente: o Painel de RH deixa de contar as retiradas; perda só até a data efetiva.
  const rh = (await (await as('gestor.rh')).get('/api/dashboard/rh?includeConcluded=true')).data;
  const row = rh.orders.find((o) => o.orderId === order.summary.id);
  assert.equal(row.positions, after.currentQuantity - (order.positions.filter((p) => ['CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED'].includes(p.status)).length));
  assert.equal(detail.metrics.uncoveredEndExclusive, today, 'dias descobertos contam até a data efetiva');
});

test('data efetiva futura: aviso antes de gravar; confirmada, a posição sai do quadro e fica com data futura', async () => {
  order = (await (await as('admin')).get(base())).data;
  const [p] = order.headcountReduction.eligible;
  const pending = await reduce('admin', { positionIds: [p.positionId], date: addDays(today, 7), justification: 'Redução combinada para a próxima semana.' },
    { confirm: false });
  assert.equal(pending.status, 422);
  assert.ok(pending.data.avisos.some((a) => a.tipo === 'FUTURE' && /data efetiva da redução/i.test(a.mensagem)));
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', p.positionId)).status, p.status, 'nada gravado');

  const done = await reduce('admin', { positionIds: [p.positionId], date: addDays(today, 7), justification: 'Redução combinada para a próxima semana.' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const detail = (await (await as('admin')).get(`/api/positions/${p.positionId}`)).data;
  assert.equal(detail.summary.dateFlags.future, true);
});

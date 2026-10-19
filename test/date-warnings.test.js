import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Flexibilização das datas (decisões do usuário em 19/10/2026): datas passadas, futuras e fora de sequência não
 * bloqueiam — a API devolve os avisos sem gravar e grava quando a tela confirma (X-Confirm-Warnings). O retroativo
 * fora da carga inicial continua pedindo justificativa; o impossível no próprio registro continua bloqueado. Os
 * indicadores usam a data de referência: nada de tempo negativo, futuro contado só até hoje.
 */

let server;
const clients = new Map();
const T = todayDate();
const d = (n) => addDays(T, n);

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function as(user) {
  if (clients.has(user)) return clients.get(user);
  const c = new Client(server.url);
  assert.equal((await c.login(`${user}@demo.local`, DEMO_PASSWORD)).status, 200, user);
  clients.set(user, c);
  return c;
}

const unconfirmed = (c, method, path, body) => c.request(method, path, body, { confirm: false });

async function newOrder(extra = {}) {
  const com = await as('comercial');
  const contract = (await com.get('/api/contracts?onlyActive=true')).data.find((c) => c.modalities.includes('MOT'));
  const roles = (await com.get(`/api/orders/job-roles?contractId=${contract.id}`)).data;
  const r = await com.post('/api/orders', {
    contractId: contract.id, modality: 'MOT', jobRoleId: roles[0].id, workLocationId: contract.contractingUnitId,
    termType: 'INDEFINITE', quantity: 2, clientRequestDate: d(-20), desiredStartDate: d(-15), ...extra,
  });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data;
}

const position = async (id) => (await (await as('gestor.rh')).get(`/api/positions/${id}`)).data;

test('data futura: sem confirmação nada é gravado; confirmada, grava e a posição fica "data futura" com o SLA não iniciado', async () => {
  const com = await as('comercial');
  const order = await newOrder();
  const id = order.summary.id;

  const pending = await unconfirmed(com, 'POST', `/api/orders/${id}/approval`, { date: d(5) });
  assert.equal(pending.status, 422);
  assert.equal(pending.data.title, 'Confirmação necessária');
  assert.deepEqual(pending.data.avisos.map((a) => a.tipo), ['FUTURE']);
  assert.match(pending.data.avisos[0].mensagem, /é uma data futura\. O registro será salvo e identificado como futuro/);
  assert.equal((await queryOne('SELECT approval_status FROM orders WHERE id = ?', id)).approval_status, 'AWAITING_CLIENT_APPROVAL');

  const done = await com.post(`/api/orders/${id}/approval`, { date: d(5) });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  const p = await position(done.data.positions[0].id);
  assert.equal(p.summary.openedAt, d(5));
  assert.deepEqual(p.summary.dateFlags, { future: true, sequence: false });
  assert.equal(p.metrics.slaSituation, null, 'abertura futura: SLA ainda não começou');
  assert.equal(p.metrics.fillTime, 0);
  assert.ok(p.dateIssues.some((i) => i.kind === 'FUTURE'));
});

test('retroativo fora da carga inicial: aviso + justificativa obrigatória; com ela, grava e sinaliza a posição', async () => {
  const admin = await as('admin');
  const com = await as('comercial');
  assert.equal((await admin.put('/api/parameters/INITIAL_LOAD_OPEN', { value: 'false' })).status, 200);
  try {
    const order = await newOrder();
    const id = order.summary.id;
    const pending = await unconfirmed(com, 'POST', `/api/orders/${id}/approval`, { date: d(-3) });
    assert.equal(pending.status, 422);
    assert.deepEqual(pending.data.avisos.map((a) => a.tipo), ['RETROACTIVE']);
    assert.match(pending.data.avisos[0].mensagem, /é anterior à data atual\. O evento será registrado com essa data/);
    assert.deepEqual(pending.data.justificativa, { campo: 'justification', obrigatoria: true });

    const noReason = await com.post(`/api/orders/${id}/approval`, { date: d(-3) });
    assert.equal(noReason.status, 422);
    assert.equal(noReason.data.campos.justification, 'A data da aprovação é anterior à data de hoje. Informe uma justificativa.');

    const done = await com.post(`/api/orders/${id}/approval`, { date: d(-3), justification: 'Aprovado por e-mail na sexta.' });
    assert.equal(done.status, 200);
    assert.equal((await position(done.data.positions[0].id)).summary.hasRetroactiveDates, true);
  } finally {
    await admin.put('/api/parameters/INITIAL_LOAD_OPEN', { value: 'true' });
  }
});

test('etapas fora de ordem: avisam, gravam com confirmação e ficam "fora de sequência" na lista e no Painel de RH', async () => {
  const com = await as('comercial');
  const grh = await as('gestor.rh');
  const nacc = await as('nacc');
  const order = await newOrder();
  const id = order.summary.id;
  await grh.post(`/api/orders/${id}/jobconvo`, { published: true, code: 'JC-SEQ', publishedAt: d(-12) });
  const approved = (await com.post(`/api/orders/${id}/approval`, { date: d(-10) })).data;
  const pid = approved.positions[0].id;

  const early = await unconfirmed(grh, 'POST', `/api/positions/${pid}/candidate-approval`, {
    date: d(-11), fullName: 'Pessoa Fora de Ordem', birthDate: '1991-02-03', sex: 'FEMALE', cpf: '111.444.777-35',
  });
  assert.equal(early.status, 422);
  const kinds = early.data.avisos.map((a) => a.tipo);
  assert.ok(kinds.includes('SEQUENCE') && kinds.includes('RETROACTIVE'), kinds.join(','));
  assert.match(early.data.avisos.find((a) => a.tipo === 'SEQUENCE').mensagem, /anterior à etapa precedente: a abertura da posição/);

  await grh.post(`/api/positions/${pid}/candidate-approval`, {
    date: d(-11), fullName: 'Pessoa Fora de Ordem', birthDate: '1991-02-03', sex: 'FEMALE', cpf: '111.444.777-35',
  });
  await grh.post(`/api/positions/${pid}/admission`, { date: d(-5), registration: 'M-SEQ' });
  const form = new FormData();
  form.set('date', d(-7));
  form.set('justification', 'Começou antes da admissão formal.');
  const filled = await nacc.request('POST', `/api/positions/${pid}/first-day`, undefined, { form });
  assert.equal(filled.status, 200, JSON.stringify(filled.data));
  assert.equal(filled.data.summary.status, 'FILLED');
  assert.deepEqual(filled.data.summary.dateFlags, { future: false, sequence: true });

  const list = (await grh.get('/api/positions?flag=SEQUENCE&pageSize=500')).data;
  assert.ok(list.items.some((p) => p.id === pid));
  const rh = (await grh.get('/api/dashboard/rh?includeConcluded=true')).data;
  assert.ok(rh.totals.outOfSequence >= 1);
});

test('pausa antes da abertura não deixa o tempo negativo nem empurra o prazo: só conta a parte dentro do SLA', async () => {
  const admin = await as('admin');
  const com = await as('comercial');
  const nacc = await as('nacc');
  const order = await newOrder();
  const pid = order.positions[0].id;
  const reason = (await admin.post('/api/catalogs/pause-reasons', { name: 'Pausa de teste das datas' })).data;
  assert.equal((await nacc.post(`/api/positions/${pid}/pause`, { reasonId: reason.id, startDate: d(-15) })).status, 200);
  await com.post(`/api/orders/${order.summary.id}/approval`, { date: d(-3) });
  assert.equal((await nacc.post(`/api/positions/${pid}/pause/end`, { date: d(-1) })).status, 200);

  const p = await position(pid);
  assert.equal(p.metrics.pausedDays, 2, 'da abertura (−3) ao fim da pausa (−1)');
  assert.equal(p.metrics.fillTime, 1, '3 dias desde a abertura − 2 pausados');
  assert.equal(p.metrics.slaDeadline, addDays(d(-3), p.metrics.slaTargetDays + 2));
  assert.equal(p.summary.dateFlags.sequence, true, 'pausa antes da abertura fica sinalizada');
});

test('1º dia agendado: a vaga fica "Aguardando 1º dia" no Painel de RH e os dias descobertos contam até hoje', async () => {
  const com = await as('comercial');
  const grh = await as('gestor.rh');
  const nacc = await as('nacc');
  const order = await newOrder({ desiredStartDate: d(-10) });
  const id = order.summary.id;
  await grh.post(`/api/orders/${id}/jobconvo`, { published: true, code: 'JC-FUT', publishedAt: d(-9) });
  const pid = (await com.post(`/api/orders/${id}/approval`, { date: d(-8) })).data.positions[0].id;
  await grh.post(`/api/positions/${pid}/candidate-approval`, {
    date: d(-2), fullName: 'Pessoa Agendada', birthDate: '1990-06-07', sex: 'MALE', cpf: '390.533.447-05',
  });
  await grh.post(`/api/positions/${pid}/admission`, { date: d(-1), registration: 'M-FUT' });
  const form = new FormData();
  form.set('date', d(4));
  form.set('justification', 'Início combinado com o cliente.');
  const r = await nacc.request('POST', `/api/positions/${pid}/first-day`, undefined, { form });
  assert.equal(r.status, 200, JSON.stringify(r.data));

  const p = await position(pid);
  assert.equal(p.summary.status, 'FILLED');
  assert.equal(p.summary.rhStage, 'AWAITING_FIRST_DAY');
  assert.equal(p.metrics.uncoveredDays, 10, 'do início desejado (−10) até hoje, não até o 1º dia');
  assert.equal(p.metrics.fillTime, 8);
  assert.notEqual(p.metrics.slaSituation, null, 'SLA ainda corre até o 1º dia chegar');
  assert.equal(p.summary.dateFlags.future, true);
});

test('o impossível continua bloqueando: fim de pausa antes do início, nascimento futuro e início desejado antes da solicitação', async () => {
  const admin = await as('admin');
  const nacc = await as('nacc');
  const grh = await as('gestor.rh');
  const com = await as('comercial');
  const order = await newOrder();
  const [p1, p2] = order.positions.map((p) => p.id);
  const reason = (await admin.post('/api/catalogs/pause-reasons', { name: 'Pausa impossível' })).data;
  await nacc.post(`/api/positions/${p1}/pause`, { reasonId: reason.id, startDate: d(-2) });
  const end = await nacc.post(`/api/positions/${p1}/pause/end`, { date: d(-5) });
  assert.equal(end.status, 422);
  assert.equal(end.data.avisos, undefined, 'bloqueio, não aviso');
  assert.match(end.data.detail, /fim da pausa deve ser igual ou posterior/);

  await grh.post(`/api/orders/${order.summary.id}/jobconvo`, { published: true, code: 'JC-IMP', publishedAt: d(-1) });
  await com.post(`/api/orders/${order.summary.id}/approval`, { date: d(-1) });
  const born = await grh.post(`/api/positions/${p2}/candidate-approval`, {
    date: T, fullName: 'Nascida Amanhã', birthDate: d(1), sex: 'FEMALE', cpf: '529.982.247-25',
  });
  assert.equal(born.status, 422);
  assert.equal(born.data.campos.birthDate, 'A data de nascimento não pode ser uma data futura.');

  const contract = (await com.get('/api/contracts?onlyActive=true')).data.find((c) => c.modalities.includes('MOT'));
  const roles = (await com.get(`/api/orders/job-roles?contractId=${contract.id}`)).data;
  const desired = await com.post('/api/orders', {
    contractId: contract.id, modality: 'MOT', jobRoleId: roles[0].id, workLocationId: contract.contractingUnitId,
    termType: 'INDEFINITE', quantity: 1, clientRequestDate: d(-2), desiredStartDate: d(-5),
  });
  assert.equal(desired.status, 422);
  assert.equal(desired.data.campos.desiredStartDate, 'A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.');
});

test('desligamento com último dia futuro (aviso prévio): avisa e grava; a reposição fica "data futura"', async () => {
  const grh = await as('gestor.rh');
  const dp = await as('dp');
  const filled = (await grh.get('/api/positions?status=FILLED&pageSize=500')).data.items.find((p) => p.isCurrentCycle);
  const pending = await unconfirmed(dp, 'POST', '/api/terminations',
    { originPositionId: filled.id, lastWorkedDay: d(10), source: 'DP', terminationType: 'RESIGNATION' });
  assert.equal(pending.status, 422);
  assert.ok(pending.data.avisos.some((a) => a.tipo === 'FUTURE' && /último dia trabalhado/i.test(a.mensagem)));
  const done = await dp.post('/api/terminations',
    { originPositionId: filled.id, lastWorkedDay: d(10), source: 'DP', terminationType: 'RESIGNATION' });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal((await position(done.data.replacementPositionId)).summary.dateFlags.future, true);
});

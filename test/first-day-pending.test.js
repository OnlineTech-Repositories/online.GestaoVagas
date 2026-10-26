import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { businessDaysBetween, REMINDER_MAX_ROWS } from '../src/services/first-day-pending.js';
import { runDailyJob } from '../src/services/jobs.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Confirmações do 1º dia pendentes (melhoria de 25/10/2026): relação por pedido para o NACC (as sem matrícula à
 * parte), situação pela data da admissão (devida ou prevista), lembrete consolidado na rotina a cada N dias úteis
 * enquanto houver pendência, saída da lista com a confirmação ou o "não compareceu", e o fim do alerta de parada
 * dessas posições (o lembrete o substitui).
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

const PATH = '/api/positions/first-day-pending';
const pendingOf = async () => (await (await as('nacc')).get(PATH)).data;
const reminders = (to = 'nacc@demo.local') => query(
  "SELECT subject, html_body FROM email_messages WHERE to_address = ? AND subject LIKE '%Confirmações do 1º dia pendentes%' ORDER BY created_at, id", to);
const setParam = async (value) => assert.equal((await (await as('admin')).put('/api/parameters/FIRST_DAY_REMINDER_DAYS', { value })).status, 200);

test('dias úteis entre lembretes: fim de semana não conta', () => {
  assert.equal(businessDaysBetween('2026-10-23', '2026-10-26'), 1, 'sexta → segunda');
  assert.equal(businessDaysBetween('2026-10-26', '2026-10-26'), 0, 'mesmo dia');
  assert.equal(businessDaysBetween('2026-10-19', '2026-10-26'), 5, 'segunda → segunda');
});

/** Admitidos pelo fluxo normal (candidato e admissão com matrícula): posições "Aguardando 1º dia". */
async function admit(count) {
  const grh = await as('gestor.rh');
  const recruiting = await query(
    "SELECT p.id FROM positions p JOIN orders o ON o.id = p.order_id WHERE p.status = 'RECRUITING' AND o.approval_status = 'APPROVED' LIMIT ?", count);
  for (const [i, { id }] of recruiting.entries()) {
    const approved = await grh.post(`/api/positions/${id}/candidate-approval`, {
      date: addDays(today, -3), fullName: `Admitida ${i + 1}`, phone: `(11) 9600${i}-1111`, sex: 'FEMALE',
    });
    assert.equal(approved.status, 200, JSON.stringify(approved.data));
    const admitted = await (await as('admissoes')).post(`/api/positions/${id}/admission`, {
      date: addDays(today, -2), registration: `PEND-${i + 1}`, birthDate: '1994-03-0' + (i + 1), cpf: ['52998224725', '11144477735', '39053344705'][i],
    });
    assert.equal(admitted.status, 200, JSON.stringify(admitted.data));
  }
}

test('relação do NACC: por pedido, devidas e previstas pela data da admissão, sem matrícula à parte', async () => {
  await admit(3);
  const awaiting = await query("SELECT id FROM positions WHERE status = 'AWAITING_FIRST_DAY' ORDER BY id");
  const noRegistration = await query("SELECT id FROM positions WHERE status = 'IN_ADMISSION'");
  assert.ok(awaiting.length >= 2 && noRegistration.length >= 1, 'a demonstração tem admitidos aguardando o 1º dia');
  // Uma das admissões com data futura: início previsto.
  const scheduled = awaiting[0].id;
  await execute('UPDATE positions SET admission_at = ? WHERE id = ?', addDays(today, 3), scheduled);

  const d = await pendingOf();
  const items = d.groups.flatMap((g) => g.items);
  assert.equal(items.length, awaiting.length);
  assert.deepEqual(d.withoutRegistration.map((i) => i.positionId).sort(), noRegistration.map((r) => r.id).sort());
  assert.ok(d.withoutRegistration.every((i) => i.situation === 'NO_REGISTRATION' && /Aguardando matrícula/.test(i.situationLabel)));

  const future = items.find((i) => i.positionId === scheduled);
  assert.equal(future.situation, 'SCHEDULED');
  assert.match(future.situationLabel, /^Início previsto para \d{2}\/\d{2}\/\d{4}$/);
  const due = items.filter((i) => i.situation === 'DUE');
  assert.ok(due.length && due.every((i) => /^Confirmação devida (desde hoje|há \d+ dias?)$/.test(i.situationLabel)));
  assert.deepEqual([d.summary.due, d.summary.scheduled, d.summary.withoutRegistration], [due.length, 1, noRegistration.length]);

  // Cada pendência uma vez, com pedido, posição, colaborador, matrícula, cliente/unidade, cargo e admissão.
  assert.equal(new Set(items.map((i) => i.positionId)).size, items.length);
  const g = d.groups[0];
  for (const key of ['orderNumber', 'client', 'unit', 'jobRole']) assert.ok(g[key], key);
  for (const key of ['position', 'employeeName', 'admissionAt']) assert.ok(g.items[0][key], key);

  assert.equal((await (await as('comercial')).get(PATH)).status, 403);
  assert.equal((await (await as('admin')).get(PATH)).status, 200);
});

test('lembrete consolidado: um por NACC, enquanto houver pendência, na periodicidade configurada', async () => {
  await runDailyJob();
  const naccs = await query(
    "SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.active = 1 AND r.role = 'NACC'");
  for (const { email } of naccs) assert.equal((await reminders(email)).length, 1, email);
  const notice = await queryOne("SELECT entity_id, message FROM notifications WHERE type = 'FIRST_DAY_PENDING' LIMIT 1");
  assert.equal(notice.entity_id, null);
  assert.match(notice.message, /confirmaç(ão|ões) devida/);
  assert.match(notice.message, /não é falta do colaborador/);

  const [mail] = await reminders();
  assert.match(mail.subject, /\[Controle de Vagas\] Confirmações do 1º dia pendentes — \d+ confirmaç/);
  for (const text of ['Consultar confirmações pendentes', '#/confirmacoes-1o-dia', 'Aguardando matrícula do RH ou DP',
    'Início previsto para', 'Confirmação devida', 'não uma falta do colaborador', 'Pedido ']) {
    assert.ok(mail.html_body.includes(text), text);
  }
  assert.ok(REMINDER_MAX_ROWS >= 100);

  // A rotina rodada de novo no mesmo dia não repete.
  await runDailyJob();
  assert.equal((await reminders()).length, 1);
  const run = await queryOne("SELECT summary FROM job_runs WHERE job_name = 'DAILY' AND run_date = ?", today);
  assert.match(run.summary, /Lembrete do 1º dia: \d+ destinatário/);

  // Com o último lembrete há dias, sai outro; com o parâmetro em 0, nenhum.
  await execute("UPDATE notifications SET created_at = ? WHERE type = 'FIRST_DAY_PENDING'", `${addDays(today, -10)}T10:00:00.000Z`);
  await setParam('0');
  await runDailyJob();
  assert.equal((await reminders()).length, 1, 'desligado');
  await setParam('1');
  await runDailyJob();
  assert.equal((await reminders()).length, 2, 'novo lembrete enquanto houver pendência');
});

test('confirmado ou com "não compareceu", o colaborador sai da lista; o histórico fica', async () => {
  const d = await pendingOf();
  const [first, second] = d.groups.flatMap((g) => g.items).filter((i) => i.situation === 'DUE');
  const nacc = await as('nacc');
  const form = new FormData();
  form.set('date', first.admissionAt);
  form.set('justification', 'Cliente confirmou o início por e-mail.');
  assert.equal((await nacc.request('POST', `/api/positions/${first.positionId}/first-day`, undefined, { form })).status, 200);
  const rh = await as('gestor.rh');
  if (second) assert.equal((await rh.post(`/api/positions/${second.positionId}/admission-no-show`, { justification: null })).status, 200);

  const after = (await pendingOf()).groups.flatMap((g) => g.items).map((i) => i.positionId);
  assert.ok(!after.includes(first.positionId), 'confirmado sai');
  if (second) assert.ok(!after.includes(second.positionId), 'não compareceu sai');
  assert.ok((await query("SELECT 1 FROM audit_logs WHERE entity_id = ? AND action = 'CONFIRM_FIRST_DAY'", first.positionId)).length);
});

test('"Aguardando 1º dia" parada não gera mais o alerta de parada: vai no lembrete', async () => {
  const [p] = (await pendingOf()).groups.flatMap((g) => g.items);
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', `${addDays(today, -10)}T10:00:00.000Z`, p.positionId);
  await runDailyJob();
  assert.equal((await query("SELECT 1 FROM position_alerts WHERE position_id = ? AND kind = 'STALE'", p.positionId)).length, 0);
});

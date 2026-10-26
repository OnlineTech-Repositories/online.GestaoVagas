import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { runAdmissionsDigest } from '../src/services/admissions-pending.js';
import { runDailyJob } from '../src/services/jobs.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Perfil "Responsável por Admissões" e admissões pendentes (melhoria de 26/10/2026): só ele registra admissões
 * (individuais e em lote), em qualquer pedido, e cuida da matrícula e do "não compareceu"; não seleciona candidatos
 * nem confirma o 1º dia. Relação por pedido, aviso a cada nova seleção e resumo diário enquanto houver pendência.
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

const PATH = '/api/positions/admissions-pending';
const pending = async () => (await (await as('admissoes')).get(PATH)).data;
const recruiting = (limit) => query(
  "SELECT p.id FROM positions p JOIN orders o ON o.id = p.order_id WHERE p.status = 'RECRUITING' AND o.approval_status = 'APPROVED' LIMIT ?", limit);
const select = async (id, name, phone = '(11) 97777-0000') => {
  const r = await (await as('gestor.rh')).post(`/api/positions/${id}/candidate-approval`, { date: addDays(today, -2), fullName: name, phone, sex: 'FEMALE' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data;
};

test('nova seleção: aviso aos Responsáveis por Admissões (sino e e-mail) e a pendência entra na relação', async () => {
  const [{ id }] = await recruiting(1);
  await select(id, 'Helena Admitir Agora', '(21) 99876-5432');
  const [admissoes] = await query("SELECT id FROM users WHERE email = 'admissoes@demo.local'");
  const notice = await queryOne("SELECT entity_id, message FROM notifications WHERE type = 'ADMISSION_PENDING' AND user_id = ?", admissoes.id);
  assert.equal(notice.entity_id, id);
  assert.match(notice.message, /Helena Admitir Agora foi selecionado\(a\) e aguarda o registro da admissão/);
  const mail = await queryOne("SELECT subject, html_body FROM email_messages WHERE to_address = 'admissoes@demo.local' AND subject LIKE '%aguardando admissão%'");
  assert.match(mail.subject, /Candidato aguardando admissão · Pedido \d+ · posição/);
  for (const text of ['Helena Admitir Agora', '(21) 99876-5432', 'Registrar admissão']) assert.ok(mail.html_body.includes(text), text);
  assert.equal((await query("SELECT 1 FROM notifications n JOIN users u ON u.id = n.user_id WHERE n.type = 'ADMISSION_PENDING' AND u.email = 'rh@demo.local'")).length, 0,
    'o RH não recebe');

  const d = await pending();
  const item = d.groups.flatMap((g) => g.items).find((i) => i.positionId === id);
  assert.deepEqual([item.candidateName, item.phone, item.selectedAt, item.waitingDays, item.waitingLabel],
    ['Helena Admitir Agora', '(21) 99876-5432', addDays(today, -2), 2, '2 dias']);
  assert.ok(['Vaga nova', 'Reposição'].includes(item.kind));
  const g = d.groups.find((x) => x.items.includes(item));
  for (const key of ['orderNumber', 'client', 'unit', 'jobRole']) assert.ok(g[key], key);
  assert.equal(d.summary.total, d.groups.flatMap((x) => x.items).length);

  assert.equal((await (await as('comercial')).get(PATH)).status, 403);
  assert.equal((await (await as('gestor.rh')).get(PATH)).status, 200, 'o Gestor de RH acompanha');
});

test('permissões: só o Responsável por Admissões admite, em qualquer pedido; não seleciona nem confirma o 1º dia', async () => {
  const [{ id }] = await recruiting(1);
  await select(id, 'Iara Permissoes');
  const docs = { date: today, registration: null, birthDate: '1993-02-02', cpf: '111.444.777-35' };
  for (const user of ['rh', 'gestor.rh', 'nacc']) {
    assert.equal((await (await as(user)).post(`/api/positions/${id}/admission`, docs)).status, 403, user);
  }
  const adm = await as('admissoes');
  const [{ id: other }] = await recruiting(1);
  assert.equal((await adm.post(`/api/positions/${other}/candidate-approval`, { date: today, fullName: 'X', phone: '(11) 91111-1111', sex: 'MALE' })).status, 403,
    'não seleciona candidato');

  const admitted = await adm.post(`/api/positions/${id}/admission`, docs);
  assert.equal(admitted.status, 200, JSON.stringify(admitted.data));
  assert.equal(admitted.data.summary.status, 'IN_ADMISSION');
  assert.equal((await adm.post(`/api/positions/${id}/admission`, docs)).status, 422, 'sem admissão duplicada');
  // Matrícula informada depois é do perfil; quem registrou e quando ficam no histórico.
  const registered = await adm.put(`/api/positions/${id}/admission-registration`, { registration: 'ADM-77', justification: null });
  assert.equal(registered.status, 200, JSON.stringify(registered.data));
  assert.ok(!registered.data.allowedActions.includes('CONFIRM_FIRST_DAY'), 'não confirma o 1º dia');
  const log = await queryOne(
    "SELECT a.user_id, a.occurred_at FROM audit_logs a JOIN users u ON u.id = a.user_id WHERE a.entity_id = ? AND a.action = 'REGISTER_ADMISSION' AND u.email = 'admissoes@demo.local' LIMIT 1", id);
  assert.ok(log?.occurred_at, 'registro com o usuário, a data e o horário');

  // Admitido, sai da relação.
  assert.ok(!(await pending()).groups.flatMap((g) => g.items).some((i) => i.positionId === id));
});

test('desistência: a seleção cancelada sai da relação', async () => {
  const [{ id }] = await recruiting(1);
  await select(id, 'Jade Desistiu');
  assert.ok((await pending()).groups.flatMap((g) => g.items).some((i) => i.positionId === id));
  await (await as('gestor.rh')).post(`/api/positions/${id}/candidate-withdrawal`, { justification: null });
  assert.ok(!(await pending()).groups.flatMap((g) => g.items).some((i) => i.positionId === id));
});

test('resumo diário: um por destinatário e por dia, com a relação por pedido; horário configurável', async () => {
  const sent = await runAdmissionsDigest(today);
  assert.ok(sent >= 1);
  const mails = await query("SELECT to_address, subject, html_body FROM email_messages WHERE subject LIKE '%Admissões pendentes de%'");
  assert.deepEqual(mails.map((m) => m.to_address).sort(),
    (await query("SELECT DISTINCT u.email FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.active = 1 AND r.role = 'ADMISSIONS'")).map((r) => r.email).sort());
  for (const text of ['Consultar admissões pendentes', '#/admissoes-pendentes', 'Maior espera', 'Pedido ']) {
    assert.ok(mails[0].html_body.includes(text), text);
  }
  assert.equal(await runAdmissionsDigest(today), 0, 'não repete no dia');
  assert.equal((await query("SELECT 1 FROM email_messages WHERE subject LIKE '%Admissões pendentes de%'")).length, mails.length);

  const admin = await as('admin');
  assert.equal((await admin.put('/api/parameters/ADMISSIONS_DIGEST_TIME', { value: '25:00' })).status, 422);
  assert.equal((await admin.put('/api/parameters/ADMISSIONS_DIGEST_TIME', { value: '08:30' })).status, 200);
});

test('"Candidato selecionado" parado vai no resumo das admissões, não no alerta de parada', async () => {
  const [p] = (await pending()).groups.flatMap((g) => g.items);
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', `${addDays(today, -10)}T10:00:00.000Z`, p.positionId);
  await runDailyJob();
  assert.equal((await query("SELECT 1 FROM position_alerts WHERE position_id = ? AND kind = 'STALE'", p.positionId)).length, 0);
});

import { DEMO_PASSWORD } from './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../src/config.js';
import { execute, query, queryOne } from '../src/db/index.js';
import { getPosition } from '../src/db/repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { ConflictError } from '../src/domain/errors.js';
import { runDailyJob } from '../src/services/jobs.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * A API de ponta a ponta, pelo HTTP real e com o banco real (SQLite por padrão; PostgreSQL com DB_DRIVER=postgres):
 * segurança, o fluxo completo de uma vaga, evidência, auditoria, concorrência e as proteções do banco.
 */

let server;
const clients = new Map();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

/** Um login por usuário (o limite é de 10 logins por minuto por IP). */
async function as(email) {
  if (clients.has(email)) return clients.get(email);
  const c = new Client(server.url);
  const r = await c.login(email, DEMO_PASSWORD);
  assert.equal(r.status, 200, `login de ${email}: ${JSON.stringify(r.data)}`);
  clients.set(email, c);
  return c;
}

const today = todayDate();

test('saúde, sessão obrigatória e cookies protegidos', async () => {
  const anonymous = new Client(server.url);
  const health = await anonymous.get('/api/saude');
  assert.equal(health.status, 200);
  assert.equal(health.data.status, 'ok');
  assert.ok(anonymous.jar.has('XSRF-TOKEN'), 'o GET em /api emite o token CSRF');
  assert.equal((await anonymous.get('/api/positions')).status, 401);

  const res = await fetch(`${server.url}/api/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: 'nacc@demo.local', password: DEMO_PASSWORD }),
  });
  const session = res.headers.getSetCookie().find((c) => c.startsWith('vagas.session='));
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Strict/);
});

test('escrita sem o token CSRF é recusada', async () => {
  const c = await as('comercial@demo.local');
  const r = await c.request('POST', '/api/notifications/read-all', {}, { headers: { 'X-XSRF-TOKEN': 'outro' } });
  assert.equal(r.status, 400);
  assert.match(r.data.detail, /token de segurança/);
});

test('senha errada 5 vezes bloqueia a conta por 15 minutos', async () => {
  const c = new Client(server.url);
  await c.get('/api/saude');
  for (let i = 1; i <= 4; i += 1) {
    const r = await c.post('/api/auth/login', { email: 'gestor@demo.local', password: 'errada' });
    assert.equal(r.data.detail, 'E-mail ou senha inválidos.');
  }
  const fifth = await c.post('/api/auth/login', { email: 'gestor@demo.local', password: 'errada' });
  assert.match(fifth.data.detail, /bloqueado temporariamente/);
  const right = await c.post('/api/auth/login', { email: 'gestor@demo.local', password: DEMO_PASSWORD });
  assert.equal(right.status, 401, 'bloqueado mesmo com a senha certa');
  await execute('UPDATE users SET lockout_end = NULL, failed_attempts = 0 WHERE email = ?', 'gestor@demo.local');
});

test('usuário com senha provisória só troca a senha', async () => {
  const admin = await as('admin@demo.local');
  const created = await admin.post('/api/users', {
    name: 'Nova Pessoa', email: 'Nova.Pessoa@Teste.Local', roles: ['NACC'], temporaryPassword: 'fraca',
  });
  assert.equal(created.status, 422);
  assert.ok(created.data.campos.temporaryPassword);

  const ok = await admin.post('/api/users', {
    name: 'Nova Pessoa', email: 'Nova.Pessoa@Teste.Local', roles: ['NACC'], temporaryPassword: 'Provisoria-1',
  });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.email, 'nova.pessoa@teste.local');
  assert.equal(ok.data.mustChangePassword, true);

  const c = new Client(server.url);
  assert.equal((await c.login('nova.pessoa@teste.local', 'Provisoria-1')).status, 200);
  const blocked = await c.get('/api/orders');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.title, 'Troca de senha obrigatória');
  const wrong = await c.post('/api/auth/change-password', { currentPassword: 'x', newPassword: 'Definitiva-2' });
  assert.equal(wrong.data.campos.currentPassword, 'A senha atual está incorreta.');
  const changed = await c.post('/api/auth/change-password', { currentPassword: 'Provisoria-1', newPassword: 'Definitiva-2' });
  assert.equal(changed.status, 200);
  assert.equal(changed.data.mustChangePassword, false);
  assert.equal((await c.get('/api/orders')).status, 200);

  // Inativado pelo administrador: perde a sessão na requisição seguinte.
  const updated = await admin.put(`/api/users/${ok.data.id}`, {
    name: 'Nova Pessoa', email: 'nova.pessoa@teste.local', roles: ['NACC'], active: false,
  });
  assert.equal(updated.status, 200);
  assert.equal((await c.get('/api/orders')).status, 401);
});

test('fluxo completo: pedido, aprovação, RH, candidato, admissão, 1º dia com evidência e reposição', async () => {
  const comercial = await as('comercial@demo.local');
  const gestorRh = await as('gestor.rh@demo.local');
  const rh = await as('rh@demo.local');
  const nacc = await as('nacc@demo.local');
  const dp = await as('dp@demo.local');

  // Pedido: aguarda a aprovação do cliente; número sequencial.
  const contracts = (await comercial.get('/api/contracts?onlyActive=true')).data;
  const contract = contracts.find((c) => c.modalities.includes('MOT'));
  const roles = (await comercial.get(`/api/orders/job-roles?contractId=${contract.id}`)).data;
  const before = await queryOne('SELECT MAX(number) AS n FROM orders');
  const invalid = await comercial.post('/api/orders', { contractId: contract.id });
  assert.equal(invalid.status, 400);
  assert.ok(invalid.data.campos.modality && invalid.data.campos.quantity, 'acumula os campos recusados');

  const created = await comercial.post('/api/orders', {
    contractId: contract.id, modality: 'MOT', jobRoleId: roles[0].id, quantity: 2,
    workLocationId: contract.contractingUnitId, clientRequestDate: addDays(today, -3), desiredStartDate: addDays(today, -1),
    termType: 'INDEFINITE', jobDescription: 'Linha 1\r\nLinha 2',
  });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  const order = created.data;
  assert.equal(order.summary.number, Number(before.n) + 1);
  assert.equal(order.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
  assert.equal(order.jobDescription, 'Linha 1\nLinha 2');
  assert.equal(order.slots.length, 2);
  const orderId = order.summary.id;

  // Gestor de RH distribui; o RH publica; o Comercial aprova.
  const analysts = (await gestorRh.get('/api/users/by-role/RH')).data;
  const rita = analysts.find((a) => a.name.startsWith('Rita'));
  assert.equal((await gestorRh.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [rita.id] })).status, 200);
  const published = await rh.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-T1', publishedAt: today });
  assert.equal(published.status, 200, JSON.stringify(published.data));
  assert.ok(published.data.positions.every((p) => p.status === 'RECRUITING'));
  const approved = await comercial.post(`/api/orders/${orderId}/approval`, { date: today });
  assert.equal(approved.data.summary.approvalStatus, 'APPROVED');
  const positionId = approved.data.positions[0].id;
  assert.equal(approved.data.positions[0].openedAt, today);

  // Candidato, admissão com matrícula.
  const cpfInUse = await rh.post(`/api/positions/${positionId}/candidate-approval`, {
    date: today, fullName: 'Fulano de Tal', birthDate: '1990-05-05', sex: 'MALE', cpf: '529.982.247-24',
  });
  assert.equal(cpfInUse.status, 422);
  assert.equal(cpfInUse.data.campos.cpf, 'CPF inválido: confira os dígitos.');
  const withCandidate = await rh.post(`/api/positions/${positionId}/candidate-approval`, {
    date: today, fullName: 'Fulano de Tal', birthDate: '1990-05-05', sex: 'MALE', cpf: '529.982.247-25',
  });
  assert.equal(withCandidate.data.summary.status, 'CANDIDATE_APPROVED');
  assert.equal(withCandidate.data.candidate.cpf, '529.982.247-25');
  const admitted = await rh.post(`/api/positions/${positionId}/admission`, { date: today, registration: 'MAT-900' });
  assert.equal(admitted.data.summary.status, 'AWAITING_FIRST_DAY');

  // O Comercial vê o candidato mascarado (LGPD).
  const masked = await comercial.get(`/api/positions/${positionId}`);
  assert.equal(masked.data.candidate.cpf, '***.982.247-**');
  assert.equal(masked.data.candidate.birthDate, null);

  // 1º dia com evidência (multipart): o NACC confirma; o download fica restrito.
  const form = new FormData();
  form.set('date', today);
  form.set('justification', 'Cliente confirmou por e-mail.');
  form.set('evidence', new Blob([Buffer.from('%PDF-1.7 teste')], { type: 'application/pdf' }), 'presenca.pdf');
  const filled = await nacc.request('POST', `/api/positions/${positionId}/first-day`, undefined, { form });
  assert.equal(filled.status, 200, JSON.stringify(filled.data));
  assert.equal(filled.data.summary.status, 'FILLED');
  assert.equal(filled.data.employeeName, 'Fulano de Tal');
  assert.equal(filled.data.employeeRegistration, 'MAT-900');
  const evidence = filled.data.firstDay.evidence;
  assert.equal(evidence.fileName, 'presenca.pdf');
  const download = await nacc.get(`/api/positions/${positionId}/evidences/${evidence.id}`);
  assert.equal(download.status, 200);
  assert.match(download.headers.get('content-disposition'), /presenca\.pdf/);
  assert.equal((await comercial.get(`/api/positions/${positionId}/evidences/${evidence.id}`)).status, 403);

  // Histórico: cada etapa no log de auditoria, com quem fez.
  const history = filled.data.history;
  for (const action of ['APPROVE_CANDIDATE', 'REGISTER_ADMISSION', 'CONFIRM_FIRST_DAY']) {
    assert.ok(history.some((h) => h.action === action), `histórico com ${action}`);
  }
  assert.ok(history.some((h) => h.field === 'Status' && h.newValue === 'FILLED' && h.userName.startsWith('Nina')));

  // Desligamento: a reposição é o ciclo 2 da mesma vaga; o NACC confirma e ela herda a publicação.
  const search = await dp.get('/api/terminations/filled-positions?term=Fulano');
  assert.equal(search.data[0].positionId, positionId);
  const terminated = await dp.post('/api/terminations', {
    originPositionId: positionId, lastWorkedDay: today, source: 'DP', terminationType: 'RESIGNATION',
  });
  assert.equal(terminated.status, 200, JSON.stringify(terminated.data));
  const duplicate = await dp.post('/api/terminations', {
    originPositionId: positionId, lastWorkedDay: today, source: 'DP', terminationType: 'RESIGNATION',
  });
  assert.equal(duplicate.data.detail, 'Já existe um desligamento registrado para esta posição.');
  const decided = await nacc.post(`/api/positions/${terminated.data.replacementPositionId}/decision`, {
    decision: 'REPLACE', decisionAt: today,
  });
  assert.equal(decided.data.summary.status, 'RECRUITING');
  assert.deepEqual([decided.data.summary.slotNumber, decided.data.summary.cycle], [1, 2]);

  const detail = (await comercial.get(`/api/orders/${orderId}`)).data;
  const slot = detail.slots.find((s) => s.number === 1);
  assert.equal(slot.current.id, terminated.data.replacementPositionId);
  assert.equal(slot.occupants.length, 2);
  assert.equal(slot.occupants[0].replacedByPositionId, terminated.data.replacementPositionId);
});

test('duas gravações sobre a mesma posição: a segunda recebe 409 em vez de apagar a primeira', async () => {
  const row = await queryOne("SELECT id FROM positions WHERE status = 'RECRUITING' LIMIT 1");
  const first = new UnitOfWork({});
  const second = new UnitOfWork({});
  const a = await getPosition(first, row.id);
  const b = await getPosition(second, row.id);
  a.hasRetroactiveDates = true;
  b.termAdjustJustification = 'Outra alteração';
  await first.save({ action: 'TESTE' });
  await assert.rejects(second.save({ action: 'TESTE' }), ConflictError);
});

test('o banco recusa exclusão física e alteração do log de auditoria (RN-26)', async () => {
  await assert.rejects(execute('DELETE FROM positions WHERE id IN (SELECT id FROM positions LIMIT 1)'));
  await assert.rejects(execute("UPDATE audit_logs SET action = 'X' WHERE id IN (SELECT id FROM audit_logs LIMIT 1)"));
  await assert.rejects(execute('DELETE FROM audit_logs'));
});

test('a rotina diária encerra a vigência vencida uma vez só', async () => {
  const expired = await query(
    `SELECT id FROM positions WHERE term_type = 'FIXED_END' AND term_end_date < ? AND status NOT IN ('FILLED',
      'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED')`, today);
  assert.ok(expired.length > 0, 'os dados de demonstração têm vigência vencida');
  await runDailyJob();
  const closed = await queryOne('SELECT status, closed_at FROM positions WHERE id = ?', expired[0].id);
  assert.equal(closed.status, 'CLOSED_CONTRACT_ENDED');
  const notified = await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE type = 'CONTRACT_ENDED'");
  await runDailyJob();
  const again = await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE type = 'CONTRACT_ENDED'");
  assert.equal(Number(again.n), Number(notified.n), 'a segunda execução não notifica de novo');
});

test('mais de 10 logins por minuto do mesmo IP recebem 429', async () => {
  config.loginRateLimitPerMinute = 10;
  const c = new Client(server.url);
  await c.get('/api/saude');
  let status = 0;
  for (let i = 0; i < 12 && status !== 429; i += 1) {
    status = (await c.post('/api/auth/login', { email: 'ninguem@teste.local', password: 'x' })).status;
  }
  assert.equal(status, 429);
});

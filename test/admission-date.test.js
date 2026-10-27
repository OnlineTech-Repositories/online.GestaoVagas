import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Nova data de admissão antes do 1º dia (melhoria de 27/10/2026): qualquer Responsável por Admissões, o NACC e o ADMIN
 * corrigem, com justificativa; o candidato continua na posição e a equipe de Admissões é avisada. Antes, o NACC só
 * tinha o "Não compareceu", que tira o candidato e devolve a vaga ao recrutamento.
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

/** Posição em recrutamento de pedido aprovado, com candidato selecionado e admissão registrada. */
async function admitted(name, cpf) {
  const { id } = await queryOne(
    "SELECT p.id FROM positions p JOIN orders o ON o.id = p.order_id WHERE p.status = 'RECRUITING' AND o.approval_status = 'APPROVED' LIMIT 1");
  const selected = await (await as('gestor.rh')).post(`/api/positions/${id}/candidate-approval`,
    { date: addDays(today, -3), fullName: name, phone: '(71) 99700-6994', sex: 'MALE' });
  assert.equal(selected.status, 200, JSON.stringify(selected.data));
  const done = await (await as('admissoes')).post(`/api/positions/${id}/admission`,
    { date: today, registration: 'MAT-1', birthDate: '2001-01-09', cpf });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  return id;
}

test('o NACC corrige a data de admissão: o candidato continua, o 1º dia acompanha e Admissões é avisada', async () => {
  const id = await admitted('Jorge Nova Data', '105.239.415-95');
  const nacc = await as('nacc');
  const path = `/api/positions/${id}/admission-date`;
  assert.ok((await nacc.get(`/api/positions/${id}`)).data.allowedActions.includes('CORRECT_ADMISSION_DATE'));
  assert.ok(!(await (await as('rh')).get(`/api/positions/${id}`)).data.allowedActions.includes('CORRECT_ADMISSION_DATE'));
  assert.equal((await (await as('rh')).put(path, { date: addDays(today, 2), justification: 'x' })).status, 403);

  assert.ok((await nacc.put(path, { date: addDays(today, 2), justification: '' })).data.campos?.justification, 'justificativa obrigatória');
  assert.ok((await nacc.put(path, { date: today, justification: 'Mesma data.' })).data.campos?.date, 'a mesma data é recusada');

  const newDate = addDays(today, 2);
  const corrected = await nacc.put(path, { date: newDate, justification: 'Cliente adiou o início para quinta.' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  const p = await queryOne('SELECT status, admission_at, admission_registration FROM positions WHERE id = ?', id);
  assert.deepEqual([p.status, p.admission_at, p.admission_registration], ['AWAITING_FIRST_DAY', newDate, 'MAT-1']);
  assert.equal((await query('SELECT 1 FROM candidates WHERE position_id = ? AND withdrawn_at IS NULL', id)).length, 1, 'o candidato continua');

  const notice = await queryOne(
    `SELECT n.message FROM notifications n JOIN users u ON u.id = n.user_id
      WHERE n.type = 'ADMISSION_DATE_CORRECTED' AND n.entity_id = ? AND u.email = 'admissoes@demo.local'`, id);
  assert.match(notice.message, /Jorge Nova Data.*passou de .* para .*Motivo: Cliente adiou o início para quinta\./);
  const log = await queryOne("SELECT justification FROM audit_logs WHERE entity_id = ? AND action = 'CORRECT_ADMISSION_DATE' LIMIT 1", id);
  assert.equal(log.justification, 'Cliente adiou o início para quinta.');

  // A relação do NACC acompanha a nova data.
  const pending = (await nacc.get('/api/positions/first-day-pending')).data;
  const items = [...(pending.groups ?? []).flatMap((g) => g.items ?? []), ...(pending.withoutRegistration ?? [])];
  const item = items.find((i) => i.positionId === id);
  assert.deepEqual([item.admissionAt, item.situationLabel], [newDate, `Início previsto para ${newDate.split('-').reverse().join('/')}`]);
});

test('qualquer Responsável por Admissões corrige, mesmo sem ter registrado a admissão', async () => {
  const id = await admitted('Outro Admitido', '529.982.247-25');
  // "todos" tem o perfil de Admissões e não registrou esta admissão (foi admissoes@demo.local).
  const corrected = await (await as('todos')).put(`/api/positions/${id}/admission-date`,
    { date: addDays(today, 5), justification: 'Exame admissional remarcado.' });
  assert.equal(corrected.status, 200, JSON.stringify(corrected.data));
  assert.equal((await queryOne('SELECT admission_at FROM positions WHERE id = ?', id)).admission_at, addDays(today, 5));
  // Quem corrigiu não recebe o próprio aviso; o outro Responsável por Admissões recebe.
  const to = (await query(`SELECT u.email FROM notifications n JOIN users u ON u.id = n.user_id
    WHERE n.type = 'ADMISSION_DATE_CORRECTED' AND n.entity_id = ?`, id)).map((r) => r.email);
  assert.deepEqual(to, ['admissoes@demo.local']);
});

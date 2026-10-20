import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { readXlsx } from '../src/services/xlsx-reader.js';
import { generateXlsx } from '../src/services/xlsx.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Admissões em lote por planilha (melhoria de 19/10/2026): modelo com as posições "Candidato selecionado", conferência
 * com erro por linha e campo e avisos de data, bloqueio enquanto houver erro, linha em branco ignorada, gravação pela
 * mesma regra do registro individual, um aviso ao NACC por importação e nenhuma duplicidade ao reenviar o arquivo.
 */

let server;
const clients = new Map();
const today = todayDate();
let order;
let rows;

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

const cookie = (c) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');
const base = () => `/api/orders/${order.summary.id}`;

async function download(user, path) {
  const res = await fetch(server.url + path, { headers: { Cookie: cookie(await as(user)) } });
  return { status: res.status, headers: res.headers, buffer: Buffer.from(await res.arrayBuffer()) };
}

async function upload(user, path, buffer) {
  const form = new FormData();
  form.append('file', new Blob([buffer]), 'admissoes.xlsx');
  return (await as(user)).request('POST', path, undefined, { form });
}

function cpf(base9) {
  const check = (digits) => {
    const rest = [...digits].reduce((s, c, i) => s + Number(c) * (digits.length + 1 - i), 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = check(base9);
  return base9 + first + check(base9 + first);
}

const KEYS = ['order', 'position', 'candidate', 'admissionAt', 'registration', 'justification', 'positionId', 'candidateId', 'orderId'];
const TITLES = ['Pedido', 'Vaga', 'Candidato', 'Data da admissão *', 'Matrícula', 'Justificativa', 'ID da posição (não alterar)',
  'ID do candidato (não alterar)', 'ID do pedido (não alterar)'];

const templateRows = (buffer) => readXlsx(buffer)[0].rows.slice(1)
  .map((cells) => Object.fromEntries(KEYS.map((k, i) => [k, cells[i] ?? null]))).filter((r) => r.positionId);

/** Planilha preenchida com as colunas do modelo (a matrícula como texto, como o modelo formata a coluna). */
const filled = (list) => generateXlsx([{
  name: 'Admissões',
  columns: TITLES.map((title, i) => ({ key: `c${i}`, title, type: i === 3 ? 'date' : undefined, editable: i === 4 })),
  rows: list.map((r) => Object.fromEntries(KEYS.map((k, i) => [`c${i}`, r[k]]))),
}]);

test('modelo: uma linha por posição com candidato selecionado, com pedido, vaga e candidato preenchidos', async () => {
  const grh = await as('gestor.rh');
  const { data: orders } = await grh.get('/api/orders');
  for (const o of orders.items ?? orders) {
    const detail = (await grh.get(`/api/orders/${o.id}`)).data;
    if (detail.candidateImport?.pending >= 3) {
      order = detail;
      break;
    }
  }
  assert.ok(order, 'a demonstração tem um pedido com ao menos 3 posições em recrutamento');
  // Três candidatos selecionados pelo registro individual.
  const recruiting = order.positions.filter((p) => p.status === 'RECRUITING').slice(0, 3);
  for (const [i, p] of recruiting.entries()) {
    const r = await grh.post(`/api/positions/${p.id}/candidate-approval`, {
      date: addDays(today, -2), fullName: `Admitido ${i + 1}`, birthDate: '1990-01-01', sex: 'FEMALE', cpf: cpf(`70011122${i}`),
    });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
  order = (await grh.get(base())).data;
  assert.ok(order.admissionImport.pending >= 3);

  const res = await download('gestor.rh', `${base()}/admissions-template`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`admissoes-pedido-${order.summary.number}\\.xlsx`));
  rows = templateRows(res.buffer);
  assert.equal(rows.length, order.admissionImport.pending);
  const names = rows.map((r) => r.candidate);
  for (const i of [1, 2, 3]) assert.ok(names.includes(`Admitido ${i}`), `candidato ${i} no modelo`);
  assert.deepEqual(readXlsx(res.buffer).map((s) => s.name), ['Admissões', 'Orientações']);
});

test('só o RH do pedido baixa o modelo e importa; a tela do Comercial não mostra a importação', async () => {
  assert.equal((await download('comercial', `${base()}/admissions-template`)).status, 403);
  assert.equal((await upload('comercial', `${base()}/admissions-import/preview`, Buffer.from('x'))).status, 403);
  assert.equal((await (await as('comercial')).get(base())).data.admissionImport, null);
});

const mine = () => rows.filter((r) => /^Admitido [123]$/.test(r.candidate)).sort((a, b) => a.candidate.localeCompare(b.candidate));

test('conferência: erro por linha e campo, linha em branco ignorada e nada gravado enquanto houver erro', async () => {
  const [a, b, c] = mine();
  const sheet = filled([
    { ...a, admissionAt: today, registration: '000123' },
    { ...b },
    { ...c, admissionAt: '31/02/2026', registration: 'X'.repeat(60) },
  ]);
  const r = await upload('gestor.rh', `${base()}/admissions-import/preview`, sheet);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const byName = Object.fromEntries(r.data.rows.map((row) => [row.candidate, row]));
  assert.equal(byName['Admitido 1'].status, 'ready');
  assert.equal(byName['Admitido 1'].registration, '000123', 'zeros à esquerda preservados');
  assert.equal(byName['Admitido 2'].status, 'blank');
  const bad = byName['Admitido 3'];
  assert.equal(bad.status, 'error');
  const fields = Object.fromEntries(bad.errors.map((e) => [e.field, e.message]));
  assert.match(fields.admissionAt, /Data inválida/);
  assert.match(fields.registration, /no máximo 50 caracteres/);
  assert.equal(r.data.summary.canConfirm, false);

  const blocked = await upload('gestor.rh', `${base()}/admissions-import`, sheet);
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.detail, /nada foi gravado/);
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', a.positionId)).status, 'CANDIDATE_APPROVED');
});

test('confirmação: grava com a regra individual, avisa datas fora do esperado, um aviso ao NACC e sem duplicar no reenvio', async () => {
  const [a, b, c] = mine();
  const sheet = filled([
    { ...a, admissionAt: today, registration: '000123' },
    { ...b, admissionAt: addDays(today, 5) },
    { ...c },
  ]);
  const preview = await upload('gestor.rh', `${base()}/admissions-import/preview`, sheet);
  const future = preview.data.rows.find((row) => row.candidate === 'Admitido 2');
  assert.equal(future.status, 'ready', 'data futura não impede');
  assert.ok(future.warnings.some((w) => /é uma data futura/.test(w)), future.warnings.join(' | '));
  assert.equal(preview.data.summary.warnings, 1);

  const before = Number((await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE type = 'ADMISSION_REGISTERED'")).n);
  const done = await upload('gestor.rh', `${base()}/admissions-import`, sheet);
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.deepEqual([done.data.imported, done.data.awaitingFirstDay, done.data.withoutRegistration], [2, 1, 1]);

  const status = async (row) => ({ ...(await queryOne('SELECT status, admission_at, admission_registration FROM positions WHERE id = ?', row.positionId)) });
  assert.deepEqual(await status(a), { status: 'AWAITING_FIRST_DAY', admission_at: today, admission_registration: '000123' });
  assert.deepEqual(await status(b), { status: 'IN_ADMISSION', admission_at: addDays(today, 5), admission_registration: null });
  assert.equal((await status(c)).status, 'CANDIDATE_APPROVED', 'linha em branco: a posição segue aguardando');

  // Histórico de cada posição e o registro da importação (quem, quando, arquivo e admissões).
  assert.ok((await query("SELECT 1 FROM audit_logs WHERE entity_id = ? AND action = 'IMPORT_ADMISSIONS'", a.positionId)).length);
  const summary = await queryOne(
    "SELECT user_id, occurred_at, new_value FROM audit_logs WHERE entity_id = ? AND action = 'IMPORT_ADMISSIONS' AND field = 'Summary'",
    order.summary.id);
  assert.ok(summary.user_id && summary.occurred_at);
  assert.equal(JSON.parse(summary.new_value).imported, 2);

  // Um aviso por importação para cada destinatário (NACC, Gestor de RH e analistas do pedido), com a lista no e-mail.
  const after = Number((await queryOne("SELECT COUNT(*) AS n FROM notifications WHERE type = 'ADMISSION_REGISTERED'")).n);
  const nacc = await queryOne("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = 'nacc@demo.local' AND n.entity_id = ?", order.summary.id);
  assert.equal(Number(nacc.n), 1);
  assert.ok(after > before);
  const email = await queryOne("SELECT html_body FROM email_messages WHERE subject LIKE '%admissão(ões) registrada(s)%' LIMIT 1");
  for (const part of ['Admitido 1', '000123', 'Admitido 2', 'Não informada', 'Consultar pedido']) assert.ok(email.html_body.includes(part), part);

  // Reenviar o mesmo arquivo não duplica: as posições já admitidas viram erro.
  const again = await upload('gestor.rh', `${base()}/admissions-import/preview`, sheet);
  assert.equal(again.data.summary.errors, 2);
  assert.ok(again.data.rows.filter((row) => row.status === 'error').every((row) => /já foi registrada/.test(row.errors[0].message)));
  assert.equal((await upload('gestor.rh', `${base()}/admissions-import`, sheet)).status, 422);
});

test('carga inicial encerrada: data passada sem justificativa é erro da linha; com ela, grava e sinaliza a posição', async () => {
  const admin = await as('admin');
  assert.equal((await admin.put('/api/parameters/INITIAL_LOAD_OPEN', { value: 'false' })).status, 200);
  try {
    const [, , c] = mine();
    const missing = await upload('gestor.rh', `${base()}/admissions-import/preview`, filled([{ ...c, admissionAt: addDays(today, -1) }]));
    const row = missing.data.rows[0];
    assert.equal(row.status, 'error');
    assert.match(row.errors.find((e) => e.field === 'justification').message, /anterior a hoje: informe a justificativa/);

    const ok = await upload('gestor.rh', `${base()}/admissions-import`,
      filled([{ ...c, admissionAt: addDays(today, -1), registration: '42', justification: 'Admitido ontem; lançado hoje.' }]));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const p = await queryOne('SELECT status, has_retroactive_dates FROM positions WHERE id = ?', c.positionId);
    assert.equal(p.status, 'AWAITING_FIRST_DAY');
    assert.equal(Number(p.has_retroactive_dates), 1);
  } finally {
    await admin.put('/api/parameters/INITIAL_LOAD_OPEN', { value: 'true' });
  }
});

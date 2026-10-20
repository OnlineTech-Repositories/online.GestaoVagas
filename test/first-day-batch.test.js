import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * 1º dia efetivo em lote pelo NACC (melhoria de 19/10/2026): só as posições marcadas são confirmadas, as demais
 * seguem pendentes; conferência com erros e avisos de data; evidência compartilhada vinculada só às linhas indicadas
 * (gravada uma vez) e arquivo próprio por linha; com qualquer erro, nada é gravado; sem confirmação duplicada.
 */

let server;
const clients = new Map();
const today = todayDate();
let order;
let ready;

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

function cpf(base9) {
  const check = (digits) => {
    const rest = [...digits].reduce((s, c, i) => s + Number(c) * (digits.length + 1 - i), 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = check(base9);
  return base9 + first + check(base9 + first);
}

const base = () => `/api/orders/${order.summary.id}`;
const PDF = Buffer.from('%PDF-1.7 lista de presença assinada pelo cliente');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function submit(user, items, files = {}) {
  const form = new FormData();
  form.append('items', JSON.stringify(items));
  for (const [field, [buffer, name]] of Object.entries(files)) form.append(field, new Blob([buffer]), name);
  return (await as(user)).request('POST', `${base()}/first-day-batch`, undefined, { form });
}

test('o NACC vê no pedido os admitidos aguardando o 1º dia; os sem matrícula aparecem à parte; outros perfis não veem', async () => {
  const grh = await as('gestor.rh');
  const { data: orders } = await grh.get('/api/orders');
  for (const o of orders.items ?? orders) {
    const detail = (await grh.get(`/api/orders/${o.id}`)).data;
    if (detail.candidateImport?.pending >= 3) {
      order = detail;
      break;
    }
  }
  assert.ok(order, 'a demonstração tem um pedido com posições em recrutamento');
  // Mais duas posições no pedido (já publicado no JobConvo: entram em recrutamento).
  const added = await (await as('comercial')).post(`${base()}/positions`, { quantity: 2, desiredStartDate: today });
  assert.equal(added.status, 200, JSON.stringify(added.data));
  order = (await grh.get(base())).data;
  const recruiting = order.positions.filter((p) => p.status === 'RECRUITING').slice(0, 4);
  for (const [i, p] of recruiting.entries()) {
    await grh.post(`/api/positions/${p.id}/candidate-approval`, {
      date: addDays(today, -6), fullName: `Colaborador ${i + 1}`, birthDate: '1991-05-05', sex: 'MALE', cpf: cpf(`90033344${i}`),
    });
    const r = await grh.post(`/api/positions/${p.id}/admission`, { date: addDays(today, -3), registration: i < 3 ? `00${i + 1}` : null });
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }

  const info = (await (await as('nacc')).get(base())).data.firstDayBatch;
  ready = info.items.filter((it) => /^Colaborador [123]$/.test(it.employeeName)).sort((a, b) => a.employeeName.localeCompare(b.employeeName));
  assert.equal(ready.length, 3);
  assert.equal(ready[0].registration, '001');
  assert.ok(info.withoutRegistration.some((w) => w.employeeName === 'Colaborador 4'), 'sem matrícula, à parte');
  assert.equal((await (await as('comercial')).get(base())).data.firstDayBatch, null);
  assert.equal((await grh.get(base())).data.firstDayBatch, null, 'a confirmação do 1º dia é do NACC');
});

test('conferência: aponta erros e avisos de data sem gravar; perfil sem permissão é recusado', async () => {
  const nacc = await as('nacc');
  const [a, b] = ready;
  const r = await nacc.post(`${base()}/first-day-batch/preview`, { items: [
    { positionId: a.positionId, date: addDays(today, 2), justification: 'Cliente confirmou.' },
    { positionId: b.positionId, date: today, justification: '' },
    { positionId: a.positionId, date: today, justification: 'Repetida.' },
  ] });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [future, noReason, repeated] = r.data.rows;
  assert.equal(future.status, 'ready');
  assert.ok(future.warnings.some((w) => /é uma data futura/.test(w)));
  assert.equal(noReason.errors[0].field, 'justification');
  assert.match(repeated.errors[0].message, /selecionada duas vezes/);
  assert.equal(r.data.summary.canConfirm, false);
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', a.positionId)).status, 'AWAITING_FIRST_DAY');

  const rh = await (await as('gestor.rh')).post(`${base()}/first-day-batch/preview`, { items: [{ positionId: a.positionId, date: today, justification: 'x' }] });
  assert.equal(rh.status, 403);
});

test('com qualquer erro nada é gravado; evidência que não é PDF/JPG/PNG também barra o lote inteiro', async () => {
  const [a, b] = ready;
  const withError = await submit('nacc', [
    { positionId: a.positionId, date: today, justification: 'Ok.' },
    { positionId: b.positionId, date: today, justification: '' },
  ]);
  assert.equal(withError.status, 422);
  assert.match(withError.data.detail, /Nada foi gravado/);

  const badFile = await submit('nacc', [
    { positionId: a.positionId, date: today, justification: 'Ok.', ownEvidence: true },
  ], { [`evidence_${a.positionId}`]: [Buffer.from('<html>não é evidência</html>'), 'x.png'] });
  assert.equal(badFile.status, 422);
  assert.match(badFile.data.detail, /PDF, JPG ou PNG/);
  for (const p of [a, b]) assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', p.positionId)).status, 'AWAITING_FIRST_DAY');
});

test('confirma só as marcadas: evidência compartilhada gravada uma vez, arquivo próprio por linha, a desmarcada segue pendente', async () => {
  const [a, b, c] = ready;
  const filesBefore = Number((await queryOne('SELECT COUNT(*) AS n FROM evidence_files')).n);
  const done = await submit('nacc', [
    { positionId: a.positionId, date: today, justification: 'Lista de presença do cliente.', sharedEvidence: true, ownEvidence: true },
    { positionId: b.positionId, date: addDays(today, -1), justification: 'Lista de presença do cliente.', sharedEvidence: true },
  ], { shared: [PDF, 'presenca.pdf'], [`evidence_${a.positionId}`]: [PNG, 'cracha.png'] });
  assert.equal(done.status, 200, JSON.stringify(done.data));
  assert.equal(done.data.confirmed, 2);

  const nacc = (await query("SELECT id FROM users WHERE email = 'nacc@demo.local'"))[0].id;
  for (const [p, day] of [[a, today], [b, addDays(today, -1)]]) {
    const row = { ...(await queryOne('SELECT status, first_day_at, first_day_confirmed_by, employee_name, employee_registration FROM positions WHERE id = ?', p.positionId)) };
    assert.deepEqual([row.status, row.first_day_at, row.first_day_confirmed_by], ['FILLED', day, nacc]);
    assert.equal(row.employee_registration, p.registration, 'matrícula da admissão, sem redigitar');
  }
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', c.positionId)).status, 'AWAITING_FIRST_DAY',
    'a desmarcada continua pendente (não vira "não compareceu")');

  const evidencesA = await query('SELECT file_name, storage_key FROM position_evidences WHERE position_id = ? ORDER BY file_name', a.positionId);
  const evidencesB = await query('SELECT file_name, storage_key FROM position_evidences WHERE position_id = ?', b.positionId);
  assert.deepEqual(evidencesA.map((e) => e.file_name), ['cracha.png', 'presenca.pdf']);
  assert.deepEqual(evidencesB.map((e) => e.file_name), ['presenca.pdf']);
  assert.equal(evidencesB[0].storage_key, evidencesA.find((e) => e.file_name === 'presenca.pdf').storage_key, 'mesmo arquivo compartilhado');
  assert.equal(Number((await queryOne('SELECT COUNT(*) AS n FROM evidence_files')).n), filesBefore + 2, 'compartilhada gravada uma vez');

  // Download da evidência compartilhada pela segunda posição.
  const detail = (await (await as('nacc')).get(`/api/positions/${b.positionId}`)).data;
  const download = await fetch(`${server.url}/api/positions/${b.positionId}/evidences/${detail.firstDay.evidence.id}`,
    { headers: { Cookie: [...(await as('nacc')).jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(download.status, 200);
  assert.equal(Buffer.from(await download.arrayBuffer()).toString(), PDF.toString());

  // Histórico: cada posição com a ação e a justificativa; o lote registrado no pedido.
  assert.ok((await query("SELECT 1 FROM audit_logs WHERE entity_id = ? AND action = 'CONFIRM_FIRST_DAY_BATCH' AND justification = 'Lista de presença do cliente.'", a.positionId)).length);
  const summary = await queryOne("SELECT new_value FROM audit_logs WHERE entity_id = ? AND action = 'CONFIRM_FIRST_DAY_BATCH' AND field = 'Summary'", order.summary.id);
  assert.equal(JSON.parse(summary.new_value).confirmed, 2);

  // Sem duplicidade: confirmar de novo a mesma posição é recusado e não grava nada.
  const again = await submit('nacc', [
    { positionId: a.positionId, date: today, justification: 'De novo.' },
    { positionId: c.positionId, date: today, justification: 'Ok.' },
  ]);
  assert.equal(again.status, 422);
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', c.positionId)).status, 'AWAITING_FIRST_DAY');
});

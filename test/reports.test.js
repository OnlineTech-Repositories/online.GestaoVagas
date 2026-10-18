import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { execute, query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Relatórios e KPIs da seção 11 (fase 3), pela API real com os dados de demonstração. Inclui os critérios de aceite
 * da fase 3: os totais do faturamento perdido batem com a soma das posições, e valores pendentes ficam fora deles.
 */

let server;
const clients = new Map();
const today = todayDate();
const YEAR = { from: addDays(today, -365), to: today };

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

const qs = (params) => `?${new URLSearchParams(params)}`;
const report = async (user, kind, params = YEAR) => {
  const r = await (await as(user)).get(`/api/reports/${kind}${qs(params)}`);
  assert.equal(r.status, 200, `${kind} (${user}): ${JSON.stringify(r.data)}`);
  return r.data;
};
const keys = (columns) => columns.map((c) => c.key);
const cents = (v) => Math.round((v ?? 0) * 100);

/** Lê as entradas de um .xlsx (ZIP) — o bastante para conferir as abas e o conteúdo. */
function unzip(buffer) {
  const files = {};
  let offset = 0;
  while (buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = buffer.readUInt32LE(offset + 18);
    const nameLength = buffer.readUInt16LE(offset + 26);
    const extra = buffer.readUInt16LE(offset + 28);
    const name = buffer.toString('utf8', offset + 30, offset + 30 + nameLength);
    const start = offset + 30 + nameLength + extra;
    files[name] = inflateRawSync(buffer.subarray(start, start + size)).toString('utf8');
    offset = start + size;
  }
  return files;
}

test('os quatro relatórios respondem com os 8 KPIs, o resumo e o detalhe', async () => {
  for (const kind of ['open', 'sla', 'loss', 'replacements']) {
    const r = await report('comercial', kind);
    assert.equal(r.kpis.length, 8, kind);
    assert.ok(r.summary.columns.length > 1 && r.detail.columns.length > 1, kind);
    assert.ok(Array.isArray(r.detail.rows), kind);
  }
  const open = await report('comercial', 'open');
  assert.ok(open.detail.rows.length > 0, 'a demonstração tem posições abertas');
  assert.equal(open.detail.rows[0].slaSituation, 'Vencido', 'as vencidas vêm primeiro');
});

test('faturamento perdido: o total bate com a soma das posições e o pendente fica de fora (aceite da fase 3)', async () => {
  // A demonstração tem um reajuste pendente, mas sem posição ligada: liga uma versão pendente a uma posição aberta.
  const target = await queryOne(
    `SELECT p.id, p.rate_id FROM positions p JOIN contract_rates r ON r.id = p.rate_id
      WHERE p.status = 'RECRUITING' AND r.status = 'VALIDATED' AND r.monthly_value IS NOT NULL LIMIT 1`);
  const rate = await queryOne('SELECT * FROM contract_rates WHERE id = ?', target.rate_id);
  const pendingId = randomUUID();
  await execute(
    `INSERT INTO contract_rates (id, contract_id, job_role_id, monthly_value, fee_value, valid_from, status, created_at, version)
     VALUES (?, ?, ?, ?, NULL, ?, 'PENDING', ?, 0)`,
    pendingId, rate.contract_id, rate.job_role_id, 3600, addDays(rate.valid_from, -1), new Date().toISOString());
  await execute('UPDATE positions SET rate_id = ? WHERE id = ?', pendingId, target.id);

  const r = await report('comercial', 'loss');
  const validated = r.detail.rows.filter((x) => x.moneyStatus === 'Validado');
  const pending = r.detail.rows.filter((x) => x.moneyStatus === 'Pendente de validação' || x.moneyStatus === 'Rejeitado');
  assert.ok(validated.length > 0 && pending.length > 0, 'a demonstração tem valores validados e pendentes');

  const sumLost = validated.reduce((s, x) => s + cents(x.lost), 0);
  const total = r.summary.rows.find((x) => x.isTotal) ?? r.summary.rows[0];
  assert.equal(cents(total.lost), sumLost, 'total do resumo = soma das posições validadas');
  assert.equal(cents(r.kpis.find((k) => k.key === 'lost').value), sumLost, 'KPI = soma das posições validadas');
  assert.equal(cents(total.pending), pending.reduce((s, x) => s + cents(x.lost) + cents(x.deferred), 0), 'pendente à parte');
  assert.equal(total.days, r.detail.rows.reduce((s, x) => s + x.periodDays, 0));
});

test('valores em R$ conforme a seção 4.2: Comercial por posição, Gestor só agregado, NACC sem R$', async () => {
  const comercial = await report('comercial', 'loss');
  assert.ok(keys(comercial.detail.columns).includes('lost') && keys(comercial.summary.columns).includes('lost'));

  const gestor = await report('gestor', 'loss');
  assert.ok(!keys(gestor.detail.columns).includes('lost'), 'Gestor não vê R$ por posição');
  assert.ok(gestor.detail.rows.every((x) => !('lost' in x) && !('dailyValue' in x)));
  assert.ok(keys(gestor.summary.columns).includes('lost'), 'Gestor vê os totais');
  assert.notEqual(gestor.kpis.find((k) => k.key === 'lost').value, null);

  const nacc = await report('nacc', 'loss');
  assert.ok(!keys(nacc.detail.columns).includes('lost') && !keys(nacc.summary.columns).includes('lost'));
  assert.ok(nacc.summary.rows.every((x) => !('lost' in x)));
  const lostKpi = nacc.kpis.find((k) => k.key === 'lost');
  assert.equal(lostKpi.value, null);
  assert.equal(lostKpi.hidden, true);
});

test('regras de período: SLA pelo 1º dia, reposições pelo último dia trabalhado, faturamento pelos dias no período', async () => {
  const period = { from: addDays(today, -15), to: today };
  const sla = await report('comercial', 'sla', period);
  assert.ok(sla.detail.rows.every((x) => x.firstDayAt >= period.from && x.firstDayAt <= period.to));
  const replacements = await report('comercial', 'replacements', period);
  assert.ok(replacements.detail.rows.length > 0);
  assert.ok(replacements.detail.rows.every((x) => x.lastWorkedDay >= period.from && x.lastWorkedDay <= period.to));

  const oneDay = await report('comercial', 'loss', { from: today, to: today });
  assert.ok(oneDay.detail.rows.every((x) => x.periodDays === 1), 'num período de 1 dia, cada posição conta no máximo 1 dia');
});

test('filtros e agrupamento: cliente restringe as linhas; o resumo agrupa pelo corte escolhido', async () => {
  const c = await as('comercial');
  const [client] = (await c.get('/api/clients')).data;
  const all = await report('comercial', 'open');
  const filtered = await report('comercial', 'open', { ...YEAR, clientId: client.id });
  assert.ok(filtered.detail.rows.length > 0 && filtered.detail.rows.length < all.detail.rows.length);
  assert.ok(filtered.detail.rows.every((x) => x.client === client.legalName));

  const byRole = await report('comercial', 'open', { ...YEAR, groupBy: 'jobRole' });
  assert.equal(byRole.summary.columns[0].title, 'Cargo');
  assert.equal(byRole.summary.rows.at(-1).group, 'Total');
  assert.equal(byRole.summary.rows.at(-1).open, all.detail.rows.length);

  assert.equal((await c.get('/api/reports/inexistente')).status, 404);
  const inverted = await c.get(`/api/reports/sla${qs({ from: today, to: addDays(today, -1) })}`);
  assert.equal(inverted.status, 422);
  assert.match(inverted.data.detail, /data inicial do período é posterior à final/);
  assert.equal((await c.get(`/api/reports/sla${qs({ groupBy: 'terminationType' })}`)).status, 400, 'corte só das reposições');
});

test('metas dos KPIs: o Admin define, o KPI mostra dentro ou fora da meta; vazio volta a "sem meta"', async () => {
  const admin = await as('admin');
  assert.equal((await admin.put('/api/parameters/KPI_TARGET_OVERDUE_BACKLOG', { value: '0' })).status, 200);
  assert.equal((await admin.put('/api/parameters/KPI_TARGET_SLA_PERCENT', { value: '150' })).status, 422);
  assert.equal((await admin.put('/api/parameters/KPI_TARGET_SLA_PERCENT', { value: 'abc' })).status, 422);

  let backlog = (await report('comercial', 'open')).kpis.find((k) => k.key === 'overdueBacklog');
  assert.ok(backlog.value > 0);
  assert.equal(backlog.target, 0);
  assert.equal(backlog.status, 'bad', 'há posição vencida e a meta é zero');

  assert.equal((await admin.put('/api/parameters/KPI_TARGET_OVERDUE_BACKLOG', { value: '' })).status, 200);
  backlog = (await report('comercial', 'open')).kpis.find((k) => k.key === 'overdueBacklog');
  assert.equal(backlog.target, null);
  assert.equal(backlog.status, null);
});

test('exportação: .xlsx com as abas Indicadores, Resumo, Detalhe e Filtros, sem R$ para quem não vê, e registrada na auditoria', async () => {
  const c = await as('comercial');
  const res = await fetch(`${server.url}/api/reports/loss/export${qs(YEAR)}`, { headers: { Cookie: [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('content-type'), 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  assert.match(res.headers.get('content-disposition'), /^attachment; filename="relatorio-faturamento-perdido-\d{4}-\d{2}-\d{2}-a-\d{4}-\d{2}-\d{2}\.xlsx"$/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  const files = unzip(Buffer.from(await res.arrayBuffer()));
  assert.match(files['xl/workbook.xml'], /<sheet name="Indicadores".*<sheet name="Resumo".*<sheet name="Detalhe".*<sheet name="Filtros"/);
  assert.ok(files['xl/worksheets/sheet3.xml'].includes('Perdido (R$)'));
  assert.match(files['xl/worksheets/sheet4.xml'], /Período/);

  const audit = await queryOne("SELECT new_value FROM audit_logs WHERE action = 'EXPORT_REPORT' ORDER BY occurred_at DESC LIMIT 1");
  assert.match(audit.new_value, /"report":"Faturamento perdido"/);

  const nacc = await as('nacc');
  const naccRes = await fetch(`${server.url}/api/reports/loss/export${qs(YEAR)}`, { headers: { Cookie: [...nacc.jar].map(([k, v]) => `${k}=${v}`).join('; ') } });
  const naccFiles = unzip(Buffer.from(await naccRes.arrayBuffer()));
  assert.ok(!naccFiles['xl/worksheets/sheet3.xml'].includes('R$'), 'o NACC exporta sem R$');
  assert.ok(!naccFiles['xl/worksheets/sheet1.xml'].includes('Faturamento perdido'), 'nem o KPI em R$');
  assert.equal(Number((await query("SELECT COUNT(*) AS n FROM audit_logs WHERE action = 'EXPORT_REPORT'"))[0].n), 2);
});

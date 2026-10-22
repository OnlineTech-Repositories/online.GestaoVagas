import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, query, queryOne } from '../src/db/index.js';
import { listPositions } from '../src/db/repository.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { calculate, isLegacyOrigin } from '../src/domain/calculator.js';
import { today as todayDate } from '../src/domain/dates.js';
import { Roles, SlaSituation } from '../src/domain/enums.js';
import { activeRhAnalysts } from '../src/domain/order.js';
import { isOpen } from '../src/domain/position.js';
import { ESCALATION_ROLES, nextAction, STALE_EMAIL_MAX_ROWS, staleEvent } from '../src/services/alerts.js';
import { DIGEST_ROLES } from '../src/services/digest.js';
import { runDailyJob } from '../src/services/jobs.js';
import { calcSettings } from '../src/services/parameters.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Fase 2 da SPEC (seções 10.1 e 10.2): avisos de Em risco, escalonamento do Vencido, alerta de posição parada e
 * resumo diário — cada um disparado uma única vez. Sobre os dados de demonstração, que têm posições vencidas, em
 * risco e pausadas com datas relativas a hoje.
 */

let server;
const today = todayDate();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function openRows() {
  const settings = await calcSettings();
  return (await listPositions(new UnitOfWork({}), { onlyOpen: true }))
    .filter((p) => isOpen(p) && !isLegacyOrigin(p))
    .map((p) => ({ p, m: calculate(p, today, settings) }));
}

async function activeUserIds(roles) {
  const rows = await query(
    `SELECT DISTINCT u.id FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.active = 1 AND r.role IN (${roles.map(() => '?').join(', ')})`, ...roles);
  return rows.map((r) => r.id);
}

const recipientsOf = async (type, positionId) =>
  (await query('SELECT user_id FROM notifications WHERE type = ? AND entity_id = ? ORDER BY user_id', type, positionId))
    .map((r) => r.user_id);

const count = async (sql, ...params) => Number((await queryOne(sql, ...params)).n);

test('Vencido escala uma única vez por posição: Gestor de RH, Gestor e Controladoria', async () => {
  await runDailyJob();
  const overdue = (await openRows()).filter((r) => r.m.slaSituation === SlaSituation.OVERDUE);
  assert.ok(overdue.length > 0, 'os dados de demonstração têm posição vencida');

  const escalation = (await activeUserIds(ESCALATION_ROLES)).sort();
  for (const { p } of overdue) assert.deepEqual(await recipientsOf('SLA_OVERDUE', p.id), escalation);

  await runDailyJob();
  for (const { p } of overdue) {
    assert.equal((await recipientsOf('SLA_OVERDUE', p.id)).length, escalation.length, 'a segunda execução não repete');
  }
  assert.equal(await count("SELECT COUNT(*) AS n FROM position_alerts WHERE kind = 'OVERDUE'"), overdue.length);
});

test('Em risco avisa a equipe de RH do pedido (analistas responsáveis e Gestores de RH)', async () => {
  const atRisk = (await openRows()).filter((r) => r.m.slaSituation === SlaSituation.AT_RISK);
  assert.ok(atRisk.length > 0, 'os dados de demonstração têm posição em risco');
  const managers = await activeUserIds([Roles.RhManager]);
  for (const { p } of atRisk) {
    const expected = [...new Set([...managers, ...activeRhAnalysts(p.order).map((a) => a.userId)])].sort();
    assert.deepEqual(await recipientsOf('SLA_AT_RISK', p.id), expected);
    const message = await queryOne("SELECT message FROM notifications WHERE type = 'SLA_AT_RISK' AND entity_id = ?", p.id);
    assert.match(message.message, /prazo do SLA vence em \d{2}\/\d{2}\/\d{4}/);
  }
});

test('resumo diário: um e-mail por pessoa dos perfis operacionais e de gestão, uma vez por dia, sem R$', async () => {
  const people = await activeUserIds(DIGEST_ROLES);
  const digests = await query("SELECT to_address, html_body FROM email_messages WHERE subject LIKE '%Resumo diário%'");
  assert.equal(digests.length, people.length, 'duas execuções no dia, um resumo por pessoa');

  const body = digests[0].html_body;
  for (const title of ['Posições abertas por cliente', 'Vencidas e em risco', 'Reposições aguardando o cliente',
    'Pausas sem fim', 'Sem atualização há']) assert.ok(body.includes(title), title);
  assert.match(body, /Aguardando documentação do cliente/, 'a pausa da demonstração aparece com o motivo');
  assert.doesNotMatch(body, /R\$/);
  const run = await queryOne("SELECT summary FROM job_runs WHERE job_name = 'DAILY' AND run_date = ?", today);
  assert.match(run.summary, new RegExp(`Resumo diário: ${people.length} destinatário`));
});

const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
const RH_STAGES = ['OPEN', 'RECRUITING', 'CANDIDATE_APPROVED'];
let agedPositions = 0;

/** Avisos consolidados de posições paradas do pedido: [{ to_address, subject, html_body }] por destinatário. */
const staleMessages = (orderNumber) => query(
  'SELECT to_address, subject, html_body FROM email_messages WHERE subject LIKE ? ORDER BY created_at, id',
  `[Controle de Vagas] Pedido ${orderNumber} — %sem atualização`);

test('posições paradas: um aviso por pedido e destinatário, com todas as posições e os dias de cada uma', async () => {
  // Um pedido com 3 posições na mão do RH e outro pedido com 1, todos com analistas responsáveis.
  const byOrder = new Map();
  for (const r of await openRows()) {
    if (!RH_STAGES.includes(r.p.status) || !activeRhAnalysts(r.p.order).length) continue;
    if (!byOrder.has(r.p.orderId)) byOrder.set(r.p.orderId, []);
    byOrder.get(r.p.orderId).push(r.p);
  }
  const [first, ...others] = [...byOrder.values()].sort((a, b) => b.length - a.length);
  assert.ok(first.length >= 3 && others.length, 'a demonstração tem pedidos com posições no RH');
  const [a, b, c] = first;
  const [d] = others[0];
  const order = a.order;
  const team = async (o) => [...new Set([...(await activeUserIds([Roles.RhManager])), ...activeRhAnalysts(o).map((x) => x.userId)])].sort();
  const expected = await team(order);
  const emails = new Map((await query('SELECT id, email FROM users')).map((u) => [u.id, u.email]));

  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(10), a.id);
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(6), b.id);
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(4), d.id);
  agedPositions = 3;
  await runDailyJob();

  // Pedido: uma notificação no sino e um e-mail por destinatário, com as duas posições.
  assert.deepEqual(await recipientsOf('ORDER_POSITIONS_STALE', order.id), expected);
  assert.equal(await count("SELECT COUNT(*) AS n FROM notifications WHERE type = 'POSITION_STALE'"), 0, 'nada por posição');
  const mails = await staleMessages(order.number);
  assert.deepEqual(mails.map((m) => m.to_address).sort(), expected.map((id) => emails.get(id)).sort());
  assert.equal(mails[0].subject, `[Controle de Vagas] Pedido ${order.number} — 2 posições sem atualização`);
  const body = mails[0].html_body;
  for (const text of [`${order.number}-${a.slotNumber}`, `${order.number}-${b.slotNumber}`, 'Posições sinalizadas (2)',
    'Dias sem movimentação', 'Exigem atualização', 'Posições vigentes do pedido', 'Consultar posições do pedido',
    `#/pedidos/${order.id}?paradas=1`, order.contract.name, order.jobRole.name]) assert.ok(body.includes(text), text);
  assert.ok(body.indexOf(`${order.number}-${a.slotNumber}<`) < body.indexOf(`${order.number}-${b.slotNumber}<`), 'a mais antiga primeiro');
  assert.match(body, />10<\/td>[\s\S]*>6<\/td>/, 'dias calculados por posição');
  assert.doesNotMatch(body, /novo aviso/, 'no primeiro aviso todas são novas');
  const message = await queryOne("SELECT message FROM notifications WHERE type = 'ORDER_POSITIONS_STALE' AND entity_id = ?", order.id);
  assert.match(message.message, /: 2 posições sem atualização há 3 dias ou mais\. Próxima ação: RH: /);

  // Outro pedido: outra mensagem, só com a posição dele.
  const other = await staleMessages(d.order.number);
  assert.equal(other.length, (await team(d.order)).length);
  assert.equal(other[0].subject, `[Controle de Vagas] Pedido ${d.order.number} — 1 posição sem atualização`);

  // Reprocessamento no mesmo ciclo: nada se repete.
  await runDailyJob();
  assert.equal((await staleMessages(order.number)).length, expected.length);
  assert.equal((await recipientsOf('ORDER_POSITIONS_STALE', order.id)).length, expected.length);

  // Outra posição do pedido parou: novo aviso com as três, a nova marcada.
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(3), c.id);
  agedPositions = 4;
  await runDailyJob();
  const next = (await staleMessages(order.number)).slice(expected.length);
  assert.equal(next.length, expected.length);
  assert.equal(next[0].subject, `[Controle de Vagas] Pedido ${order.number} — 3 posições sem atualização`);
  assert.equal(next[0].html_body.match(/novo aviso/gi).length, 2, 'a linha nova e a legenda');
  assert.ok(next[0].html_body.includes(`${order.number}-${c.slotNumber} · novo aviso`));
  assert.equal((await staleMessages(d.order.number)).length, other.length, 'o outro pedido não teve posição nova');

  // Na tela do pedido, as paradas vêm marcadas para o destaque do link.
  const admin = new Client(server.url);
  await admin.login('admin@demo.local', DEMO_PASSWORD);
  const detail = (await admin.get(`/api/orders/${order.id}`)).data;
  assert.equal(detail.stale.days, 3);
  assert.deepEqual(detail.stale.positions.map((x) => [x.positionId, x.idleDays]).sort(),
    [[a.id, 10], [b.id, 6], [c.id, 3]].sort());
});

test('aviso consolidado: até 100 posições na tabela, o restante fica para o sistema', () => {
  const order = { id: 'x', number: 7, quantity: 130, contract: null, jobRole: { name: 'Cargo' } };
  const action = { label: 'RH: selecionar o candidato' };
  const items = Array.from({ length: 130 }, (_, i) => ({
    p: { slotNumber: i + 1, cycle: 1, status: 'RECRUITING' }, action, idle: 3 + (i % 9), since: today, isNew: true,
  }));
  const event = staleEvent(order, items, 3, 130);
  assert.equal(event.subject, 'Pedido 7 — 130 posições sem atualização');
  assert.equal(event.email.bodyHtml.match(/<tr>/g).length, STALE_EMAIL_MAX_ROWS + 1, 'cabeçalho + 100 linhas');
  assert.match(event.email.bodyHtml, /… e mais 30 posições\. Consulte todas no sistema\./);
  assert.match(event.email.bodyHtml, />7-9</, 'as mais paradas primeiro');
});

test('posição recente, pausada ou sem próxima ação não gera alerta de parada', async () => {
  const stale = await query("SELECT DISTINCT position_id FROM position_alerts WHERE kind = 'STALE'");
  assert.equal(stale.length, agedPositions, 'só as posições envelhecidas no teste anterior');
  const paused = (await openRows()).find((r) => r.p.status === 'PAUSED');
  assert.equal(nextAction(paused.p), null);
});

test('o registro de alertas não aceita exclusão (RN-26)', async () => {
  await assert.rejects(execute('DELETE FROM position_alerts'));
});

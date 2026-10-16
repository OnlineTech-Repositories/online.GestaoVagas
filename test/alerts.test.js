import './env.js';
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
import { ESCALATION_ROLES, nextAction } from '../src/services/alerts.js';
import { DIGEST_ROLES } from '../src/services/digest.js';
import { runDailyJob } from '../src/services/jobs.js';
import { calcSettings } from '../src/services/parameters.js';
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

test('posição parada: avisa quem responde pela próxima ação, uma vez por período parado', async () => {
  const { p } = (await openRows()).find((r) => r.p.status === 'RECRUITING' && activeRhAnalysts(r.p.order).length);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const expected = [...new Set([...(await activeUserIds([Roles.RhManager])),
    ...activeRhAnalysts(p.order).map((a) => a.userId)])].sort();
  assert.equal(nextAction(p).label, 'RH: selecionar o candidato');

  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(10), p.id);
  await runDailyJob();
  assert.deepEqual(await recipientsOf('POSITION_STALE', p.id), expected);
  const message = await queryOne("SELECT message FROM notifications WHERE type = 'POSITION_STALE' AND entity_id = ?", p.id);
  assert.match(message.message, /sem atualização desde .* \(10 dias\)\. Próxima ação: RH: selecionar o candidato\./);

  await runDailyJob();
  assert.equal((await recipientsOf('POSITION_STALE', p.id)).length, expected.length, 'o mesmo período não repete');

  // A posição andou e parou de novo: é outro período, outro aviso.
  await execute('UPDATE positions SET updated_at = ? WHERE id = ?', daysAgo(5), p.id);
  await runDailyJob();
  assert.equal((await recipientsOf('POSITION_STALE', p.id)).length, expected.length * 2);
});

test('posição recente, pausada ou sem próxima ação não gera alerta de parada', async () => {
  const stale = await query("SELECT DISTINCT position_id FROM position_alerts WHERE kind = 'STALE'");
  assert.equal(stale.length, 1, 'só a posição envelhecida no teste anterior');
  const paused = (await openRows()).find((r) => r.p.status === 'PAUSED');
  assert.equal(nextAction(paused.p), null);
});

test('o registro de alertas não aceita exclusão (RN-26)', async () => {
  await assert.rejects(execute('DELETE FROM position_alerts'));
});

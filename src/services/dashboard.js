import { listPositions } from '../db/repository.js';
import { calculate, isLegacyOrigin, moneyOf, overlapDays, sumMoney } from '../domain/calculator.js';
import { addMonths, monthStart, today as todayDate } from '../domain/dates.js';
import { OrderApprovalStatus, PositionStatus, SlaSituation } from '../domain/enums.js';
import { Permissions } from '../domain/guards.js';
import { activeRhAnalysts } from '../domain/order.js';
import { isOpen, stageStatus } from '../domain/position.js';
import { calcSettings } from './parameters.js';
import { toSummary } from './position-views.js';

/** Painel (seção 9 da SPEC): cards do mês e a lista de posições vencidas ou em risco. */
export async function getDashboard(ctx) {
  const today = todayDate();
  const start = monthStart(today);
  const nextMonth = addMonths(start, 1);
  const settings = await calcSettings();
  const showAggregated = Permissions.canSeeAggregatedValues(ctx.user);
  const showDetailed = Permissions.canSeeDetailedValues(ctx.user);

  const rows = (await listPositions(ctx.uow, {}))
    .filter((p) => !isLegacyOrigin(p))
    .map((p) => ({ p, m: calculate(p, today, settings) }));
  const open = rows.filter((r) => isOpen(r.p));
  const monthItems = rows
    .map((r) => ({ p: r.p, days: overlapDays(r.m.uncoveredStart, r.m.uncoveredEndExclusive, start, nextMonth) }))
    .filter((x) => x.days > 0);
  const totals = sumMoney(monthItems.map((x) => moneyOf(x.p, x.days, settings)));

  const critical = open
    .filter((r) => r.m.slaSituation === SlaSituation.OVERDUE || r.m.slaSituation === SlaSituation.AT_RISK)
    .sort((a, b) => b.m.uncoveredDays - a.m.uncoveredDays)
    .slice(0, 100)
    .map((r) => toSummary(r.p, r.m, showDetailed));

  // Pedido "aguardando atribuição do RH": não recusado, sem analista ativo e com posição aberta (a própria linha).
  const awaitingRh = new Set(open
    .filter((r) => r.p.order.approvalStatus !== OrderApprovalStatus.NOT_APPROVED && activeRhAnalysts(r.p.order).length === 0)
    .map((r) => r.p.orderId));

  return {
    today,
    monthStart: start,
    openPositions: open.filter((r) => r.p.status !== PositionStatus.AWAITING_CONFIRMATION).length,
    overdue: open.filter((r) => r.m.slaSituation === SlaSituation.OVERDUE).length,
    atRisk: open.filter((r) => r.m.slaSituation === SlaSituation.AT_RISK).length,
    awaitingClient: open.filter((r) => stageStatus(r.p) === PositionStatus.AWAITING_CONFIRMATION).length,
    awaitingApproval: open.filter((r) => r.p.order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL).length,
    awaitingRhAssignment: awaitingRh.size,
    paused: open.filter((r) => r.p.status === PositionStatus.PAUSED).length,
    uncoveredDaysInMonth: monthItems.reduce((s, x) => s + x.days, 0),
    lostInMonth: showAggregated ? totals.lost : null,
    deferredInMonth: showAggregated ? totals.deferred : null,
    pendingValidationInMonth: showAggregated ? Math.round((totals.pendingLost + totals.pendingDeferred) * 100) / 100 : null,
    pendingValidationCount: showAggregated ? totals.pendingCount : 0,
    critical,
  };
}

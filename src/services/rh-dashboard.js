import { listPositions } from '../db/repository.js';
import { calculate, isLegacyOrigin } from '../domain/calculator.js';
import { today as todayDate } from '../domain/dates.js';
import { OrderApprovalStatus, RhStage, Roles, SlaSituation } from '../domain/enums.js';
import { BusinessRuleError } from '../domain/errors.js';
import { hasAnyRole, hasRole, Permissions } from '../domain/guards.js';
import { activeRhAnalysts } from '../domain/order.js';
import { dateFlags } from '../domain/date-checks.js';
import { rhStage } from '../domain/position.js';
import { Input, isId } from './input.js';
import { calcSettings } from './parameters.js';

/**
 * Painel de RH: acompanhamento dos pedidos, das vagas e das demandas por analista.
 *
 * Regras decididas com o usuário em 19/10/2026:
 *   acesso     Gestor de RH, Gestor e Admin veem a equipe toda; o Analista de RH vê só os pedidos atribuídos a ele
 *              (o filtro de analista fica fixo nele). Os demais perfis não acessam.
 *   escopo     por padrão, os pedidos em andamento (alguma vaga pendente), de qualquer data; o período filtra pela
 *              data da solicitação do cliente e há a opção de incluir os pedidos concluídos.
 *   etapas     pausa e espera pela decisão do cliente contam como pendentes, mas em etapa própria (RhStage).
 *
 * Uma linha por vaga: o ciclo atual de cada uma (a reposição substitui o ocupante desligado, sem criar vaga nova).
 * Vagas encerradas sem preenchimento (cancelada pelo cliente, fim do contrato) saem da conta. Os totais contam cada
 * pedido e cada vaga uma vez, mesmo quando o pedido é compartilhado entre analistas. SLA, pausas e meta saem do mesmo
 * cálculo da seção 8 (calculate): "não iniciado" é a vaga ainda sem data de abertura (aguardando a aprovação do
 * cliente ou a decisão sobre a reposição) e "sem meta" é a vaga aberta sem prazo de SLA.
 */

export const VIEW_ALL = Object.freeze([Roles.RhManager, Roles.Manager, Roles.Admin]);

/** Situação do SLA no painel: as quatro do cálculo e a vaga ainda sem contagem. */
export const SLA_KEYS = Object.freeze([
  SlaSituation.ON_TIME, SlaSituation.AT_RISK, SlaSituation.OVERDUE, SlaSituation.NO_TARGET, 'NOT_STARTED',
]);
const STAGE_KEYS = Object.values(RhStage);
const UNASSIGNED = 'UNASSIGNED';
const MAIN_UNIT = 'MAIN';

export const canViewRhDashboard = (user) => hasAnyRole(user, [...VIEW_ALL, Roles.Rh]);

/** Analista de RH sem perfil de gestão: vê só os próprios pedidos. */
const lockedToSelf = (user) => hasRole(user, Roles.Rh) && !hasAnyRole(user, VIEW_ALL);

export const slaKey = (m) => m.slaSituation ?? 'NOT_STARTED';

function parseFilters(ctx, query) {
  const input = new Input(query);
  const filters = {
    from: input.date('from', { required: false }),
    to: input.date('to', { required: false }),
    clientId: input.id('clientId', { required: false }),
    unit: input.text('unit'),
    contractId: input.id('contractId', { required: false }),
    jobRoleId: input.id('jobRoleId', { required: false }),
    rh: input.text('rh'),
    stage: input.option('stage', RhStage, { required: false }),
    sla: input.option('sla', Object.fromEntries(SLA_KEYS.map((k) => [k, k])), { required: false }),
    includeConcluded: input.bool('includeConcluded', false),
  };
  input.done();
  if (filters.from && filters.to && filters.from > filters.to) {
    throw new BusinessRuleError('A data inicial do período é posterior à final.', 'from');
  }
  if (filters.unit && filters.unit !== MAIN_UNIT && !isId(filters.unit)) {
    throw new BusinessRuleError('Unidade contratante inválida.', 'unit');
  }
  if (lockedToSelf(ctx.user)) filters.rh = ctx.user.id;
  else if (filters.rh && filters.rh !== UNASSIGNED && !isId(filters.rh)) {
    throw new BusinessRuleError('Filtro de analista de RH inválido.', 'rh');
  }
  if (filters.rh && filters.rh !== UNASSIGNED) filters.rh = filters.rh.toLowerCase();
  return filters;
}

const unitKey = (order) => order.contract?.contractingUnitId ?? MAIN_UNIT;
const unitLabel = (order) => {
  const unit = order.contract?.contractingUnit;
  return unit ? `${unit.code} — ${unit.name}` : 'Cliente principal';
};

const emptyStages = () => Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
const emptySla = () => Object.fromEntries(SLA_KEYS.map((k) => [k, 0]));
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);

/** Contadores de um conjunto de vagas: total, preenchidas, pendentes, por etapa e por situação do SLA das pendentes. */
function count(rows) {
  const stages = emptyStages();
  const sla = emptySla();
  let filled = 0;
  for (const r of rows) {
    stages[r.stage]++;
    if (r.stage === RhStage.FILLED) filled++;
    else sla[r.sla]++;
  }
  return { positions: rows.length, filled, pending: rows.length - filled, percentFilled: pct(filled, rows.length), stages, sla };
}

export async function getRhDashboard(ctx, query) {
  Permissions.require(ctx.user, ...VIEW_ALL, Roles.Rh);
  const filters = parseFilters(ctx, query);
  const today = todayDate();
  const settings = await calcSettings();

  // Filtros de pedido no banco; os de vaga (etapa, SLA) e os calculados (escopo, período, unidade) em memória.
  const positions = (await listPositions(ctx.uow, {
    clientId: filters.clientId,
    contractId: filters.contractId,
    jobRoleId: filters.jobRoleId,
    rhAnalystId: filters.rh && filters.rh !== UNASSIGNED ? filters.rh : null,
    rhUnassigned: filters.rh === UNASSIGNED,
    currentCycleOnly: true,
  })).filter((p) => !isLegacyOrigin(p));

  const byOrder = new Map();
  for (const p of positions) {
    const stage = rhStage(p, today);
    if (!stage) continue; // encerrada sem preenchimento: não é vaga a acompanhar
    if (!byOrder.has(p.orderId)) byOrder.set(p.orderId, { order: p.order, rows: [] });
    byOrder.get(p.orderId).rows.push({ p, stage, sla: slaKey(calculate(p, today, settings)), flags: dateFlags(p, today) });
  }

  // Escopo: pedidos em andamento (alguma vaga pendente) ou também os concluídos; período pela solicitação do cliente.
  const scoped = [...byOrder.values()].filter(({ order, rows }) => order.approvalStatus !== OrderApprovalStatus.NOT_APPROVED
    && (filters.includeConcluded || rows.some((r) => r.stage !== RhStage.FILLED))
    && (!filters.from || order.clientRequestDate >= filters.from)
    && (!filters.to || order.clientRequestDate <= filters.to));

  // Opções dos filtros a partir do escopo (antes dos demais filtros), para não oferecer combinação vazia.
  const options = buildOptions(scoped, ctx.user);

  const orders = scoped
    .filter(({ order }) => !filters.unit || unitKey(order) === filters.unit)
    .map(({ order, rows }) => ({
      order,
      // A situação do SLA filtra as pendentes, como nos cards (a preenchida guarda só a situação final).
      rows: rows.filter((r) => (!filters.stage || r.stage === filters.stage)
        && (!filters.sla || (r.stage !== RhStage.FILLED && r.sla === filters.sla))),
    }))
    .filter(({ rows }) => rows.length > 0);

  const allRows = orders.flatMap((o) => o.rows);
  const totals = {
    orders: orders.length,
    ...count(allRows),
    awaitingApproval: orders.filter(({ order }) => order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL).length,
    unassigned: orders.filter(({ order }) => activeRhAnalysts(order).length === 0).length,
    sharedOrders: orders.filter(({ order }) => activeRhAnalysts(order).length > 1).length,
    // Datas a acompanhar: eventos agendados (data futura) e etapas lançadas fora de ordem.
    futureDated: allRows.filter((r) => r.flags.future).length,
    outOfSequence: allRows.filter((r) => r.flags.sequence).length,
  };

  const orderRows = orders.map(({ order, rows }) => {
    const analysts = activeRhAnalysts(order);
    return {
      orderId: order.id,
      number: order.number,
      client: order.contract?.client?.legalName ?? '',
      unit: unitLabel(order),
      contract: order.contract?.name ?? '',
      jobRole: order.jobRole?.name ?? '',
      clientRequestDate: order.clientRequestDate,
      approvalStatus: order.approvalStatus,
      analysts: analysts.map((a) => a.userName),
      shared: analysts.length > 1,
      ...count(rows),
    };
  }).sort((a, b) => b.sla.OVERDUE - a.sla.OVERDUE || b.sla.AT_RISK - a.sla.AT_RISK || b.pending - a.pending
    || b.number - a.number);

  return {
    today,
    filters: { ...filters, rh: filters.rh || '' },
    analystLocked: lockedToSelf(ctx.user),
    totals,
    orders: orderRows,
    analysts: byAnalyst(orders, lockedToSelf(ctx.user) ? ctx.user.id : null),
    options,
  };
}

/**
 * Uma linha por analista com os pedidos atribuídos a ele (o pedido compartilhado entra em cada analista e é marcado),
 * mais a linha dos pedidos sem analista. O total da equipe conta cada pedido e cada vaga uma vez.
 */
function byAnalyst(orders, onlyId) {
  const map = new Map();
  const unassigned = [];
  for (const item of orders) {
    const analysts = activeRhAnalysts(item.order);
    if (analysts.length === 0) unassigned.push(item);
    for (const a of analysts) {
      if (onlyId && a.userId !== onlyId) continue;
      if (!map.has(a.userId)) map.set(a.userId, { id: a.userId, name: a.userName, items: [] });
      map.get(a.userId).items.push(item);
    }
  }
  const line = (items) => ({
    orders: items.length,
    sharedOrders: items.filter(({ order }) => activeRhAnalysts(order).length > 1).length,
    ...count(items.flatMap((i) => i.rows)),
  });
  const rows = [...map.values()]
    .map(({ id, name, items }) => ({ id, name, ...line(items) }))
    .sort((a, b) => b.pending - a.pending || a.name.localeCompare(b.name, 'pt-BR'));
  if (!onlyId && unassigned.length) rows.push({ id: UNASSIGNED, name: 'Sem analista', unassigned: true, ...line(unassigned) });
  return rows;
}

function buildOptions(scoped, user) {
  const unique = (pairs) => [...new Map(pairs).entries()]
    .map(([value, label]) => ({ value, label }))
    .sort((a, b) => a.label.localeCompare(b.label, 'pt-BR'));
  const list = scoped.map((s) => s.order);
  return {
    clients: unique(list.map((o) => [o.contract?.clientId, o.contract?.client?.legalName ?? '—'])),
    units: unique(list.map((o) => [unitKey(o), unitLabel(o)])),
    contracts: unique(list.map((o) => [o.contractId, o.contract?.name ?? '—'])),
    jobRoles: unique(list.map((o) => [o.jobRoleId, o.jobRole?.name ?? '—'])),
    analysts: lockedToSelf(user) ? [] : unique(list.flatMap((o) => activeRhAnalysts(o).map((a) => [a.userId, a.userName]))),
  };
}

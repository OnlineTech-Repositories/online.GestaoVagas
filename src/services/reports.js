import { listPositions, userNames } from '../db/repository.js';
import { calculate, isLegacyOrigin, moneyOf, overlapDays, sumMoney } from '../domain/calculator.js';
import { addDays, diffDays, formatBr, monthStart, today as todayDate } from '../domain/dates.js';
import {
  DemandType, KPIS, Labels, Modality, ParameterKeys, PositionStatus as S, SlaSituation,
} from '../domain/enums.js';
import { BusinessRuleError, NotFoundError } from '../domain/errors.js';
import { Permissions } from '../domain/guards.js';
import { activeRhAnalysts } from '../domain/order.js';
import { isCurrentCycle, isOpen, stageStatus } from '../domain/position.js';
import { nextAction } from './alerts.js';
import { Input } from './input.js';
import { calcSettings, getInt, kpiTargets } from './parameters.js';
import { generateXlsx } from './xlsx.js';

/**
 * Relatórios e KPIs da seção 11 da SPEC (fase 3): posições em aberto, SLA por período, faturamento perdido e
 * reposições, com os cortes da seção 11 e exportação para Excel.
 *
 * Tudo sai dos MESMOS cálculos da seção 8 (calculate, moneyOf, sumMoney), testados com os casos T1–T12: o relatório
 * agrega, não recalcula. E cada relatório devolve colunas tipadas — a mesma definição desenha a tabela na tela e as
 * abas do Excel, para os dois nunca divergirem.
 *
 * Regras de período (decididas com o usuário em 18/10/2026):
 *   em aberto     foto de hoje (o período vale só para os KPIs);
 *   SLA           posições preenchidas (1º dia efetivo) no período;
 *   faturamento   dias descobertos que caem dentro do período, como o painel faz no mês;
 *   reposições    desligamentos com último dia trabalhado no período.
 *
 * Valores em R$ (seção 4.2): por posição só para quem vê valores detalhados (Comercial, Controladoria, Admin); o
 * Gestor vê totais e somas por grupo; NACC, DP e RH veem dias, sem R$. Valor não validado fica fora dos totais
 * (RN-21) e aparece à parte, como "pendente de validação".
 */

const L = {
  ...Labels,
  modality: { RS: 'R&S', MOT: 'Mão de obra temporária', MOE: 'Mão de obra efetiva', FAC: 'Facilities' },
  slaSituation: { ON_TIME: 'No prazo', AT_RISK: 'Em risco', OVERDUE: 'Vencido', NO_TARGET: 'Sem meta' },
  terminationType: { RESIGNATION: 'Pedido de demissão', DISMISSAL: 'Dispensa', CONTRACT_END: 'Fim de contrato', ABANDONMENT: 'Abandono', OTHER: 'Outro' },
  terminationSource: { DP: 'DP', NACC: 'NACC', CLIENT: 'Cliente' },
  clientDecision: { REPLACE: 'Repor', NOT_REPLACE: 'Não repor' },
  moneyStatus: { NOT_APPLICABLE: 'Não se aplica (R&S)', NO_RATE: 'Sem valor cadastrado', PENDING: 'Pendente de validação', VALIDATED: 'Validado', REJECTED: 'Rejeitado' },
  termType: { FIXED_END: 'Data fim fixa', PRESERVED_DURATION: 'Duração preservada', INDEFINITE: 'Indeterminado' },
};

/** Cortes de agrupamento do resumo (seção 11). */
const GROUPS = {
  client: { label: 'Cliente', of: (p) => p.order.contract?.client?.legalName ?? '—' },
  contract: { label: 'Contrato', of: (p) => p.order.contract?.name ?? '—' },
  jobRole: { label: 'Cargo', of: (p) => p.order.jobRole?.name ?? '—' },
  modality: { label: 'Modalidade', of: (p) => L.modality[p.order.modality] ?? p.order.modality },
  demandType: { label: 'Tipo de demanda', of: (p) => L.demandType[p.demandType] },
  groupEntity: { label: 'CNPJ do Grupo', of: (p) => p.order.contract?.groupEntity?.name ?? '—' },
  workLocation: { label: 'Local', of: (p) => p.order.workLocation?.name ?? '—' },
  rhAnalyst: { label: 'Analista de RH', of: (p) => activeRhAnalysts(p.order).map((a) => a.userName).join(', ') || 'Sem analista' },
  commercialOwner: { label: 'Responsável comercial', of: (p, names) => names.get(p.order.contract?.commercialOwnerId) ?? '—' },
  terminationType: { label: 'Tipo de desligamento', of: (p) => L.terminationType[p.termination?.terminationType] ?? '—' },
};

export const REPORTS = {
  open: { title: 'Posições em aberto', file: 'posicoes-em-aberto', groups: Object.keys(GROUPS).filter((g) => g !== 'terminationType'), group: 'client' },
  sla: { title: 'SLA por período', file: 'sla-por-periodo', groups: Object.keys(GROUPS).filter((g) => g !== 'terminationType'), group: 'client' },
  loss: { title: 'Faturamento perdido', file: 'faturamento-perdido', groups: Object.keys(GROUPS).filter((g) => g !== 'terminationType'), group: 'client' },
  replacements: { title: 'Reposições', file: 'reposicoes', groups: Object.keys(GROUPS), group: 'terminationType' },
};

// ---------------------------------------------------------------- filtros

function parseFilters(kind, query) {
  const report = REPORTS[kind];
  if (!report) throw new NotFoundError('Relatório não encontrado.');
  const today = todayDate();
  const input = new Input(query);
  const filters = {
    from: input.date('from', { required: false }) ?? monthStart(today),
    to: input.date('to', { required: false }) ?? today,
    clientId: input.id('clientId', { required: false }),
    contractId: input.id('contractId', { required: false }),
    modality: input.option('modality', Modality, { required: false }),
    jobRoleId: input.id('jobRoleId', { required: false }),
    demandType: input.option('demandType', DemandType, { required: false }),
    groupEntityId: input.id('groupEntityId', { required: false }),
    workLocationId: input.id('workLocationId', { required: false }),
    rhAnalystId: input.id('rhAnalystId', { required: false }),
    commercialOwnerId: input.id('commercialOwnerId', { required: false }),
    groupBy: input.option('groupBy', Object.fromEntries(report.groups.map((g) => [g, g])), { required: false }) ?? report.group,
  };
  input.done();
  if (filters.from > filters.to) throw new BusinessRuleError('A data inicial do período é posterior à final.', 'from');
  return { ...filters, today };
}

// ---------------------------------------------------------------- execução

/** Relatório na tela: KPIs, resumo agrupado, detalhe e totais. */
export async function runReport(ctx, kind, query) {
  const filters = parseFilters(kind, query);
  return build(ctx, kind, filters);
}

/** Planilha: abas Indicadores, Resumo, Detalhe e Filtros. A exportação vai para o log de auditoria. */
export async function exportReport(ctx, kind, query) {
  const filters = parseFilters(kind, query);
  const report = await build(ctx, kind, filters);
  const kpiColumns = [
    { key: 'label', title: 'Indicador', width: 32 }, { key: 'value', title: 'Valor', type: 'decimal', width: 16 },
    { key: 'unit', title: 'Unidade', width: 14 }, { key: 'target', title: 'Meta', type: 'decimal', width: 12 },
    { key: 'status', title: 'Situação', width: 16 }, { key: 'note', title: 'Base de cálculo', width: 50 },
  ];
  const UNIT = { days: 'dias', percent: '%', int: '', money: 'R$' };
  const STATUS = { ok: 'Dentro da meta', bad: 'Fora da meta' };
  const buffer = generateXlsx([
    {
      name: 'Indicadores',
      columns: kpiColumns,
      rows: report.kpis.filter((k) => !k.hidden).map((k) => ({
        ...k, unit: UNIT[k.unit], status: k.target === null ? 'Sem meta' : STATUS[k.status] ?? '—',
      })),
    },
    { name: 'Resumo', ...report.summary },
    { name: 'Detalhe', ...report.detail },
    { name: 'Filtros', columns: [{ key: 'field', title: 'Filtro', width: 26 }, { key: 'value', title: 'Valor', width: 60 }], rows: report.filterRows },
  ]);
  const fileName = `relatorio-${REPORTS[kind].file}-${filters.from}-a-${filters.to}.xlsx`;
  // Toda exportação é registrada (controle de saída de informação, como na aplicação financeira).
  ctx.uow.log({
    entity: 'Report', entityId: kind, action: 'EXPORT_REPORT',
    newValue: JSON.stringify({ report: REPORTS[kind].title, file: fileName, rows: report.detail.rows.length, filters: report.filterRows }),
  });
  await ctx.uow.save({ action: 'EXPORT_REPORT' });
  return { fileName, buffer };
}

async function build(ctx, kind, filters) {
  const settings = await calcSettings();
  const earlyWindow = await getInt(ParameterKeys.EarlyReplacementWindowDays);
  const targets = await kpiTargets();
  const showDetailed = Permissions.canSeeDetailedValues(ctx.user);
  const showAggregated = Permissions.canSeeAggregatedValues(ctx.user);
  const { today, from, to } = filters;
  const toExclusive = addDays(to, 1);
  const inPeriod = (d) => Boolean(d) && d >= from && d <= to;

  const positions = (await listPositions(ctx.uow, {
    clientId: filters.clientId, contractId: filters.contractId, modality: filters.modality, jobRoleId: filters.jobRoleId,
    demandType: filters.demandType, groupEntityId: filters.groupEntityId, workLocationId: filters.workLocationId,
    rhAnalystId: filters.rhAnalystId, commercialOwnerId: filters.commercialOwnerId,
  })).filter((p) => !isLegacyOrigin(p));
  const names = await userNames(positions.map((p) => p.order.contract?.commercialOwnerId));
  const rows = positions.map((p) => {
    const m = calculate(p, today, settings);
    const periodDays = overlapDays(m.uncoveredStart, m.uncoveredEndExclusive, from, toExclusive);
    return { p, m, periodDays, money: moneyOf(p, periodDays, settings) };
  });

  const filled = rows.filter(({ p }) => p.status === S.FILLED && inPeriod(p.firstDayAt));
  const terminated = rows.filter(({ p }) => p.demandType === DemandType.REPLACEMENT && inPeriod(p.termination?.lastWorkedDay));
  const isEarly = ({ p }) => {
    const origin = p.termination?.originPosition;
    return Boolean(origin?.firstDayAt) && diffDays(origin.firstDayAt, p.termination.lastWorkedDay) <= earlyWindow;
  };
  const totals = sumMoney(rows.filter((r) => r.periodDays > 0).map((r) => r.money));

  const ctxData = { rows, filled, terminated, isEarly, totals, today, from, to, names, showDetailed, showAggregated, earlyWindow };
  const kpis = buildKpis(ctxData, targets);
  const { summary, detail, notes } = BUILDERS[kind](ctxData, GROUPS[filters.groupBy], filters.groupBy);

  return {
    kind,
    title: REPORTS[kind].title,
    period: { from, to },
    generatedAt: today,
    groupBy: filters.groupBy,
    groups: REPORTS[kind].groups.map((g) => ({ value: g, label: GROUPS[g].label })),
    showMoney: kind === 'loss' ? (showDetailed ? 'detailed' : showAggregated ? 'aggregated' : 'none') : 'none',
    kpis,
    summary,
    detail,
    notes,
    filterRows: filterRows(filters, positions, names),
  };
}

// ---------------------------------------------------------------- KPIs

const avg = (values) => {
  const list = values.filter((v) => v !== null && v !== undefined);
  return list.length ? Math.round((list.reduce((s, v) => s + v, 0) / list.length) * 10) / 10 : null;
};
const pct = (part, whole) => (whole ? Math.round((part / whole) * 1000) / 10 : null);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

function buildKpis(d, targets) {
  const { rows, filled, terminated, isEarly, totals, showAggregated, earlyWindow } = d;
  const withTarget = filled.filter(({ m }) => m.slaSituation === SlaSituation.ON_TIME || m.slaSituation === SlaSituation.OVERDUE);
  const onTime = withTarget.filter(({ m }) => m.slaSituation === SlaSituation.ON_TIME).length;
  const communications = terminated.map(({ m }) => m.communicationTime).filter((v) => v !== null);
  const early = terminated.filter(isEarly).length;
  const values = {
    communication: [avg(communications), `média de ${plural(communications.length, 'desligamento', 'desligamentos')} no período`],
    fill: [avg(filled.map(({ m }) => m.fillTime)), `média de ${plural(filled.length, 'posição preenchida', 'posições preenchidas')} no período, descontadas as pausas`],
    uncoveredAvg: [avg(filled.map(({ m }) => m.uncoveredDays)), 'dias descobertos, do início da janela ao 1º dia, nas posições preenchidas no período'],
    slaPercent: [pct(onTime, withTarget.length), `${onTime} de ${plural(withTarget.length, 'posição preenchida', 'posições preenchidas')} com meta`],
    uncoveredPositionDays: [rows.reduce((s, r) => s + r.periodDays, 0), 'soma dos dias descobertos de todas as posições que caem no período'],
    lost: [totals.lost, totals.pendingCount
      ? `só valores validados; ${plural(totals.pendingCount, 'posição', 'posições')} com valor pendente fora do total` : 'só valores validados (RN-21)'],
    overdueBacklog: [rows.filter(({ p, m }) => isOpen(p) && m.slaSituation === SlaSituation.OVERDUE).length, 'posições abertas vencidas hoje'],
    earlyReplacement: [pct(early, filled.length),
      `${plural(early, 'desligamento', 'desligamentos')} em até ${earlyWindow} dias do 1º dia ÷ ${plural(filled.length, 'posição preenchida', 'posições preenchidas')} no período`],
  };
  return KPIS.map((k) => {
    const hidden = k.money && !showAggregated;
    const [value, note] = values[k.key];
    const target = targets[k.target] ?? null;
    const status = value === null || target === null ? null
      : (k.better === 'down' ? value <= target : value >= target) ? 'ok' : 'bad';
    return { key: k.key, label: k.label, unit: k.unit, value: hidden ? null : value, target, status: hidden ? null : status, note, hidden };
  });
}

// ---------------------------------------------------------------- relatórios

const POSITION = { key: 'position', title: 'Vaga', width: 14 };
const CLIENT = { key: 'client', title: 'Cliente', width: 30 };
const CONTRACT = { key: 'contract', title: 'Contrato', width: 22 };
const JOB_ROLE = { key: 'jobRole', title: 'Cargo', width: 24 };
const DEMAND = { key: 'demandType', title: 'Tipo de demanda', width: 14 };

function base(p) {
  const order = p.order;
  return {
    id: p.id,
    position: `${order.number}-${p.slotNumber}${p.cycle > 1 ? ` (rep. ${p.cycle - 1})` : ''}`,
    client: order.contract?.client?.legalName ?? '',
    contract: order.contract?.name ?? '',
    jobRole: order.jobRole?.name ?? '',
    modality: L.modality[order.modality] ?? order.modality,
    demandType: L.demandType[p.demandType],
    workLocation: order.workLocation?.name ?? '',
    rhAnalysts: activeRhAnalysts(order).map((a) => a.userName).join(', '),
  };
}

/** Agrupa e resume: uma linha por grupo, ordenada pelo maior valor da primeira métrica, com o total no fim. */
function groupSummary(items, group, groupBy, names, metricColumns, metrics) {
  const byGroup = new Map();
  for (const item of items) {
    const label = group.of(item.p, names);
    if (!byGroup.has(label)) byGroup.set(label, []);
    byGroup.get(label).push(item);
  }
  const first = metricColumns[0].key;
  const rows = [...byGroup].map(([label, list]) => ({ group: label, ...metrics(list) }))
    .sort((a, b) => (b[first] ?? 0) - (a[first] ?? 0) || String(a.group).localeCompare(String(b.group), 'pt-BR'));
  if (rows.length > 1) rows.push({ group: 'Total', isTotal: true, ...metrics(items) });
  return { columns: [{ key: 'group', title: group.label, width: 30 }, ...metricColumns], rows, groupBy };
}

const SEVERITY = { OVERDUE: 0, AT_RISK: 1, ON_TIME: 2, NO_TARGET: 3 };

const BUILDERS = {
  open(d, group, groupBy) {
    const items = d.rows.filter(({ p }) => isOpen(p) && isCurrentCycle(p))
      .sort((a, b) => (SEVERITY[a.m.slaSituation] ?? 4) - (SEVERITY[b.m.slaSituation] ?? 4) || b.m.uncoveredDays - a.m.uncoveredDays);
    const count = (list, fn) => list.filter(fn).length;
    return {
      summary: groupSummary(items, group, groupBy, d.names, [
        { key: 'open', title: 'Abertas', type: 'int', width: 10 },
        { key: 'overdue', title: 'Vencidas', type: 'int', width: 10 },
        { key: 'atRisk', title: 'Em risco', type: 'int', width: 10 },
        { key: 'awaitingClient', title: 'Aguardando cliente', type: 'int', width: 12 },
        { key: 'paused', title: 'Pausadas', type: 'int', width: 10 },
        { key: 'avgUncovered', title: 'Média de dias descobertos', type: 'decimal', width: 14 },
      ], (list) => ({
        open: list.length,
        overdue: count(list, ({ m }) => m.slaSituation === SlaSituation.OVERDUE),
        atRisk: count(list, ({ m }) => m.slaSituation === SlaSituation.AT_RISK),
        awaitingClient: count(list, ({ p }) => stageStatus(p) === S.AWAITING_CONFIRMATION),
        paused: count(list, ({ p }) => p.status === S.PAUSED),
        avgUncovered: avg(list.map(({ m }) => m.uncoveredDays)),
      })),
      detail: {
        columns: [
          POSITION, CLIENT, CONTRACT, JOB_ROLE, DEMAND, { key: 'workLocation', title: 'Local', width: 22 },
          { key: 'status', title: 'Status', width: 22 }, { key: 'openedAt', title: 'Aberta em', type: 'date', width: 12 },
          { key: 'openDays', title: 'Dias em aberto', type: 'int', width: 10 },
          { key: 'uncoveredDays', title: 'Dias descobertos', type: 'int', width: 11 },
          { key: 'slaTargetDays', title: 'Meta (dias)', type: 'int', width: 9 },
          { key: 'slaDeadline', title: 'Prazo do SLA', type: 'date', width: 12 },
          { key: 'slaSituation', title: 'Situação do SLA', width: 13 },
          { key: 'nextAction', title: 'Próxima ação', width: 40 }, { key: 'rhAnalysts', title: 'Analistas de RH', width: 26 },
        ],
        rows: items.map(({ p, m }) => ({
          ...base(p),
          status: L.positionStatus[p.status],
          openedAt: p.openedAt,
          openDays: p.openedAt ? diffDays(p.openedAt, d.today) : null,
          uncoveredDays: m.uncoveredDays,
          slaTargetDays: p.slaTargetDays,
          slaDeadline: m.slaDeadline,
          slaSituation: L.slaSituation[m.slaSituation] ?? (p.status === S.AWAITING_CONFIRMATION ? 'Aguardando cliente' : ''),
          nextAction: nextAction(p)?.label ?? (p.status === S.PAUSED ? 'Pausada: aguardando o cliente' : ''),
          situationKey: m.slaSituation,
        })),
      },
      notes: ['Foto de hoje: o período escolhido vale só para os indicadores. Uma linha por vaga (o ciclo atual).'],
    };
  },

  sla(d, group, groupBy) {
    const items = [...d.filled].sort((a, b) => b.p.firstDayAt.localeCompare(a.p.firstDayAt));
    return {
      summary: groupSummary(items, group, groupBy, d.names, [
        { key: 'count', title: 'Preenchidas', type: 'int', width: 11 },
        { key: 'communication', title: 'Comunicação (média, dias)', type: 'decimal', width: 14 },
        { key: 'confirmation', title: 'Confirmação (média, dias)', type: 'decimal', width: 14 },
        { key: 'fill', title: 'Preenchimento (média, dias)', type: 'decimal', width: 14 },
        { key: 'total', title: 'Total descoberto (média, dias)', type: 'decimal', width: 15 },
        { key: 'slaPercent', title: '% no SLA', type: 'percent', width: 10 },
      ], (list) => {
        const withTarget = list.filter(({ m }) => m.slaSituation === SlaSituation.ON_TIME || m.slaSituation === SlaSituation.OVERDUE);
        return {
          count: list.length,
          communication: avg(list.map(({ m }) => m.communicationTime)),
          confirmation: avg(list.map(({ m }) => m.confirmationTime)),
          fill: avg(list.map(({ m }) => m.fillTime)),
          total: avg(list.map(({ m }) => m.uncoveredDays)),
          slaPercent: pct(withTarget.filter(({ m }) => m.slaSituation === SlaSituation.ON_TIME).length, withTarget.length),
        };
      }),
      detail: {
        columns: [
          POSITION, CLIENT, JOB_ROLE, DEMAND, { key: 'openedAt', title: 'Aberta em', type: 'date', width: 12 },
          { key: 'firstDayAt', title: '1º dia', type: 'date', width: 12 },
          { key: 'communication', title: 'Comunicação (dias)', type: 'int', width: 12 },
          { key: 'confirmation', title: 'Confirmação (dias)', type: 'int', width: 12 },
          { key: 'pausedDays', title: 'Pausas (dias)', type: 'int', width: 10 },
          { key: 'fill', title: 'Preenchimento (dias)', type: 'int', width: 12 },
          { key: 'total', title: 'Total descoberto (dias)', type: 'int', width: 13 },
          { key: 'slaTargetDays', title: 'Meta (dias)', type: 'int', width: 9 },
          { key: 'slaSituation', title: 'Situação do SLA', width: 13 },
        ],
        rows: items.map(({ p, m }) => ({
          ...base(p), openedAt: p.openedAt, firstDayAt: p.firstDayAt, communication: m.communicationTime,
          confirmation: m.confirmationTime, pausedDays: m.pausedDays, fill: m.fillTime, total: m.uncoveredDays,
          slaTargetDays: p.slaTargetDays, slaSituation: L.slaSituation[m.slaSituation] ?? '', situationKey: m.slaSituation,
        })),
      },
      notes: ['Posições preenchidas (1º dia efetivo) no período. Comunicação e confirmação se aplicam só às reposições.'],
    };
  },

  loss(d, group, groupBy) {
    const items = d.rows.filter((r) => r.periodDays > 0).sort((a, b) => b.periodDays - a.periodDays);
    const moneyCols = (cols) => (d.showAggregated ? cols : []);
    const detailMoney = d.showDetailed;
    return {
      summary: groupSummary(items, group, groupBy, d.names, [
        { key: 'days', title: 'Dias descobertos no período', type: 'int', width: 14 },
        { key: 'positions', title: 'Posições', type: 'int', width: 10 },
        ...moneyCols([
          { key: 'lost', title: 'Perdido (R$)', type: 'money', width: 16 },
          { key: 'deferred', title: 'Postergado (R$)', type: 'money', width: 16 },
          { key: 'pending', title: 'Pendente de validação (R$)', type: 'money', width: 18 },
        ]),
      ], (list) => {
        const t = sumMoney(list.map((r) => r.money));
        return {
          days: list.reduce((s, r) => s + r.periodDays, 0),
          positions: list.length,
          ...(d.showAggregated ? { lost: t.lost, deferred: t.deferred, pending: Math.round((t.pendingLost + t.pendingDeferred) * 100) / 100 } : {}),
        };
      }),
      detail: {
        columns: [
          POSITION, CLIENT, CONTRACT, JOB_ROLE, { key: 'modality', title: 'Modalidade', width: 16 },
          { key: 'termType', title: 'Vigência', width: 16 }, { key: 'status', title: 'Status', width: 20 },
          { key: 'periodDays', title: 'Dias descobertos no período', type: 'int', width: 14 },
          ...(detailMoney ? [
            { key: 'dailyValue', title: 'Valor diário (R$)', type: 'money', width: 14 },
            { key: 'lost', title: 'Perdido (R$)', type: 'money', width: 14 },
            { key: 'deferred', title: 'Postergado (R$)', type: 'money', width: 14 },
            { key: 'moneyStatus', title: 'Situação do valor', width: 20 },
          ] : []),
        ],
        rows: items.map(({ p, periodDays, money }) => ({
          ...base(p), termType: L.termType[p.termType], status: L.positionStatus[p.status], periodDays,
          ...(detailMoney ? { dailyValue: money.daily, lost: money.lost, deferred: money.deferred, moneyStatus: L.moneyStatus[money.status] } : {}),
        })),
      },
      notes: [
        'Dias descobertos de cada posição que caem dentro do período (uma posição descoberta de 20/09 a 05/10 conta 5 dias em outubro).',
        ...(d.showAggregated ? ['Os totais somam só valores validados pela Controladoria; valor pendente aparece à parte (RN-21). R&S não tem cálculo em R$.'] : []),
        ...(!d.showAggregated ? ['Seu perfil vê os dias descobertos, sem os valores em R$ (seção 4.2).'] : []),
        ...(d.showAggregated && !d.showDetailed ? ['Seu perfil vê os totais em R$, sem o valor de cada posição (seção 4.2).'] : []),
      ],
    };
  },

  replacements(d, group, groupBy) {
    const items = [...d.terminated].sort((a, b) => b.p.termination.lastWorkedDay.localeCompare(a.p.termination.lastWorkedDay));
    return {
      summary: groupSummary(items, group, groupBy, d.names, [
        { key: 'count', title: 'Desligamentos', type: 'int', width: 13 },
        { key: 'early', title: `Precoces (até ${d.earlyWindow} dias)`, type: 'int', width: 13 },
        { key: 'awaiting', title: 'Aguardando decisão', type: 'int', width: 12 },
        { key: 'notReplaced', title: 'Não repostas', type: 'int', width: 11 },
        { key: 'replaced', title: 'Repostas', type: 'int', width: 10 },
        { key: 'avgReplacement', title: 'Tempo médio de reposição (dias)', type: 'decimal', width: 16 },
      ], (list) => ({
        count: list.length,
        early: list.filter(d.isEarly).length,
        awaiting: list.filter(({ p }) => !p.termination.clientDecision).length,
        notReplaced: list.filter(({ p }) => p.termination.clientDecision === 'NOT_REPLACE').length,
        replaced: list.filter(({ p }) => p.status === S.FILLED).length,
        avgReplacement: avg(list.filter(({ p }) => p.status === S.FILLED).map(({ m }) => m.uncoveredDays)),
      })),
      detail: {
        columns: [
          { key: 'employee', title: 'Colaborador desligado', width: 26 }, { key: 'registration', title: 'Matrícula', width: 12 },
          CLIENT, JOB_ROLE, { key: 'terminationType', title: 'Tipo de desligamento', width: 18 },
          { key: 'source', title: 'Informado por', width: 12 }, { key: 'lastWorkedDay', title: 'Último dia trabalhado', type: 'date', width: 13 },
          { key: 'decision', title: 'Decisão do cliente', width: 14 },
          { key: 'communication', title: 'Comunicação (dias)', type: 'int', width: 12 },
          { key: 'confirmation', title: 'Confirmação (dias)', type: 'int', width: 12 },
          { key: 'replacementStatus', title: 'Reposição', width: 22 },
          { key: 'replacementFirstDay', title: '1º dia do substituto', type: 'date', width: 13 },
          { key: 'replacementDays', title: 'Tempo de reposição (dias)', type: 'int', width: 13 },
          { key: 'early', title: 'Precoce', width: 9 },
        ],
        rows: items.map(({ p, m, ...rest }) => {
          const t = p.termination;
          const origin = t.originPosition;
          return {
            ...base(p),
            employee: origin?.employeeName ?? '', registration: origin?.employeeRegistration ?? '',
            terminationType: L.terminationType[t.terminationType], source: L.terminationSource[t.source],
            lastWorkedDay: t.lastWorkedDay, decision: L.clientDecision[t.clientDecision] ?? 'Aguardando',
            communication: m.communicationTime, confirmation: m.confirmationTime,
            replacementStatus: L.positionStatus[p.status], replacementFirstDay: p.firstDayAt,
            replacementDays: p.status === S.FILLED ? m.uncoveredDays : null,
            early: d.isEarly({ p, m, ...rest }) ? 'Sim' : 'Não',
          };
        }),
      },
      notes: [
        'Desligamentos com último dia trabalhado no período. Tempo de reposição: do dia seguinte ao último dia trabalhado ao 1º dia do substituto.',
        `Precoce: desligamento em até ${d.earlyWindow} dias do 1º dia do colaborador (parâmetro EARLY_REPLACEMENT_WINDOW_DAYS).`,
      ],
    };
  },
};

// ---------------------------------------------------------------- filtros aplicados (para a aba Filtros)

function filterRows(f, positions, names) {
  const pick = (id, of) => (id ? (positions.map(of).find((x) => x?.id === id)?.label ?? id) : null);
  const ref = (id, label) => (id ? { id, label } : null);
  const rows = [
    ['Período', `${formatBr(f.from)} a ${formatBr(f.to)}`],
    ['Cliente', pick(f.clientId, (p) => ref(p.order.contract?.client?.id, p.order.contract?.client?.legalName))],
    ['Contrato', pick(f.contractId, (p) => ref(p.order.contract?.id, p.order.contract?.name))],
    ['Modalidade', f.modality ? L.modality[f.modality] : null],
    ['Cargo', pick(f.jobRoleId, (p) => ref(p.order.jobRole?.id, p.order.jobRole?.name))],
    ['Tipo de demanda', f.demandType ? L.demandType[f.demandType] : null],
    ['CNPJ do Grupo', pick(f.groupEntityId, (p) => ref(p.order.contract?.groupEntity?.id, p.order.contract?.groupEntity?.name))],
    ['Local', pick(f.workLocationId, (p) => ref(p.order.workLocation?.id, p.order.workLocation?.name))],
    ['Analista de RH', f.rhAnalystId ? (positions.flatMap((p) => activeRhAnalysts(p.order)).find((a) => a.userId === f.rhAnalystId)?.userName ?? f.rhAnalystId) : null],
    ['Responsável comercial', f.commercialOwnerId ? (names.get(f.commercialOwnerId) ?? f.commercialOwnerId) : null],
    ['Agrupado por', GROUPS[f.groupBy].label],
    ['Gerado em', formatBr(f.today)],
  ];
  return rows.filter(([, v]) => v !== null && v !== undefined).map(([field, value]) => ({ field, value }));
}

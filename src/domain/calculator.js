import { addDays, diffDays, maxDate, minDate } from './dates.js';
import {
  ClientDecision, DemandType, Modality, MoneyStatus, OrderApprovalStatus, PositionStatus as S, RateStatus, SlaSituation,
  TermType,
} from './enums.js';
import { isClosed, pauseDays } from './position.js';

/**
 * Funções puras da seção 8 da SPEC. Recebem a posição (com order, termination, pauses e rate pendurados) e a data de
 * hoje. Toda conta de dias é diferença simples entre datas, em dias corridos.
 *
 * Valores em R$ são calculados em CENTAVOS inteiros, com arredondamento "meio para o par" — o mesmo do decimal da
 * versão .NET. Em ponto flutuante, 3 dias de R$ 3.000,00 / 30 viravam 299.99999999999994 e o total do mês saía um
 * centavo diferente do relatório anterior.
 */

/** Parâmetros que influenciam os cálculos. */
export const DEFAULT_SETTINGS = Object.freeze({ atRiskDays: 2, lossOnCancelAfterOpen: true });

export function calculate(p, today, settings) {
  const start = uncoveredStart(p);
  const end = uncoveredEndExclusive(p, today);
  const uncovered = Math.max(0, diffDays(start, end));
  const paused = pausedDays(p, today);
  const fill = fillTime(p, today, paused);
  const { deadline, situation } = sla(p, today, settings, paused, fill);
  const money = moneyOf(p, uncovered, settings);
  return {
    uncoveredStart: start,
    uncoveredEndExclusive: end,
    uncoveredDays: uncovered,
    pausedDays: paused,
    registrationTime: registrationTime(p),
    communicationTime: communicationTime(p),
    confirmationTime: confirmationTime(p),
    fillTime: fill,
    slaDeadline: deadline,
    slaSituation: situation,
    dailyValue: money.daily,
    lost: money.lost,
    deferred: money.deferred,
    moneyStatus: money.status,
    approvalWaitTime: approvalWaitTime(p, today),
  };
}

/** 8.1 — início da janela descoberta. */
export const uncoveredStart = (p) => (p.demandType === DemandType.REPLACEMENT
  ? addDays(terminationOf(p).lastWorkedDay, 1)
  : p.desiredStartDate);

/**
 * 8.1 — fim (exclusivo) da janela descoberta. Marco com data futura (1º dia ou cancelamento agendados) conta só até
 * hoje: a vaga continua descoberta até a data chegar.
 */
export function uncoveredEndExclusive(p, today) {
  if (isLegacyOrigin(p)) return uncoveredStart(p);
  switch (p.status) {
    case S.FILLED: return minDate(p.firstDayAt ?? uncoveredStart(p), today);
    case S.CLOSED_CONTRACT_ENDED: return p.termEndDate ? addDays(p.termEndDate, 1) : p.closedAt ?? today;
    case S.CLOSED_CLIENT_CANCELLED:
    case S.CLOSED_HEADCOUNT_REDUCED: return minDate(p.closedAt ?? today, today);
    default:
      if (p.termType === TermType.FIXED_END && p.termEndDate) return minDate(today, addDays(p.termEndDate, 1));
      return today;
  }
}

/** 1º dia já ocorrido (o futuro é agendado: a vaga ainda não está preenchida para os cálculos). */
const filledBy = (p, today) => (p.status === S.FILLED && p.firstDayAt && p.firstDayAt <= today ? p.firstDayAt : null);

/**
 * 8.2 — dias pausados que contam para o SLA: só a parte de cada pausa entre a abertura e o 1º dia (ou hoje). Uma
 * pausa lançada antes da abertura, ou terminada depois do 1º dia, não desconta dias em que o SLA não corria — antes,
 * ela deixava o tempo de preenchimento negativo e empurrava o prazo. Sem abertura, a soma simples até hoje.
 */
export function pausedDays(p, today) {
  const pauses = p.pauses ?? [];
  if (!p.openedAt) return pauses.reduce((sum, x) => sum + pauseDays(x, today), 0);
  const end = filledBy(p, today) ?? today;
  return pauses.reduce((sum, x) => sum + overlapDays(x.startDate, minDate(x.endDate ?? today, today), p.openedAt, end), 0);
}

/** 8.3 — tempo de cadastro (vaga nova). */
export const registrationTime = (p) => (p.demandType === DemandType.NEW && p.order && !p.order.isLegacy
  ? Math.max(0, diffDays(p.order.clientRequestDate, p.order.registeredAt))
  : null);

/** Espera pela aprovação formal do cliente (vaga nova): do registro do pedido à decisão, ou até hoje. */
export function approvalWaitTime(p, today) {
  if (p.demandType !== DemandType.NEW || !p.order || p.order.isLegacy) return null;
  const order = p.order;
  const end = order.clientDecisionDate ?? (order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL ? today : null);
  return end ? Math.max(0, diffDays(order.registeredAt, end)) : null;
}

/** 8.3 — tempo de comunicação interna (reposição). */
export const communicationTime = (p) => (p.demandType === DemandType.REPLACEMENT
  ? Math.max(0, diffDays(terminationOf(p).lastWorkedDay, terminationOf(p).registeredAt))
  : null);

/** 8.3 — tempo de espera pela decisão do cliente (reposição). */
export const confirmationTime = (p) => (p.demandType === DemandType.REPLACEMENT && terminationOf(p).clientDecisionAt
  ? Math.max(0, diffDays(terminationOf(p).registeredAt, terminationOf(p).clientDecisionAt))
  : null);

/**
 * 8.3 — tempo de preenchimento (SLA do RH), descontadas as pausas (RN-18), contado até o 1º dia já ocorrido ou até
 * hoje (data de referência). Abertura futura ou datas fora de ordem dão 0, nunca um tempo negativo.
 */
export function fillTime(p, today, paused) {
  if (!p.openedAt || isClosed(p) || isLegacyOrigin(p)) return null;
  return Math.max(0, diffDays(p.openedAt, filledBy(p, today) ?? today) - paused);
}

/** 8.4 — prazo e situação do SLA. */
export function sla(p, today, settings, paused, fill) {
  // AWAITING_CONFIRMATION não tem SLA do RH; posições encerradas sem preenchimento não têm situação.
  if (!p.openedAt || isClosed(p) || isLegacyOrigin(p)) return { deadline: null, situation: null };
  const target = p.slaTargetDays;
  const hasTarget = target !== null && target !== undefined;
  // Abertura futura (aprovação ou decisão agendadas): o SLA ainda não começou.
  if (p.openedAt > today) return { deadline: hasTarget ? addDays(p.openedAt, target) : null, situation: null };
  if (!hasTarget) return { deadline: null, situation: SlaSituation.NO_TARGET };
  const deadline = addDays(p.openedAt, target + paused);
  // Resultado final só com o 1º dia já ocorrido; agendado para o futuro, segue contando como vaga aberta.
  if (filledBy(p, today)) return { deadline, situation: fill <= target ? SlaSituation.ON_TIME : SlaSituation.OVERDUE };
  if (today > deadline) return { deadline, situation: SlaSituation.OVERDUE };
  if (today >= addDays(deadline, -settings.atRiskDays)) return { deadline, situation: SlaSituation.AT_RISK };
  return { deadline, situation: SlaSituation.ON_TIME };
}

/** 8.5 — valor diário, faturamento perdido e postergado para uma quantidade de dias descobertos. */
export function moneyOf(p, uncoveredDays, settings) {
  if (modalityOf(p) === Modality.RS) return { daily: null, lost: 0, deferred: 0, status: MoneyStatus.NOT_APPLICABLE };
  const monthly = p.rate?.monthlyValue;
  if (monthly === null || monthly === undefined) return { daily: null, lost: null, deferred: null, status: MoneyStatus.NO_RATE };

  const status = p.rate.status === RateStatus.VALIDATED ? MoneyStatus.VALIDATED
    : p.rate.status === RateStatus.REJECTED ? MoneyStatus.REJECTED : MoneyStatus.PENDING;
  const monthlyCents = Math.round(monthly * 100);
  const daily = divideCents(monthlyCents, 30) / 100;
  // Multiplica antes de dividir para não acumular o arredondamento do valor diário.
  const amount = divideCents(uncoveredDays * monthlyCents, 30) / 100;
  const none = { daily, lost: 0, deferred: 0, status };

  if (isLegacyOrigin(p)) return none;
  // Pedido que o cliente não aprovou: o posto nunca foi contratado, não há perda.
  if (p.order?.approvalStatus === OrderApprovalStatus.NOT_APPROVED) return none;
  if (p.demandType === DemandType.REPLACEMENT && p.termination?.clientDecision === ClientDecision.NOT_REPLACE) return none;
  // Redução do quadro conta como cancelamento (decisão do usuário em 22/10/2026).
  if ((p.status === S.CLOSED_CLIENT_CANCELLED || p.status === S.CLOSED_HEADCOUNT_REDUCED) && !settings.lossOnCancelAfterOpen) return none;
  if (p.termType === TermType.PRESERVED_DURATION) return { daily, lost: 0, deferred: amount, status };
  return { daily, lost: amount, deferred: 0, status };
}

/** Dias descobertos de uma janela que caem dentro do período [from, toExclusive). */
export const overlapDays = (start, endExclusive, from, toExclusive) =>
  Math.max(0, diffDays(maxDate(start, from), minDate(endExclusive, toExclusive)));

/** Posição FILLED criada pelo desligamento avulso (D1): não tem histórico de preenchimento. */
export const isLegacyOrigin = (p) => p.order?.isLegacy === true && p.demandType === DemandType.NEW;

/** Totais oficiais em R$ (RN-21): valores não validados ficam de fora e são contados à parte. */
export function sumMoney(items) {
  let lost = 0;
  let deferred = 0;
  let pendingLost = 0;
  let pendingDeferred = 0;
  let pendingCount = 0;
  for (const { lost: l, deferred: d, status } of items) {
    if (status === MoneyStatus.VALIDATED) {
      lost += cents(l);
      deferred += cents(d);
    } else if (status === MoneyStatus.PENDING || status === MoneyStatus.REJECTED) {
      pendingLost += cents(l);
      pendingDeferred += cents(d);
      pendingCount += 1;
    }
  }
  return {
    lost: lost / 100, deferred: deferred / 100, pendingLost: pendingLost / 100, pendingDeferred: pendingDeferred / 100,
    pendingCount,
  };
}

/** Soma de valores em R$ sem acumular erro de ponto flutuante. */
export const sumValues = (values) => values.reduce((s, v) => s + cents(v), 0) / 100;

const cents = (v) => Math.round((v ?? 0) * 100);

/** Divisão inteira com arredondamento "meio para o par" (o padrão de Math.Round no decimal do .NET). */
function divideCents(numerator, divisor) {
  const q = Math.floor(numerator / divisor);
  const r = numerator - q * divisor;
  if (2 * r > divisor) return q + 1;
  if (2 * r < divisor) return q;
  return q % 2 === 0 ? q : q + 1;
}

function modalityOf(p) {
  if (!p.order) throw new Error('Pedido da posição não carregado.');
  return p.order.modality;
}

function terminationOf(p) {
  if (!p.termination) throw new Error('Desligamento da reposição não carregado.');
  return p.termination;
}

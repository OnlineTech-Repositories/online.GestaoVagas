import { dateFlags } from '../domain/date-checks.js';
import { today as todayDate } from '../domain/dates.js';
import { activeRhAnalysts, isApproved } from '../domain/order.js';
import {
  activeCandidate, canRegisterMissingCandidate, isAdmitted, isCurrentCycle, isOpen, notReplaced, rhStage, stageStatus,
} from '../domain/position.js';
import { OrderApprovalStatus, PositionStatus as S, Roles } from '../domain/enums.js';
import { ForbiddenError } from '../domain/errors.js';
import { Cpf, hasAnyRole, hasRole, RhAccess } from '../domain/guards.js';

/**
 * O que a tela recebe de uma posição: o resumo da lista, as métricas, as ações permitidas e os dados do candidato
 * com a proteção da LGPD. É o mesmo JSON da API .NET — o front-end não mudou.
 */

// ---------------------------------------------------------------- ações (matriz 4.1 + status da seção 6)

export const Actions = Object.freeze({
  Decide: 'DECIDE',
  ApproveCandidate: 'APPROVE_CANDIDATE',
  RegisterAdmission: 'REGISTER_ADMISSION',
  ConfirmFirstDay: 'CONFIRM_FIRST_DAY',
  CandidateWithdrew: 'CANDIDATE_WITHDREW',
  AdmissionNoShow: 'ADMISSION_NO_SHOW',
  StartPause: 'START_PAUSE',
  EndPause: 'END_PAUSE',
  Cancel: 'CANCEL',
  AdjustTerm: 'ADJUST_TERM',
  RegisterTermination: 'REGISTER_TERMINATION',
  CorrectDates: 'CORRECT_DATES',
  CorrectCandidate: 'CORRECT_CANDIDATE',
  CorrectRegistration: 'CORRECT_REGISTRATION',
});

const A = Actions;
const ALLOWED_ROLES = {
  [A.Decide]: [Roles.Nacc],
  [A.ApproveCandidate]: [Roles.Rh, Roles.RhManager],
  [A.RegisterAdmission]: [Roles.Rh, Roles.RhManager],
  [A.ConfirmFirstDay]: [Roles.Nacc],
  [A.CandidateWithdrew]: [Roles.Rh, Roles.RhManager],
  [A.CorrectCandidate]: [Roles.Rh, Roles.RhManager],
  // A matrícula vem da admissão (RH do pedido) e costuma ser gerada pelo DP.
  [A.CorrectRegistration]: [Roles.Rh, Roles.RhManager, Roles.Dp],
  [A.AdmissionNoShow]: [Roles.Rh, Roles.RhManager, Roles.Nacc],
  [A.StartPause]: [Roles.Nacc],
  [A.EndPause]: [Roles.Nacc],
  [A.Cancel]: [Roles.Commercial, Roles.Nacc],
  [A.AdjustTerm]: [Roles.Nacc],
  [A.RegisterTermination]: [Roles.Dp, Roles.Nacc],
  // A autoria de cada marco é verificada na correção; ADMIN corrige qualquer data.
  [A.CorrectDates]: [Roles.Commercial, Roles.Nacc, Roles.Dp, Roles.Rh, Roles.RhManager, Roles.Admin],
};

/** Execução do recrutamento: o Analista de RH age só nos pedidos atribuídos a ele. */
const RH_EXECUTION = new Set([
  A.ApproveCandidate, A.RegisterAdmission, A.CandidateWithdrew, A.AdmissionNoShow, A.CorrectCandidate, A.CorrectRegistration,
]);

export const actionsFor = (p, user) => Object.keys(ALLOWED_ROLES).filter((a) => roleAllows(p, user, a) && statusAllows(p, a));

/** Verificação no back-end do perfil exigido pela ação (o status é validado pelo domínio). */
export function ensureRole(p, user, action) {
  if (roleAllows(p, user, action)) return;
  if (RH_EXECUTION.has(action) && hasRole(user, Roles.Rh)) RhAccess.require(user, p.order);
  throw new ForbiddenError();
}

function roleAllows(p, user, action) {
  const roles = ALLOWED_ROLES[action];
  if (!RH_EXECUTION.has(action)) return hasAnyRole(user, roles);
  // Outros perfis da ação (Gestor de RH, NACC) valem sempre; o Analista de RH, só se for responsável pelo pedido.
  return hasAnyRole(user, roles.filter((r) => r !== Roles.Rh))
    || (hasRole(user, Roles.Rh) && Boolean(p.order) && RhAccess.canAct(user, p.order));
}

function statusAllows(p, action) {
  const approved = !p.order || isApproved(p.order);
  switch (action) {
    case A.Decide: return p.status === S.AWAITING_CONFIRMATION;
    // Antes da aprovação do cliente, a posição avança só até "Em recrutamento".
    case A.ApproveCandidate: return p.status === S.RECRUITING && approved;
    case A.RegisterAdmission: return p.status === S.CANDIDATE_APPROVED && approved;
    case A.CandidateWithdrew: return p.status === S.CANDIDATE_APPROVED;
    case A.CorrectCandidate: return Boolean(activeCandidate(p)) || canRegisterMissingCandidate(p);
    case A.CorrectRegistration: return isAdmitted(p);
    case A.ConfirmFirstDay: return p.status === S.AWAITING_FIRST_DAY && approved;
    case A.AdmissionNoShow: return isAdmitted(p);
    case A.StartPause: return isOpen(p) && p.status !== S.PAUSED;
    case A.EndPause: return p.status === S.PAUSED;
    case A.Cancel:
    case A.AdjustTerm: return isOpen(p);
    case A.RegisterTermination: return p.status === S.FILLED && !p.exitTermination;
    case A.CorrectDates: return true;
    default: return false;
  }
}

// ---------------------------------------------------------------- DTOs

export function toSummary(p, m, showMoney) {
  const order = p.order;
  const today = todayDate();
  const contract = order.contract;
  return {
    id: p.id,
    orderId: p.orderId,
    orderNumber: order.number,
    sequence: p.sequence,
    clientName: contract?.client?.legalName ?? '',
    contractName: contract?.name ?? '',
    groupEntityName: contract?.groupEntity?.name ?? '',
    modality: order.modality,
    jobRoleName: order.jobRole?.name ?? '',
    workLocationName: order.workLocation?.name ?? '',
    demandType: p.demandType,
    status: p.status,
    stageStatus: stageStatus(p),
    rhStage: rhStage(p, today),
    openedAt: p.openedAt,
    uncoveredStart: m.uncoveredStart,
    uncoveredDays: m.uncoveredDays,
    pausedDays: m.pausedDays,
    fillTime: m.fillTime,
    slaTargetDays: p.slaTargetDays,
    slaDeadline: m.slaDeadline,
    slaSituation: m.slaSituation,
    lost: showMoney ? m.lost : null,
    deferred: showMoney ? m.deferred : null,
    moneyStatus: showMoney ? m.moneyStatus : null,
    employeeName: p.employeeName,
    jobconvoCode: order.jobconvoCode,
    hasRetroactiveDates: p.hasRetroactiveDates,
    lastUpdate: p.updatedAt ?? p.createdAt,
    orderApprovalStatus: order.approvalStatus ?? OrderApprovalStatus.AWAITING_CLIENT_APPROVAL,
    rhAnalystNames: activeRhAnalysts(order).map((a) => a.userName),
    candidateName: activeCandidate(p)?.fullName ?? null,
    slotNumber: p.slotNumber,
    cycle: p.cycle,
    isCurrentCycle: isCurrentCycle(p),
    notReplaced: notReplaced(p),
    // Selos calculados a cada leitura: "Data futura" some sozinho quando a data chega.
    dateFlags: dateFlags(p, today),
  };
}

export const toMetrics = (p, m, showMoney) => ({
  uncoveredDays: m.uncoveredDays,
  uncoveredStart: m.uncoveredStart,
  uncoveredEndExclusive: m.uncoveredEndExclusive,
  pausedDays: m.pausedDays,
  registrationTime: m.registrationTime,
  communicationTime: m.communicationTime,
  confirmationTime: m.confirmationTime,
  fillTime: m.fillTime,
  slaTargetDays: p.slaTargetDays,
  slaTargetSource: p.slaTargetSource,
  slaDeadline: m.slaDeadline,
  slaSituation: m.slaSituation,
  dailyValue: showMoney ? m.dailyValue : null,
  lost: showMoney ? m.lost : null,
  deferred: showMoney ? m.deferred : null,
  moneyStatus: showMoney ? m.moneyStatus : null,
  approvalWaitTime: m.approvalWaitTime,
});

export const terminationDto = (t) => ({
  id: t.id,
  originPositionId: t.originPositionId,
  originEmployeeName: t.originPosition?.employeeName ?? null,
  originEmployeeRegistration: t.originPosition?.employeeRegistration ?? null,
  lastWorkedDay: t.lastWorkedDay,
  source: t.source,
  terminationType: t.terminationType,
  notes: t.notes,
  clientDecision: t.clientDecision,
  clientDecisionAt: t.clientDecisionAt,
  registeredAt: t.registeredAt,
  replacementPositionId: t.replacementPosition?.id ?? null,
});

// ---------------------------------------------------------------- LGPD e evidências

/** Quem vê os dados completos do candidato: RH do pedido (analistas responsáveis e Gestor de RH), NACC e DP. */
export const canSeeFullCandidate = (user, order) => RhAccess.canAct(user, order) || hasAnyRole(user, [Roles.Nacc, Roles.Dp]);

/** Quem baixa as evidências da posição: RH do pedido, NACC, DP e Gestor. */
export const canDownloadEvidence = (user, order) => canSeeFullCandidate(user, order) || hasRole(user, Roles.Manager);

/** Para quem não vê os dados completos, CPF mascarado e nascimento/sexo nulos (restricted = true). */
export const candidateDto = (c, full, names) => ({
  id: c.id,
  fullName: c.fullName,
  birthDate: full ? c.birthDate : null,
  sex: full ? c.sex : null,
  cpf: full ? Cpf.format(c.cpf) : Cpf.mask(c.cpf),
  restricted: !full,
  approvedAt: c.approvedAt,
  recordedAt: c.createdAt,
  recordedByName: c.createdBy ? names.get(c.createdBy) ?? null : null,
  updatedAt: c.updatedAt,
  updatedByName: c.updatedBy ? names.get(c.updatedBy) ?? null : null,
  withdrawnAt: c.withdrawnAt,
  withdrawalReason: c.withdrawalReason,
});

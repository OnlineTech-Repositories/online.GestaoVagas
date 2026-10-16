import { entity } from '../db/model.js';
import { addDays } from './dates.js';
import { BusinessRuleError } from './errors.js';
import {
  ClientDecision, DemandType, Labels, OrderApprovalStatus, PositionStatus as S, SlaTargetSource, TermType,
} from './enums.js';
import { Cpf } from './guards.js';

/**
 * Posição: cada vaga individual do pedido e unidade de controle do sistema. As transições da máquina de estados
 * (seção 6 da SPEC) ficam concentradas aqui; permissões e persistência ficam nos serviços.
 *
 * Funções sobre objetos simples (a entidade carregada pela unidade de trabalho), com as relações penduradas:
 * p.order, p.termination (desligamento que originou a reposição), p.exitTermination (desligamento do ocupante),
 * p.pauses, p.candidates, p.evidences, p.rate.
 */

const label = (status) => Labels.positionStatus[status] ?? status;

// ---------------------------------------------------------------- estado derivado

export const isClosed = (p) => p.status === S.CLOSED_CLIENT_CANCELLED || p.status === S.CLOSED_CONTRACT_ENDED;
/** "Estado aberto" = qualquer status exceto FILLED e CLOSED_*. */
export const isOpen = (p) => p.status !== S.FILLED && !isClosed(p);
export const activePause = (p) => (p.pauses ?? []).find((x) => !x.endDate) ?? null;
export const activeCandidate = (p) => (p.candidates ?? []).find((c) => !c.withdrawnAt) ?? null;
/** Ciclo atual da vaga: o ocupante ainda não foi desligado (o desligamento abre o próximo ciclo). */
export const isCurrentCycle = (p) => !p.exitTermination;
/** Reposição que o cliente decidiu não repor: a vaga termina aqui. */
export const notReplaced = (p) =>
  p.demandType === DemandType.REPLACEMENT && p.termination?.clientDecision === ClientDecision.NOT_REPLACE;
/** Status efetivo da etapa, ignorando a pausa (para saber o responsável pela próxima ação). */
export const stageStatus = (p) => (p.status === S.PAUSED && p.previousStatus ? p.previousStatus : p.status);
/** Admissão registrada, com ou sem matrícula, e o 1º dia ainda não confirmado. */
export const isAdmitted = (p) => p.status === S.IN_ADMISSION || p.status === S.AWAITING_FIRST_DAY;
/** Candidato selecionado (ou em admissão) sem candidato cadastrado: dados anteriores à regra do candidato. */
export const canRegisterMissingCandidate = (p) => !activeCandidate(p)
  && [S.CANDIDATE_APPROVED, S.IN_ADMISSION, S.AWAITING_FIRST_DAY].includes(stageStatus(p));
/** Seção 8.2: coalesce(end_date, today) - start_date. */
export const pauseDays = (pause, today) => Math.max(0, dayDiff(pause.startDate, pause.endDate ?? today));

const dayDiff = (a, b) => Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);

// ---------------------------------------------------------------- criação

function base(order, props) {
  return entity('Position', {
    orderId: order.id,
    sequence: null,
    slotNumber: null,
    cycle: 1,
    demandType: DemandType.NEW,
    originPositionId: null,
    terminationId: null,
    status: S.OPEN,
    previousStatus: null,
    desiredStartDate: null,
    openedAt: null,
    candidateApprovedAt: null,
    admissionAt: null,
    admissionRegistration: null,
    firstDayAt: null,
    employeeName: null,
    employeeRegistration: null,
    firstDayJustification: null,
    firstDayConfirmedAt: null,
    firstDayConfirmedBy: null,
    closedAt: null,
    cancellationReason: null,
    termType: order.termType,
    termEndDate: order.termEndDate,
    termDurationDays: order.termDurationDays,
    termAdjustJustification: null,
    rateId: null,
    slaTargetDays: null,
    slaTargetSource: SlaTargetSource.NONE,
    hasRetroactiveDates: false,
    ...props,
    order,
    termination: null,
    exitTermination: null,
    pauses: [],
    candidates: [],
    evidences: [],
  });
}

/**
 * RN-02: cada posição do pedido nasce NEW/OPEN, com os valores gravados na abertura (valor por cargo e meta de SLA).
 * `openedAt` nulo = pedido aguardando a aprovação do cliente: a posição abre (e o SLA começa) na aprovação.
 */
export function createNew(order, sequence, desiredStartDate, openedAt, rate, slaTargetDays, slaSource, slotNumber = null) {
  return base(order, {
    sequence,
    slotNumber: slotNumber ?? sequence,
    // Pedido com a publicação no JobConvo já informada: a posição acrescentada herda e nasce em recrutamento.
    status: hasJobconvoRecord(order) ? S.RECRUITING : S.OPEN,
    desiredStartDate,
    openedAt,
    rateId: rate?.id ?? null,
    rate: rate ?? null,
    slaTargetDays: slaTargetDays ?? null,
    slaTargetSource: slaSource,
  });
}

/** D1: posição de origem já preenchida, criada pelo desligamento avulso. */
export function createLegacyFilled(order, firstDayAt, employeeName, employeeRegistration, rate) {
  if (!employeeName?.trim() || !employeeRegistration?.trim()) {
    throw new BusinessRuleError('Informe o nome e a matrícula do colaborador.', 'employeeName');
  }
  return base(order, {
    sequence: 1,
    slotNumber: 1,
    status: S.FILLED,
    desiredStartDate: order.desiredStartDate,
    openedAt: firstDayAt,
    firstDayAt,
    employeeName: employeeName.trim(),
    employeeRegistration: employeeRegistration.trim(),
    rateId: rate?.id ?? null,
    rate: rate ?? null,
  });
}

/** RN-14: reposição no mesmo pedido (novo ciclo da mesma vaga), aguardando o cliente, herdando vigência e valor. */
export function createReplacement(origin, termination, sequence) {
  const replacement = base(origin.order, {
    sequence,
    slotNumber: origin.slotNumber,
    cycle: origin.cycle + 1,
    demandType: DemandType.REPLACEMENT,
    originPositionId: origin.id,
    terminationId: termination.id,
    status: S.AWAITING_CONFIRMATION,
    desiredStartDate: addDays(termination.lastWorkedDay, 1),
    termType: origin.termType,
    termEndDate: origin.termEndDate,
    termDurationDays: origin.termDurationDays,
    rateId: origin.rateId,
    rate: origin.rate ?? null,
  });
  replacement.termination = termination;
  termination.replacementPosition = replacement;
  return replacement;
}

/** RN-11/RN-12: desligamento só de posição FILLED e no máximo um por posição de origem. */
export function registerTermination(origin, alreadyTerminated, lastWorkedDay, source, type, notes, registeredAt) {
  if (alreadyTerminated || origin.exitTermination) {
    throw new BusinessRuleError('Já existe um desligamento registrado para esta posição.');
  }
  if (origin.status !== S.FILLED) {
    throw new BusinessRuleError('O desligamento só pode ser registrado para uma posição preenchida.');
  }
  const termination = entity('Termination', {
    originPositionId: origin.id,
    lastWorkedDay,
    source,
    terminationType: type,
    notes: notes?.trim() ? notes.trim() : null,
    clientDecision: null,
    clientDecisionAt: null,
    registeredAt,
    originPosition: origin,
    replacementPosition: null,
  });
  origin.exitTermination = termination;
  return termination;
}

// ---------------------------------------------------------------- transições

/** Decisão REPLACE: abre a reposição na data da decisão. */
export function confirmReplacement(p, decisionAt, slaTargetDays, slaSource) {
  ensureStatus(p, S.AWAITING_CONFIRMATION);
  const termination = requireTermination(p);
  termination.clientDecision = ClientDecision.REPLACE;
  termination.clientDecisionAt = decisionAt;
  p.openedAt = decisionAt;
  p.slaTargetDays = slaTargetDays ?? null;
  p.slaTargetSource = slaSource;
  p.status = S.OPEN;
  startRecruitingFromOrder(p); // a reposição herda a publicação do pedido
}

/** Decisão NOT_REPLACE: encerra sem perda (RN-15). */
export function declineReplacement(p, decisionAt) {
  ensureStatus(p, S.AWAITING_CONFIRMATION);
  const termination = requireTermination(p);
  termination.clientDecision = ClientDecision.NOT_REPLACE;
  termination.clientDecisionAt = decisionAt;
  p.closedAt = decisionAt;
  p.status = S.CLOSED_CLIENT_CANCELLED;
}

/**
 * RN-06: a posição entra em recrutamento quando o pedido tem a publicação no JobConvo informada. Pausada na etapa
 * "Aberta", volta da pausa já em recrutamento. Devolve true quando a etapa mudou.
 */
export function startRecruitingFromOrder(p) {
  if (!p.order || !hasJobconvoRecord(p.order)) return false;
  if (p.status === S.OPEN) {
    p.status = S.RECRUITING;
    return true;
  }
  if (p.status === S.PAUSED && p.previousStatus === S.OPEN) {
    p.previousStatus = S.RECRUITING;
    return true;
  }
  return false;
}

/** Aprovação do cliente: a vaga nova abre na data da aprovação e grava a meta de SLA (RN-19). */
export function openOnApproval(p, openedAt, slaTargetDays, slaSource) {
  if (p.demandType !== DemandType.NEW || p.openedAt) return;
  p.openedAt = openedAt;
  p.slaTargetDays = slaTargetDays ?? null;
  p.slaTargetSource = slaSource;
}

/** Aprova o candidato e registra os dados dele, individualizados por posição. */
export function approveCandidate(p, approvedAt, data, today) {
  ensureStatus(p, S.RECRUITING);
  ensureOrderApproved(p);
  const candidate = newCandidate(p, approvedAt, data, today);
  p.candidates.push(candidate);
  p.candidateApprovedAt = approvedAt;
  p.status = S.CANDIDATE_APPROVED;
  return candidate;
}

/**
 * Corrige os dados do candidato. Posição aprovada antes do cadastro de candidatos (sem candidato, em "Candidato
 * selecionado", "Em admissão" ou "Aguardando 1º dia"): registra o candidato com a data de aprovação já gravada.
 */
export function correctCandidate(p, data, today) {
  const current = activeCandidate(p);
  if (current) {
    applyCandidate(current, data, today);
    return current;
  }
  if (!canRegisterMissingCandidate(p)) throw new BusinessRuleError('A posição não tem candidato selecionado.');
  const created = newCandidate(p, p.candidateApprovedAt ?? today, data, today);
  p.candidates.push(created);
  return created;
}

/** Anexa a evidência de um marco: metadados na posição, conteúdo no arquivo de evidência. */
export function attachEvidence(p, kind, fileName, contentType, content) {
  const file = entity('EvidenceFile', { content, createdAt: null });
  const evidence = entity('PositionEvidence', {
    positionId: p.id, kind, fileName, contentType, sizeBytes: content.length, storageKey: file.id, file,
  });
  p.evidences.push(evidence);
  return evidence;
}

/**
 * Informa ou corrige a matrícula da admissão, antes da confirmação do 1º dia. Com a matrícula, a admissão está
 * concluída: a posição passa a "Aguardando 1º dia". Devolve true quando a admissão acabou de ser concluída.
 */
export function setAdmissionRegistration(p, registration) {
  if (!isAdmitted(p)) {
    throw new BusinessRuleError(
      `Ação não permitida: a posição está "${label(p.status)}". A matrícula é informada só antes da confirmação do 1º dia.`);
  }
  const value = registration?.trim();
  if (!value) throw new BusinessRuleError('Informe a matrícula.', 'registration');
  if (value.length > 50) throw new BusinessRuleError('A matrícula deve ter no máximo 50 caracteres.', 'registration');
  const completed = p.status === S.IN_ADMISSION;
  p.admissionRegistration = value;
  p.status = S.AWAITING_FIRST_DAY;
  return completed;
}

export function registerAdmission(p, admissionAt, registration = null) {
  ensureStatus(p, S.CANDIDATE_APPROVED);
  ensureOrderApproved(p);
  const value = registration?.trim() ? registration.trim() : null;
  if (value && value.length > 50) throw new BusinessRuleError('A matrícula deve ter no máximo 50 caracteres.', 'registration');
  p.admissionAt = admissionAt;
  p.admissionRegistration = value;
  // Com a matrícula, a admissão já está concluída e só falta a confirmação do 1º dia.
  p.status = value ? S.AWAITING_FIRST_DAY : S.IN_ADMISSION;
}

const MISSING_REGISTRATION =
  'A matrícula não foi informada na admissão: o RH do pedido ou o DP deve informá-la antes da confirmação.';

/**
 * RN-07/RN-08: 1º dia efetivo (≥ abertura). Nome e matrícula não são digitados aqui: vêm do candidato selecionado e
 * da admissão, e ficam preservados. Faltando algum, a correção é feita na origem antes da confirmação.
 */
export function confirmFirstDay(p, firstDayAt, justification, confirmedBy, confirmedAt) {
  if (p.status === S.IN_ADMISSION) throw new BusinessRuleError(MISSING_REGISTRATION, 'employeeRegistration');
  ensureStatus(p, S.AWAITING_FIRST_DAY);
  ensureOrderApproved(p);
  const candidate = activeCandidate(p);
  if (!candidate) {
    throw new BusinessRuleError(
      'A posição não tem candidato cadastrado: o RH do pedido deve registrar os dados do candidato antes da confirmação.',
      'employeeName');
  }
  if (!p.admissionRegistration) throw new BusinessRuleError(MISSING_REGISTRATION, 'employeeRegistration');
  if (!justification?.trim()) throw new BusinessRuleError('Informe a justificativa da confirmação do 1º dia.', 'justification');
  if (p.openedAt && firstDayAt < p.openedAt) {
    throw new BusinessRuleError('O 1º dia efetivo não pode ser anterior à data de abertura da posição.', 'date');
  }
  p.firstDayAt = firstDayAt;
  p.firstDayJustification = justification.trim();
  p.firstDayConfirmedAt = confirmedAt;
  p.firstDayConfirmedBy = confirmedBy;
  p.employeeName = candidate.fullName;
  p.employeeRegistration = p.admissionRegistration;
  p.status = S.FILLED;
}

/** Candidato desistiu: volta a recrutamento (o candidato fica no histórico da posição). */
export function candidateWithdrew(p, at) {
  ensureStatus(p, S.CANDIDATE_APPROVED);
  withdraw(activeCandidate(p), at, 'Candidato desistiu');
  p.candidateApprovedAt = null;
  p.status = S.RECRUITING;
}

/** Admitido não compareceu: volta a recrutamento (o candidato fica no histórico da posição). */
export function admissionNoShow(p, at) {
  if (!isAdmitted(p)) ensureStatus(p, S.IN_ADMISSION);
  withdraw(activeCandidate(p), at, 'Admitido não compareceu');
  p.admissionAt = null;
  p.admissionRegistration = null;
  p.status = S.RECRUITING;
}

/** RN-17: no máximo uma pausa ativa e sem sobreposição. */
export function startPause(p, reason, startDate) {
  if (!isOpen(p) || p.status === S.PAUSED) {
    throw new BusinessRuleError(`Não é possível pausar uma posição com status "${label(p.status)}".`);
  }
  if (activePause(p)) throw new BusinessRuleError('A posição já possui uma pausa ativa.');
  if (p.pauses.some((x) => x.endDate && x.endDate > startDate)) {
    throw new BusinessRuleError('A pausa não pode se sobrepor a outra pausa da posição.', 'date');
  }
  const pause = entity('Pause', { positionId: p.id, reasonId: reason.id, startDate, endDate: null, reason });
  p.pauses.push(pause);
  p.previousStatus = p.status;
  p.status = S.PAUSED;
  return pause;
}

export function endPause(p, endDate) {
  ensureStatus(p, S.PAUSED);
  const pause = activePause(p);
  if (!pause) throw new BusinessRuleError('A posição não possui pausa ativa.');
  if (endDate < pause.startDate) {
    throw new BusinessRuleError('A data de fim da pausa deve ser igual ou posterior à data de início.', 'date');
  }
  pause.endDate = endDate;
  p.status = p.previousStatus ?? S.OPEN;
  p.previousStatus = null;
  return pause;
}

/** Cancelamento pelo cliente (RN-10). Uma pausa ativa é encerrada na mesma data. */
export function cancel(p, closedAt, reason) {
  ensureOpen(p);
  if (!reason?.trim()) throw new BusinessRuleError('Informe o motivo do cancelamento.', 'reason');
  const pause = activePause(p);
  if (pause && closedAt < pause.startDate) {
    throw new BusinessRuleError('A data de cancelamento não pode ser anterior ao início da pausa ativa.', 'date');
  }
  close(p, S.CLOSED_CLIENT_CANCELLED, closedAt);
  p.cancellationReason = reason.trim();
}

/** Rotina diária: FIXED_END e hoje > data fim → CLOSED_CONTRACT_ENDED com closed_at = data fim + 1. */
export function closeByContractEnd(p, today) {
  if (!isOpen(p) || p.termType !== TermType.FIXED_END || !p.termEndDate || today <= p.termEndDate) return false;
  close(p, S.CLOSED_CONTRACT_ENDED, addDays(p.termEndDate, 1));
  return true;
}

/** RN-23: ajuste de vigência até FILLED, com justificativa. */
export function adjustTerm(p, type, endDate, durationDays, justification) {
  ensureOpen(p);
  if (!justification?.trim()) throw new BusinessRuleError('Informe a justificativa do ajuste de vigência.', 'justification');
  validateTerm(type, endDate, durationDays, p.desiredStartDate);
  const normalized = normalizeTerm(type, endDate, durationDays);
  p.termEndDate = normalized.endDate;
  p.termDurationDays = normalized.durationDays;
  p.termType = type;
  p.termAdjustJustification = justification.trim();
}

export const markRetroactive = (p) => {
  p.hasRetroactiveDates = true;
};

// ---------------------------------------------------------------- vigência (RN-03), compartilhada com o pedido

export function validateTerm(type, endDate, durationDays, desiredStartDate) {
  if (type === TermType.FIXED_END && !endDate) throw new BusinessRuleError('Informe a data fim da vigência.', 'termEndDate');
  if (type === TermType.FIXED_END && endDate < desiredStartDate) {
    throw new BusinessRuleError('A data fim da vigência deve ser igual ou posterior à data de início desejada.', 'termEndDate');
  }
  if (type === TermType.PRESERVED_DURATION && !(durationDays >= 1)) {
    throw new BusinessRuleError('Informe a duração da vigência em dias (mínimo 1).', 'termDurationDays');
  }
}

/** Mantém apenas os campos pertinentes ao tipo de vigência. */
export function normalizeTerm(type, endDate, durationDays) {
  if (type === TermType.FIXED_END) return { endDate, durationDays: null };
  if (type === TermType.PRESERVED_DURATION) return { endDate: null, durationDays };
  return { endDate: null, durationDays: null };
}

// ---------------------------------------------------------------- auxiliares

export const hasJobconvoRecord = (order) => order.jobconvoPublished !== null && order.jobconvoPublished !== undefined;

function close(p, status, closedAt) {
  const pause = activePause(p);
  if (pause) pause.endDate = closedAt < pause.startDate ? pause.startDate : closedAt;
  p.closedAt = closedAt;
  p.status = status;
  p.previousStatus = null;
}

/** Antes da aprovação do cliente o RH só prepara o recrutamento (até "Em recrutamento"). */
function ensureOrderApproved(p) {
  if (p.order && p.order.approvalStatus !== OrderApprovalStatus.APPROVED) {
    throw new BusinessRuleError(
      'O pedido ainda aguarda a aprovação do cliente: até lá, a posição pode avançar só até "Em recrutamento".');
  }
}

export function ensureOpen(p) {
  if (!isOpen(p)) throw new BusinessRuleError(`Ação não permitida: a posição está "${label(p.status)}".`);
}

function ensureStatus(p, expected) {
  if (p.status !== expected) {
    throw new BusinessRuleError(
      `Ação não permitida: a posição está "${label(p.status)}" e precisa estar "${label(expected)}".`);
  }
}

function requireTermination(p) {
  if (!p.termination) throw new Error('Desligamento da reposição não carregado.');
  return p.termination;
}

// ---------------------------------------------------------------- candidato

export const FULL_NAME_MAX_LENGTH = 200;
const SEXES = ['FEMALE', 'MALE', 'NOT_INFORMED'];

function newCandidate(p, approvedAt, data, today) {
  const candidate = entity('Candidate', {
    positionId: p.id, fullName: '', birthDate: null, sex: null, cpf: '', approvedAt, withdrawnAt: null,
    withdrawalReason: null,
  });
  applyCandidate(candidate, data, today);
  return candidate;
}

/** Valida e grava os dados: nome, nascimento (não futuro), sexo e CPF com dígitos verificadores. */
function applyCandidate(candidate, data, today) {
  const name = String(data.fullName ?? '').split(' ').filter(Boolean).join(' ');
  if (!name) throw new BusinessRuleError('Informe o nome completo do candidato.', 'fullName');
  if (name.length > FULL_NAME_MAX_LENGTH) {
    throw new BusinessRuleError(`O nome deve ter no máximo ${FULL_NAME_MAX_LENGTH} caracteres.`, 'fullName');
  }
  if (!data.birthDate) throw new BusinessRuleError('Informe a data de nascimento.', 'birthDate');
  if (data.birthDate > today) throw new BusinessRuleError('A data de nascimento não pode ser uma data futura.', 'birthDate');
  if (data.birthDate < '1900-01-01') throw new BusinessRuleError('Informe uma data de nascimento válida.', 'birthDate');
  if (!SEXES.includes(data.sex)) throw new BusinessRuleError('Selecione o sexo.', 'sex');
  const cpf = Cpf.require(data.cpf, 'cpf');
  candidate.fullName = name;
  candidate.birthDate = data.birthDate;
  candidate.sex = data.sex;
  candidate.cpf = cpf;
}

function withdraw(candidate, at, reason) {
  if (!candidate) return;
  candidate.withdrawnAt = at;
  candidate.withdrawalReason = reason;
}

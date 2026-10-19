import { inList, query, queryOne } from '../db/index.js';
import {
  findOpenWithCandidateCpf, getById, getPosition, listPositions as listPositionRows, userNames,
} from '../db/repository.js';
import { calculate, isLegacyOrigin } from '../domain/calculator.js';
import { addDays, formatBr, today as todayDate, utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import {
  CandidateSex, ClientDecision, DemandType, EvidenceKind, Labels, Modality, NotificationTypes, PositionStatus,
  RhStage, Roles, SlaSituation, TermType,
} from '../domain/enums.js';
import { Cpf, DateGuard, EvidenceFiles, hasRole, Permissions, RhAccess } from '../domain/guards.js';
import { activeRhAnalysts } from '../domain/order.js';
import * as P from '../domain/position.js';
import { Input, isId } from './input.js';
import { links, notify } from './notifications.js';
import { calcSettings, isInitialLoadOpen } from './parameters.js';
import {
  Actions, actionsFor, candidateDto, canDownloadEvidence, canSeeFullCandidate, ensureRole, terminationDto, toMetrics,
  toSummary,
} from './position-views.js';
import { slaFor } from './snapshots.js';

/** Posições: lista, detalhe e as ações da seção 6 (transições, pausas, vigência e correção de datas). */

// ---------------------------------------------------------------- consultas

export async function listPositionsDto(ctx, q) {
  const input = new Input(q);
  const filter = {
    openedFrom: input.date('openedFrom', { required: false }),
    openedTo: input.date('openedTo', { required: false }),
    clientId: input.id('clientId', { required: false }),
    contractId: input.id('contractId', { required: false }),
    orderId: input.id('orderId', { required: false }),
    modality: input.option('modality', Modality, { required: false }),
    jobRoleId: input.id('jobRoleId', { required: false }),
    demandType: input.option('demandType', DemandType, { required: false }),
    groupEntityId: input.id('groupEntityId', { required: false }),
    workLocationId: input.id('workLocationId', { required: false }),
    statuses: input.options('status', PositionStatus),
    onlyOpen: input.bool('onlyOpen', false),
    search: input.text('search'),
    currentCycleOnly: !input.bool('allCycles', false),
  };
  // "NOT_STARTED": vaga ainda sem contagem de SLA (vem do Painel de RH, como a etapa).
  const situations = input.options('slaSituation', { ...SlaSituation, NOT_STARTED: 'NOT_STARTED' });
  const stage = input.option('stage', RhStage, { required: false });
  const sort = input.text('sort');
  const rh = input.text('rh');
  const page = Math.max(1, input.int('page') ?? 1);
  const pageSize = Math.min(500, Math.max(1, input.int('pageSize') ?? 50));
  input.done();

  if (rh === 'UNASSIGNED') filter.rhUnassigned = true;
  else if (rh === 'MINE') filter.rhAnalystId = ctx.user.id;
  else if (rh && isId(rh)) filter.rhAnalystId = rh.toLowerCase();
  else if (rh) throw new BusinessRuleError('Filtro de analista de RH inválido.', 'rh');

  const settings = await calcSettings();
  const today = todayDate();
  const showMoney = Permissions.canSeeDetailedValues(ctx.user);
  let rows = (await listPositionRows(ctx.uow, filter))
    .filter((p) => !isLegacyOrigin(p))
    .map((p) => toSummary(p, calculate(p, today, settings), showMoney));
  if (situations.length) rows = rows.filter((r) => situations.includes(r.slaSituation ?? 'NOT_STARTED'));
  if (stage) rows = rows.filter((r) => r.rhStage === stage);
  rows.sort(sort === 'uncovered'
    ? (a, b) => b.uncoveredDays - a.uncoveredDays || a.orderNumber - b.orderNumber
    : (a, b) => b.orderNumber - a.orderNumber || a.slotNumber - b.slotNumber || a.cycle - b.cycle);
  return { items: rows.slice((page - 1) * pageSize, page * pageSize), total: rows.length };
}

export async function getPositionDetail(ctx, id) {
  const p = await getPosition(ctx.uow, id);
  if (!p) throw new NotFoundError('Posição não encontrada.');
  const today = todayDate();
  const metrics = calculate(p, today, await calcSettings());
  const showMoney = Permissions.canSeeDetailedValues(ctx.user);
  const order = p.order;
  const fullCandidate = canSeeFullCandidate(ctx.user, order);
  const names = await userNames([
    ...p.candidates.flatMap((c) => [c.createdBy, c.updatedBy]), ...p.evidences.map((e) => e.createdBy), p.firstDayConfirmedBy,
  ]);
  const canDownload = canDownloadEvidence(ctx.user, order);
  const firstDayEvidence = p.evidences.filter((e) => e.kind === EvidenceKind.FIRST_DAY)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null;
  const active = P.activeCandidate(p);

  return {
    summary: toSummary(p, metrics, showMoney),
    clientRequestDate: order.clientRequestDate,
    orderRegisteredAt: order.registeredAt,
    desiredStartDate: p.desiredStartDate,
    orderNotes: order.notes,
    jobDescription: order.jobDescription,
    isLegacyOrder: order.isLegacy,
    orderClientDecisionDate: order.clientDecisionDate,
    jobconvoPublished: order.jobconvoPublished,
    jobconvoCode: order.jobconvoCode,
    jobconvoPublishedAt: order.jobconvoPublishedAt,
    jobconvoNotes: order.jobconvoNotes,
    candidateApprovedAt: p.candidateApprovedAt,
    admissionAt: p.admissionAt,
    firstDayAt: p.firstDayAt,
    employeeName: p.employeeName,
    employeeRegistration: p.employeeRegistration,
    closedAt: p.closedAt,
    cancellationReason: p.cancellationReason,
    termType: p.termType,
    termEndDate: p.termEndDate,
    termDurationDays: p.termDurationDays,
    termAdjustJustification: p.termAdjustJustification,
    termination: p.termination ? terminationDto(p.termination) : null,
    exitTermination: p.exitTermination ? terminationDto(p.exitTermination) : null,
    pauses: [...p.pauses].sort((a, b) => a.startDate.localeCompare(b.startDate)).map((x) => ({
      id: x.id, reasonId: x.reasonId, reasonName: x.reason?.name ?? '', startDate: x.startDate, endDate: x.endDate,
      days: P.pauseDays(x, today),
    })),
    metrics: toMetrics(p, metrics, showMoney),
    allowedActions: actionsFor(p, ctx.user),
    history: await history(p, fullCandidate),
    rhAnalysts: activeRhAnalysts(order).map((a) => ({ id: a.userId, name: a.userName })),
    canActAsRh: RhAccess.canAct(ctx.user, order),
    candidate: active ? candidateDto(active, fullCandidate, names) : null,
    previousCandidates: p.candidates.filter((c) => c.withdrawnAt)
      .sort((a, b) => b.withdrawnAt.localeCompare(a.withdrawnAt))
      .map((c) => candidateDto(c, fullCandidate, names)),
    admissionRegistration: p.admissionRegistration,
    firstDay: p.firstDayAt ? {
      date: p.firstDayAt,
      justification: p.firstDayJustification,
      confirmedAt: p.firstDayConfirmedAt,
      confirmedByName: p.firstDayConfirmedBy ? names.get(p.firstDayConfirmedBy) ?? null : null,
      evidence: firstDayEvidence ? {
        id: firstDayEvidence.id,
        fileName: firstDayEvidence.fileName,
        contentType: firstDayEvidence.contentType,
        sizeBytes: firstDayEvidence.sizeBytes,
        uploadedAt: firstDayEvidence.createdAt,
        uploadedByName: firstDayEvidence.createdBy ? names.get(firstDayEvidence.createdBy) ?? null : null,
        canDownload,
      } : null,
    } : null,
  };
}

/** Campos técnicos que não interessam no histórico da tela. */
const NOISE = new Set(['UpdatedAt', 'UpdatedBy', 'FirstDayConfirmedAt', 'FirstDayConfirmedBy', 'StorageKey']);

async function history(p, fullCandidate) {
  const ids = [p.id, ...p.pauses.map((x) => x.id), ...p.candidates.map((x) => x.id), ...p.evidences.map((x) => x.id)];
  if (p.terminationId) ids.push(p.terminationId);
  if (p.exitTermination) ids.push(p.exitTermination.id);
  const list = inList(ids);
  const logs = await query(
    `SELECT * FROM audit_logs WHERE entity_id IN (${list.sql}) ORDER BY occurred_at DESC, id DESC`, ...list.params);
  const names = await userNames(logs.map((l) => l.user_id));
  return logs.filter((l) => !NOISE.has(l.field)).map((l) => ({
    timestamp: l.occurred_at,
    userName: l.user_id ? names.get(l.user_id) ?? null : 'Sistema',
    entity: l.entity,
    action: l.action,
    field: l.field,
    oldValue: protect(l, l.old_value, fullCandidate),
    newValue: protect(l, l.new_value, fullCandidate),
    justification: l.justification,
  }));
}

/** Dados pessoais do candidato no histórico: mascarados para quem não vê os dados completos (LGPD). */
function protect(log, value, fullCandidate) {
  if (fullCandidate || value === null || log.entity !== 'Candidate') return value;
  if (log.field === 'Cpf') return Cpf.mask(value);
  if (log.field === 'BirthDate' || log.field === 'Sex') return '(restrito)';
  if (log.field === null) return '(dados do candidato restritos)';
  return value;
}

// ---------------------------------------------------------------- comandos

/**
 * Molde de toda ação: carrega a posição, confere o perfil (o status é conferido pelo domínio), aplica a operação e
 * grava com o log de auditoria. Devolve o detalhe atualizado, que a tela redesenha.
 */
async function execute(ctx, id, action, justification, operation) {
  const p = await getPosition(ctx.uow, id);
  if (!p) throw new NotFoundError('Posição não encontrada.');
  ensureRole(p, ctx.user, action);
  const auditAction = await operation(p);
  await ctx.uow.save({ action: auditAction, justification: DateGuard.clean(justification) });
  return getPositionDetail(ctx, id);
}

/** Bloqueia datas futuras e aplica a RN-24 (data retroativa exige justificativa e sinaliza a posição). */
async function checkDate(p, date, label, justification, field) {
  const today = todayDate();
  DateGuard.notFuture(date, today, label, field);
  if (DateGuard.checkRetroactive(date, today, await isInitialLoadOpen(), justification, label)) P.markRetroactive(p);
}

export function decide(ctx, id, body) {
  const input = new Input(body);
  const decision = input.option('decision', ClientDecision, { message: 'Selecione a decisão do cliente.' });
  const decisionAt = input.date('decisionAt', { message: 'Informe a data da decisão.' });
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.Decide, justification, async (p) => {
    if (!p.termination) {
      throw new BusinessRuleError(`Ação não permitida: a posição está "${Labels.positionStatus[p.status]}".`);
    }
    if (decisionAt < p.termination.registeredAt) {
      throw new BusinessRuleError('A decisão do cliente não pode ser anterior ao registro do desligamento.', 'decisionAt');
    }
    await checkDate(p, decisionAt, 'A data da decisão', justification, 'decisionAt');
    if (decision === ClientDecision.REPLACE) {
      const order = p.order;
      const sla = await slaFor(order.contract, order.modality, DemandType.REPLACEMENT, decisionAt);
      P.confirmReplacement(p, decisionAt, sla.days, sla.source);
      await notifyPosition(ctx, p, NotificationTypes.ReplacementConfirmed, 'Reposição confirmada pelo cliente',
        P.hasJobconvoRecord(order)
          ? 'O cliente confirmou a reposição. Ela entrou em recrutamento com a publicação no JobConvo do pedido.'
          : 'O cliente confirmou a reposição. Informe a publicação no JobConvo no pedido para iniciar o recrutamento.',
        [Roles.Rh]);
      return 'CLIENT_DECISION_REPLACE';
    }
    P.declineReplacement(p, decisionAt);
    return 'CLIENT_DECISION_NOT_REPLACE';
  });
}

function candidateData(input) {
  return {
    fullName: input.text('fullName'),
    birthDate: input.date('birthDate', { required: false }),
    sex: input.option('sex', CandidateSex, { required: false }),
    cpf: input.text('cpf'),
  };
}

export function approveCandidate(ctx, id, body) {
  const input = new Input(body);
  const date = input.date('date');
  const data = candidateData(input);
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.ApproveCandidate, justification, async (p) => {
    await checkDate(p, date, 'A data de aprovação', justification, 'date');
    const candidate = P.approveCandidate(p, date, data, todayDate());
    await ensureCpfFree(p, candidate.cpf);
    return 'APPROVE_CANDIDATE';
  });
}

/** Correção dos dados do candidato pelo RH do pedido; quem e quando ficam no cadastro e no histórico. */
export function correctCandidate(ctx, id, body) {
  const input = new Input(body);
  const data = candidateData(input);
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.CorrectCandidate, justification, async (p) => {
    const candidate = P.correctCandidate(p, data, todayDate());
    await ensureCpfFree(p, candidate.cpf);
    return 'CORRECT_CANDIDATE';
  });
}

/** O mesmo CPF não pode ser o candidato selecionado de duas posições abertas. */
async function ensureCpfFree(p, cpf) {
  const other = await findOpenWithCandidateCpf(cpf, p.id);
  if (other) {
    throw new BusinessRuleError(
      `Este CPF já é o candidato selecionado da posição ${other.order_number}-${other.slot_number}, ainda aberta.`, 'cpf');
  }
}

export function registerAdmission(ctx, id, body) {
  const input = new Input(body);
  const date = input.date('date');
  const registration = input.text('registration');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.RegisterAdmission, justification, async (p) => {
    await checkDate(p, date, 'A data de admissão', justification, 'date');
    P.registerAdmission(p, date, registration);
    await notifyPosition(ctx, p, NotificationTypes.AdmissionRegistered, 'Admissão registrada',
      p.status === PositionStatus.AWAITING_FIRST_DAY
        ? `Admissão registrada em ${formatBr(date)}, com matrícula. Confirme o 1º dia efetivo do colaborador.`
        : `Admissão registrada em ${formatBr(date)}, sem matrícula. A confirmação do 1º dia fica liberada quando o RH ou o DP informar a matrícula.`,
      [Roles.Nacc]);
    return 'REGISTER_ADMISSION';
  });
}

/**
 * NACC confirma o 1º dia: justificativa obrigatória e evidência opcional (PDF, JPG ou PNG até 10 MB), gravadas na
 * mesma transação; quem confirmou e quando ficam na posição e no histórico.
 * @param {{ fileName: string, content: Buffer }|null} evidence
 */
export function confirmFirstDay(ctx, id, body, evidence = null) {
  const input = new Input(body);
  const date = input.date('date');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.ConfirmFirstDay, justification, async (p) => {
    const file = evidence ? EvidenceFiles.validate(evidence) : null;
    await checkDate(p, date, 'O 1º dia efetivo', justification, 'date');
    P.confirmFirstDay(p, date, justification, ctx.user.id, utcNow());
    if (file) P.attachEvidence(p, EvidenceKind.FIRST_DAY, file.fileName, file.contentType, evidence.content);
    return 'CONFIRM_FIRST_DAY';
  });
}

/** Informa ou corrige a matrícula da admissão (RH do pedido ou DP), antes da confirmação do 1º dia. */
export function correctRegistration(ctx, id, body) {
  const input = new Input(body);
  const registration = input.text('registration');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.CorrectRegistration, justification, async (p) => {
    if (P.setAdmissionRegistration(p, registration)) {
      await notifyPosition(ctx, p, NotificationTypes.AdmissionRegistered, 'Admissão concluída',
        'A matrícula foi informada e a admissão está concluída. Confirme o 1º dia efetivo do colaborador.', [Roles.Nacc]);
    }
    return 'CORRECT_REGISTRATION';
  });
}

/** Download da evidência: RH do pedido, NACC, DP e Gestor. */
export async function downloadEvidence(ctx, positionId, evidenceId) {
  const p = await getPosition(ctx.uow, positionId);
  if (!p) throw new NotFoundError('Posição não encontrada.');
  const evidence = p.evidences.find((e) => e.id === evidenceId);
  if (!evidence) throw new NotFoundError('Evidência não encontrada.');
  if (!canDownloadEvidence(ctx.user, p.order)) {
    throw new ForbiddenError('A evidência fica restrita ao RH do pedido, ao NACC, ao DP e ao Gestor.');
  }
  const row = await queryOne('SELECT content FROM evidence_files WHERE id = ?', evidence.storageKey);
  if (!row) throw new NotFoundError('O arquivo da evidência não foi encontrado.');
  return { content: Buffer.from(row.content), contentType: evidence.contentType, fileName: evidence.fileName };
}

export function candidateWithdrew(ctx, id, body) {
  const justification = new Input(body).text('justification');
  return execute(ctx, id, Actions.CandidateWithdrew, justification, async (p) => {
    P.candidateWithdrew(p, utcNow());
    return 'CANDIDATE_WITHDREW';
  });
}

export function admissionNoShow(ctx, id, body) {
  const justification = new Input(body).text('justification');
  return execute(ctx, id, Actions.AdmissionNoShow, justification, async (p) => {
    P.admissionNoShow(p, utcNow());
    return 'ADMISSION_NO_SHOW';
  });
}

export function startPause(ctx, id, body) {
  const input = new Input(body);
  const reasonId = input.id('reasonId', { message: 'Selecione o motivo da pausa.' });
  const startDate = input.date('startDate', { message: 'Informe a data de início da pausa.' });
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.StartPause, justification, async (p) => {
    const reason = await getById(ctx.uow, 'PauseReason', 'pause_reasons', reasonId);
    if (!reason?.active) throw new BusinessRuleError('Selecione um motivo de pausa cadastrado e ativo.', 'reasonId');
    await checkDate(p, startDate, 'A data de início da pausa', justification, 'startDate');
    P.startPause(p, reason, startDate);
    await notifyPosition(ctx, p, NotificationTypes.PauseStarted, 'Posição pausada',
      `Posição pausada a partir de ${formatBr(startDate)}. Motivo: ${reason.name}.`, [Roles.Rh]);
    return 'START_PAUSE';
  });
}

export function endPause(ctx, id, body) {
  const input = new Input(body);
  const date = input.date('date');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.EndPause, justification, async (p) => {
    await checkDate(p, date, 'A data de fim da pausa', justification, 'date');
    P.endPause(p, date);
    await notifyPosition(ctx, p, NotificationTypes.PauseEnded, 'Pausa encerrada',
      `A pausa da posição foi encerrada em ${formatBr(date)}. Status atual: ${Labels.positionStatus[p.status]}.`, [Roles.Rh]);
    return 'END_PAUSE';
  });
}

export function cancelPosition(ctx, id, body) {
  const input = new Input(body);
  const date = input.date('date');
  const reason = input.text('reason');
  input.done();
  return execute(ctx, id, Actions.Cancel, reason, async (p) => {
    DateGuard.notFuture(date, todayDate(), 'A data de cancelamento', 'date');
    P.cancel(p, date, reason);
    return 'CANCEL';
  });
}

export function adjustTerm(ctx, id, body) {
  const input = new Input(body);
  const termType = input.option('termType', TermType, { message: 'Selecione o tipo de vigência.' });
  const termEndDate = input.date('termEndDate', { required: false });
  const termDurationDays = input.int('termDurationDays');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.AdjustTerm, justification, async (p) => {
    P.adjustTerm(p, termType, termEndDate, termDurationDays, justification);
    return 'ADJUST_TERM';
  });
}

const CORRECTABLE = Object.freeze({
  CANDIDATE_APPROVED_AT: 'CANDIDATE_APPROVED_AT',
  ADMISSION_AT: 'ADMISSION_AT',
  FIRST_DAY_AT: 'FIRST_DAY_AT',
  CLOSED_AT: 'CLOSED_AT',
  CLIENT_DECISION_AT: 'CLIENT_DECISION_AT',
  LAST_WORKED_DAY: 'LAST_WORKED_DAY',
  TERMINATION_REGISTERED_AT: 'TERMINATION_REGISTERED_AT',
  PAUSE_START: 'PAUSE_START',
  PAUSE_END: 'PAUSE_END',
});

/** RN-25: correção de data já registrada, pelo autor do marco ou ADMIN, com justificativa. */
export function correctDate(ctx, id, body) {
  const input = new Input(body);
  const field = input.option('field', CORRECTABLE, { message: 'Selecione a data a corrigir.' });
  const pauseId = input.id('pauseId', { required: false });
  const date = input.date('date');
  const justification = input.text('justification');
  input.done();
  return execute(ctx, id, Actions.CorrectDates, justification, async (p) => {
    DateGuard.requireText(justification, 'Informe a justificativa da correção.', 'justification');
    if (field !== CORRECTABLE.LAST_WORKED_DAY) DateGuard.notFuture(date, todayDate(), 'A data corrigida', 'date');
    const target = targetOf(p, field, pauseId);
    if (!target.current) throw new BusinessRuleError('Esta data ainda não foi registrada; não há o que corrigir.');
    await ensureAuthor(ctx, target);
    applyCorrection(p, field, pauseId, date);
    return 'CORRECT_DATE';
  });
}

function targetOf(p, field, pauseId) {
  const t = () => {
    if (!p.termination) throw new BusinessRuleError('Esta posição não é uma reposição.');
    return p.termination;
  };
  const pause = () => {
    const found = p.pauses.find((x) => x.id === pauseId);
    if (!found) throw new BusinessRuleError('Pausa não encontrada.');
    return found;
  };
  const position = (property, current) => ({ entity: 'Position', id: p.id, property, current, createdBy: p.createdBy });
  switch (field) {
    case CORRECTABLE.CANDIDATE_APPROVED_AT: return position('CandidateApprovedAt', p.candidateApprovedAt);
    case CORRECTABLE.ADMISSION_AT: return position('AdmissionAt', p.admissionAt);
    case CORRECTABLE.FIRST_DAY_AT: return position('FirstDayAt', p.firstDayAt);
    case CORRECTABLE.CLOSED_AT:
      if (p.status !== PositionStatus.CLOSED_CLIENT_CANCELLED || p.termination?.clientDecision === ClientDecision.NOT_REPLACE) {
        throw new BusinessRuleError('Apenas a data de cancelamento pode ser corrigida aqui.');
      }
      return position('ClosedAt', p.closedAt);
    case CORRECTABLE.CLIENT_DECISION_AT:
      return { entity: 'Termination', id: t().id, property: 'ClientDecisionAt', current: t().clientDecisionAt, createdBy: t().createdBy };
    case CORRECTABLE.LAST_WORKED_DAY:
      return { entity: 'Termination', id: t().id, property: 'LastWorkedDay', current: t().lastWorkedDay, createdBy: t().createdBy };
    case CORRECTABLE.TERMINATION_REGISTERED_AT:
      return { entity: 'Termination', id: t().id, property: 'RegisteredAt', current: t().registeredAt, createdBy: t().createdBy };
    case CORRECTABLE.PAUSE_START:
      return { entity: 'Pause', id: pause().id, property: 'StartDate', current: pause().startDate, createdBy: pause().createdBy };
    default:
      return { entity: 'Pause', id: pause().id, property: 'EndDate', current: pause().endDate, createdBy: pause().createdBy };
  }
}

/** Só o autor do marco (quem gravou o valor atual, pelo log) ou um administrador corrige a data. */
async function ensureAuthor(ctx, target) {
  if (hasRole(ctx.user, Roles.Admin)) return;
  const row = await queryOne(
    `SELECT user_id FROM audit_logs WHERE entity = ? AND entity_id = ? AND field = ? AND new_value IS NOT NULL
      ORDER BY occurred_at DESC, id DESC LIMIT 1`, target.entity, target.id, target.property);
  const author = row?.user_id ?? target.createdBy;
  if (!author || author !== ctx.user.id) {
    throw new ForbiddenError('Somente o autor do registro ou um administrador pode corrigir esta data.');
  }
}

function applyCorrection(p, field, pauseId, date) {
  switch (field) {
    case CORRECTABLE.CANDIDATE_APPROVED_AT:
      p.candidateApprovedAt = date;
      break;
    case CORRECTABLE.ADMISSION_AT:
      p.admissionAt = date;
      break;
    case CORRECTABLE.FIRST_DAY_AT:
      if (p.openedAt && date < p.openedAt) {
        throw new BusinessRuleError('O 1º dia efetivo não pode ser anterior à data de abertura da posição.', 'date');
      }
      p.firstDayAt = date;
      break;
    case CORRECTABLE.CLOSED_AT:
      p.closedAt = date;
      break;
    case CORRECTABLE.CLIENT_DECISION_AT: {
      const t = p.termination;
      if (date < t.registeredAt) {
        throw new BusinessRuleError('A decisão do cliente não pode ser anterior ao registro do desligamento.', 'date');
      }
      if (p.firstDayAt && date > p.firstDayAt) {
        throw new BusinessRuleError('A decisão do cliente não pode ser posterior ao 1º dia efetivo.', 'date');
      }
      t.clientDecisionAt = date;
      if (t.clientDecision === ClientDecision.REPLACE) p.openedAt = date;
      else p.closedAt = date;
      break;
    }
    case CORRECTABLE.LAST_WORKED_DAY:
      p.termination.lastWorkedDay = date;
      p.desiredStartDate = addDays(date, 1);
      break;
    case CORRECTABLE.TERMINATION_REGISTERED_AT:
      if (p.termination.clientDecisionAt && date > p.termination.clientDecisionAt) {
        throw new BusinessRuleError('O registro do desligamento não pode ser posterior à decisão do cliente.', 'date');
      }
      p.termination.registeredAt = date;
      break;
    default: {
      const pause = p.pauses.find((x) => x.id === pauseId);
      const start = field === CORRECTABLE.PAUSE_START ? date : pause.startDate;
      const end = field === CORRECTABLE.PAUSE_END ? date : pause.endDate;
      if (end && end < start) {
        throw new BusinessRuleError('A data de fim da pausa deve ser igual ou posterior à data de início.', 'date');
      }
      const overlaps = p.pauses.filter((x) => x.id !== pause.id)
        .some((x) => start < (x.endDate ?? '9999-12-31') && x.startDate < (end ?? '9999-12-31'));
      if (overlaps) throw new BusinessRuleError('A pausa não pode se sobrepor a outra pausa da posição.', 'date');
      pause.startDate = start;
      pause.endDate = end;
    }
  }
}

// ---------------------------------------------------------------- avisos

/**
 * Avisos ao RH vão para os analistas responsáveis pelo pedido e para os gestores de RH (que redistribuem as
 * demandas); os demais perfis recebem por perfil.
 */
async function notifyPosition(ctx, p, type, subject, detail, roles) {
  const order = p.order;
  const rh = roles.includes(Roles.Rh);
  await notify(ctx.uow, {
    type, entityId: p.id, subject: `${subject} — Pedido ${order.number}`, message: `${describe(p)}: ${detail}`,
    link: links.position(p.id),
  }, {
    roles: rh ? [...roles.filter((r) => r !== Roles.Rh), Roles.RhManager] : roles,
    userIds: rh ? activeRhAnalysts(order).map((a) => a.userId) : null,
  });
}

export function describe(p) {
  const order = p.order;
  return `${Labels.demandType[p.demandType]} — ${order.jobRole?.name} — ${order.contract?.client?.legalName} `
    + `(pedido ${order.number}, posição ${p.slotNumber}${p.cycle > 1 ? `, reposição nº ${p.cycle - 1}` : ''})`;
}

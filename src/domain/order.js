import { entity } from '../db/model.js';
import { BusinessRuleError } from './errors.js';
import { DemandType, Labels, OrderApprovalStatus as A, OrderStatus, PositionStatus } from './enums.js';
import { cancel, activePause, isCurrentCycle, isOpen, startRecruitingFromOrder } from './position.js';

/**
 * Pedido: solicitação do cliente de um cargo em determinada quantidade. Relações penduradas no objeto:
 * order.contract (com client, contractingUnit, groupEntity), order.jobRole, order.workLocation, order.positions,
 * order.rhAnalysts.
 */

export const isApproved = (o) => o.approvalStatus === A.APPROVED;

/** Analistas de RH responsáveis, ativos, em ordem de nome. */
export const activeRhAnalysts = (o) =>
  (o.rhAnalysts ?? []).filter((a) => !a.removedAt).sort((a, b) => a.userName.localeCompare(b.userName, 'pt-BR'));

/** "Aguardando atribuição do RH": pedido em andamento, com posição aberta e sem analista responsável. */
export const awaitingRhAssignment = (o) =>
  o.approvalStatus !== A.NOT_APPROVED && (o.positions ?? []).some(isOpen) && activeRhAnalysts(o).length === 0;

/** Uma posição por vaga: o ciclo atual de cada uma (reposições substituem o ciclo anterior). */
export const currentPositions = (o) => (o.positions ?? []).filter(isCurrentCycle);

/** Status do pedido pelo ciclo atual de cada vaga (um colaborador desligado não conta como vaga preenchida). */
export function computeStatus(positions) {
  const current = positions.filter(isCurrentCycle);
  if (current.length === 0 || current.some(isOpen)) return OrderStatus.IN_PROGRESS;
  return current.some((p) => p.status === PositionStatus.FILLED) ? OrderStatus.FULFILLED : OrderStatus.CANCELLED;
}

/**
 * Aprovação formal do cliente. Devolve as vagas novas ainda sem abertura: quem chama grava a meta de SLA de cada
 * uma na data da aprovação (openOnApproval).
 */
export function approve(o, decisionDate, recordedBy, recordedAt) {
  ensureAwaitingApproval(o);
  if (decisionDate < o.clientRequestDate) {
    throw new BusinessRuleError('A aprovação não pode ser anterior à solicitação do cliente.', 'date');
  }
  o.approvalStatus = A.APPROVED;
  o.clientDecisionDate = decisionDate;
  o.approvalRecordedAt = recordedAt;
  o.approvalRecordedBy = recordedBy;
  return o.positions.filter((p) => p.demandType === DemandType.NEW && !p.openedAt && isOpen(p));
}

/** O cliente não aprovou: as posições abertas são encerradas como "cliente cancelou", sem perda. */
export function reject(o, decisionDate, reason, recordedBy, recordedAt) {
  ensureAwaitingApproval(o);
  const text = reason?.trim();
  if (!text) throw new BusinessRuleError('Informe o motivo da não aprovação.', 'reason');
  if (decisionDate < o.clientRequestDate) {
    throw new BusinessRuleError('A decisão não pode ser anterior à solicitação do cliente.', 'date');
  }
  o.approvalStatus = A.NOT_APPROVED;
  o.clientDecisionDate = decisionDate;
  o.approvalRecordedAt = recordedAt;
  o.approvalRecordedBy = recordedBy;
  o.notApprovedReason = text;
  for (const p of o.positions.filter(isOpen)) {
    const pause = activePause(p);
    cancel(p, pause && decisionDate < pause.startDate ? pause.startDate : decisionDate, `Cliente não aprovou o pedido: ${text}`);
  }
}

/**
 * RN-06 no pedido: registra (ou atualiza) a publicação no JobConvo. Publicado exige código e data; não publicado
 * exige justificativa. As posições abertas passam a "Em recrutamento"; as que entrarem depois herdam.
 * Devolve as posições que mudaram de etapa.
 */
export function recordJobconvo(o, published, code, publishedAt, notes, recordedBy, recordedAt) {
  if (o.approvalStatus === A.NOT_APPROVED) {
    throw new BusinessRuleError('O cliente não aprovou este pedido: não há recrutamento a registrar.');
  }
  const cleanNotes = notes?.trim() ? notes.trim() : null;
  if (published) {
    if (!code?.trim()) throw new BusinessRuleError('Informe o código da vaga no JobConvo.', 'code');
    if (!publishedAt) throw new BusinessRuleError('Informe a data da publicação.', 'publishedAt');
    if (publishedAt < o.clientRequestDate) {
      throw new BusinessRuleError('A publicação não pode ser anterior à solicitação do cliente.', 'publishedAt');
    }
    o.jobconvoCode = code.trim();
    o.jobconvoPublishedAt = publishedAt;
  } else {
    if (!cleanNotes) throw new BusinessRuleError('Informe a justificativa de não publicar a vaga no JobConvo.', 'justification');
    o.jobconvoCode = null;
    o.jobconvoPublishedAt = null;
  }
  o.jobconvoPublished = published;
  o.jobconvoNotes = cleanNotes;
  o.jobconvoRecordedAt = recordedAt;
  o.jobconvoRecordedBy = recordedBy;
  return o.positions.filter((p) => startRecruitingFromOrder(p));
}

/**
 * Define os analistas de RH responsáveis (inclui, substitui ou remove). Quem sai é removido logicamente, mantendo o
 * histórico. Devolve quem entrou e quem saiu, para os avisos.
 */
export function setRhAnalysts(o, analysts, changedBy, changedAt) {
  if (o.approvalStatus === A.NOT_APPROVED) {
    throw new BusinessRuleError('O cliente não aprovou este pedido: não há atendimento a distribuir.');
  }
  const wanted = [...new Map(analysts.map((a) => [a.id, a])).values()];
  const removed = o.rhAnalysts.filter((a) => !a.removedAt && !wanted.some((w) => w.id === a.userId));
  for (const a of removed) {
    a.removedAt = changedAt;
    a.removedBy = changedBy;
  }
  const isActive = (id) => o.rhAnalysts.some((a) => !a.removedAt && a.userId === id);
  const added = wanted.filter((w) => !isActive(w.id)).map((w) => entity('OrderRhAnalyst', {
    orderId: o.id, userId: w.id, userName: w.name, assignedAt: changedAt, assignedBy: changedBy,
    removedAt: null, removedBy: null,
  }));
  o.rhAnalysts.push(...added);
  return { added, removed };
}

function ensureAwaitingApproval(o) {
  if (o.approvalStatus !== A.AWAITING_CLIENT_APPROVAL) {
    throw new BusinessRuleError(`O pedido já está "${Labels.approvalStatus[o.approvalStatus]}".`);
  }
}

/** Novo pedido (sem número: a unidade de trabalho atribui o próximo na gravação). */
export function newOrder(props) {
  return entity('Order', {
    number: null,
    notes: null,
    jobDescription: null,
    isLegacy: false,
    approvalStatus: A.AWAITING_CLIENT_APPROVAL,
    clientDecisionDate: null,
    approvalRecordedAt: null,
    approvalRecordedBy: null,
    notApprovedReason: null,
    jobconvoPublished: null,
    jobconvoCode: null,
    jobconvoPublishedAt: null,
    jobconvoNotes: null,
    jobconvoRecordedAt: null,
    jobconvoRecordedBy: null,
    termEndDate: null,
    termDurationDays: null,
    positions: [],
    rhAnalysts: [],
    ...props,
  });
}

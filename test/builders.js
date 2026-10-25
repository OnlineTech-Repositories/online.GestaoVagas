import { entity } from '../src/db/model.js';
import {
  CandidateSex, Modality, OrderApprovalStatus, RateStatus, SlaTargetSource, TermType, TerminationSource, TerminationType,
} from '../src/domain/enums.js';
import { newOrder, recordJobconvo } from '../src/domain/order.js';
import * as P from '../src/domain/position.js';

/** Cenários dos casos de teste da seção 8.7 (valor mensal R$ 3.000,00 → diário R$ 100,00). */

export const NOW = '2026-10-16T12:00:00.000Z';

/** Candidato válido (CPF 529.982.247-25, exemplo clássico de CPF válido). */
/** Candidato com nascimento e CPF já gravados (registro anterior à admissão com esses campos). */
export const candidate = (cpf = '52998224725') => ({
  fullName: 'Maria da Silva', phone: '11912345678', birthDate: '1995-04-10', sex: CandidateSex.FEMALE, cpf,
});

export const rate = (status = RateStatus.VALIDATED) =>
  entity('ContractRate', { monthlyValue: 3000, validFrom: '2026-01-01', status });

export function order({ modality = Modality.MOT, term = TermType.INDEFINITE, desired = '2026-12-01', termEnd = null,
  duration = null } = {}) {
  return newOrder({
    modality,
    quantity: 1,
    clientRequestDate: desired,
    desiredStartDate: desired,
    registeredAt: desired,
    termType: term,
    termEndDate: termEnd,
    termDurationDays: duration,
    approvalStatus: OrderApprovalStatus.APPROVED,
    clientDecisionDate: desired,
  });
}

export function newPosition(o, { rateValue = rate(), slaDays = null, openedAt = null } = {}) {
  const p = P.createNew(o, o.positions.length + 1, o.desiredStartDate, openedAt ?? o.registeredAt, rateValue, slaDays,
    slaDays === null ? SlaTargetSource.NONE : SlaTargetSource.CONTRACT);
  o.positions.push(p);
  return p;
}

/** RN-06: a publicação no JobConvo é do pedido; as posições abertas dele entram em recrutamento. */
export const recruit = (p) => recordJobconvo(p.order, true, 'JC-1', p.order.clientRequestDate, null, null, NOW);

/** Leva a posição de OPEN até FILLED pelo fluxo completo. */
export function fill(p, firstDay) {
  recruit(p);
  P.approveCandidate(p, firstDay, candidate(), firstDay);
  P.registerAdmission(p, firstDay, 'M-1');
  P.confirmFirstDay(p, firstDay, 'Confirmado pelo cliente', null, NOW);
}

/** Posição FILLED de origem + desligamento + reposição AWAITING_CONFIRMATION. */
export function replacement(lastWorkedDay, registeredAt, { term = TermType.INDEFINITE, rateValue = rate() } = {}) {
  const o = order({ term, desired: '2026-01-05' });
  const origin = newPosition(o, { rateValue });
  fill(origin, '2026-01-05');
  const termination = P.registerTermination(origin, false, lastWorkedDay, TerminationSource.DP,
    TerminationType.RESIGNATION, null, registeredAt);
  const r = P.createReplacement(origin, termination, 2);
  o.positions.push(r);
  return { origin, termination, replacement: r };
}

/** Motivo de pausa qualquer. */
export const reason = () => entity('PauseReason', { name: 'Aguardando o cliente', active: true });

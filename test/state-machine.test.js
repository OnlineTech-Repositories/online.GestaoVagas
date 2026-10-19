import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate } from '../src/domain/calculator.js';
import { BusinessRuleError } from '../src/domain/errors.js';
import {
  DemandType, OrderApprovalStatus, OrderStatus, PositionStatus as S, SlaTargetSource, TermType, TerminationSource,
  TerminationType,
} from '../src/domain/enums.js';
import { ContractCode } from '../src/domain/guards.js';
import { dateFlags, orderDateIssues, positionDateIssues } from '../src/domain/date-checks.js';
import { approve, computeStatus, isApproved, recordJobconvo, reject } from '../src/domain/order.js';
import * as P from '../src/domain/position.js';
import { candidate, fill, NOW, newPosition, order, rate, reason, recruit, replacement } from './builders.js';

/** Máquina de estados da posição (seção 6), aprovação do cliente e código do contrato. */

const throwsRule = (fn, check = () => true) => assert.throws(fn, (e) => e instanceof BusinessRuleError && check(e));

test('recrutamento exige o código do JobConvo', () => {
  const p = newPosition(order());
  throwsRule(() => recordJobconvo(p.order, true, ' ', '2026-12-01', null, null, NOW));
  assert.equal(p.status, S.OPEN);
});

test('1º dia antes da abertura e da admissão não bloqueia: fica sinalizado como fora de sequência', () => {
  const p = newPosition(order({ desired: '2026-12-01' }));
  recruit(p);
  P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02');
  P.registerAdmission(p, '2026-12-03', 'M1');
  P.confirmFirstDay(p, '2026-11-30', 'Ok', null, NOW);
  assert.equal(p.status, S.FILLED);
  const keys = positionDateIssues(p, '2026-12-10').map((i) => i.key);
  assert.ok(keys.includes('p:firstDay<opened') && keys.includes('p:firstDay<admission'), keys.join(', '));
  assert.deepEqual(dateFlags(p, '2026-12-10'), { future: false, sequence: true });
});

test('transições fora de ordem são bloqueadas', () => {
  const p = newPosition(order());
  throwsRule(() => P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02'));
  throwsRule(() => P.confirmFirstDay(p, '2026-12-02', 'Ok', null, NOW));
});

test('desistência do candidato volta a recrutamento e limpa a data', () => {
  const p = newPosition(order());
  recruit(p);
  P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02');
  P.candidateWithdrew(p, NOW);
  assert.equal(p.status, S.RECRUITING);
  assert.equal(p.candidateApprovedAt, null);
});

test('não comparecimento à admissão volta a recrutamento e limpa a data', () => {
  const p = newPosition(order());
  recruit(p);
  P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02');
  P.registerAdmission(p, '2026-12-03');
  P.admissionNoShow(p, NOW);
  assert.equal(p.status, S.RECRUITING);
  assert.equal(p.admissionAt, null);
});

test('a pausa volta ao status anterior', () => {
  const p = newPosition(order());
  recruit(p);
  P.startPause(p, reason(), '2026-12-05');
  assert.equal(p.status, S.PAUSED);
  assert.equal(p.previousStatus, S.RECRUITING);
  P.endPause(p, '2026-12-07');
  assert.equal(p.status, S.RECRUITING);
  assert.equal(p.previousStatus, null);
});

test('uma pausa ativa só, e sem sobreposição', () => {
  const p = newPosition(order());
  P.startPause(p, reason(), '2026-12-05');
  throwsRule(() => P.startPause(p, reason(), '2026-12-06'));
  P.endPause(p, '2026-12-10');
  throwsRule(() => P.startPause(p, reason(), '2026-12-08'));
  P.startPause(p, reason(), '2026-12-10');
});

test('o cancelamento encerra a pausa ativa e exige motivo', () => {
  const p = newPosition(order());
  P.startPause(p, reason(), '2026-12-05');
  throwsRule(() => P.cancel(p, '2026-12-08', ''));
  P.cancel(p, '2026-12-08', 'Cliente desistiu');
  assert.equal(p.status, S.CLOSED_CLIENT_CANCELLED);
  assert.equal(p.pauses[0].endDate, '2026-12-08');
});

test('desligamento só de posição preenchida', () => {
  const p = newPosition(order());
  throwsRule(() => P.registerTermination(p, false, '2026-12-01', TerminationSource.DP, TerminationType.RESIGNATION, null,
    '2026-12-01'));
});

test('a reposição herda a vigência e o valor', () => {
  const { origin, replacement: r } = replacement('2026-11-10', '2026-11-12', { term: TermType.FIXED_END });
  assert.equal(r.status, S.AWAITING_CONFIRMATION);
  assert.equal(r.demandType, DemandType.REPLACEMENT);
  assert.equal(r.termType, origin.termType);
  assert.equal(r.rateId, origin.rateId);
  assert.equal(r.openedAt, null);
});

test('ajuste de vigência exige justificativa e posição aberta', () => {
  const p = newPosition(order({ desired: '2026-12-01' }));
  throwsRule(() => P.adjustTerm(p, TermType.FIXED_END, '2026-12-31', null, ''));
  P.adjustTerm(p, TermType.FIXED_END, '2026-12-31', null, 'Cliente estendeu');
  assert.equal(p.termEndDate, '2026-12-31');
  fill(p, '2026-12-03');
  throwsRule(() => P.adjustTerm(p, TermType.INDEFINITE, null, null, 'x'));
});

test('o status do pedido é calculado', () => {
  const o = order();
  const a = newPosition(o);
  const b = newPosition(o);
  assert.equal(computeStatus(o.positions), OrderStatus.IN_PROGRESS);
  fill(a, '2026-12-01');
  P.cancel(b, '2026-12-02', 'Redução');
  assert.equal(computeStatus(o.positions), OrderStatus.FULFILLED);

  const other = order();
  P.cancel(newPosition(other), '2026-12-02', 'Cancelado');
  assert.equal(computeStatus(other.positions), OrderStatus.CANCELLED);
});

// ---------------------------------------------------------------- aprovação do cliente

function awaitingOrder() {
  const o = order({ desired: '2026-11-10' });
  Object.assign(o, {
    approvalStatus: OrderApprovalStatus.AWAITING_CLIENT_APPROVAL, clientDecisionDate: null,
    clientRequestDate: '2026-11-01', registeredAt: '2026-11-03',
  });
  const p = P.createNew(o, 1, o.desiredStartDate, null, rate(), null, SlaTargetSource.NONE);
  o.positions.push(p);
  return { o, p };
}

const defaults = { atRiskDays: 2, lossOnCancelAfterOpen: true };

test('aguardando aprovação: sem abertura nem SLA, mas os dias descobertos contam', () => {
  const { p } = awaitingOrder();
  const m = calculate(p, '2026-11-20', defaults);
  assert.equal(p.openedAt, null);
  assert.equal(m.slaSituation, null);
  assert.equal(m.fillTime, null);
  assert.equal(m.uncoveredDays, 10); // desde o início desejado (10/11), como na pausa (RN-18)
  assert.equal(m.approvalWaitTime, 17); // registro 03/11 → hoje 20/11
  assert.equal(m.lost, 1000);
});

test('aguardando aprovação: o RH prepara até "Em recrutamento", mas não aprova candidato', () => {
  const { p } = awaitingOrder();
  recruit(p);
  throwsRule(() => P.approveCandidate(p, '2026-11-05', candidate(), '2026-11-05'),
    (e) => e.message.includes('aguarda a aprovação do cliente'));
});

test('a aprovação abre as posições na data dela e o SLA começa ali', () => {
  const { o, p } = awaitingOrder();
  recruit(p);
  for (const x of approve(o, '2026-11-12', 'u', NOW)) P.openOnApproval(x, '2026-11-12', 10, SlaTargetSource.CONTRACT);
  const m = calculate(p, '2026-11-20', defaults);
  assert.ok(isApproved(o));
  assert.equal(p.openedAt, '2026-11-12');
  assert.equal(m.slaDeadline, '2026-11-22');
  assert.equal(m.fillTime, 8);
  assert.equal(m.approvalWaitTime, 9); // registro 03/11 → aprovação 12/11
  P.approveCandidate(p, '2026-11-20', candidate(), '2026-11-20'); // liberado depois da aprovação
});

test('a aprovação não acontece duas vezes; antes da solicitação, só sinaliza', () => {
  const { o } = awaitingOrder();
  approve(o, '2026-10-30', null, NOW);
  assert.ok(orderDateIssues(o, '2026-11-20').some((i) => i.key === 'order:decision<request'));
  throwsRule(() => approve(o, '2026-11-06', null, NOW));
});

test('a recusa encerra todas as posições, sem perda', () => {
  const { o, p } = awaitingOrder();
  reject(o, '2026-11-15', 'Cliente desistiu da contratação', null, NOW);
  const m = calculate(p, '2026-11-20', defaults);
  assert.equal(o.approvalStatus, OrderApprovalStatus.NOT_APPROVED);
  assert.equal(p.status, S.CLOSED_CLIENT_CANCELLED);
  assert.equal(m.lost, 0);
  assert.equal(m.deferred, 0);
  throwsRule(() => reject(o, '2026-11-16', '', null, NOW));
});

// ---------------------------------------------------------------- código do contrato

for (const [source, expected] of [
  ['LJ-001', 'LJ-001'],
  ['Loja Moema', 'LOJA-MOEMA'],
  ['Logística Exemplo Ltda (demo)', 'LOGISTICA-EXEMPLO'],
  ['CENCOSUD', 'CENCOSUD'],
  ['Supermercados São João do Rio Preto', 'SUPERMERCADOS-SAO'],
  ['Abcdefghijklmnopqrstuvwxyz', 'ABCDEFGHIJKLMNOPQRST'],
  ['  ###  ', 'CLIENTE'],
]) {
  test(`código do contrato: "${source}" → ${expected}`, () => {
    const segment = ContractCode.segment(source);
    assert.equal(segment, expected);
    assert.ok(segment.length <= ContractCode.SEGMENT_MAX_LENGTH);
  });
}

test('código do contrato segue o padrão CT-AAAA-UNIDADE-SEQUENCIAL', () => {
  assert.equal(ContractCode.build(2026, 'LOJA-MOEMA', 1), 'CT-2026-LOJA-MOEMA-0001');
});

test('o sequencial conta só o mesmo ano e a mesma unidade', () => {
  const existing = ['CT-2026-LJ-001-0001', 'CT-2026-LJ-001-0002', 'CT-2026-LJ-002-0007', 'CT-2025-LJ-001-0009'];
  assert.equal(ContractCode.nextSequence(ContractCode.prefix(2026, 'LJ-001'), existing), 3);
  assert.equal(ContractCode.nextSequence(ContractCode.prefix(2027, 'LJ-001'), existing), 1);
});

test('o sequencial não confunde unidades que compartilham o prefixo', () => {
  // "LJ-001" não pode contar os contratos de "LJ-001-A".
  const existing = ['CT-2026-LJ-001-A-0004', 'CT-2026-LJ-001-0001'];
  assert.equal(ContractCode.nextSequence(ContractCode.prefix(2026, 'LJ-001'), existing), 2);
});

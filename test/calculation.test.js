import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculate, sumMoney } from '../src/domain/calculator.js';
import { BusinessRuleError } from '../src/domain/errors.js';
import {
  Modality, MoneyStatus, PositionStatus, RateStatus, SlaSituation, SlaTargetSource, TermType, TerminationSource,
  TerminationType,
} from '../src/domain/enums.js';
import * as P from '../src/domain/position.js';
import { fill, newPosition, order, rate, reason, replacement } from './builders.js';

/** Casos de teste da seção 8.7 da SPEC. */
const settings = { atRiskDays: 2, lossOnCancelAfterOpen: true };

test('T1 reposição com vigência indeterminada', () => {
  const { replacement: p } = replacement('2026-11-10', '2026-11-12');
  P.confirmReplacement(p, '2026-11-14', null, SlaTargetSource.NONE);
  P.startPause(p, reason(), '2026-11-18');
  P.endPause(p, '2026-11-20');
  fill(p, '2026-11-24');

  const m = calculate(p, '2026-11-30', settings);

  assert.equal(m.communicationTime, 2);
  assert.equal(m.confirmationTime, 2);
  assert.equal(m.fillTime, 8);
  assert.equal(m.uncoveredDays, 13);
  assert.equal(m.lost, 1300);
  assert.equal(m.deferred, 0);
});

test('T2 vaga nova com duração preservada', () => {
  const p = newPosition(order({ term: TermType.PRESERVED_DURATION, desired: '2026-12-01', duration: 30 }));
  fill(p, '2026-12-05');
  const m = calculate(p, '2026-12-10', settings);
  assert.equal(m.uncoveredDays, 4);
  assert.equal(m.lost, 0);
  assert.equal(m.deferred, 400);
});

test('T3 vaga nova com data fim', () => {
  const p = newPosition(order({ term: TermType.FIXED_END, desired: '2026-12-01', termEnd: '2026-12-31' }));
  fill(p, '2026-12-05');
  const m = calculate(p, '2026-12-10', settings);
  assert.equal(m.uncoveredDays, 4);
  assert.equal(m.lost, 400);
});

test('T4 data fim sem preenchimento: encerrada pela rotina diária', () => {
  const p = newPosition(order({ term: TermType.FIXED_END, desired: '2026-12-01', termEnd: '2026-12-31' }));
  assert.equal(P.closeByContractEnd(p, '2026-12-31'), false);
  assert.equal(P.closeByContractEnd(p, '2027-01-01'), true);
  const m = calculate(p, '2027-01-01', settings);
  assert.equal(p.status, PositionStatus.CLOSED_CONTRACT_ENDED);
  assert.equal(p.closedAt, '2027-01-01');
  assert.equal(m.uncoveredDays, 31);
  assert.equal(m.lost, 3100);
});

test('T4 a data de encerramento não depende do dia em que a rotina rodou', () => {
  const p = newPosition(order({ term: TermType.FIXED_END, desired: '2026-12-01', termEnd: '2026-12-31' }));
  P.closeByContractEnd(p, '2027-01-04'); // a rotina só rodou na segunda-feira seguinte
  const m = calculate(p, '2027-01-04', settings);
  assert.equal(p.closedAt, '2027-01-01');
  assert.equal(m.uncoveredDays, 31);
});

test('T5 reposição que o cliente não repõe: sem perda', () => {
  const { replacement: p } = replacement('2026-11-10', '2026-11-11');
  P.declineReplacement(p, '2026-11-12');
  const m = calculate(p, '2026-11-30', settings);
  assert.equal(p.status, PositionStatus.CLOSED_CLIENT_CANCELLED);
  assert.equal(m.lost, 0);
  assert.equal(m.deferred, 0);
});

test('T6 R&S: sem valor em R$ e SLA normal', () => {
  const p = newPosition(order({ modality: Modality.RS, desired: '2026-12-01' }), { slaDays: 10 });
  const m = calculate(p, '2026-12-05', settings);
  assert.equal(m.lost, 0);
  assert.equal(m.deferred, 0);
  assert.equal(m.moneyStatus, MoneyStatus.NOT_APPLICABLE);
  assert.equal(m.dailyValue, null);
  assert.equal(m.slaSituation, SlaSituation.ON_TIME);
  assert.equal(m.slaDeadline, '2026-12-11');
});

test('T7 reposição antecipada: último dia no futuro', () => {
  const { replacement: p } = replacement('2026-11-30', '2026-11-20');
  P.confirmReplacement(p, '2026-11-21', null, SlaTargetSource.NONE);
  fill(p, '2026-12-01');
  const m = calculate(p, '2026-12-02', settings);
  assert.equal(m.uncoveredDays, 0);
  assert.equal(m.lost, 0);
});

test('T8 substituto começa antes da saída', () => {
  const { replacement: p } = replacement('2026-11-30', '2026-11-20');
  P.confirmReplacement(p, '2026-11-21', null, SlaTargetSource.NONE);
  fill(p, '2026-11-28');
  assert.equal(calculate(p, '2026-12-02', settings).uncoveredDays, 0);
});

test('T9 cancelada depois de aberta, vigência indeterminada', () => {
  const { replacement: p } = replacement('2026-11-10', '2026-11-11');
  P.confirmReplacement(p, '2026-11-12', null, SlaTargetSource.NONE);
  P.cancel(p, '2026-11-20', 'Cliente cancelou a vaga');
  const m = calculate(p, '2026-11-30', settings);
  assert.equal(m.uncoveredDays, 9);
  assert.equal(m.lost, 900);
});

test('T9 cancelada depois de aberta, sem o parâmetro de perda', () => {
  const { replacement: p } = replacement('2026-11-10', '2026-11-11');
  P.confirmReplacement(p, '2026-11-12', null, SlaTargetSource.NONE);
  P.cancel(p, '2026-11-20', 'Cliente cancelou a vaga');
  assert.equal(calculate(p, '2026-11-30', { ...settings, lossOnCancelAfterOpen: false }).lost, 0);
});

test('T10 SLA em risco, descontando a pausa', () => {
  const { replacement: p } = replacement('2026-11-10', '2026-11-12');
  P.confirmReplacement(p, '2026-11-14', 10, SlaTargetSource.CONTRACT);
  P.startPause(p, reason(), '2026-11-16');
  P.endPause(p, '2026-11-18');
  const m = calculate(p, '2026-11-24', settings);
  assert.equal(m.pausedDays, 2);
  assert.equal(m.slaDeadline, '2026-11-26');
  assert.equal(m.slaSituation, SlaSituation.AT_RISK);
});

for (const [today, expected] of [
  ['2026-11-23', SlaSituation.ON_TIME], ['2026-11-26', SlaSituation.AT_RISK], ['2026-11-27', SlaSituation.OVERDUE],
]) {
  test(`T10 limites do SLA: ${today} → ${expected}`, () => {
    const p = newPosition(order({ desired: '2026-11-14' }), { slaDays: 12 });
    assert.equal(calculate(p, today, settings).slaSituation, expected);
  });
}

test('T10 sem meta de SLA', () => {
  const p = newPosition(order({ desired: '2026-11-14' }));
  assert.equal(calculate(p, '2026-11-20', settings).slaSituation, SlaSituation.NO_TARGET);
});

test('T11 valor pendente: calculado, mas fora dos totais', () => {
  const pending = newPosition(order({ desired: '2026-12-01' }), { rateValue: rate(RateStatus.PENDING) });
  const validated = newPosition(order({ desired: '2026-12-01' }), { rateValue: rate(RateStatus.VALIDATED) });
  const mp = calculate(pending, '2026-12-05', settings);
  const mv = calculate(validated, '2026-12-05', settings);
  const totals = sumMoney([mp, mv].map((m) => ({ lost: m.lost, deferred: m.deferred, status: m.moneyStatus })));
  assert.equal(mp.lost, 400);
  assert.equal(mp.moneyStatus, MoneyStatus.PENDING);
  assert.equal(totals.lost, 400);
  assert.equal(totals.pendingLost, 400);
  assert.equal(totals.pendingCount, 1);
});

test('T12 desligamento duplicado é bloqueado', () => {
  const { origin } = replacement('2026-11-10', '2026-11-12');
  assert.throws(() => P.registerTermination(origin, false, '2026-11-15', TerminationSource.NACC, TerminationType.DISMISSAL,
    null, '2026-11-16'), (e) => e instanceof BusinessRuleError
      && e.message === 'Já existe um desligamento registrado para esta posição.');
});

test('T12 desligamento duplicado detectado pelo banco', () => {
  const p = newPosition(order({ desired: '2026-01-05' }));
  fill(p, '2026-01-05');
  assert.throws(() => P.registerTermination(p, true, '2026-11-15', TerminationSource.DP, TerminationType.RESIGNATION,
    null, '2026-11-16'), BusinessRuleError);
});

test('valores em centavos: 7 dias de R$ 3.333,33 sem erro de ponto flutuante', () => {
  const r = rate();
  r.monthlyValue = 3333.33;
  const p = newPosition(order({ desired: '2026-12-01' }), { rateValue: r });
  const m = calculate(p, '2026-12-08', settings);
  assert.equal(m.dailyValue, 111.11);
  // 7 × 333333 / 30 = 77777,7 centavos → 77778 centavos
  assert.equal(m.lost, 777.78);
});

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BusinessRuleError, ForbiddenError } from '../src/domain/errors.js';
import {
  CandidateSex, EvidenceKind, OrderApprovalStatus, OrderStatus, PositionStatus as S, Roles, SlaTargetSource,
  TerminationSource, TerminationType,
} from '../src/domain/enums.js';
import { Cpf, EvidenceFiles, RhAccess } from '../src/domain/guards.js';
import {
  activeRhAnalysts, awaitingRhAssignment, computeStatus, currentPositions, recordJobconvo, reject, setRhAnalysts,
} from '../src/domain/order.js';
import { orderDateIssues } from '../src/domain/date-checks.js';
import * as P from '../src/domain/position.js';
import { Actions, actionsFor, ensureRole } from '../src/services/position-views.js';
import { candidate, fill, NOW, newPosition, order, reason, recruit, replacement } from './builders.js';

/** JobConvo no pedido, analistas de RH, candidato, 1º dia e reposição como ciclo da vaga. */

const ruleField = (fn) => {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof BusinessRuleError, `esperava regra de negócio, veio ${e}`);
    return e.field;
  }
  assert.fail('esperava BusinessRuleError');
};

// ---------------------------------------------------------------- JobConvo (RN-06 no pedido)

function orderWith(quantity) {
  const o = order({ desired: '2026-11-10' });
  o.clientRequestDate = '2026-11-01';
  const positions = Array.from({ length: quantity }, () => newPosition(o));
  return { o, positions };
}

test('publicado: toda posição aberta passa a "Em recrutamento"', () => {
  const { o, positions } = orderWith(3);
  P.cancel(positions[2], '2026-11-05', 'Cliente reduziu o quadro.');
  const started = recordJobconvo(o, true, ' JC-10 ', '2026-11-03', 'Publicação única.', null, NOW);
  assert.equal(started.length, 2);
  assert.ok(positions.slice(0, 2).every((p) => p.status === S.RECRUITING));
  assert.equal(positions[2].status, S.CLOSED_CLIENT_CANCELLED);
  assert.equal(o.jobconvoCode, 'JC-10');
  assert.equal(o.jobconvoPublished, true);
});

test('publicado exige código e data; antes da solicitação, só sinaliza', () => {
  const { o, positions } = orderWith(1);
  assert.equal(ruleField(() => recordJobconvo(o, true, '', '2026-11-03', null, null, NOW)), 'code');
  assert.equal(ruleField(() => recordJobconvo(o, true, 'JC', null, null, null, NOW)), 'publishedAt');
  assert.equal(positions[0].status, S.OPEN);
  recordJobconvo(o, true, 'JC', '2026-10-30', null, null, NOW);
  assert.equal(positions[0].status, S.RECRUITING);
  assert.ok(orderDateIssues(o, '2026-11-20').some((i) => i.key === 'order:jobconvo<request'));
});

test('não publicado exige justificativa e também inicia o recrutamento', () => {
  const { o, positions } = orderWith(2);
  assert.equal(ruleField(() => recordJobconvo(o, false, null, null, ' ', null, NOW)), 'justification');
  recordJobconvo(o, false, 'JC-ignorado', '2026-11-03', 'Indicação do cliente.', null, NOW);
  assert.equal(o.jobconvoPublished, false);
  assert.equal(o.jobconvoCode, null);
  assert.equal(o.jobconvoPublishedAt, null);
  assert.ok(positions.every((p) => p.status === S.RECRUITING));
});

test('a atualização é refletida e as posições acrescentadas herdam', () => {
  const { o } = orderWith(1);
  recordJobconvo(o, true, 'JC-1', '2026-11-03', null, null, NOW);
  recordJobconvo(o, true, 'JC-2', '2026-11-04', 'Vaga republicada.', null, NOW);
  const added = newPosition(o);
  assert.equal(o.jobconvoCode, 'JC-2');
  assert.equal(added.status, S.RECRUITING);
});

test('posição aberta pausada volta da pausa em recrutamento', () => {
  const { o, positions: [p] } = orderWith(1);
  P.startPause(p, reason(), '2026-11-02');
  recordJobconvo(o, true, 'JC-1', '2026-11-03', null, null, NOW);
  assert.equal(p.status, S.PAUSED);
  P.endPause(p, '2026-11-04');
  assert.equal(p.status, S.RECRUITING);
});

test('reposição confirmada herda a publicação', () => {
  const { origin, replacement: r } = replacement('2026-02-10', '2026-02-11');
  assert.ok(P.hasJobconvoRecord(origin.order));
  P.confirmReplacement(r, '2026-02-12', 5, SlaTargetSource.CONTRACT);
  assert.equal(r.status, S.RECRUITING);
});

test('reposição sem publicação fica aberta', () => {
  const { o, positions: [origin] } = orderWith(1);
  fill(origin, '2026-11-10');
  o.jobconvoPublished = null; // pedido sem publicação (ex.: preenchido na carga inicial)
  const t = P.registerTermination(origin, false, '2026-11-20', TerminationSource.DP, TerminationType.RESIGNATION, null, '2026-11-21');
  const r = P.createReplacement(origin, t, 2);
  o.positions.push(r);
  P.confirmReplacement(r, '2026-11-22', 5, SlaTargetSource.CONTRACT);
  assert.equal(r.status, S.OPEN);
});

test('pedido não aprovado recusa a publicação', () => {
  const { o } = orderWith(1);
  o.approvalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
  reject(o, '2026-11-02', 'Desistiu', null, NOW);
  assert.throws(() => recordJobconvo(o, true, 'JC-1', '2026-11-03', null, null, NOW), BusinessRuleError);
});

// ---------------------------------------------------------------- analistas de RH

const RITA = 'aaaaaaaa-0000-7000-8000-000000000001';
const RENATO = 'aaaaaaaa-0000-7000-8000-000000000002';
const MANAGER = 'aaaaaaaa-0000-7000-8000-000000000003';
const T1 = '2026-11-03T12:00:00.000Z';
const T2 = '2026-11-03T17:00:00.000Z';
const user = (id, ...roles) => ({ id, roles });

test('pedido novo aguarda a atribuição do RH até alguém ser atribuído', () => {
  const o = order();
  newPosition(o);
  assert.ok(awaitingRhAssignment(o));
  setRhAnalysts(o, [{ id: RITA, name: 'Rita' }], MANAGER, T1);
  assert.ok(!awaitingRhAssignment(o));
});

test('substituir mantém o histórico com quem e quando', () => {
  const o = order();
  newPosition(o);
  setRhAnalysts(o, [{ id: RITA, name: 'Rita' }], MANAGER, T1);
  const { added, removed } = setRhAnalysts(o, [{ id: RENATO, name: 'Renato' }], MANAGER, T2);
  assert.deepEqual(added.map((a) => a.userId), [RENATO]);
  assert.deepEqual(removed.map((a) => a.userId), [RITA]);
  assert.deepEqual(activeRhAnalysts(o).map((a) => a.userName), ['Renato']);
  const old = o.rhAnalysts.find((a) => a.userId === RITA);
  assert.deepEqual([old.assignedAt, old.assignedBy, old.removedAt, old.removedBy], [T1, MANAGER, T2, MANAGER]);
  assert.equal(o.rhAnalysts.length, 2);
});

test('a mesma equipe não muda nada; remover todos volta a aguardar', () => {
  const o = order();
  newPosition(o);
  setRhAnalysts(o, [{ id: RITA, name: 'Rita' }, { id: RENATO, name: 'Renato' }], MANAGER, T1);
  const { added, removed } = setRhAnalysts(o,
    [{ id: RENATO, name: 'Renato' }, { id: RITA, name: 'Rita' }, { id: RITA, name: 'Rita' }], MANAGER, T2);
  assert.equal(added.length + removed.length, 0);
  setRhAnalysts(o, [], MANAGER, T2);
  assert.ok(awaitingRhAssignment(o));
});

test('pedido não aprovado não tem atendimento a distribuir', () => {
  const o = order();
  o.approvalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
  newPosition(o);
  reject(o, o.clientRequestDate, 'Desistiu', null, T1);
  assert.ok(!awaitingRhAssignment(o));
  assert.throws(() => setRhAnalysts(o, [{ id: RITA, name: 'Rita' }], MANAGER, T1), BusinessRuleError);
});

test('o analista age só nos pedidos atribuídos; o gestor em qualquer um', () => {
  const o = order();
  const p = newPosition(o);
  recruit(p);
  const rita = user(RITA, Roles.Rh);
  const manager = user(MANAGER, Roles.RhManager);
  assert.ok(!actionsFor(p, rita).includes(Actions.ApproveCandidate));
  assert.ok(actionsFor(p, manager).includes(Actions.ApproveCandidate));
  assert.throws(() => ensureRole(p, rita, Actions.ApproveCandidate),
    (e) => e instanceof ForbiddenError && e.message.includes('analistas de RH responsáveis'));

  setRhAnalysts(o, [{ id: RITA, name: 'Rita' }], MANAGER, T1);
  assert.ok(actionsFor(p, rita).includes(Actions.ApproveCandidate));
  ensureRole(p, rita, Actions.ApproveCandidate);
  assert.ok(RhAccess.canAct(rita, o));
  assert.ok(!RhAccess.canAct(user(RENATO, Roles.Rh), o));
});

test('o NACC mantém o "não compareceu" sem atribuição', () => {
  const p = newPosition(order());
  recruit(p);
  P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02');
  P.registerAdmission(p, '2026-12-03');
  assert.ok(actionsFor(p, user(RENATO, Roles.Nacc)).includes(Actions.AdmissionNoShow));
});

// ---------------------------------------------------------------- candidato

const TODAY = '2026-12-02';
const recruiting = () => {
  const p = newPosition(order());
  recruit(p);
  return p;
};

for (const [cpf, valid] of [
  ['529.982.247-25', true], ['52998224725', true], ['529.982.247-24', false], ['111.111.111-11', false], ['1234', false],
]) {
  test(`CPF ${cpf} ${valid ? 'válido' : 'inválido'}`, () => assert.equal(Cpf.isValid(cpf), valid));
}

test('CPF mascarado para quem não vê os dados completos', () => assert.equal(Cpf.mask('529.982.247-25'), '***.982.247-**'));

test('a aprovação guarda o candidato na posição', () => {
  const p = recruiting();
  const c = P.approveCandidate(p, TODAY, {
    fullName: '  Maria   da Silva ', birthDate: '1995-04-10', sex: CandidateSex.FEMALE, cpf: '529.982.247-25',
  }, TODAY);
  assert.equal(P.activeCandidate(p), c);
  assert.equal(c.fullName, 'Maria da Silva');
  assert.equal(c.cpf, '52998224725');
  assert.equal(p.status, S.CANDIDATE_APPROVED);
});

for (const [name, birth, sex, cpf, field] of [
  ['', '1995-04-10', CandidateSex.FEMALE, '52998224725', 'fullName'],
  ['Maria', null, CandidateSex.FEMALE, '52998224725', 'birthDate'],
  ['Maria', '2026-12-03', CandidateSex.FEMALE, '52998224725', 'birthDate'],
  ['Maria', '1995-04-10', null, '52998224725', 'sex'],
  ['Maria', '1995-04-10', CandidateSex.MALE, '52998224724', 'cpf'],
  ['Maria', '1995-04-10', CandidateSex.MALE, null, 'cpf'],
]) {
  test(`a aprovação valida o campo ${field} (${name || 'sem nome'}, ${birth}, ${sex}, ${cpf})`, () => {
    const p = recruiting();
    assert.equal(ruleField(() => P.approveCandidate(p, TODAY, { fullName: name, birthDate: birth, sex, cpf }, TODAY)), field);
    assert.equal(p.status, S.RECRUITING);
    assert.equal(p.candidates.length, 0);
  });
}

test('a correção altera o candidato ativo', () => {
  const p = recruiting();
  P.approveCandidate(p, TODAY, candidate(), TODAY);
  P.correctCandidate(p, { fullName: 'Maria da Silva Santos', birthDate: '1995-04-11', sex: CandidateSex.NOT_INFORMED,
    cpf: '52998224725' }, TODAY);
  assert.equal(P.activeCandidate(p).fullName, 'Maria da Silva Santos');
  assert.equal(P.activeCandidate(p).sex, CandidateSex.NOT_INFORMED);
  assert.equal(p.candidates.length, 1);
});

test('a desistência guarda o candidato anterior e libera a posição', () => {
  const p = recruiting();
  P.approveCandidate(p, TODAY, candidate(), TODAY);
  P.candidateWithdrew(p, NOW);
  P.approveCandidate(p, TODAY, { fullName: 'João Pereira', birthDate: '1990-01-01', sex: CandidateSex.MALE, cpf: '11144477735' }, TODAY);
  P.registerAdmission(p, TODAY);
  P.admissionNoShow(p, NOW);
  assert.equal(P.activeCandidate(p), null);
  assert.deepEqual(p.candidates.map((c) => c.withdrawalReason), ['Candidato desistiu', 'Admitido não compareceu']);
  assert.throws(() => P.correctCandidate(p, candidate(), TODAY), BusinessRuleError);
});

// ---------------------------------------------------------------- 1º dia efetivo

function inAdmission(registration = null) {
  const p = newPosition(order());
  recruit(p);
  P.approveCandidate(p, '2026-12-02', candidate(), '2026-12-02');
  P.registerAdmission(p, '2026-12-03', registration);
  return p;
}

const FIRST_DAY_NOW = '2026-12-05T13:00:00.000Z';
const NACC = 'aaaaaaaa-0000-7000-8000-000000000009';

test('a admissão guarda a matrícula opcional e o "não compareceu" a apaga', () => {
  const p = inAdmission('  M-77 ');
  assert.equal(p.admissionRegistration, 'M-77');
  P.admissionNoShow(p, FIRST_DAY_NOW);
  assert.equal(p.admissionRegistration, null);
  assert.equal(inAdmission(' ').admissionRegistration, null);
});

test('o 1º dia exige justificativa e registra quem e quando', () => {
  const p = inAdmission('M-1');
  assert.equal(ruleField(() => P.confirmFirstDay(p, '2026-12-05', ' ', NACC, FIRST_DAY_NOW)), 'justification');
  P.confirmFirstDay(p, '2026-12-05', ' Cliente confirmou por e-mail ', NACC, FIRST_DAY_NOW);
  assert.equal(p.status, S.FILLED);
  assert.deepEqual([p.employeeName, p.employeeRegistration], ['Maria da Silva', 'M-1']); // vêm da origem
  assert.equal(p.firstDayJustification, 'Cliente confirmou por e-mail');
  assert.deepEqual([p.firstDayConfirmedBy, p.firstDayConfirmedAt], [NACC, FIRST_DAY_NOW]);
});

test('a evidência fica ligada à posição', () => {
  const p = inAdmission();
  const evidence = P.attachEvidence(p, EvidenceKind.FIRST_DAY, 'presenca.pdf', 'application/pdf', Buffer.from('%PDF-1.7'));
  assert.deepEqual(p.evidences, [evidence]);
  assert.equal(evidence.positionId, p.id);
  assert.equal(evidence.storageKey, evidence.file.id);
});

const PDF = Buffer.from('%PDF-1.7 conteúdo');
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]);

test('o tipo da evidência é detectado pelo conteúdo', () => {
  assert.deepEqual(EvidenceFiles.validate({ fileName: 'presenca.pdf', content: PDF }),
    { fileName: 'presenca.pdf', contentType: 'application/pdf' });
  assert.equal(EvidenceFiles.validate({ fileName: 'a.png', content: PNG }).contentType, 'image/png');
  assert.equal(EvidenceFiles.validate({ fileName: 'a.jpg', content: JPG }).contentType, 'image/jpeg');
  assert.equal(EvidenceFiles.validate({ fileName: 'C:\\pasta\\relatorio.pdf', content: PDF }).fileName, 'relatorio.pdf');
});

test('evidência de outro tipo, vazia ou grande demais é recusada', () => {
  assert.throws(() => EvidenceFiles.validate({ fileName: 'planilha.pdf', content: Buffer.from('PK\u0003\u0004') }), BusinessRuleError);
  assert.throws(() => EvidenceFiles.validate({ fileName: 'vazio.pdf', content: Buffer.alloc(0) }), BusinessRuleError);
  const big = Buffer.alloc(EvidenceFiles.MAX_BYTES + 1);
  PDF.copy(big);
  assert.throws(() => EvidenceFiles.validate({ fileName: 'grande.pdf', content: big }), BusinessRuleError);
});

test('o 1º dia exige a matrícula da admissão, que o RH ou o DP informam antes', () => {
  const p = inAdmission();
  assert.equal(ruleField(() => P.confirmFirstDay(p, '2026-12-05', 'Ok', null, FIRST_DAY_NOW)), 'employeeRegistration');
  assert.equal(ruleField(() => P.setAdmissionRegistration(p, ' ')), 'registration');
  assert.equal(p.status, S.IN_ADMISSION);
  assert.equal(P.setAdmissionRegistration(p, ' M-55 '), true); // admissão concluída agora
  assert.equal(p.status, S.AWAITING_FIRST_DAY);
  assert.equal(P.setAdmissionRegistration(p, 'M-55'), false); // correção: já estava concluída
  P.confirmFirstDay(p, '2026-12-05', 'Ok', null, FIRST_DAY_NOW);
  assert.equal(p.employeeRegistration, 'M-55');
  assert.throws(() => P.setAdmissionRegistration(p, 'M-56'), BusinessRuleError); // preservada após a confirmação
});

test('posição aprovada antes da regra do candidato recebe o candidato pelo RH', () => {
  const p = inAdmission('M-1');
  p.candidates.length = 0; // aprovada antes do cadastro de candidatos
  assert.ok(P.canRegisterMissingCandidate(p));
  assert.equal(ruleField(() => P.confirmFirstDay(p, '2026-12-05', 'Ok', null, FIRST_DAY_NOW)), 'employeeName');
  const c = P.correctCandidate(p, { fullName: 'João Pereira', birthDate: '1990-01-01', sex: CandidateSex.MALE,
    cpf: '11144477735' }, '2026-12-04');
  assert.equal(c.approvedAt, '2026-12-02');
  P.confirmFirstDay(p, '2026-12-05', 'Ok', null, FIRST_DAY_NOW);
  assert.equal(p.employeeName, 'João Pereira');
});

test('admissão com matrícula vai direto para "Aguardando 1º dia"', () => {
  assert.equal(inAdmission('M-1').status, S.AWAITING_FIRST_DAY);
  assert.equal(inAdmission().status, S.IN_ADMISSION);
});

test('o "não compareceu" vale nas duas etapas da admissão e a pausa mantém a etapa', () => {
  const p = inAdmission('M-1');
  P.startPause(p, reason(), '2026-12-04');
  P.endPause(p, '2026-12-04');
  assert.equal(p.status, S.AWAITING_FIRST_DAY);
  P.admissionNoShow(p, FIRST_DAY_NOW);
  assert.equal(p.status, S.RECRUITING);
  assert.equal(p.admissionRegistration, null);
});

// ---------------------------------------------------------------- reposição como ciclo da vaga

test('a reposição mantém a vaga e abre o próximo ciclo', () => {
  const { origin, replacement: r } = replacement('2026-02-10', '2026-02-11');
  assert.equal(r.slotNumber, origin.slotNumber);
  assert.equal(origin.cycle, 1);
  assert.equal(r.cycle, 2);
  assert.ok(!P.isCurrentCycle(origin), 'o colaborador desligado sai do ciclo atual');
  assert.ok(P.isCurrentCycle(r));
  assert.deepEqual(currentPositions(origin.order), [r]);
});

test('a segunda reposição é o terceiro ciclo da mesma vaga', () => {
  const { replacement: first } = replacement('2026-02-10', '2026-02-11');
  P.confirmReplacement(first, '2026-02-12', 5, SlaTargetSource.CONTRACT);
  fill(first, '2026-02-20');
  const t = P.registerTermination(first, false, '2026-03-10', TerminationSource.DP, TerminationType.DISMISSAL, null, '2026-03-11');
  const second = P.createReplacement(first, t, 3);
  first.order.positions.push(second);
  assert.deepEqual([second.slotNumber, second.cycle], [1, 3]);
  assert.equal(currentPositions(first.order).length, 1);
});

test('o status do pedido olha só o ciclo atual', () => {
  const { origin, replacement: r } = replacement('2026-02-10', '2026-02-11');
  // O colaborador desligado continua "Preenchida" no seu ciclo, mas o pedido está em reposição.
  assert.equal(origin.status, S.FILLED);
  assert.equal(computeStatus(origin.order.positions), OrderStatus.IN_PROGRESS);
  P.declineReplacement(r, '2026-02-12');
  assert.ok(P.notReplaced(r));
  assert.equal(computeStatus(origin.order.positions), OrderStatus.CANCELLED);
});

test('posições novas usam o próprio número de vaga', () => {
  const o = order();
  const p = P.createNew(o, 12, o.desiredStartDate, null, null, null, SlaTargetSource.NONE, 11);
  assert.deepEqual([p.sequence, p.slotNumber, p.cycle], [12, 11, 1]);
});

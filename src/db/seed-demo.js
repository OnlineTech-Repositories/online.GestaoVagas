import { addDays, addYears, today as todayDate, utcNow, yearOf } from '../domain/dates.js';
import {
  ALL_ROLES, CandidateSex, Modality, OrderApprovalStatus, RateStatus, Roles, SlaTargetSource, TermType,
  TerminationSource, TerminationType,
} from '../domain/enums.js';
import { ContractCode } from '../domain/guards.js';
import { newOrder, recordJobconvo, setRhAnalysts } from '../domain/order.js';
import * as P from '../domain/position.js';
import { hashPassword } from '../services/auth.js';
import { execute, queryOne, transaction } from './index.js';
import { entity } from './model.js';
import { UnitOfWork } from './unit-of-work.js';

/**
 * Dados FICTÍCIOS para avaliação local (DADOS_DEMO=1). Um usuário por perfil e cenários que cobrem os principais
 * estados: vencidas, em risco, reposição aguardando o cliente, pausa, fim de vigência, valor pendente e R&S.
 * As datas são relativas a "hoje", para as situações de SLA fazerem sentido em qualquer dia. A senha dos usuários
 * de demonstração vem de configuração segura (SENHA_DEMO), nunca do código.
 */
export async function seedDemoData(password) {
  if (await queryOne('SELECT 1 AS yes FROM orders LIMIT 1')) return;
  if (!password) {
    console.warn('[demo] DADOS_DEMO ligado, mas SENHA_DEMO não foi definida. Dados de demonstração não criados.');
    return;
  }

  const uow = new UnitOfWork({});
  const today = todayDate();
  const D = (days) => addDays(today, days);
  const now = utcNow();

  // ------------------------------------------------------------ usuários (um por perfil)
  const userRoles = [];
  const createUser = (roles, name, email) => {
    const { hash, salt } = hashPassword(password);
    const user = uow.add(entity('User', {
      name, email, passwordHash: hash, passwordSalt: salt, active: true, mustChangePassword: false, failedAttempts: 0,
      lockoutEnd: null,
    }));
    for (const role of roles) userRoles.push([user.id, role]);
    return user;
  };
  const users = {};
  for (const [role, name, email] of [
    [Roles.Commercial, 'Carla Comercial (demo)', 'comercial@demo.local'],
    [Roles.Nacc, 'Nina NACC (demo)', 'nacc@demo.local'],
    [Roles.Dp, 'Davi DP (demo)', 'dp@demo.local'],
    [Roles.Rh, 'Rita RH (demo)', 'rh@demo.local'],
    [Roles.RhManager, 'Helena Gestora de RH (demo)', 'gestor.rh@demo.local'],
    [Roles.Manager, 'Gustavo Gestor (demo)', 'gestor@demo.local'],
    [Roles.Controllership, 'Clara Controladoria (demo)', 'controladoria@demo.local'],
    [Roles.Admin, 'Alice Administradora (demo)', 'admin@demo.local'],
  ]) users[role] = createUser([role], name, email);
  // Segundo analista de RH, para a distribuição dos pedidos entre a equipe.
  const rh2 = createUser([Roles.Rh], 'Renato RH (demo)', 'rh2@demo.local');
  // Um usuário com todos os perfis, para o teste completo da aplicação num login só.
  createUser(ALL_ROLES, 'Todos os Perfis (demo)', 'todos@demo.local');

  // ------------------------------------------------------------ cadastros
  const add = (kind, props) => uow.add(entity(kind, props));
  const group1 = add('GroupEntity', { name: 'ON LINE Serviços (demo)', cnpj: fakeCnpj('11222333', 1), active: true });
  const group2 = add('GroupEntity', { name: 'ON LINE Facilities (demo)', cnpj: fakeCnpj('11222333', 2), active: true });
  const clientA = add('Client', { legalName: 'Logística Exemplo Ltda (demo)', cnpj: fakeCnpj('12345678', 1), active: true, hasMultipleUnits: true, isBrand: false });
  // Bandeira/marca sem o CNPJ central: cada unidade tem o próprio CNPJ.
  const clientB = add('Client', { legalName: 'Varejo Modelo S.A. (demo)', cnpj: '', active: true, hasMultipleUnits: true, isBrand: true });
  const role = (name) => add('JobRole', { name, active: true });
  const stockist = role('Estoquista');
  const forklift = role('Operador de empilhadeira');
  const cleaner = role('Auxiliar de limpeza');
  const hrAnalyst = role('Analista de RH');
  const location = (props) => add('WorkLocation', { active: true, removedAt: null, cnpj: null, code: null, clientId: null, ...props });
  // O CNPJ é obrigatório em toda unidade de cliente (19/10/2026).
  const cdCajamar = location({ code: 'CD-01', name: 'CD Cajamar', clientId: clientA.id, cnpj: fakeCnpj('12345678', 2) });
  const storeCenter = location({ code: 'LJ-001', name: 'Loja Centro', clientId: clientB.id, cnpj: fakeCnpj('98765432', 2) });
  location({ code: 'LJ-002', name: 'Loja Shopping Norte', clientId: clientB.id, cnpj: fakeCnpj('98765432', 3) });
  location({ name: 'Sede do cliente' });
  const pauseDocs = add('PauseReason', { name: 'Aguardando documentação do cliente', active: true });
  add('PauseReason', { name: 'Cliente suspendeu temporariamente a vaga', active: true });

  const commercial = users[Roles.Commercial].id;
  const contract = (props) => add('Contract', { endDate: null, slaNewDays: null, slaReplacementDays: null, status: 'ACTIVE',
    commercialOwnerId: commercial, ...props });
  const contractA = contract({
    clientId: clientA.id, contractingUnitId: cdCajamar.id, groupEntityId: group1.id,
    name: ContractCode.build(yearOf(today), ContractCode.segment(cdCajamar.code), 1),
    modalities: [Modality.MOT, Modality.MOE], startDate: D(-200), slaNewDays: 10, slaReplacementDays: 5,
  });
  const contractB = contract({
    clientId: clientB.id, contractingUnitId: storeCenter.id, groupEntityId: group2.id,
    name: ContractCode.build(yearOf(today), ContractCode.segment(storeCenter.code), 1),
    modalities: [Modality.RS, Modality.FAC], startDate: D(-120),
  });
  for (const [c, client, unit, group] of [[contractA, clientA, cdCajamar, group1], [contractB, clientB, storeCenter, group2]]) {
    Object.assign(c, { client, contractingUnit: unit, groupEntity: group });
  }
  add('SlaTarget', { modality: Modality.FAC, demandType: 'NEW', days: 15, validFrom: D(-300) });

  const controller = users[Roles.Controllership].id;
  const rate = (c, j, monthly, status, fee = null) => add('ContractRate', {
    contractId: c.id, jobRoleId: j.id, monthlyValue: monthly, feeValue: fee, validFrom: D(-365), status,
    createdBy: commercial, rejectionReason: null,
    validatedBy: status === RateStatus.VALIDATED ? controller : null,
    validatedAt: status === RateStatus.VALIDATED ? now : null,
  });
  const rateStockist = rate(contractA, stockist, 3000, RateStatus.VALIDATED);
  const rateForklift = rate(contractA, forklift, 4500, RateStatus.VALIDATED);
  // Reajuste ainda pendente: fica na fila da Controladoria e não entra nos pedidos até ser validado.
  const adjustment = rate(contractA, forklift, 4800, RateStatus.PENDING);
  adjustment.validFrom = D(-10);
  const rateCleaner = rate(contractB, cleaner, 2700, RateStatus.VALIDATED);
  const rateHr = rate(contractB, hrAnalyst, null, RateStatus.VALIDATED, 5000);

  const order = (c, modality, jobRole, workLocation, quantity, request, registered, desired, termType, extra = {}) => {
    const o = newOrder({
      contractId: c.id, modality, jobRoleId: jobRole.id, workLocationId: workLocation.id, quantity,
      clientRequestDate: D(request), registeredAt: D(registered), desiredStartDate: D(desired), termType,
      createdBy: commercial,
      // Pedidos de demonstração já aprovados pelo cliente na data do registro.
      approvalStatus: OrderApprovalStatus.APPROVED, clientDecisionDate: D(registered), approvalRecordedAt: now,
      approvalRecordedBy: commercial,
      ...extra,
    });
    Object.assign(o, { contract: c, jobRole, workLocation });
    return uow.add(o);
  };
  const positions = (o, r, sla, source) => {
    for (let i = 1; i <= o.quantity; i += 1) o.positions.push(P.createNew(o, i, o.desiredStartDate, o.registeredAt, r, sla, source));
    return o.positions;
  };

  // Uma publicação no JobConvo por pedido: as posições abertas entram em recrutamento juntas.
  const rh = users[Roles.Rh].id;
  const nacc = users[Roles.Nacc].id;
  const publish = (o, code, publishedAt, notes = null) => recordJobconvo(o, true, code, D(publishedAt), notes, rh, now);

  // Candidatos fictícios: CPFs com dígitos verificadores válidos e celulares, gerados a partir de um número. Os
  // dados de demonstração já trazem nascimento e CPF, como os cadastros anteriores à admissão com esses campos.
  const sexes = [CandidateSex.FEMALE, CandidateSex.MALE, CandidateSex.NOT_INFORMED];
  const candidate = (fullName, n) => ({
    fullName, birthDate: addDays(addYears(today, -20 - (n % 15)), -37 * n), sex: sexes[n % 3], cpf: fakeCpf(n),
    // Celular fictício de São Paulo: 11 9 + 8 dígitos derivados do número.
    phone: `119${String(10_000_000 + ((n * 7_919) % 90_000_000)).slice(-8)}`,
  });
  const approve = (p, approvedAt, data) => {
    P.approveCandidate(p, D(approvedAt), data, today).createdBy = rh;
  };
  let employee = 0;
  const fill = (p, approved, admission, firstDay) => {
    employee += 1;
    approve(p, approved, candidate(`Colaborador Demo ${String(employee).padStart(2, '0')}`, employee));
    P.registerAdmission(p, D(admission), `DEMO${String(employee).padStart(3, '0')}`);
    P.confirmFirstDay(p, D(firstDay), 'Comparecimento confirmado pelo cliente por e-mail (demo).', nacc, now);
  };

  // ------------------------------------------------------------ pedido 1: 10 estoquistas (exemplo-base da SPEC)
  const order1 = order(contractA, Modality.MOT, stockist, cdCajamar, 10, -24, -22, -13, TermType.INDEFINITE,
    { notes: 'Pedido recebido por WhatsApp.' });
  order1.jobDescription = 'Atividades: recebimento, conferência e armazenagem de mercadorias; separação de pedidos.\n\n'
    + 'Requisitos: ensino fundamental completo; experiência de 6 meses em estoque.\n'
    + 'Desejável: curso de empilhadeira.\n\nTurno: segunda a sábado, 6h às 14h20.';
  const p1 = positions(order1, rateStockist, 10, SlaTargetSource.CONTRACT);
  publish(order1, 'JC-DEMO-1001', -21, 'Uma publicação para as 10 vagas de estoquista.');
  fill(p1[0], -15, -13, -13);
  fill(p1[1], -15, -12, -12);
  fill(p1[2], -14, -11, -11);
  fill(p1[3], -14, -10, -8);
  approve(p1[4], -6, candidate('Ana Paula Souza', 21));
  P.registerAdmission(p1[4], D(-1), 'DEMO101');
  approve(p1[5], -6, candidate('Bruno Henrique Lima', 22));
  P.registerAdmission(p1[5], D(-1));
  approve(p1[6], -2, candidate('Carla Mendes', 23));
  P.startPause(p1[8], pauseDocs, D(-5));
  // p1[7] e p1[9] em recrutamento.

  // Reposição confirmada pelo cliente (em risco: meta contratual de 5 dias).
  const t1 = P.registerTermination(p1[0], false, D(-6), TerminationSource.DP, TerminationType.RESIGNATION,
    'Pediu demissão na primeira semana.', D(-5));
  const r1 = P.createReplacement(p1[0], t1, 11);
  order1.positions.push(r1);
  P.confirmReplacement(r1, D(-4), contractA.slaReplacementDays, SlaTargetSource.CONTRACT); // herda a publicação

  // Reposição aguardando a decisão do cliente.
  const t2 = P.registerTermination(p1[1], false, D(-2), TerminationSource.NACC, TerminationType.ABANDONMENT, null, D(-1));
  order1.positions.push(P.createReplacement(p1[1], t2, 12));

  // ------------------------------------------------------------ pedido 2: vigência fixa já vencida (a rotina encerra)
  const order2 = order(contractA, Modality.MOT, forklift, cdCajamar, 2, -35, -34, -30, TermType.FIXED_END, { termEndDate: D(-4) });
  const p2 = positions(order2, rateForklift, 10, SlaTargetSource.CONTRACT);
  publish(order2, 'JC-DEMO-1002', -33);
  fill(p2[1], -25, -21, -19);

  // ------------------------------------------------------------ pedido 3: facilities, duração preservada, meta padrão
  const order3 = order(contractB, Modality.FAC, cleaner, storeCenter, 3, -9, -8, -1, TermType.PRESERVED_DURATION,
    { termDurationDays: 90 });
  const p3 = positions(order3, rateCleaner, 15, SlaTargetSource.DEFAULT);
  // Recrutamento sem JobConvo: a loja indicou candidatos.
  recordJobconvo(order3, false, null, null, 'Vagas preenchidas por indicação da loja; sem publicação no JobConvo.', rh, now);
  P.cancel(p3[2], D(-4), 'Cliente reduziu o quadro da loja.');

  // ------------------------------------------------------------ pedido 4: R&S (sem cálculo em R$, sem meta)
  const order4 = order(contractB, Modality.RS, hrAnalyst, storeCenter, 1, -13, -13, 6, TermType.INDEFINITE);
  positions(order4, rateHr, null, SlaTargetSource.NONE);
  // Aberta: o RH ainda não informou a publicação no JobConvo.

  // ------------------------------------------------------------ pedido 5: aguardando a aprovação do cliente
  const order5 = order(contractB, Modality.FAC, cleaner, storeCenter, 4, -2, -2, 5, TermType.INDEFINITE, {
    notes: 'Pedido feito por telefone; o cliente vai formalizar por e-mail.',
    approvalStatus: OrderApprovalStatus.AWAITING_CLIENT_APPROVAL, clientDecisionDate: null, approvalRecordedAt: null,
    approvalRecordedBy: null,
  });
  for (let i = 1; i <= order5.quantity; i += 1) {
    order5.positions.push(P.createNew(order5, i, order5.desiredStartDate, null, rateCleaner, null, SlaTargetSource.NONE));
  }

  // ------------------------------------------------------------ analistas de RH responsáveis
  const rita = { id: users[Roles.Rh].id, name: users[Roles.Rh].name };
  const renato = { id: rh2.id, name: rh2.name };
  const manager = users[Roles.RhManager].id;
  setRhAnalysts(order1, [rita, renato], manager, now);
  setRhAnalysts(order2, [rita], manager, now);
  setRhAnalysts(order3, [renato], manager, now);
  // Pedidos 4 e 5: aguardando atribuição do RH.

  await transaction(async () => {
    await uow.save({ action: 'DEMO_SEED' });
    for (const [userId, r] of userRoles) await execute('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', userId, r);
  });
  const total = [order1, order2, order3, order4, order5].reduce((s, o) => s + o.positions.length, 0);
  console.log(`[demo] Dados de demonstração criados: 5 pedidos, ${total} posições e 10 usuários (um por perfil, um segundo analista de RH e um com todos).`);
}

/** CPF fictício com dígitos verificadores válidos (base de 9 dígitos a partir de n). */
export function fakeCpf(n) {
  const base = String(100000000 + n * 7919).slice(0, 9);
  const digit = (digits) => {
    const rest = [...digits].reduce((s, c, i) => s + Number(c) * (digits.length + 1 - i), 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = digit(base);
  const d2 = digit(base + d1);
  return `${base}${d1}${d2}`;
}

/** CNPJ fictício com dígitos verificadores válidos (raiz de 8 dígitos + filial). */
export function fakeCnpj(root8, branch = 1) {
  const base = root8.slice(0, 8) + String(branch).padStart(4, '0');
  const digit = (digits, weights) => {
    const rest = [...digits].reduce((s, c, i) => s + Number(c) * weights[i], 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = digit(base, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digit(base + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base}${d1}${d2}`;
}

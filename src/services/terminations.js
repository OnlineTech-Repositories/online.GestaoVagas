import {
  getById, getContract, getPosition, hasTermination, nextSequence, searchFilled,
} from '../db/repository.js';
import { addDays, formatBr, today as todayDate, utcNow } from '../domain/dates.js';
import { BusinessRuleError, NotFoundError } from '../domain/errors.js';
import {
  ContractStatus, Modality, NotificationTypes, OrderApprovalStatus, ParameterKeys, Roles, TermType, TerminationSource,
  TerminationType,
} from '../domain/enums.js';
import { Permissions } from '../domain/guards.js';
import { newOrder } from '../domain/order.js';
import * as P from '../domain/position.js';
import { DateReview } from './date-review.js';
import { positionFields } from './notice-fields.js';
import { Input } from './input.js';
import { links, notify } from './notifications.js';
import { getBool } from './parameters.js';
import { rateAt } from './snapshots.js';

/** Desligamentos (RN-11 a RN-14) e o desligamento avulso de colaborador sem posição no sistema (D1). */

/** Busca do colaborador por nome ou matrícula entre as posições FILLED sem desligamento. */
export async function searchFilledPositions(ctx, term) {
  Permissions.require(ctx.user, Roles.Dp, Roles.Nacc);
  const list = await searchFilled(ctx.uow, term, 50);
  return list.map((p) => ({
    positionId: p.id,
    employeeName: p.employeeName ?? '',
    employeeRegistration: p.employeeRegistration ?? '',
    clientName: p.order.contract?.client?.legalName ?? '',
    contractName: p.order.contract?.name ?? '',
    jobRoleName: p.order.jobRole?.name ?? '',
    workLocationName: p.order.workLocation?.name ?? '',
    firstDayAt: p.firstDayAt,
    orderNumber: p.order.number,
    slotNumber: p.slotNumber,
  }));
}

function readTermination(input) {
  return {
    lastWorkedDay: input.date('lastWorkedDay', { message: 'Informe o último dia trabalhado.' }),
    source: input.option('source', TerminationSource, { message: 'Selecione a origem da informação.' }),
    terminationType: input.option('terminationType', TerminationType, { message: 'Selecione o tipo de desligamento.' }),
    notes: input.text('notes'),
    registeredAt: input.date('registeredAt', { required: false }),
    justification: input.text('justification'),
  };
}

/** RN-11 a RN-14: registra o desligamento e cria a reposição AWAITING_CONFIRMATION. */
export async function registerTermination(ctx, body) {
  Permissions.require(ctx.user, Roles.Dp, Roles.Nacc);
  const input = new Input(body);
  const originPositionId = input.id('originPositionId', { message: 'Selecione o colaborador.' });
  const r = readTermination(input);
  input.done();
  const origin = await getPosition(ctx.uow, originPositionId);
  if (!origin) throw new NotFoundError('Posição não encontrada.');
  const result = await registerCore(ctx, origin, r, false);
  await ctx.uow.save({ action: 'REGISTER_TERMINATION', justification: r.justification });
  return result;
}

/** D1: cria pedido avulso (is_legacy) com a posição de origem FILLED e segue a RN-14. */
export async function registerLegacyTermination(ctx, body) {
  Permissions.require(ctx.user, Roles.Dp, Roles.Nacc);
  const input = new Input(body);
  const contractId = input.id('contractId', { message: 'Selecione o contrato.' });
  const modality = input.option('modality', Modality, { message: 'Selecione a modalidade.' });
  const jobRoleId = input.id('jobRoleId', { message: 'Selecione o cargo.' });
  const workLocationId = input.id('workLocationId', { message: 'Selecione o local de trabalho.' });
  const termType = input.option('termType', TermType, { message: 'Selecione o tipo de vigência.' });
  const termEndDate = input.date('termEndDate', { required: false });
  const termDurationDays = input.int('termDurationDays');
  const employeeName = input.text('employeeName');
  const employeeRegistration = input.text('employeeRegistration');
  const firstDayAt = input.date('firstDayAt', { required: false });
  const r = readTermination(input);
  input.done();

  if (!(await getBool(ParameterKeys.AllowLegacyTermination))) {
    throw new BusinessRuleError('O desligamento avulso está desabilitado pelo administrador.');
  }
  const contract = await getContract(ctx.uow, contractId);
  if (!contract) throw new BusinessRuleError('Contrato não encontrado.', 'contractId');
  if (contract.status !== ContractStatus.ACTIVE) throw new BusinessRuleError('Selecione um contrato ativo.', 'contractId');
  if (!contract.modalities.includes(modality)) {
    throw new BusinessRuleError('A modalidade selecionada não pertence ao contrato.', 'modality');
  }
  const jobRole = await getById(ctx.uow, 'JobRole', 'job_roles', jobRoleId);
  if (!jobRole) throw new BusinessRuleError('Cargo não encontrado.', 'jobRoleId');
  const location = await getById(ctx.uow, 'WorkLocation', 'work_locations', workLocationId);
  if (!location?.active) throw new BusinessRuleError('Selecione um local de trabalho ativo.', 'workLocationId');
  if (location.clientId && location.clientId !== contract.clientId) {
    throw new BusinessRuleError('O local de trabalho selecionado pertence a outro cliente.', 'workLocationId');
  }
  if (contract.contractingUnitId && location.id !== contract.contractingUnitId) {
    throw new BusinessRuleError('O pedido deste contrato usa a unidade contratante do contrato.', 'workLocationId');
  }
  // 1º dia futuro ou depois do último dia trabalhado: aviso antes de salvar (date-checks.js), não bloqueio.
  const startDate = firstDayAt ?? r.lastWorkedDay;
  P.validateTerm(termType, termEndDate, termDurationDays, startDate);
  const term = P.normalizeTerm(termType, termEndDate, termDurationDays);
  const order = newOrder({
    contractId: contract.id,
    modality,
    jobRoleId: jobRole.id,
    quantity: 1,
    workLocationId: location.id,
    clientRequestDate: startDate,
    desiredStartDate: startDate,
    termType,
    termEndDate: term.endDate,
    termDurationDays: term.durationDays,
    isLegacy: true,
    // Colaborador já trabalhava: não há aprovação do cliente a aguardar.
    approvalStatus: OrderApprovalStatus.APPROVED,
    clientDecisionDate: startDate,
    approvalRecordedAt: utcNow(),
    approvalRecordedBy: ctx.user.id,
    registeredAt: todayDate(),
    notes: 'Pedido criado automaticamente por desligamento avulso.',
  });
  order.contract = contract;
  order.jobRole = jobRole;
  order.workLocation = location;
  // RN-14: a reposição herda o valor da origem; usa a versão vigente no dia seguinte à saída.
  const rate = await rateAt(ctx.uow, contract.id, jobRole.id, addDays(r.lastWorkedDay, 1));
  const origin = P.createLegacyFilled(order, firstDayAt, employeeName, employeeRegistration, rate);
  order.positions.push(origin);
  ctx.uow.add(order);

  const result = await registerCore(ctx, origin, r, true);
  await ctx.uow.save({ action: 'REGISTER_LEGACY_TERMINATION', justification: r.justification });
  return result;
}

const TERMINATION_TYPE = {
  RESIGNATION: 'Pedido de demissão', DISMISSAL: 'Dispensa', CONTRACT_END: 'Fim de contrato', ABANDONMENT: 'Abandono', OTHER: 'Outro',
};

async function registerCore(ctx, origin, r, isNewOrigin) {
  const today = todayDate();
  const registeredAt = r.registeredAt ?? today;
  // Registro passado, último dia futuro (aviso prévio) ou antes do 1º dia: avisos antes de salvar (date-review.js).
  const review = new DateReview(ctx);
  const retroactive = await review.retroactive(registeredAt, 'A data de registro do desligamento', r.justification);

  const alreadyTerminated = !isNewOrigin && (await hasTermination(origin.id));
  const termination = P.registerTermination(origin, alreadyTerminated, r.lastWorkedDay, r.source, r.terminationType,
    r.notes, registeredAt);
  const sequence = isNewOrigin ? 2 : await nextSequence(ctx.uow, origin.orderId);
  const replacement = P.createReplacement(origin, termination, sequence);
  if (retroactive) P.markRetroactive(replacement);
  review.watchPosition(replacement, { fresh: true }).settle();

  const order = origin.order;
  await notify(ctx.uow, {
    type: NotificationTypes.TerminationRegistered,
    entityId: replacement.id,
    subject: `Desligamento registrado · Pedido ${order.number} · ${origin.employeeName}`,
    message: `Desligamento de ${origin.employeeName} (matrícula ${origin.employeeRegistration}), ${order.jobRole?.name} — `
      + `${order.contract?.client?.legalName}. Último dia trabalhado: ${formatBr(r.lastWorkedDay)}. `
      + 'Registre a decisão do cliente sobre a reposição.',
    link: links.position(replacement.id),
    email: {
      title: 'Desligamento registrado: decisão do cliente pendente',
      summary: 'Um colaborador foi desligado e a reposição da vaga aguarda a decisão do cliente (repor ou não repor).',
      status: { label: 'Aguardando decisão do cliente', tone: 'warning' },
      fields: [
        ['Colaborador', origin.employeeName, { strong: true }],
        ['Matrícula', origin.employeeRegistration],
        ...positionFields(replacement),
        ['Último dia trabalhado', formatBr(r.lastWorkedDay), { strong: true }],
        ['Tipo de desligamento', TERMINATION_TYPE[r.terminationType] ?? r.terminationType],
      ],
      action: 'NACC: registre na reposição a decisão do cliente. Os dias descobertos contam a partir do dia seguinte ao último dia trabalhado.',
      button: 'Registrar decisão',
    },
  }, { roles: [Roles.Nacc] });

  return { terminationId: termination.id, replacementPositionId: replacement.id };
}

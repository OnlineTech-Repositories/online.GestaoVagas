import { query } from '../db/index.js';
import {
  activeUsersByRoles, getById, getContract, getOrder, listOrders as listOrderRows, nextSequence, userNames,
} from '../db/repository.js';
import { calculate, isLegacyOrigin, sumValues } from '../domain/calculator.js';
import { formatBr, today as todayDate, utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import {
  ALL_ROLES, ContractStatus, DemandType, Labels, Modality, NotificationTypes, OrderApprovalStatus, OrderStatus,
  PositionStatus, Roles, SlaTargetSource, TermType,
} from '../domain/enums.js';
import {
  cleanMultiline, DateGuard, hasAnyRole, hasRole, isRhAnalyst, JOB_DESCRIPTION_MAX_LENGTH, Permissions, RhAccess,
} from '../domain/guards.js';
import * as O from '../domain/order.js';
import * as P from '../domain/position.js';
import { Input, isId } from './input.js';
import { links, notify } from './notifications.js';
import { calcSettings, isInitialLoadOpen } from './parameters.js';
import { toSummary } from './position-views.js';
import { slaFor, validatedRateAt } from './snapshots.js';

/** Pedidos: criação (RN-01 a RN-05), aprovação do cliente, JobConvo, analistas de RH e correção de datas. */

/** RN-01 a RN-04: cria o pedido e as N posições NEW. */
export async function createOrder(ctx, body) {
  const initialLoadOpen = await isInitialLoadOpen();
  // Matriz 4.1: só COMMERCIAL cria pedido. Na carga inicial (seção 13) o NACC também cadastra pedidos em aberto.
  if (!hasRole(ctx.user, Roles.Commercial) && !(initialLoadOpen && hasRole(ctx.user, Roles.Nacc))) {
    throw new ForbiddenError();
  }
  const input = new Input(body);
  const r = {
    contractId: input.id('contractId', { message: 'Selecione o contrato.' }),
    modality: input.option('modality', Modality, { message: 'Selecione a modalidade.' }),
    jobRoleId: input.id('jobRoleId', { message: 'Selecione o cargo.' }),
    quantity: input.int('quantity', { required: true, message: 'Informe a quantidade.' }),
    workLocationId: input.id('workLocationId', { message: 'Selecione o local de trabalho.' }),
    clientRequestDate: input.date('clientRequestDate', { message: 'Informe a data da solicitação do cliente.' }),
    desiredStartDate: input.date('desiredStartDate', { message: 'Informe a data de início desejada.' }),
    termType: input.option('termType', TermType, { message: 'Selecione o tipo de vigência.' }),
    termEndDate: input.date('termEndDate', { required: false }),
    termDurationDays: input.int('termDurationDays'),
    notes: input.text('notes'),
    registeredAt: input.date('registeredAt', { required: false }),
    justification: input.text('justification'),
    jobDescription: input.text('jobDescription'),
  };
  input.done();

  const today = todayDate();
  const contract = await getContract(ctx.uow, r.contractId);
  if (!contract) throw new BusinessRuleError('Contrato não encontrado.', 'contractId');
  if (contract.status !== ContractStatus.ACTIVE) {
    throw new BusinessRuleError('O pedido só pode ser registrado em contrato ativo.', 'contractId');
  }
  if (!contract.modalities.includes(r.modality)) {
    throw new BusinessRuleError('A modalidade selecionada não pertence ao contrato.', 'modality');
  }
  const jobRole = await getById(ctx.uow, 'JobRole', 'job_roles', r.jobRoleId);
  if (!jobRole?.active) throw new BusinessRuleError('Selecione um cargo ativo.', 'jobRoleId');
  const location = await getById(ctx.uow, 'WorkLocation', 'work_locations', r.workLocationId);
  if (!location?.active) throw new BusinessRuleError('Selecione um local de trabalho ativo.', 'workLocationId');
  if (location.clientId && location.clientId !== contract.clientId) {
    throw new BusinessRuleError('O local de trabalho selecionado pertence a outro cliente.', 'workLocationId');
  }
  if (contract.contractingUnitId && location.id !== contract.contractingUnitId) {
    throw new BusinessRuleError('O pedido deste contrato usa a unidade contratante do contrato.', 'workLocationId');
  }
  if (r.quantity < 1 || r.quantity > 1000) throw new BusinessRuleError('A quantidade deve estar entre 1 e 1000.', 'quantity');
  if (r.desiredStartDate < r.clientRequestDate) {
    throw new BusinessRuleError(
      'A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.', 'desiredStartDate');
  }
  P.validateTerm(r.termType, r.termEndDate, r.termDurationDays, r.desiredStartDate);
  const jobDescription = cleanMultiline(r.jobDescription);
  if (jobDescription && jobDescription.length > JOB_DESCRIPTION_MAX_LENGTH) {
    throw new BusinessRuleError(
      `A descrição da vaga deve ter no máximo ${JOB_DESCRIPTION_MAX_LENGTH} caracteres.`, 'jobDescription');
  }

  const registeredAt = r.registeredAt ?? today;
  DateGuard.notFuture(r.clientRequestDate, today, 'A data da solicitação do cliente', 'clientRequestDate');
  DateGuard.notFuture(registeredAt, today, 'A data de registro', 'registeredAt');
  if (registeredAt < r.clientRequestDate) {
    throw new BusinessRuleError('A data de registro não pode ser anterior à data da solicitação do cliente.', 'registeredAt');
  }
  const retroactive = DateGuard.checkRetroactive(registeredAt, today, initialLoadOpen, r.justification, 'A data de registro');

  // Valores por cargo são do contrato: o pedido só aceita cargo com valor validado vigente na data de registro.
  if (!(await validatedRateAt(ctx.uow, contract.id, jobRole.id, registeredAt))) {
    throw new BusinessRuleError(
      `O cargo ${jobRole.name} não tem valor validado neste contrato vigente em ${formatBr(registeredAt)}. `
      + 'Cadastre e valide o valor em Valores por cargo antes de concluir o pedido.', 'jobRoleId');
  }

  const term = P.normalizeTerm(r.termType, r.termEndDate, r.termDurationDays);
  const order = O.newOrder({
    contractId: contract.id,
    modality: r.modality,
    jobRoleId: jobRole.id,
    quantity: r.quantity,
    workLocationId: location.id,
    clientRequestDate: r.clientRequestDate,
    desiredStartDate: r.desiredStartDate,
    termType: r.termType,
    termEndDate: term.endDate,
    termDurationDays: term.durationDays,
    notes: DateGuard.clean(r.notes),
    jobDescription,
    registeredAt,
  });
  order.contract = contract;
  order.jobRole = jobRole;
  order.workLocation = location;

  // Todo pedido nasce aguardando a aprovação do cliente: as posições abrem (e o SLA começa) na aprovação.
  await addNewPositions(ctx, order, r.quantity, r.desiredStartDate, null, registeredAt, retroactive, 1);
  ctx.uow.add(order);
  await ctx.uow.save({ action: 'CREATE_ORDER', justification: r.justification });

  // Depois de gravar: o número do pedido (atribuído na gravação) entra na notificação.
  await notifyEveryone(ctx, order, NotificationTypes.OrderCreated, 'Novo pedido aguardando aprovação do cliente',
    'Nova demanda registrada, aguardando a aprovação formal do cliente. O RH já pode preparar o recrutamento.');
  await ctx.uow.save({ action: 'CREATE_ORDER' });
  return getOrderDetail(ctx, order.id);
}

/** RN-05: aumentar a quantidade gera novas posições, com a própria data de início desejada. */
export async function addPositions(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial);
  const input = new Input(body);
  const quantity = input.int('quantity', { required: true, message: 'Informe a quantidade.' });
  const desiredStartDate = input.date('desiredStartDate', { message: 'Informe a data de início desejada.' });
  const justification = input.text('justification');
  input.done();

  const order = await requireOrder(ctx, id);
  if (order.isLegacy) throw new BusinessRuleError('Não é possível acrescentar posições a um pedido de desligamento avulso.');
  if (order.contract.status !== ContractStatus.ACTIVE) throw new BusinessRuleError('O contrato do pedido não está ativo.');
  if (quantity < 1 || quantity > 1000) throw new BusinessRuleError('A quantidade deve estar entre 1 e 1000.', 'quantity');
  if (desiredStartDate < order.clientRequestDate) {
    throw new BusinessRuleError(
      'A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.', 'desiredStartDate');
  }
  if (order.approvalStatus === OrderApprovalStatus.NOT_APPROVED) {
    throw new BusinessRuleError('O cliente não aprovou este pedido: não é possível acrescentar posições.');
  }

  const sequence = await nextSequence(ctx.uow, order.id, order.positions);
  const today = todayDate();
  // Pedido aprovado: as novas posições abrem hoje; aguardando aprovação: abrem quando o cliente aprovar.
  await addNewPositions(ctx, order, quantity, desiredStartDate, O.isApproved(order) ? today : null, today, false, sequence);
  order.quantity += quantity;

  await notify(ctx.uow, {
    type: NotificationTypes.OrderCreated,
    entityId: order.id,
    subject: `Pedido ${order.number}: +${quantity} posição(ões)`,
    message: `O pedido ${order.number} (${order.jobRole?.name}, ${order.contract?.client?.legalName}) recebeu ${quantity} `
      + `nova(s) posição(ões), início desejado em ${formatBr(desiredStartDate)}.`,
    link: links.order(order.id),
  }, { roles: [Roles.RhManager, Roles.Nacc], userIds: O.activeRhAnalysts(order).map((a) => a.userId) });

  await ctx.uow.save({ action: 'ADD_POSITIONS', justification });
  return getOrderDetail(ctx, order.id);
}

const ORDER_DATES = Object.freeze({
  CLIENT_REQUEST_DATE: 'CLIENT_REQUEST_DATE',
  DESIRED_START_DATE: 'DESIRED_START_DATE',
  REGISTERED_AT: 'REGISTERED_AT',
  APPROVAL_DATE: 'APPROVAL_DATE',
});

/** RN-25: correção de datas do pedido pelo autor (ou ADMIN), com justificativa. */
export async function correctOrderDate(ctx, id, body) {
  const input = new Input(body);
  const field = input.option('field', ORDER_DATES, { message: 'Selecione a data a corrigir.' });
  const date = input.date('date');
  const rawJustification = input.text('justification');
  input.done();
  const justification = DateGuard.requireText(rawJustification, 'Informe a justificativa da correção.', 'justification');

  const order = await requireOrder(ctx, id);
  if (!hasRole(ctx.user, Roles.Admin) && order.createdBy !== ctx.user.id) {
    throw new ForbiddenError('Somente o autor do pedido ou um administrador pode corrigir estas datas.');
  }
  const today = todayDate();
  DateGuard.notFuture(field === ORDER_DATES.DESIRED_START_DATE ? today : date, today, 'A data corrigida', 'date');

  switch (field) {
    case ORDER_DATES.CLIENT_REQUEST_DATE:
      if (date > order.desiredStartDate || date > order.registeredAt) {
        throw new BusinessRuleError('A solicitação do cliente não pode ser posterior ao início desejado nem ao registro.', 'date');
      }
      order.clientRequestDate = date;
      break;
    case ORDER_DATES.DESIRED_START_DATE:
      if (date < order.clientRequestDate) {
        throw new BusinessRuleError(
          'A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.', 'desiredStartDate');
      }
      // Posições criadas com a data original acompanham a correção; acréscimos posteriores mantêm a própria data.
      for (const p of order.positions.filter((x) => x.demandType === DemandType.NEW && x.desiredStartDate === order.desiredStartDate)) {
        p.desiredStartDate = date;
      }
      order.desiredStartDate = date;
      break;
    case ORDER_DATES.REGISTERED_AT:
      if (date < order.clientRequestDate) {
        throw new BusinessRuleError('A data de registro não pode ser anterior à data da solicitação do cliente.', 'registeredAt');
      }
      order.registeredAt = date;
      break;
    default: {
      const current = order.clientDecisionDate;
      if (!O.isApproved(order) || !current) {
        throw new BusinessRuleError('O pedido não está aprovado: não há data de aprovação a corrigir.', 'date');
      }
      if (date < order.clientRequestDate) {
        throw new BusinessRuleError('A aprovação não pode ser anterior à solicitação do cliente.', 'date');
      }
      // A abertura das vagas novas é a data da aprovação: elas acompanham a correção.
      for (const p of order.positions.filter((x) => x.demandType === DemandType.NEW && x.openedAt === current)) {
        if (p.firstDayAt && p.firstDayAt < date) {
          throw new BusinessRuleError(`A posição ${p.slotNumber} tem 1º dia efetivo anterior à nova data de aprovação.`);
        }
        p.openedAt = date;
      }
      order.clientDecisionDate = date;
    }
  }
  await ctx.uow.save({ action: 'CORRECT_DATE', justification });
  return getOrderDetail(ctx, order.id);
}

/** Cargos que o pedido do contrato pode usar: ativos e com valor validado no contrato. */
export async function listJobRolesForContract(ctx, contractId) {
  const rows = await query(
    `SELECT j.id, j.name, MIN(r.valid_from) AS valid_from FROM contract_rates r JOIN job_roles j ON j.id = r.job_role_id
      WHERE r.contract_id = ? AND r.status = 'VALIDATED' AND j.active = 1
      GROUP BY j.id, j.name`, contractId);
  return rows.map((r) => ({ id: r.id, name: r.name, validFrom: r.valid_from }))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
}

export async function listOrdersDto(ctx, q) {
  const input = new Input(q);
  const clientId = input.id('clientId', { required: false });
  const contractId = input.id('contractId', { required: false });
  const status = input.option('status', OrderStatus, { required: false });
  const approvalStatus = input.option('approvalStatus', OrderApprovalStatus, { required: false });
  const rh = input.text('rh');
  input.done();

  let rhFilter = () => true;
  if (rh === 'UNASSIGNED') rhFilter = O.awaitingRhAssignment;
  else if (rh === 'MINE') rhFilter = (o) => Boolean(ctx.user.id) && isRhAnalyst(o, ctx.user.id);
  else if (rh && isId(rh)) rhFilter = (o) => isRhAnalyst(o, rh.toLowerCase());
  else if (rh) throw new BusinessRuleError('Filtro de analista de RH inválido.', 'rh');

  const list = await listOrderRows(ctx.uow, { clientId, contractId });
  // Pedidos avulsos (D1) só aparecem no filtro do RH: as reposições deles também precisam de responsável.
  return list.filter((o) => !o.isLegacy || rh)
    .filter(rhFilter)
    .filter((o) => !approvalStatus || o.approvalStatus === approvalStatus)
    .map(orderSummary)
    .filter((o) => !status || o.status === status)
    .sort((a, b) => b.number - a.number);
}

export async function getOrderDetail(ctx, id) {
  const order = await requireOrder(ctx, id);
  const today = todayDate();
  const settings = await calcSettings();
  const showMoney = Permissions.canSeeDetailedValues(ctx.user);
  const names = await userNames([
    order.createdBy, order.approvalRecordedBy, order.jobconvoRecordedBy,
    ...order.rhAnalysts.flatMap((a) => [a.assignedBy, a.removedBy]),
    ...order.positions.flatMap((p) => [p.firstDayConfirmedBy, p.exitTermination?.createdBy]),
  ]);
  const metrics = new Map(order.positions.map((p) => [p.id, calculate(p, today, settings)]));
  const positions = order.positions.filter((p) => !isLegacyOrigin(p))
    .sort((a, b) => a.slotNumber - b.slotNumber || a.cycle - b.cycle)
    .map((p) => toSummary(p, metrics.get(p.id), showMoney));

  return {
    summary: orderSummary(order),
    contractId: order.contractId,
    jobRoleId: order.jobRoleId,
    workLocationId: order.workLocationId,
    termType: order.termType,
    termEndDate: order.termEndDate,
    termDurationDays: order.termDurationDays,
    notes: order.notes,
    jobDescription: order.jobDescription,
    createdByName: order.createdBy ? names.get(order.createdBy) ?? null : null,
    canAddPositions: hasRole(ctx.user, Roles.Commercial) && !order.isLegacy,
    canCorrectDates: hasRole(ctx.user, Roles.Admin) || order.createdBy === ctx.user.id,
    positions,
    contractingUnit: contractingUnitLabel(order),
    approvalRecordedAt: order.approvalRecordedAt,
    approvalRecordedByName: order.approvalRecordedBy ? names.get(order.approvalRecordedBy) ?? null : null,
    notApprovedReason: order.notApprovedReason,
    canDecideApproval: order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL
      && hasAnyRole(ctx.user, [Roles.Commercial, Roles.Controllership]),
    jobconvo: order.jobconvoPublished === null || order.jobconvoPublished === undefined ? null : {
      published: order.jobconvoPublished,
      code: order.jobconvoCode,
      publishedAt: order.jobconvoPublishedAt,
      notes: order.jobconvoNotes,
      recordedAt: order.jobconvoRecordedAt,
      recordedByName: order.jobconvoRecordedBy ? names.get(order.jobconvoRecordedBy) ?? null : null,
    },
    canRecordJobconvo: RhAccess.canAct(ctx.user, order) && order.approvalStatus !== OrderApprovalStatus.NOT_APPROVED,
    rhAnalysts: O.activeRhAnalysts(order).map((a) => ({ id: a.userId, name: a.userName })),
    rhAssignmentHistory: [...order.rhAnalysts]
      .sort((a, b) => (b.removedAt ?? b.assignedAt).localeCompare(a.removedAt ?? a.assignedAt)
        || a.userName.localeCompare(b.userName, 'pt-BR'))
      .map((a) => ({
        userId: a.userId,
        userName: a.userName,
        assignedAt: a.assignedAt,
        assignedByName: a.assignedBy ? names.get(a.assignedBy) ?? null : null,
        removedAt: a.removedAt,
        removedByName: a.removedBy ? names.get(a.removedBy) ?? null : null,
      })),
    canAssignRh: hasRole(ctx.user, Roles.RhManager) && order.approvalStatus !== OrderApprovalStatus.NOT_APPROVED,
    slots: buildSlots(order, metrics, names, showMoney),
  };
}

/** Agrupa os ciclos por vaga: a linha mostra o ciclo atual; os anteriores formam o histórico de ocupantes. */
function buildSlots(order, metrics, names, showMoney) {
  const name = (id) => (id ? names.get(id) ?? null : null);
  const occupantName = (p) => p.employeeName ?? P.activeCandidate(p)?.fullName ?? null;
  const groups = new Map();
  for (const p of order.positions) {
    if (!groups.has(p.slotNumber)) groups.set(p.slotNumber, []);
    groups.get(p.slotNumber).push(p);
  }
  return [...groups.entries()].sort((a, b) => a[0] - b[0]).map(([number, slotPositions]) => {
    const cycles = [...slotPositions].sort((a, b) => a.cycle - b.cycle);
    const current = [...cycles].reverse().find(P.isCurrentCycle) ?? cycles[cycles.length - 1];
    const counted = cycles.filter((p) => !isLegacyOrigin(p));
    const occupants = cycles.map((p) => {
      const exit = p.exitTermination;
      const next = exit?.replacementPosition ?? null;
      return {
        positionId: p.id,
        cycle: p.cycle,
        demandType: p.demandType,
        status: p.status,
        isCurrent: P.isCurrentCycle(p),
        notReplaced: P.notReplaced(p),
        name: occupantName(p),
        registration: p.employeeRegistration ?? p.admissionRegistration,
        isCandidate: !p.employeeName && Boolean(P.activeCandidate(p)),
        openedAt: p.openedAt,
        admissionAt: p.admissionAt,
        firstDayAt: p.firstDayAt,
        firstDayConfirmedByName: name(p.firstDayConfirmedBy),
        leftAt: exit?.lastWorkedDay ?? null,
        exitType: exit?.terminationType ?? null,
        exitNotes: exit?.notes ?? null,
        exitRegisteredAt: exit?.registeredAt ?? null,
        exitRegisteredByName: name(exit?.createdBy),
        exitRecordedAt: exit?.createdAt ?? null,
        replacedByPositionId: next?.id ?? null,
        replacedByName: next ? occupantName(next) : null,
        isLegacyOrigin: isLegacyOrigin(p),
      };
    });
    return {
      number,
      current: toSummary(current, metrics.get(current.id), showMoney),
      uncoveredDaysTotal: counted.reduce((s, p) => s + metrics.get(p.id).uncoveredDays, 0),
      lostTotal: showMoney ? sumValues(counted.map((p) => metrics.get(p.id).lost)) : null,
      deferredTotal: showMoney ? sumValues(counted.map((p) => metrics.get(p.id).deferred)) : null,
      replacementCount: cycles.filter((p) => p.demandType === DemandType.REPLACEMENT).length,
      occupants,
    };
  });
}

/**
 * Gestor de RH distribui o pedido entre analistas de RH ativos (inclui, substitui ou remove). Quem entra e quem sai
 * é avisado; as remoções são lógicas e formam o histórico.
 */
export async function setRhAnalysts(ctx, id, body) {
  Permissions.require(ctx.user, Roles.RhManager);
  const input = new Input(body);
  const requested = [...new Set(input.ids('analystIds'))];
  input.done();
  const order = await requireOrder(ctx, id);
  const analysts = new Map((await activeUsersByRoles([Roles.Rh])).map((u) => [u.id, u]));
  if (requested.some((a) => !analysts.has(a))) {
    throw new BusinessRuleError('Selecione apenas usuários ativos com o perfil Analista de RH.', 'analystIds');
  }

  const { added, removed } = O.setRhAnalysts(order, requested.map((a) => ({ id: a, name: analysts.get(a).name })),
    ctx.user.id, utcNow());
  if (!added.length && !removed.length) return getOrderDetail(ctx, order.id);

  const active = O.activeRhAnalysts(order);
  const team = active.length ? active.map((a) => a.userName).join(', ') : 'nenhum';
  if (added.length) {
    await notifyTeamChange(ctx, order, NotificationTypes.RhAssigned, 'Você é responsável por um pedido',
      `Você passou a ser responsável pelo atendimento deste pedido. Equipe atual: ${team}.`, added);
  }
  if (removed.length) {
    await notifyTeamChange(ctx, order, NotificationTypes.RhUnassigned, 'Você não é mais responsável por um pedido',
      `Você não é mais responsável pelo atendimento deste pedido. Equipe atual: ${team}.`, removed);
  }
  await ctx.uow.save({ action: 'ASSIGN_RH' });
  return getOrderDetail(ctx, order.id);
}

function notifyTeamChange(ctx, order, type, subject, intro, analysts) {
  const quantity = order.positions.filter((p) => p.demandType === DemandType.NEW).length;
  return notify(ctx.uow, {
    type,
    entityId: order.id,
    subject: `${subject} — Pedido ${order.number}`,
    message: `Pedido ${order.number} — ${intro} Cliente: ${order.contract?.client?.legalName}. `
      + `Unidade contratante: ${contractingUnitLabel(order)}. Cargo: ${order.jobRole?.name}. Vagas: ${quantity}.`,
    link: links.order(order.id),
  }, { userIds: analysts.map((a) => a.userId) });
}

/**
 * RN-06 no pedido (RH): uma publicação no JobConvo atende todas as posições. As abertas entram em recrutamento; as
 * acrescentadas e as reposições confirmadas depois herdam. Atualizar a publicação reflete em todas.
 */
export async function recordJobconvo(ctx, id, body) {
  const input = new Input(body);
  const published = input.bool('published', false);
  const code = input.text('code');
  const publishedAt = input.date('publishedAt', { required: false });
  const justification = input.text('justification');
  input.done();

  const order = await requireOrder(ctx, id);
  RhAccess.require(ctx.user, order);
  let retroactive = false;
  if (published && publishedAt) {
    const today = todayDate();
    DateGuard.notFuture(publishedAt, today, 'A data da publicação', 'publishedAt');
    retroactive = DateGuard.checkRetroactive(publishedAt, today, await isInitialLoadOpen(), justification,
      'A data da publicação');
  }
  const started = O.recordJobconvo(order, published, code, publishedAt, justification, ctx.user.id, utcNow());
  if (retroactive) for (const p of started) P.markRetroactive(p);
  await ctx.uow.save({ action: 'RECORD_JOBCONVO', justification: order.jobconvoNotes });
  return getOrderDetail(ctx, order.id);
}

/** Aprovação formal do cliente (Comercial ou Controladoria): as vagas novas abrem e o SLA começa. */
export async function approveOrder(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial, Roles.Controllership);
  const input = new Input(body);
  const date = input.date('date', { message: 'Informe a data da aprovação.' });
  const justification = input.text('justification');
  input.done();

  const order = await requireOrder(ctx, id);
  const today = todayDate();
  DateGuard.notFuture(date, today, 'A data da aprovação', 'date');
  const retroactive = DateGuard.checkRetroactive(date, today, await isInitialLoadOpen(), justification, 'A data da aprovação');
  for (const p of O.approve(order, date, ctx.user.id, utcNow())) {
    const sla = await slaFor(order.contract, order.modality, DemandType.NEW, date);
    P.openOnApproval(p, date, sla.days, sla.source);
    if (retroactive) P.markRetroactive(p);
  }
  await notifyEveryone(ctx, order, NotificationTypes.OrderApproved, 'Pedido aprovado pelo cliente',
    `A demanda foi aprovada formalmente pelo cliente em ${formatBr(date)}; as posições estão abertas.`);
  await ctx.uow.save({ action: 'APPROVE_ORDER', justification });
  return getOrderDetail(ctx, order.id);
}

/** O cliente não aprovou: as posições são encerradas como "cliente cancelou", sem perda em R$. */
export async function rejectOrder(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial, Roles.Controllership);
  const input = new Input(body);
  const date = input.date('date', { message: 'Informe a data da decisão.' });
  const reason = input.text('reason');
  input.done();

  const order = await requireOrder(ctx, id);
  DateGuard.notFuture(date, todayDate(), 'A data da decisão', 'date');
  O.reject(order, date, reason, ctx.user.id, utcNow());
  await notifyEveryone(ctx, order, NotificationTypes.OrderNotApproved, 'Pedido não aprovado pelo cliente',
    `O cliente não aprovou a demanda (${order.notApprovedReason}); as posições foram encerradas.`);
  await ctx.uow.save({ action: 'NOT_APPROVE_ORDER', justification: order.notApprovedReason });
  return getOrderDetail(ctx, order.id);
}

// ---------------------------------------------------------------- auxiliares

async function requireOrder(ctx, id) {
  const order = await getOrder(ctx.uow, id);
  if (!order) throw new NotFoundError('Pedido não encontrado.');
  return order;
}

/** Unidade contratante do contrato, ou o cliente principal quando o contrato não tem unidade. */
const contractingUnitLabel = (order) => {
  const unit = order.contract?.contractingUnit;
  return unit ? `${unit.code} — ${unit.name}` : 'Cliente principal';
};

/** Notificação a todos os usuários ativos, identificando pedido, cliente, unidade, cargo, vagas e status. */
function notifyEveryone(ctx, order, type, subject, intro) {
  const quantity = order.positions.filter((p) => p.demandType === DemandType.NEW).length;
  return notify(ctx.uow, {
    type,
    entityId: order.id,
    subject: `${subject} — ${order.jobRole?.name}`,
    message: `Pedido ${order.number} — ${intro} Cliente: ${order.contract?.client?.legalName}. `
      + `Unidade contratante: ${contractingUnitLabel(order)}. Cargo: ${order.jobRole?.name}. Vagas: ${quantity}. `
      + `Status: ${Labels.approvalStatus[order.approvalStatus]}.`,
    link: links.order(order.id),
  }, { roles: ALL_ROLES });
}

/**
 * Cria as vagas novas. `openedAt` nulo = aguardando a aprovação (sem abertura nem meta, gravadas na aprovação); o
 * valor é a versão validada vigente em `rateDate`.
 */
async function addNewPositions(ctx, order, quantity, desiredStartDate, openedAt, rateDate, retroactive, firstSequence) {
  const rate = await validatedRateAt(ctx.uow, order.contractId, order.jobRoleId, rateDate);
  // Vagas novas continuam a numeração das vagas do pedido (as reposições não consomem números de vaga).
  const firstSlot = Math.max(0, ...order.positions.map((p) => p.slotNumber)) + 1;
  const sla = openedAt
    ? await slaFor(order.contract, order.modality, DemandType.NEW, openedAt)
    : { days: null, source: SlaTargetSource.NONE };
  for (let i = 0; i < quantity; i += 1) {
    const p = P.createNew(order, firstSequence + i, desiredStartDate, openedAt, rate, sla.days, sla.source, firstSlot + i);
    if (retroactive) P.markRetroactive(p);
    order.positions.push(p);
  }
}

export function orderSummary(o) {
  const current = O.currentPositions(o);
  return {
    id: o.id,
    number: o.number,
    clientName: o.contract?.client?.legalName ?? '',
    contractName: o.contract?.name ?? '',
    modality: o.modality,
    jobRoleName: o.jobRole?.name ?? '',
    workLocationName: o.workLocation?.name ?? '',
    quantity: o.quantity,
    clientRequestDate: o.clientRequestDate,
    desiredStartDate: o.desiredStartDate,
    registeredAt: o.registeredAt,
    status: O.computeStatus(o.positions),
    openPositions: current.filter(P.isOpen).length,
    filledPositions: current.filter((p) => p.status === PositionStatus.FILLED).length,
    isLegacy: o.isLegacy,
    approvalStatus: o.approvalStatus,
    clientDecisionDate: o.clientDecisionDate,
    jobconvoPublished: o.jobconvoPublished,
    jobconvoCode: o.jobconvoCode,
    rhAnalystNames: O.activeRhAnalysts(o).map((a) => a.userName),
    awaitingRhAssignment: O.awaitingRhAssignment(o),
    replacementCount: o.positions.filter((p) => p.demandType === DemandType.REPLACEMENT).length,
  };
}

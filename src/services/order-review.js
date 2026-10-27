import { query, queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { getById, listWithoutRate, userNames } from '../db/repository.js';
import { formatBr, utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError } from '../domain/errors.js';
import {
  ControllershipStatus, NotificationTypes, OrderApprovalStatus as A, OrderReviewAction, RateStatus, Roles,
} from '../domain/enums.js';
import { DateGuard, hasRole, Permissions } from '../domain/guards.js';
import { isOpen } from '../domain/position.js';
import { Input } from './input.js';
import { orderFields } from './notice-fields.js';
import { links, notify } from './notifications.js';
import { getOrderDetail, notifyEveryone, requireOrder } from './orders.js';
import { checkRateValues, dailyOf, money, round2 } from './rates.js';
import { validatedRateAt } from './snapshots.js';

/**
 * Cargo e valores comerciais no próprio pedido, com a validação da Controladoria (melhoria de 26/10/2026).
 *
 * O Comercial informa no pedido o valor mensal, o fee e o início da vigência. Se forem os do valor já validado e
 * vigente para contrato + cargo, o pedido segue direto para a aprovação do cliente, como antes. Valor inexistente ou
 * diferente vira uma nova versão em Valores por cargo (pendente, vinculada ao pedido) e o pedido fica "Aguardando
 * aprovação da Controladoria": uma única solicitação, que a Controladoria valida ou devolve com motivo e o Comercial
 * ajusta (cargo e valores) e reenvia. Validado, o valor entra em Valores por cargo e o pedido segue para o cliente.
 */

export const inReview = (order) => order.approvalStatus === A.AWAITING_CONTROLLERSHIP;
/** Alteração de cargo e valores feita pela edição administrativa, aguardando a Controladoria (o pedido segue). */
export const inRevalidation = (order) => !inReview(order) && Boolean(order.pendingRateId);

/** Valores informados no pedido; null quando nenhum veio (o pedido usa o valor validado vigente, como antes). */
export function readCommercialValues(input) {
  const values = {
    monthlyValue: input.decimal('monthlyValue'),
    feeValue: input.decimal('feeValue'),
    validFrom: input.date('rateValidFrom', { required: false }),
  };
  return Object.values(values).every((v) => v === null) ? null : values;
}

const same = (a, b) => (a === null || a === undefined ? null : Number(a)) === (b === null || b === undefined ? null : Number(b));
export const sameValues = (rate, v) => same(rate.monthlyValue, round2(v.monthlyValue)) && same(rate.feeValue, round2(v.feeValue))
  && rate.validFrom === v.validFrom;

/**
 * Valor do pedido para contrato + cargo. Sem valores informados: o validado vigente no registro (obrigatório). Com
 * valores: o validado, se forem os mesmos; senão uma versão pendente — a do próprio pedido, corrigida (`ownRate`,
 * devolvida e do mesmo cargo), ou uma nova. Devolve { rate, review } (review = precisa da Controladoria).
 */
export async function resolveOrderRate(ctx, contract, jobRole, values, registeredAt, ownRate = null) {
  if (!values) {
    const validated = await validatedRateAt(ctx.uow, contract.id, jobRole.id, registeredAt);
    if (!validated) {
      throw new BusinessRuleError(
        `O cargo ${jobRole.name} não tem valor validado neste contrato vigente em ${formatBr(registeredAt)}. `
        + 'Informe o valor mensal e o início da vigência: o pedido segue para a validação da Controladoria.', 'jobRoleId');
    }
    return { rate: validated, review: false };
  }
  if (!values.validFrom) throw new BusinessRuleError('Informe o início da vigência do valor.', 'rateValidFrom');
  checkRateValues(contract, values.monthlyValue, values.feeValue);

  const validated = await validatedRateAt(ctx.uow, contract.id, jobRole.id, registeredAt);
  if (validated && sameValues(validated, values)) return { rate: validated, review: false };

  // Uma versão por contrato + cargo + vigência (índice único): sem cadastro duplicado.
  const existing = ctx.uow.load('ContractRate', await queryOne(
    'SELECT * FROM contract_rates WHERE contract_id = ? AND job_role_id = ? AND valid_from = ?',
    contract.id, jobRole.id, values.validFrom));
  if (existing && existing !== ownRate) {
    if (existing.status === RateStatus.VALIDATED && sameValues(existing, values)) return { rate: existing, review: false };
    throw new BusinessRuleError(existing.status === RateStatus.VALIDATED
      ? `Já existe valor validado de ${describeValue(existing)} para este cargo no contrato a partir de `
        + `${formatBr(values.validFrom)}. Para alterá-lo, informe outro início de vigência (nova versão).`
      : `Já existe valor ${existing.status === RateStatus.PENDING ? 'aguardando validação' : 'rejeitado'} para este cargo no `
        + `contrato a partir de ${formatBr(values.validFrom)} (Valores por cargo). Informe outro início de vigência.`,
    'rateValidFrom');
  }

  const props = {
    monthlyValue: round2(values.monthlyValue), feeValue: round2(values.feeValue), validFrom: values.validFrom,
    status: RateStatus.PENDING, validatedBy: null, validatedAt: null, rejectionReason: null,
  };
  if (ownRate && ownRate.jobRoleId === jobRole.id && ownRate.status !== RateStatus.VALIDATED) {
    Object.assign(ownRate, props);
    return { rate: ownRate, review: true };
  }
  const rate = ctx.uow.add(entity('ContractRate', { contractId: contract.id, jobRoleId: jobRole.id, orderId: null, ...props }));
  rate.contract = contract;
  rate.jobRole = jobRole;
  return { rate, review: true };
}

/** Pedido recém-criado com valor novo ou alterado: nasce aguardando a Controladoria. */
export function startReview(ctx, order, rate) {
  rate.orderId ??= order.id;
  order.approvalStatus = A.AWAITING_CONTROLLERSHIP;
  order.controllershipStatus = ControllershipStatus.PENDING;
  record(ctx, order, OrderReviewAction.SUBMITTED, rate);
}

/** Controladoria valida: o valor entra em Valores por cargo e o pedido segue para a aprovação do cliente. */
export async function validateOrderReview(ctx, id) {
  Permissions.require(ctx.user, Roles.Controllership);
  const order = await requireDecision(ctx, id);
  ensureNotAuthor(ctx, order);
  if (inRevalidation(order)) return decideRevalidation(ctx, order, null);
  const rate = order.rate;
  const now = utcNow();
  if (rate.status !== RateStatus.VALIDATED) {
    Object.assign(rate, { status: RateStatus.VALIDATED, validatedBy: ctx.user.id, validatedAt: now, rejectionReason: null });
  }
  // Como no cadastro em Valores por cargo: posições abertas sem valor, abertas a partir da vigência, recebem esta versão.
  for (const p of await listWithoutRate(ctx.uow, rate.contractId, rate.jobRoleId, rate.validFrom)) p.rateId = rate.id;
  Object.assign(order, {
    approvalStatus: A.AWAITING_CLIENT_APPROVAL, controllershipStatus: ControllershipStatus.VALIDATED,
    controllershipDecidedAt: now, controllershipDecidedBy: ctx.user.id, controllershipReason: null,
  });
  record(ctx, order, OrderReviewAction.VALIDATED, rate);
  // O aviso de pedido novo, que antes saía na criação, sai agora: a todos, inclusive o Comercial que enviou.
  await notifyEveryone(ctx, order, NotificationTypes.OrderCreated, 'Pedido validado pela Controladoria, aguardando aprovação do cliente',
    'A Controladoria validou o cargo e os valores comerciais; o pedido aguarda a aprovação formal do cliente. O RH já pode preparar o recrutamento.', {
      status: { label: 'Aguardando aprovação do cliente', tone: 'warning' },
      fields: [['Solicitação do cliente', formatBr(order.clientRequestDate)], ['Início desejado', formatBr(order.desiredStartDate), { strong: true }],
        ['Validação da Controladoria', `Validado em ${formatBr(now.slice(0, 10))}`, { tone: 'success' }]],
      action: 'Comercial ou Controladoria: registre no pedido a aprovação (ou a recusa) do cliente. RH: o recrutamento já pode ser preparado; o prazo do SLA começa na aprovação.',
    });
  await ctx.uow.save({ action: 'VALIDATE_ORDER_REVIEW' });
  return getOrderDetail(ctx, order.id);
}

/** Controladoria devolve para ajustes, com motivo: o valor proposto fica rejeitado até o reenvio. */
export async function returnOrderReview(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Controllership);
  const input = new Input(body);
  const rawReason = input.text('reason');
  input.done();
  const reason = DateGuard.requireText(rawReason, 'Informe o motivo da devolução.', 'reason');
  const order = await requireDecision(ctx, id);
  ensureNotAuthor(ctx, order);
  if (inRevalidation(order)) return decideRevalidation(ctx, order, reason);
  const rate = order.rate;
  const now = utcNow();
  if (rate.orderId === order.id && rate.status === RateStatus.PENDING) {
    Object.assign(rate, { status: RateStatus.REJECTED, rejectionReason: reason, validatedBy: ctx.user.id, validatedAt: now });
  }
  Object.assign(order, {
    controllershipStatus: ControllershipStatus.RETURNED, controllershipDecidedAt: now, controllershipDecidedBy: ctx.user.id,
    controllershipReason: reason,
  });
  record(ctx, order, OrderReviewAction.RETURNED, rate, reason);
  await notify(ctx.uow, {
    type: NotificationTypes.OrderReviewReturned,
    entityId: order.id,
    subject: `Pedido devolvido pela Controladoria · Pedido ${order.number}`,
    message: `O pedido ${order.number} (${order.jobRole?.name}, ${order.contract?.client?.legalName}) foi devolvido pela `
      + `Controladoria para ajustes. Motivo: ${reason}`,
    link: links.order(order.id),
    email: {
      title: 'Pedido devolvido pela Controladoria',
      summary: 'A Controladoria devolveu o pedido para ajustes no cargo ou nos valores comerciais.',
      status: { label: 'Devolvido para ajustes', tone: 'danger' },
      fields: [...orderFields(order), ...valueFields(rate), ['Motivo da devolução', reason, { strong: true }]],
      action: 'Comercial: ajuste o cargo ou os valores no pedido e reenvie à Controladoria.',
      button: 'Ajustar pedido',
    },
  }, { userIds: authorsOf(order) });
  await ctx.uow.save({ action: 'RETURN_ORDER_REVIEW', justification: reason });
  return getOrderDetail(ctx, order.id);
}

/** Comercial ajusta cargo e valores do pedido devolvido e reenvia a mesma solicitação. */
export async function resubmitOrderReview(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial);
  const input = new Input(body);
  const jobRoleId = input.id('jobRoleId', { message: 'Selecione o cargo.' });
  const values = readCommercialValues(input) ?? { monthlyValue: null, feeValue: null, validFrom: null };
  input.done();
  const order = await requireReview(ctx, id, ControllershipStatus.RETURNED);
  const jobRole = await getById(ctx.uow, 'JobRole', 'job_roles', jobRoleId);
  if (!jobRole?.active) throw new BusinessRuleError('Selecione um cargo ativo.', 'jobRoleId');

  const previous = order.rate;
  const own = previous?.orderId === order.id ? previous : null;
  // O reenvio volta sempre à Controladoria, mesmo que agora coincida com o valor já validado.
  const { rate } = await resolveOrderRate(ctx, order.contract, jobRole, values, order.registeredAt, own);
  if (rate.status !== RateStatus.VALIDATED) rate.orderId ??= order.id;
  order.jobRoleId = jobRole.id;
  order.jobRole = jobRole;
  order.rateId = rate.id;
  order.rate = rate;
  for (const p of order.positions.filter((x) => isOpen(x) && x.rateId === previous?.id)) {
    p.rateId = rate.id;
    p.rate = rate;
  }
  order.controllershipStatus = ControllershipStatus.PENDING;
  order.controllershipReason = null;
  record(ctx, order, OrderReviewAction.RESUBMITTED, rate);
  await notifyReviewPending(ctx, order, true);
  await ctx.uow.save({ action: 'RESUBMIT_ORDER_REVIEW' });
  return getOrderDetail(ctx, order.id);
}

/**
 * Decisão da Controladoria sobre a alteração administrativa de cargo e valores (o pedido não parou). Validada, o
 * pedido passa ao cargo e ao valor novos e as posições em aberto recebem o valor; devolvida (`reason`), o valor
 * proposto fica rejeitado e o pedido segue com o cargo e o valor anteriores. A validação anterior fica no histórico.
 */
async function decideRevalidation(ctx, order, reason) {
  const rate = order.pendingRate;
  const now = utcNow();
  const editor = [...(order.reviews ?? [])].reverse().find((r) => r.action === OrderReviewAction.REVALIDATION_REQUESTED)?.userId;
  if (reason === null) {
    Object.assign(rate, { status: RateStatus.VALIDATED, validatedBy: ctx.user.id, validatedAt: now, rejectionReason: null });
    order.jobRoleId = rate.jobRoleId;
    order.jobRole = rate.jobRole ?? await getById(ctx.uow, 'JobRole', 'job_roles', rate.jobRoleId);
    order.rateId = rate.id;
    order.rate = rate;
    // Todas as posições em aberto passam ao novo valor; preenchidas e encerradas ficam com o que tinham (decisão do usuário).
    for (const p of order.positions.filter((x) => isOpen(x) && !x.exitTermination)) {
      p.rateId = rate.id;
      p.rate = rate;
    }
    order.controllershipStatus = ControllershipStatus.VALIDATED;
    order.controllershipReason = null;
  } else {
    Object.assign(rate, { status: RateStatus.REJECTED, rejectionReason: reason, validatedBy: ctx.user.id, validatedAt: now });
    const validatedBefore = (order.reviews ?? []).some((r) => r.action === OrderReviewAction.VALIDATED);
    order.controllershipStatus = validatedBefore ? ControllershipStatus.VALIDATED : null;
    order.controllershipReason = reason;
  }
  order.pendingRateId = null;
  order.pendingRate = null;
  order.controllershipDecidedAt = now;
  order.controllershipDecidedBy = ctx.user.id;
  record(ctx, order, reason === null ? OrderReviewAction.VALIDATED : OrderReviewAction.RETURNED, rate, reason);
  const validated = reason === null;
  await notify(ctx.uow, {
    type: validated ? NotificationTypes.OrderReviewValidated : NotificationTypes.OrderReviewReturned,
    entityId: order.id,
    subject: `Alteração de valores ${validated ? 'validada' : 'devolvida'} pela Controladoria · Pedido ${order.number}`,
    message: validated
      ? `A Controladoria validou a alteração de cargo e valores do pedido ${order.number}: ${rate.jobRole?.name ?? order.jobRole?.name}, `
        + `${describeValue(rate)}, vigência a partir de ${formatBr(rate.validFrom)}.`
      : `A Controladoria devolveu a alteração de cargo e valores do pedido ${order.number}; o pedido segue com o cargo e o `
        + `valor anteriores. Motivo: ${reason}`,
    link: links.order(order.id),
    email: {
      title: `Alteração de valores ${validated ? 'validada' : 'devolvida'} pela Controladoria`,
      summary: validated
        ? 'O pedido passa a usar o cargo e o valor validados; as posições em aberto recebem o novo valor.'
        : 'A alteração feita na edição administrativa foi devolvida; o pedido segue com o cargo e o valor anteriores.',
      status: validated ? { label: 'Validada', tone: 'success' } : { label: 'Devolvida', tone: 'danger' },
      fields: [...orderFields(order), ...valueFields(rate), ...(validated ? [] : [['Motivo da devolução', reason, { strong: true }]])],
      button: 'Consultar pedido',
    },
  }, { userIds: [editor, order.contract?.commercialOwnerId].filter(Boolean) });
  await ctx.uow.save({ action: validated ? 'VALIDATE_ORDER_REVALIDATION' : 'RETURN_ORDER_REVALIDATION', justification: reason });
  return getOrderDetail(ctx, order.id);
}

/** Aviso à Controladoria: pedido novo, reenviado ou com alteração administrativa aguardando a validação. */
export function notifyReviewPending(ctx, order, resubmitted = false) {
  if (resubmitted === 'revalidation') return notifyRevalidationPending(ctx, order);
  const title = resubmitted ? 'Pedido ajustado, aguardando validação da Controladoria' : 'Pedido aguardando validação da Controladoria';
  return notify(ctx.uow, {
    type: NotificationTypes.OrderReviewPending,
    entityId: order.id,
    subject: `${title} · Pedido ${order.number}`,
    message: `O pedido ${order.number} (${order.jobRole?.name}, ${order.contract?.client?.legalName}) `
      + `${resubmitted ? 'foi ajustado pelo Comercial e ' : ''}aguarda a validação do cargo e dos valores comerciais.`,
    link: links.order(order.id),
    email: {
      title,
      summary: resubmitted
        ? 'O Comercial ajustou o pedido devolvido e o reenviou para a validação da Controladoria.'
        : 'O Comercial criou um pedido com valor por cargo novo ou alterado, que precisa da validação da Controladoria.',
      status: { label: 'Aguardando aprovação da Controladoria', tone: 'warning' },
      fields: [...orderFields(order), ...valueFields(order.rate)],
      action: 'Controladoria: confira o cargo e os valores e valide ou devolva para ajustes, no próprio pedido. '
        + 'Validado, o pedido segue para a aprovação do cliente.',
      button: 'Validar pedido',
    },
  }, { roles: [Roles.Controllership] });
}

function notifyRevalidationPending(ctx, order) {
  const rate = order.pendingRate;
  return notify(ctx.uow, {
    type: NotificationTypes.OrderReviewPending,
    entityId: order.id,
    subject: `Alteração de valores aguardando validação da Controladoria · Pedido ${order.number}`,
    message: `O Administrador alterou o cargo ou os valores do pedido ${order.number} (${order.contract?.client?.legalName}). `
      + 'O pedido segue com o valor atual até a validação da Controladoria.',
    link: links.order(order.id),
    email: {
      title: 'Alteração de valores aguardando validação da Controladoria',
      summary: 'A edição administrativa alterou o cargo ou os valores comerciais de um pedido já validado. O pedido segue na '
        + 'etapa em que está, com o valor atual, até a decisão da Controladoria.',
      status: { label: 'Aguardando validação da Controladoria', tone: 'warning' },
      fields: [...orderFields(order), ['Cargo proposto', rate.jobRole?.name], ...valueFields(rate)],
      action: 'Controladoria: valide ou devolva a alteração no próprio pedido.',
      button: 'Validar alteração',
    },
  }, { roles: [Roles.Controllership] });
}

/** Bloco "Validação da Controladoria" do detalhe: situação, valores propostos, histórico e ações permitidas. */
export async function reviewDto(ctx, order, showMoney) {
  // Pedidos anteriores ao fluxo integrado não gravam o valor: vale o validado vigente no registro.
  const rate = order.rate ?? (order.isLegacy ? null : await validatedRateAt(ctx.uow, order.contractId, order.jobRoleId, order.registeredAt));
  const values = showMoney && rate ? {
    rateId: rate.id,
    jobRoleName: rate.jobRole?.name ?? order.jobRole?.name ?? '',
    monthlyValue: rate.monthlyValue,
    dailyValue: rate.monthlyValue === null ? null : dailyOf(rate.monthlyValue),
    feeValue: rate.feeValue,
    validFrom: rate.validFrom,
    status: rate.status,
  } : null;
  const reviews = order.reviews ?? [];
  if (!order.controllershipStatus && !reviews.length) return { values, controllership: null };

  const names = await userNames([...reviews.map((r) => r.userId)]);
  const roleIds = [...new Set(reviews.map((r) => r.jobRoleId).filter(Boolean))];
  const roles = roleIds.length
    ? await query(`SELECT id, name FROM job_roles WHERE id IN (${roleIds.map(() => '?').join(', ')})`, ...roleIds)
    : [];
  const pending = order.controllershipStatus === ControllershipStatus.PENDING && (inReview(order) || inRevalidation(order));
  const proposed = order.pendingRate;
  return {
    values,
    controllership: {
      status: order.controllershipStatus,
      // Alteração administrativa aguardando a decisão (o pedido segue com `values` até lá).
      revalidation: inRevalidation(order) ? {
        jobRoleName: proposed?.jobRole?.name ?? null,
        ...(showMoney && proposed ? {
          monthlyValue: proposed.monthlyValue, feeValue: proposed.feeValue, validFrom: proposed.validFrom,
          dailyValue: proposed.monthlyValue === null ? null : dailyOf(proposed.monthlyValue),
        } : {}),
      } : null,
      reason: order.controllershipReason,
      history: reviews.map((r) => ({
        action: r.action,
        userName: r.userId ? names.get(r.userId) ?? null : null,
        occurredAt: r.occurredAt,
        reason: r.reason,
        jobRoleName: roles.find((j) => j.id === r.jobRoleId)?.name ?? null,
        ...(showMoney ? { monthlyValue: r.monthlyValue, feeValue: r.feeValue, validFrom: r.validFrom } : {}),
      })),
      canDecide: pending && hasRole(ctx.user, Roles.Controllership) && !authorsOf(order).includes(ctx.user.id),
      authorBlocked: pending && hasRole(ctx.user, Roles.Controllership) && authorsOf(order).includes(ctx.user.id),
      canResubmit: inReview(order) && order.controllershipStatus === ControllershipStatus.RETURNED
        && hasRole(ctx.user, Roles.Commercial),
    },
  };
}

// ---------------------------------------------------------------- auxiliares

export function record(ctx, order, action, rate, reason = null) {
  order.reviews ??= [];
  order.reviews.push(entity('OrderReview', {
    orderId: order.id, action, userId: ctx.user.id, occurredAt: utcNow(), reason,
    jobRoleId: rate?.jobRoleId ?? order.jobRoleId, monthlyValue: rate?.monthlyValue ?? null,
    feeValue: rate?.feeValue ?? null, validFrom: rate?.validFrom ?? null, rateId: rate?.id ?? null,
  }));
}

/** Algo aguardando a decisão da Controladoria: o pedido em validação ou a alteração administrativa. */
async function requireDecision(ctx, id) {
  const order = await requireOrder(ctx, id);
  if (order.controllershipStatus === ControllershipStatus.PENDING && (inReview(order) || inRevalidation(order))) return order;
  if (inReview(order) && order.controllershipStatus === ControllershipStatus.RETURNED) {
    throw new BusinessRuleError('O pedido foi devolvido para ajustes: aguarde o reenvio do Comercial.');
  }
  throw new BusinessRuleError('O pedido não tem cargo e valores aguardando a validação da Controladoria.');
}

async function requireReview(ctx, id, status) {
  const order = await requireOrder(ctx, id);
  if (!inReview(order)) throw new BusinessRuleError('O pedido não está aguardando a validação da Controladoria.');
  if (order.controllershipStatus !== status) {
    throw new BusinessRuleError(status === ControllershipStatus.PENDING
      ? 'O pedido foi devolvido para ajustes: aguarde o reenvio do Comercial.'
      : 'O pedido já está com a Controladoria: só o pedido devolvido pode ser ajustado e reenviado.');
  }
  return order;
}

/** Quem enviou ou reenviou a solicitação (e quem criou o pedido): recebe a devolução e não pode validar. */
const authorsOf = (order) => [...new Set([order.createdBy, ...(order.reviews ?? [])
  .filter((r) => [OrderReviewAction.SUBMITTED, OrderReviewAction.RESUBMITTED, OrderReviewAction.REVALIDATION_REQUESTED].includes(r.action))
  .map((r) => r.userId)].filter(Boolean))];

/** Segregação, como em Valores por cargo: quem propôs o valor não o valida. */
function ensureNotAuthor(ctx, order) {
  if (authorsOf(order).includes(ctx.user.id)) {
    throw new ForbiddenError('Quem criou ou ajustou o pedido não pode validá-lo nem devolvê-lo.');
  }
}

const describeValue = (rate) => (rate.monthlyValue !== null && rate.monthlyValue !== undefined
  ? `${money.format(rate.monthlyValue)} mensais`
  : `fee de ${money.format(rate.feeValue ?? 0)}`);

const valueFields = (rate) => (rate ? [
  ['Valor mensal', rate.monthlyValue === null ? null : money.format(rate.monthlyValue), { strong: true }],
  ['Fee R&S', rate.feeValue === null ? null : money.format(rate.feeValue)],
  ['Início da vigência', formatBr(rate.validFrom)],
] : []);

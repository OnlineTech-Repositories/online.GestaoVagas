import { entity } from '../db/model.js';
import { getById, userNames } from '../db/repository.js';
import { formatBr, utcNow } from '../domain/dates.js';
import { BusinessRuleError } from '../domain/errors.js';
import {
  ControllershipStatus, DemandType, Modality, OrderApprovalStatus as A, OrderReviewAction, Roles, TermType,
} from '../domain/enums.js';
import { cleanMultiline, DateGuard, JOB_DESCRIPTION_MAX_LENGTH, Permissions } from '../domain/guards.js';
import { itemsOf } from '../domain/order.js';
import * as P from '../domain/position.js';
import { DateReview } from './date-review.js';
import { Input } from './input.js';
import {
  forItem, inReview, inRevalidation, notifyReviewPending, readCommercialValues, record, resolveOrderRate, sameValues,
  syncOrderSummary,
} from './order-review.js';
import { getOrderDetail, requireOrder } from './orders.js';
import { money } from './rates.js';
import { slaFor, validatedRateAt } from './snapshots.js';

/**
 * Edição administrativa do pedido (ADMIN; melhoria de 26/10/2026): corrige os dados de um pedido em qualquer etapa sem
 * cancelar nem recriar. Decisões do usuário: tudo menos o contrato (a quantidade segue com "Acrescentar" e "Reduzir
 * posições"); cargo ou valores alterados num pedido já validado vão para a Controladoria sem parar o pedido (as
 * posições seguem com o valor atual até a validação); modalidade, vigência e início desejado atualizam as posições
 * ainda em aberto (preenchidas e encerradas ficam como estão). Com vários cargos (06/11/2026), cargo, descrição e
 * valores são editados em cada item (`items`: { itemId, jobRoleId, jobDescription, monthlyValue, feeValue,
 * rateValidFrom }); no pedido de um cargo, o formato antigo (no próprio corpo) continua valendo.
 *
 * Duas chamadas: a prévia devolve os campos que mudam (antes e depois) e os efeitos, sem gravar; a confirmação, com
 * a justificativa, grava a mesma edição e o histórico permanente (order_admin_edits, além do log de auditoria).
 */
export async function editOrder(ctx, id, body, { preview = false } = {}) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const rawItems = input.raw('items');
  const multi = Array.isArray(rawItems);
  const r = {
    modality: input.option('modality', Modality, { message: 'Selecione a modalidade.' }),
    workLocationId: input.id('workLocationId', { message: 'Selecione o local de trabalho.' }),
    clientRequestDate: input.date('clientRequestDate', { message: 'Informe a data da solicitação do cliente.' }),
    desiredStartDate: input.date('desiredStartDate', { message: 'Informe a data de início desejada.' }),
    registeredAt: input.date('registeredAt', { message: 'Informe a data de registro.' }),
    clientDecisionDate: input.date('clientDecisionDate', { required: false }),
    termType: input.option('termType', TermType, { message: 'Selecione o tipo de vigência.' }),
    termEndDate: input.date('termEndDate', { required: false }),
    termDurationDays: input.int('termDurationDays'),
    notes: input.text('notes'),
    justification: input.text('justification'),
  };
  const changesIn = multi ? readItems(input, rawItems) : [{
    itemId: null,
    jobRoleId: input.id('jobRoleId', { message: 'Selecione o cargo.' }),
    jobDescription: input.text('jobDescription'),
    values: readCommercialValues(input),
  }];
  input.done();

  const order = await requireOrder(ctx, id);
  if (order.isLegacy) throw new BusinessRuleError('O pedido de desligamento avulso não é editado: corrija o desligamento.');
  const contract = order.contract;
  const items = itemsOf(order);
  if (!multi) {
    if (items.length !== 1) throw new BusinessRuleError('Informe os dados de cada cargo do pedido.', 'items');
    changesIn[0].itemId = items[0].id;
  }
  const currentRates = new Map();
  for (const item of items) {
    currentRates.set(item.id, item.rate ?? await validatedRateAt(ctx.uow, order.contractId, item.jobRoleId, order.registeredAt));
  }
  const before = describe(order, currentRates);
  const review = new DateReview(ctx).watchOrder(order);
  const impacts = [];

  // ---- validações do cabeçalho (as mesmas da criação)
  if (!contract.modalities.includes(r.modality)) throw new BusinessRuleError('A modalidade selecionada não pertence ao contrato.', 'modality');
  const location = await getById(ctx.uow, 'WorkLocation', 'work_locations', r.workLocationId);
  if (!location || (!location.active && location.id !== order.workLocationId)) {
    throw new BusinessRuleError('Selecione um local de trabalho ativo.', 'workLocationId');
  }
  if (location.clientId && location.clientId !== contract.clientId) {
    throw new BusinessRuleError('O local de trabalho selecionado pertence a outro cliente.', 'workLocationId');
  }
  if (contract.contractingUnitId && location.id !== contract.contractingUnitId) {
    throw new BusinessRuleError('O pedido deste contrato usa a unidade contratante do contrato.', 'workLocationId');
  }
  if (r.desiredStartDate < r.clientRequestDate) {
    throw new BusinessRuleError('A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.', 'desiredStartDate');
  }
  P.validateTerm(r.termType, r.termEndDate, r.termDurationDays, r.desiredStartDate);
  const decided = order.approvalStatus === A.APPROVED || order.approvalStatus === A.NOT_APPROVED;
  if (!decided && r.clientDecisionDate) {
    throw new BusinessRuleError('O cliente ainda não decidiu: não há data de aprovação a corrigir.', 'clientDecisionDate');
  }
  if (decided && !r.clientDecisionDate) throw new BusinessRuleError('Informe a data da decisão do cliente.', 'clientDecisionDate');

  // ---- posições em aberto (preenchidas e encerradas ficam como estão)
  const open = order.positions.filter((p) => P.isOpen(p) && P.isCurrentCycle(p));
  const openNew = open.filter((p) => p.demandType === DemandType.NEW);
  const touched = new Set();
  if (r.desiredStartDate !== order.desiredStartDate) {
    for (const p of openNew.filter((x) => x.desiredStartDate === order.desiredStartDate)) {
      p.desiredStartDate = r.desiredStartDate;
      touched.add(p);
    }
  }
  const term = P.normalizeTerm(r.termType, r.termEndDate, r.termDurationDays);
  const sameTerm = (x) => x.termType === order.termType && (x.termEndDate ?? null) === (order.termEndDate ?? null)
    && (x.termDurationDays ?? null) === (order.termDurationDays ?? null);
  if (r.termType !== order.termType || term.endDate !== (order.termEndDate ?? null) || term.durationDays !== (order.termDurationDays ?? null)) {
    for (const p of openNew.filter(sameTerm)) {
      Object.assign(p, { termType: r.termType, termEndDate: term.endDate, termDurationDays: term.durationDays });
      touched.add(p);
    }
  }
  if (decided && r.clientDecisionDate !== order.clientDecisionDate) {
    // Como na correção de datas: as vagas novas abertas na aprovação acompanham a data corrigida.
    for (const p of order.positions.filter((x) => x.demandType === DemandType.NEW && x.openedAt === order.clientDecisionDate)) {
      p.openedAt = r.clientDecisionDate;
      touched.add(p);
    }
  }
  if (r.modality !== order.modality) {
    for (const p of open.filter((x) => x.openedAt)) {
      const sla = await slaFor(contract, r.modality, p.demandType, p.openedAt);
      if (sla.days !== p.slaTargetDays || sla.source !== p.slaTargetSource) {
        p.slaTargetDays = sla.days;
        p.slaTargetSource = sla.source;
        touched.add(p);
      }
    }
  }

  // ---- dados do pedido
  Object.assign(order, {
    modality: r.modality,
    workLocationId: location.id,
    clientRequestDate: r.clientRequestDate,
    desiredStartDate: r.desiredStartDate,
    registeredAt: r.registeredAt,
    clientDecisionDate: decided ? r.clientDecisionDate : order.clientDecisionDate,
    termType: r.termType,
    termEndDate: term.endDate,
    termDurationDays: term.durationDays,
    notes: DateGuard.clean(r.notes),
  });
  order.workLocation = location;

  // ---- cargo, descrição e valores de cada item
  const run = (index, fn) => (multi ? forItem(index, fn) : fn());
  const revalidatingBefore = inRevalidation(order);
  let revalidation = false;
  let appliedNow = false;
  const seen = new Set();
  for (const [index, change] of changesIn.entries()) {
    await run(index, async () => {
      const item = items.find((i) => i.id === change.itemId);
      if (!item) throw new BusinessRuleError('Cargo do pedido não encontrado.', 'jobRoleId');
      const jobRole = await getById(ctx.uow, 'JobRole', 'job_roles', change.jobRoleId);
      if (!jobRole || (!jobRole.active && jobRole.id !== item.jobRoleId)) throw new BusinessRuleError('Selecione um cargo ativo.', 'jobRoleId');
      if (seen.has(jobRole.id)) throw new BusinessRuleError(`O cargo ${jobRole.name} aparece em mais de um item do pedido.`, 'jobRoleId');
      seen.add(jobRole.id);
      const description = cleanMultiline(change.jobDescription);
      if (description && description.length > JOB_DESCRIPTION_MAX_LENGTH) {
        throw new BusinessRuleError(`A descrição da vaga deve ter no máximo ${JOB_DESCRIPTION_MAX_LENGTH} caracteres.`, 'jobDescription');
      }
      item.jobDescription = description;

      const currentRate = currentRates.get(item.id);
      const roleChanged = jobRole.id !== item.jobRoleId;
      const valuesChanged = Boolean(change.values) && (!currentRate || !sameValues(currentRate, change.values));
      if (!roleChanged && !valuesChanged) return;
      if (inReview(order)) {
        throw new BusinessRuleError('O pedido está em validação pela Controladoria: cargo e valores são ajustados pelo fluxo da '
          + 'validação (devolução e "Ajustar e reenviar").', 'jobRoleId');
      }
      if (revalidatingBefore) {
        throw new BusinessRuleError('Já há uma alteração de cargo e valores aguardando a Controladoria neste pedido: aguarde a decisão.', 'jobRoleId');
      }
      const { rate, review: needsReview } = await resolveOrderRate(ctx, contract, jobRole, change.values, order.registeredAt);
      if (needsReview) {
        rate.orderId = order.id;
        item.pendingRateId = rate.id;
        item.pendingRate = rate;
        order.controllershipStatus = ControllershipStatus.PENDING;
        record(ctx, order, OrderReviewAction.REVALIDATION_REQUESTED, item, rate);
        revalidation = true;
      } else {
        // Valor já validado para o cargo: vale na hora; as posições em aberto do item passam a usá-lo.
        Object.assign(item, { jobRoleId: jobRole.id, jobRole, rateId: rate.id, rate });
        rate.jobRole ??= jobRole;
        for (const p of open.filter((x) => P.itemOf(x)?.id === item.id && x.rateId !== rate.id)) {
          p.rateId = rate.id;
          p.rate = rate;
          touched.add(p);
        }
        appliedNow = true;
      }
    });
  }
  syncOrderSummary(order);
  order.jobDescription = items.length === 1 ? items[0].jobDescription : order.jobDescription;
  if (revalidation) {
    impacts.push('Cargo e valores alterados vão para a validação da Controladoria. O pedido segue na etapa em que está e '
      + 'as posições usam o valor atual até a validação; devolvida, o pedido continua com o cargo e o valor atuais.');
  }
  if (appliedNow) impacts.push('O cargo e o valor informados já estão validados em Valores por cargo: valem a partir de agora.');

  const afterRates = new Map(items.map((i) => [i.id, i.pendingRate ?? i.rate ?? currentRates.get(i.id)]));
  const after = describe(order, afterRates);
  const byKey = new Map(after.map((a) => [a.key, a]));
  const changes = before.map((b) => ({ ...b, after: byKey.get(b.key)?.value ?? '—' })).filter((c) => c.value !== c.after)
    .map(({ key, label, value, after: next, money: isMoney }) => ({ key, label, before: value, after: next, money: Boolean(isMoney) }));
  if (!changes.length) throw new BusinessRuleError('Nenhuma alteração em relação aos dados atuais do pedido.');
  if (touched.size) {
    impacts.push(`${touched.size} posição(ões) em aberto atualizada(s). Preenchidas e encerradas ficam como estão.`);
  }

  if (preview) return { changes, impacts, revalidation };

  const justification = DateGuard.requireText(r.justification, 'Informe a justificativa da alteração.', 'justification');
  review.settle();
  order.adminEdits ??= [];
  order.adminEdits.push(entity('OrderAdminEdit', {
    orderId: order.id, userId: ctx.user.id, occurredAt: utcNow(), justification,
    changes: JSON.stringify(changes), revalidation,
  }));
  await ctx.uow.save({ action: 'ADMIN_EDIT_ORDER', justification });
  if (revalidation) {
    await notifyReviewPending(ctx, order, 'revalidation');
    await ctx.uow.save({ action: 'ADMIN_EDIT_ORDER' });
  }
  return getOrderDetail(ctx, order.id);
}

/** Ajustes de cada item, lidos de `items`; os erros levam o índice do item no nome do campo. */
function readItems(input, rawItems) {
  if (!rawItems.length) {
    input.fail('items', 'Informe os cargos do pedido.');
    return [];
  }
  return rawItems.map((raw, index) => {
    const it = new Input(raw ?? {});
    const change = {
      itemId: it.id('itemId', { message: 'Cargo do pedido não encontrado.' }),
      jobRoleId: it.id('jobRoleId', { message: 'Selecione o cargo.' }),
      jobDescription: it.text('jobDescription'),
      values: readCommercialValues(it),
    };
    for (const [field, message] of Object.entries(it.errors)) input.fail(`${field}-${index}`, message);
    return change;
  });
}

/** Histórico das edições para o detalhe: valores em R$ só para quem vê valores. */
export async function adminEditsDto(order, showMoney) {
  const edits = order.adminEdits ?? [];
  const names = await userNames(edits.map((e) => e.userId));
  return [...edits].reverse().map((e) => ({
    userName: e.userId ? names.get(e.userId) ?? null : null,
    occurredAt: e.occurredAt,
    justification: e.justification,
    revalidation: Boolean(e.revalidation),
    changes: JSON.parse(e.changes || '[]').map((c) => (c.money && !showMoney
      ? { label: c.label, before: '(restrito)', after: '(restrito)' }
      : { label: c.label, before: c.before, after: c.after })),
  }));
}

/**
 * Retrato legível dos campos editáveis: [{ key, label, value, money }]. Os de cada cargo levam "Cargo N — " no rótulo
 * quando o pedido tem mais de um; no pedido de um cargo, os rótulos de sempre.
 */
function describe(order, rates) {
  const term = [TERM_LABELS[order.termType] ?? order.termType,
    order.termEndDate ? `até ${formatBr(order.termEndDate)}` : null,
    order.termDurationDays ? `${order.termDurationDays} dias` : null].filter(Boolean).join(' · ');
  const brl = (v) => (v === null || v === undefined ? '—' : money.format(Number(v)));
  const location = order.workLocation ? (order.workLocation.code ? `${order.workLocation.code} — ${order.workLocation.name}` : order.workLocation.name) : '—';
  const items = itemsOf(order);
  const fields = [
    ['modality', 'Modalidade', MODALITY_LABELS[order.modality] ?? order.modality],
    ['workLocation', 'Local de trabalho', location],
    ['clientRequestDate', 'Solicitação do cliente', formatBr(order.clientRequestDate)],
    ['desiredStartDate', 'Início desejado', formatBr(order.desiredStartDate)],
    ['registeredAt', 'Data de registro', formatBr(order.registeredAt)],
    ['clientDecisionDate', 'Decisão do cliente', order.clientDecisionDate ? formatBr(order.clientDecisionDate) : '—'],
    ['term', 'Vigência', term],
    ['notes', 'Observações', order.notes || '—'],
  ];
  for (const item of items) {
    const prefix = items.length > 1 ? `Cargo ${item.sequence} — ` : '';
    const rate = rates.get(item.id);
    fields.push(
      [`jobRole-${item.id}`, items.length > 1 ? `Cargo ${item.sequence}` : 'Cargo', (item.pendingRate?.jobRole?.name ?? item.jobRole?.name) ?? '—'],
      [`jobDescription-${item.id}`, `${prefix}${prefix ? 'descrição da vaga' : 'Descrição da vaga'}`, item.jobDescription || '—'],
      [`monthlyValue-${item.id}`, `${prefix}${prefix ? 'valor mensal' : 'Valor mensal'}`, brl(rate?.monthlyValue), true],
      [`feeValue-${item.id}`, `${prefix}${prefix ? 'fee R&S' : 'Fee R&S'}`, brl(rate?.feeValue), true],
      [`rateValidFrom-${item.id}`, `${prefix}${prefix ? 'início da vigência do valor' : 'Início da vigência do valor'}`,
        rate?.validFrom ? formatBr(rate.validFrom) : '—', true],
    );
  }
  return fields.map(([key, label, value, isMoney]) => ({ key, label, value, money: Boolean(isMoney) }));
}

const MODALITY_LABELS = { RS: 'R&S', MOT: 'Mão de Obra Temporária', MOE: 'Mão de Obra Efetiva', FAC: 'Facilities' };
const TERM_LABELS = { FIXED_END: 'Data fim fixa', PRESERVED_DURATION: 'Duração preservada', INDEFINITE: 'Indeterminado' };

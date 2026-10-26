import { query, queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { attachRateRefs, getById, getContract, listWithoutRate, userNames } from '../db/repository.js';
import { formatBr, utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import { Modality, NotificationTypes, OrderApprovalStatus, RateStatus, Roles } from '../domain/enums.js';
import { DateGuard, Permissions } from '../domain/guards.js';
import { Input } from './input.js';
import { rateFields } from './notice-fields.js';
import { links, notify } from './notifications.js';
import { validatedRateAt } from './snapshots.js';

/** Valores por cargo, versionados. Segregação obrigatória: COMMERCIAL cadastra, só CONTROLLERSHIP valida. */

export const round2 = (v) => (v === null || v === undefined ? null : Math.round(v * 100) / 100);

/** Valor mensal obrigatório, exceto em contrato só de R&S; valores positivos (o fee pode ser zero). */
export function checkRateValues(contract, monthlyValue, feeValue) {
  const onlyRs = contract.modalities.every((m) => m === Modality.RS);
  if (!onlyRs && monthlyValue === null) throw new BusinessRuleError('Informe o valor mensal.', 'monthlyValue');
  if ((monthlyValue !== null && monthlyValue <= 0) || (feeValue !== null && feeValue < 0)) {
    throw new BusinessRuleError('Os valores devem ser positivos.', 'monthlyValue');
  }
}

/** Valor proposto por um pedido ainda em validação: decide-se no próprio pedido (fluxo integrado de 26/10/2026). */
function ensureNotInOrderReview(rate) {
  if (rate.originOrder?.approvalStatus === OrderApprovalStatus.AWAITING_CONTROLLERSHIP) {
    throw new BusinessRuleError(`Este valor faz parte do pedido ${rate.originOrder.number}, em validação pela Controladoria: `
      + 'valide, devolva ou ajuste pelo próprio pedido.');
  }
}

export async function listRates(ctx, { contractId = null, status = null } = {}) {
  if (!Permissions.canSeeDetailedValues(ctx.user)) throw new ForbiddenError();
  const where = [];
  const params = [];
  if (contractId) {
    where.push('contract_id = ?');
    params.push(contractId);
  }
  if (status) {
    where.push('status = ?');
    params.push(status);
  }
  const rates = await attachRateRefs(ctx.uow, ctx.uow.loadAll('ContractRate',
    await query(`SELECT * FROM contract_rates ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params)));
  rates.sort((a, b) => cmp(a.contract?.client?.legalName, b.contract?.client?.legalName)
    || cmp(a.contract?.name, b.contract?.name) || cmp(a.jobRole?.name, b.jobRole?.name)
    || b.validFrom.localeCompare(a.validFrom));
  return toDtos(rates);
}

export async function createRate(ctx, body) {
  Permissions.require(ctx.user, Roles.Commercial);
  const rate = entity('ContractRate', {
    status: RateStatus.PENDING, validatedBy: null, validatedAt: null, rejectionReason: null,
  });
  await apply(ctx, rate, body, null);
  ctx.uow.add(rate);
  // Posições abertas sem valor (cadastradas antes de existir valor vigente) recebem a nova versão, desde que ela já
  // vigorasse na abertura. Posições que já têm o valor gravado não mudam.
  for (const p of await listWithoutRate(ctx.uow, rate.contractId, rate.jobRoleId, rate.validFrom)) p.rateId = rate.id;
  await notifyPending(ctx, rate);
  await ctx.uow.save({ action: 'CREATE_RATE' });
  return (await toDtos([rate]))[0];
}

/** Correção de valor pendente ou rejeitado: volta para PENDING e reentra na fila de validação. */
export async function updateRate(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial);
  const rate = await load(ctx, id);
  if (rate.status === RateStatus.VALIDATED) {
    throw new BusinessRuleError('Valor já validado não pode ser alterado. Cadastre uma nova versão com outra data de vigência.');
  }
  ensureNotInOrderReview(rate);
  const input = new Input(body);
  const contractId = input.id('contractId');
  const jobRoleId = input.id('jobRoleId');
  input.done();
  if (contractId !== rate.contractId || jobRoleId !== rate.jobRoleId) {
    throw new BusinessRuleError('Não é possível trocar o contrato ou o cargo de um valor já cadastrado.');
  }
  const wasRejected = rate.status === RateStatus.REJECTED;
  await apply(ctx, rate, body, rate.id);
  rate.status = RateStatus.PENDING;
  rate.rejectionReason = null;
  rate.validatedBy = null;
  rate.validatedAt = null;
  await notifyPending(ctx, rate, wasRejected ? 'corrected-after-rejection' : 'corrected');
  await ctx.uow.save({ action: 'UPDATE_RATE' });
  return (await toDtos([rate]))[0];
}

export async function validateRate(ctx, id) {
  Permissions.require(ctx.user, Roles.Controllership);
  const rate = await loadPending(ctx, id);
  const recipients = authorsOf(rate);
  rate.status = RateStatus.VALIDATED;
  rate.validatedBy = ctx.user.id;
  rate.validatedAt = utcNow();
  // Fora da SPEC (10.1 só prevê pendente e rejeitado), a pedido do usuário em 16/10/2026: sem este aviso o Comercial
  // só sabia que o valor foi aprovado abrindo a tela.
  await notify(ctx.uow, {
    type: NotificationTypes.RateValidated,
    entityId: rate.id,
    subject: `Valor por cargo validado · ${rate.contract?.name}`,
    message: `O valor de ${describeRate(rate)} foi validado pela Controladoria e passa a entrar nos totais de `
      + 'faturamento perdido e postergado.',
    link: links.contractRates(),
    email: {
      title: 'Valor por cargo validado',
      summary: 'A Controladoria validou o valor: ele passa a entrar nos totais de faturamento perdido e postergado.',
      status: { label: 'Validado', tone: 'success' },
      fields: [...rateFields(rate), ['Situação da validação', 'Validado pela Controladoria', { tone: 'success' }]],
      button: 'Consultar valores',
    },
  }, { userIds: recipients });
  await ctx.uow.save({ action: 'VALIDATE_RATE' });
  return (await toDtos([rate]))[0];
}

export async function rejectRate(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Controllership);
  const reason = DateGuard.requireText(new Input(body).text('reason'), 'Informe o motivo da rejeição.', 'reason');
  const rate = await loadPending(ctx, id);
  const recipients = authorsOf(rate);
  rate.status = RateStatus.REJECTED;
  rate.rejectionReason = reason;
  rate.validatedBy = ctx.user.id;
  rate.validatedAt = utcNow();
  await notify(ctx.uow, {
    type: NotificationTypes.RateRejected,
    entityId: rate.id,
    subject: `Valor por cargo rejeitado · ${rate.contract?.name}`,
    message: `O valor de ${describeRate(rate)} foi rejeitado pela Controladoria. Motivo: ${reason}`,
    link: links.contractRates(),
    email: {
      title: 'Valor por cargo rejeitado',
      summary: 'A Controladoria rejeitou o valor cadastrado. Enquanto não for corrigido e validado, ele fica fora dos totais.',
      status: { label: 'Rejeitado', tone: 'danger' },
      fields: [...rateFields(rate), ['Situação da validação', 'Rejeitado pela Controladoria', { tone: 'danger' }],
        ['Motivo da rejeição', reason]],
      action: 'Corrija o valor em Valores por cargo; a correção volta para a validação da Controladoria.',
      button: 'Corrigir valor',
    },
  }, { userIds: recipients });
  await ctx.uow.save({ action: 'REJECT_RATE', justification: reason });
  return (await toDtos([rate]))[0];
}

async function load(ctx, id) {
  const rate = await getById(ctx.uow, 'ContractRate', 'contract_rates', id);
  if (!rate) throw new NotFoundError('Valor não encontrado.');
  await attachRateRefs(ctx.uow, [rate]);
  return rate;
}

async function loadPending(ctx, id) {
  const rate = await load(ctx, id);
  if (rate.status !== RateStatus.PENDING) {
    throw new BusinessRuleError('Somente valores pendentes podem ser validados ou rejeitados.');
  }
  ensureNotInOrderReview(rate);
  // Segregação (seção 4): quem cadastra valores não os valida — vale também para quem corrigiu a versão em análise.
  if (authorsOf(rate).includes(ctx.user.id)) {
    throw new ForbiddenError('Quem cadastrou ou corrigiu o valor não pode validá-lo nem rejeitá-lo.');
  }
  return rate;
}

/**
 * Quem responde pela versão em análise: quem cadastrou e o último Comercial que a corrigiu. Enquanto o valor está
 * pendente, updated_by só pode ser essa correção — validar e rejeitar exigem o status PENDING, e corrigir o devolve a
 * ele. Antes, a rejeição avisava só quem cadastrou, mesmo quando outro Comercial tinha feito a correção rejeitada.
 */
const authorsOf = (rate) => [...new Set([rate.createdBy, rate.updatedBy].filter(Boolean))];

export const money = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** "Estoquista no contrato CT-2026-X-001 (R$ 3.000,00 mensais, vigência a partir de 01/11/2026)". */
function describeRate(rate) {
  const value = rate.monthlyValue !== null && rate.monthlyValue !== undefined
    ? `${money.format(rate.monthlyValue)} mensais, `
    : rate.feeValue !== null && rate.feeValue !== undefined ? `fee de ${money.format(rate.feeValue)}, ` : '';
  return `${rate.jobRole?.name} no contrato ${rate.contract?.name} (${value}vigência a partir de ${formatBr(rate.validFrom)})`;
}

async function apply(ctx, rate, body, exceptId) {
  const input = new Input(body);
  const contractId = input.id('contractId', { message: 'Selecione o contrato.' });
  const jobRoleId = input.id('jobRoleId', { message: 'Selecione o cargo.' });
  const monthlyValue = input.decimal('monthlyValue');
  const feeValue = input.decimal('feeValue');
  const validFrom = input.date('validFrom', { message: 'Informe a data de vigência.' });
  input.done();

  const contract = await getContract(ctx.uow, contractId);
  if (!contract) throw new BusinessRuleError('Contrato não encontrado.', 'contractId');
  const jobRole = await getById(ctx.uow, 'JobRole', 'job_roles', jobRoleId);
  if (!jobRole) throw new BusinessRuleError('Cargo não encontrado.', 'jobRoleId');
  checkRateValues(contract, monthlyValue, feeValue);
  const clash = await queryOne(
    'SELECT id FROM contract_rates WHERE contract_id = ? AND job_role_id = ? AND valid_from = ? AND id <> ?',
    contractId, jobRoleId, validFrom, exceptId ?? '');
  if (clash) throw new BusinessRuleError('Já existe valor para este cargo no contrato com a mesma data de vigência.', 'validFrom');

  Object.assign(rate, { contractId, jobRoleId, monthlyValue: round2(monthlyValue), feeValue: round2(feeValue), validFrom });
  rate.contract = contract;
  rate.jobRole = jobRole;
}

/** Aviso à Controladoria; a correção é dita como correção (antes saía "Novo valor" também ao corrigir). */
const notifyPending = (ctx, rate, kind = 'new') => notify(ctx.uow, {
  type: NotificationTypes.RatePending,
  entityId: rate.id,
  subject: `${kind === 'new' ? 'Valor por cargo aguardando validação' : 'Valor por cargo corrigido, aguardando validação'} · ${rate.contract?.name}`,
  message: kind === 'new'
    ? `Novo valor de ${describeRate(rate)} aguarda validação da Controladoria.`
    : `O valor de ${describeRate(rate)} foi corrigido${kind === 'corrected-after-rejection' ? ' depois da rejeição' : ''} `
      + 'e aguarda nova validação da Controladoria.',
  link: links.contractRates(),
  email: {
    title: kind === 'new' ? 'Valor por cargo aguardando validação' : 'Valor por cargo corrigido, aguardando validação',
    summary: kind === 'new'
      ? 'O Comercial cadastrou um novo valor por cargo, que precisa da validação da Controladoria antes de entrar nos totais.'
      : `O Comercial corrigiu o valor${kind === 'corrected-after-rejection' ? ' depois da rejeição' : ''}; ele precisa de nova validação da Controladoria.`,
    status: { label: 'Pendente de validação', tone: 'warning' },
    fields: [...rateFields(rate), ['Situação da validação', 'Pendente de validação', { tone: 'warning' }]],
    action: 'Controladoria: confira o valor e a vigência e valide ou rejeite em Valores por cargo. Só valores validados entram nos totais de faturamento.',
    button: 'Acessar validação',
  },
}, { roles: [Roles.Controllership] });

async function toDtos(rates) {
  const names = await userNames(rates.flatMap((r) => [r.createdBy, r.validatedBy]));
  return rates.map((r) => ({
    id: r.id,
    contractId: r.contractId,
    contractName: r.contract?.name ?? '',
    clientName: r.contract?.client?.legalName ?? '',
    jobRoleId: r.jobRoleId,
    jobRoleName: r.jobRole?.name ?? '',
    monthlyValue: r.monthlyValue,
    dailyValue: r.monthlyValue === null ? null : dailyOf(r.monthlyValue),
    feeValue: r.feeValue,
    validFrom: r.validFrom,
    status: r.status,
    createdByName: r.createdBy ? names.get(r.createdBy) ?? null : null,
    createdAt: r.createdAt,
    validatedByName: r.validatedBy ? names.get(r.validatedBy) ?? null : null,
    validatedAt: r.validatedAt,
    rejectionReason: r.rejectionReason,
    // Valor proposto num pedido: em validação, as ações ficam no pedido.
    order: r.originOrder ? {
      id: r.originOrder.id,
      number: r.originOrder.number,
      inReview: r.originOrder.approvalStatus === OrderApprovalStatus.AWAITING_CONTROLLERSHIP,
    } : null,
  }));
}

/** Valor validado vigente para contrato + cargo na data, para preencher o pedido (null se não houver). */
export async function currentRate(ctx, q) {
  if (!Permissions.canSeeDetailedValues(ctx.user)) throw new ForbiddenError();
  const input = new Input(q);
  const contractId = input.id('contractId', { message: 'Selecione o contrato.' });
  const jobRoleId = input.id('jobRoleId', { message: 'Selecione o cargo.' });
  const date = input.date('date');
  input.done();
  const rate = await validatedRateAt(ctx.uow, contractId, jobRoleId, date);
  return rate ? (await toDtos(await attachRateRefs(ctx.uow, [rate])))[0] : null;
}

/** RN-20: valor diário = mensal / 30, arredondado a centavos (meio para o par, como o decimal do .NET). */
export function dailyOf(monthly) {
  const cents = Math.round(monthly * 100);
  const q = Math.floor(cents / 30);
  const r = cents - q * 30;
  const rounded = 2 * r > 30 ? q + 1 : 2 * r < 30 ? q : q + (q % 2);
  return rounded / 100;
}

const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR');

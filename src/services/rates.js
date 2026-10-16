import { query, queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { attachRateRefs, getById, getContract, listWithoutRate, userNames } from '../db/repository.js';
import { formatBr, utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import { Modality, NotificationTypes, RateStatus, Roles } from '../domain/enums.js';
import { DateGuard, Permissions } from '../domain/guards.js';
import { Input } from './input.js';
import { links, notify } from './notifications.js';

/** Valores por cargo, versionados. Segregação obrigatória: COMMERCIAL cadastra, só CONTROLLERSHIP valida. */

const round2 = (v) => (v === null ? null : Math.round(v * 100) / 100);

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
  const input = new Input(body);
  const contractId = input.id('contractId');
  const jobRoleId = input.id('jobRoleId');
  input.done();
  if (contractId !== rate.contractId || jobRoleId !== rate.jobRoleId) {
    throw new BusinessRuleError('Não é possível trocar o contrato ou o cargo de um valor já cadastrado.');
  }
  await apply(ctx, rate, body, rate.id);
  rate.status = RateStatus.PENDING;
  rate.rejectionReason = null;
  rate.validatedBy = null;
  rate.validatedAt = null;
  await notifyPending(ctx, rate);
  await ctx.uow.save({ action: 'UPDATE_RATE' });
  return (await toDtos([rate]))[0];
}

export async function validateRate(ctx, id) {
  Permissions.require(ctx.user, Roles.Controllership);
  const rate = await loadPending(ctx, id);
  rate.status = RateStatus.VALIDATED;
  rate.validatedBy = ctx.user.id;
  rate.validatedAt = utcNow();
  await ctx.uow.save({ action: 'VALIDATE_RATE' });
  return (await toDtos([rate]))[0];
}

export async function rejectRate(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Controllership);
  const reason = DateGuard.requireText(new Input(body).text('reason'), 'Informe o motivo da rejeição.', 'reason');
  const rate = await loadPending(ctx, id);
  rate.status = RateStatus.REJECTED;
  rate.rejectionReason = reason;
  rate.validatedBy = ctx.user.id;
  rate.validatedAt = utcNow();
  if (rate.createdBy) {
    await notify(ctx.uow, {
      type: NotificationTypes.RateRejected,
      entityId: rate.id,
      subject: 'Valor por cargo rejeitado',
      message: `O valor de ${rate.jobRole?.name} no contrato ${rate.contract?.name} (vigência a partir de ${formatBr(rate.validFrom)}) `
        + `foi rejeitado pela Controladoria. Motivo: ${reason}`,
      link: links.contractRates(),
    }, { userIds: [rate.createdBy] });
  }
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
  if (rate.createdBy === ctx.user.id) throw new ForbiddenError('Quem cadastrou o valor não pode validá-lo.');
  return rate;
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
  const onlyRs = contract.modalities.every((m) => m === Modality.RS);
  if (!onlyRs && monthlyValue === null) throw new BusinessRuleError('Informe o valor mensal.', 'monthlyValue');
  if ((monthlyValue !== null && monthlyValue <= 0) || (feeValue !== null && feeValue < 0)) {
    throw new BusinessRuleError('Os valores devem ser positivos.', 'monthlyValue');
  }
  const clash = await queryOne(
    'SELECT id FROM contract_rates WHERE contract_id = ? AND job_role_id = ? AND valid_from = ? AND id <> ?',
    contractId, jobRoleId, validFrom, exceptId ?? '');
  if (clash) throw new BusinessRuleError('Já existe valor para este cargo no contrato com a mesma data de vigência.', 'validFrom');

  Object.assign(rate, { contractId, jobRoleId, monthlyValue: round2(monthlyValue), feeValue: round2(feeValue), validFrom });
  rate.contract = contract;
  rate.jobRole = jobRole;
}

const notifyPending = (ctx, rate) => notify(ctx.uow, {
  type: NotificationTypes.RatePending,
  entityId: rate.id,
  subject: 'Valor por cargo pendente de validação',
  message: `Novo valor de ${rate.jobRole?.name} no contrato ${rate.contract?.name} aguarda validação da Controladoria.`,
  link: links.contractRates(),
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
  }));
}

/** RN-20: valor diário = mensal / 30, arredondado a centavos (meio para o par, como o decimal do .NET). */
function dailyOf(monthly) {
  const cents = Math.round(monthly * 100);
  const q = Math.floor(cents / 30);
  const r = cents - q * 30;
  const rounded = 2 * r > 30 ? q + 1 : 2 * r < 30 ? q : q + (q % 2);
  return rounded / 100;
}

const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR');

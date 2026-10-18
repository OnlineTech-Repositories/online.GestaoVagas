import { query } from '../db/index.js';
import { BusinessRuleError, NotFoundError } from '../domain/errors.js';
import { ParameterKeys, PARAMETER_DEFAULTS, Roles } from '../domain/enums.js';
import { Permissions } from '../domain/guards.js';

/**
 * Parâmetros do sistema (seção 15 da SPEC): mudar uma regra de prazo não exige publicação. O valor ausente no banco
 * cai no padrão de PARAMETER_DEFAULTS.
 */

const toDto = (p) => ({ key: p.paramKey, value: p.paramValue, description: p.description });

export async function listParameters(ctx) {
  const rows = ctx.uow.loadAll('SystemParameter', await query('SELECT * FROM system_parameters ORDER BY param_key'));
  return rows.map(toDto);
}

export async function updateParameter(ctx, key, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const rows = ctx.uow.loadAll('SystemParameter', await query('SELECT * FROM system_parameters WHERE param_key = ?', key));
  const parameter = rows[0];
  if (!parameter) throw new NotFoundError('Parâmetro não encontrado.');
  parameter.paramValue = validate(key, body?.value);
  await ctx.uow.save({ action: 'UPDATE_PARAMETER' });
  return toDto(parameter);
}

async function valueOf(key) {
  const rows = await query('SELECT param_value FROM system_parameters WHERE param_key = ?', key);
  return rows[0]?.param_value ?? PARAMETER_DEFAULTS[key][0];
}

export const getInt = async (key) => Number.parseInt(await valueOf(key), 10);
export const getBool = async (key) => (await valueOf(key)).toLowerCase() === 'true';
export const getText = (key) => valueOf(key);

export async function calcSettings() {
  return {
    atRiskDays: await getInt(ParameterKeys.AtRiskDays),
    lossOnCancelAfterOpen: await getBool(ParameterKeys.LossOnCancelAfterOpen),
  };
}

export const isInitialLoadOpen = () => getBool(ParameterKeys.InitialLoadOpen);

/** Meta de KPI: vazia (sem meta) ou número maior ou igual a zero; percentual até 100. */
function kpiTarget(key, value) {
  if (value === '') return '';
  const n = Number(value.replace(',', '.'));
  if (!Number.isFinite(n) || n < 0) throw new BusinessRuleError('Informe um número maior ou igual a zero, ou deixe vazio para "sem meta".', 'value');
  if (key.endsWith('_PERCENT') && n > 100) throw new BusinessRuleError('O percentual vai de 0 a 100.', 'value');
  return String(n);
}

/** Metas dos KPIs (null = sem meta), pela chave do parâmetro. */
export async function kpiTargets() {
  const keys = Object.keys(PARAMETER_DEFAULTS).filter((k) => k.startsWith('KPI_TARGET_'));
  const entries = await Promise.all(keys.map(async (k) => {
    const v = await valueOf(k);
    return [k, v === '' ? null : Number(v)];
  }));
  return Object.fromEntries(entries);
}

function validate(key, raw) {
  const value = String(raw ?? '').trim();
  if (key.startsWith('KPI_TARGET_')) return kpiTarget(key, value);
  switch (key) {
    case ParameterKeys.AtRiskDays:
    case ParameterKeys.StaleDays:
    case ParameterKeys.EarlyReplacementWindowDays:
      if (!/^\d+$/.test(value)) throw new BusinessRuleError('Informe um número inteiro maior ou igual a zero.', 'value');
      return String(Number(value));
    case ParameterKeys.DailyDigestTime:
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(value)) throw new BusinessRuleError('Informe o horário no formato HH:mm.', 'value');
      return value;
    default:
      if (!/^(true|false)$/i.test(value)) throw new BusinessRuleError('Informe true ou false.', 'value');
      return value.toLowerCase();
  }
}

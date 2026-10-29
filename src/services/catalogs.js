import { query } from '../db/index.js';
import { entity } from '../db/model.js';
import { getById } from '../db/repository.js';
import { BusinessRuleError, NotFoundError, WarningsPendingError } from '../domain/errors.js';
import { DemandType, Modality, Roles } from '../domain/enums.js';
import { Cnpj, DateGuard, Permissions } from '../domain/guards.js';
import { Input } from './input.js';

/** Cadastros auxiliares mantidos pelo ADMIN: cargos, locais, CNPJs do Grupo, motivos de pausa e metas de SLA. */

const byName = (a, b) => a.name.localeCompare(b.name, 'pt-BR');
const named = (x) => ({ id: x.id, name: x.name, active: x.active });

async function saveNamed(ctx, kind, table, id, body, { required, duplicate }) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), required, 'name');
  const active = input.bool('active', true);
  input.done();
  const clash = await query(`SELECT id FROM ${table} WHERE lower(name) = lower(?)`, name);
  if (clash.some((r) => r.id !== id)) throw new BusinessRuleError(duplicate, 'name');

  const item = id ? await getById(ctx.uow, kind, table, id) : ctx.uow.add(entity(kind, {}));
  if (!item) throw new NotFoundError('Registro não encontrado.');
  item.name = name;
  item.active = active;
  await ctx.uow.save({ action: id ? 'UPDATE' : 'CREATE' });
  return named(item);
}

// ---------------------------------------------------------------- cargos

export async function listJobRoles(ctx) {
  return ctx.uow.loadAll('JobRole', await query('SELECT * FROM job_roles')).sort(byName).map(named);
}

export const saveJobRole = (ctx, id, body) => saveNamed(ctx, 'JobRole', 'job_roles', id, body,
  { required: 'Informe o nome do cargo.', duplicate: 'Já existe um cargo com este nome.' });

/** Nome para comparar: sem acento, minúsculas e espaços simples. */
const nameKey = (text) => String(text ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .split(' ').filter(Boolean).join(' ');

/**
 * Cargo novo cadastrado durante a criação do pedido, pelo Comercial ou pelo Administrador (melhoria de 29/10/2026).
 * Só cadastra: editar e inativar continua com o Administrador, em Cadastros auxiliares (decisão do usuário). Nome igual
 * a um existente, ignorando maiúsculas e acentos, é recusado; nome parecido (um contém o outro) pede confirmação,
 * mostrando os cargos já cadastrados. Quem cadastrou e quando ficam no log de auditoria.
 */
export async function createJobRoleFromOrder(ctx, body) {
  Permissions.require(ctx.user, Roles.Commercial, Roles.Admin);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), 'Informe o nome do cargo.', 'name').split(' ').filter(Boolean).join(' ');
  input.done();
  if (name.length > 120) throw new BusinessRuleError('O nome do cargo deve ter no máximo 120 caracteres.', 'name');

  const key = nameKey(name);
  const roles = await query('SELECT id, name, active FROM job_roles');
  const same = roles.find((r) => nameKey(r.name) === key);
  if (same) {
    throw new BusinessRuleError(Number(same.active)
      ? `Já existe o cargo "${same.name}": escolha-o na lista.`
      : `Já existe o cargo "${same.name}", inativo: peça ao administrador para reativá-lo.`, 'name');
  }
  const similar = roles.filter((r) => Number(r.active) && key.length >= 3
    && (nameKey(r.name).includes(key) || key.includes(nameKey(r.name))));
  if (similar.length && !ctx.confirmWarnings) {
    throw new WarningsPendingError([{
      kind: 'DUPLICATE',
      message: `Já existe cargo com nome parecido: ${similar.slice(0, 5).map((r) => `"${r.name}"`).join(', ')}. `
        + 'Confira se não é o mesmo antes de cadastrar outro.',
    }]);
  }

  const role = ctx.uow.add(entity('JobRole', { name, active: true }));
  await ctx.uow.save({ action: 'CREATE_JOB_ROLE_FROM_ORDER' });
  return named(role);
}

// ---------------------------------------------------------------- motivos de pausa

export async function listPauseReasons(ctx) {
  return ctx.uow.loadAll('PauseReason', await query('SELECT * FROM pause_reasons')).sort(byName).map(named);
}

export const savePauseReason = (ctx, id, body) => saveNamed(ctx, 'PauseReason', 'pause_reasons', id, body,
  { required: 'Informe o motivo.', duplicate: 'Já existe um motivo de pausa com este nome.' });

// ---------------------------------------------------------------- CNPJs do Grupo

const groupDto = (x) => ({ id: x.id, name: x.name, cnpj: x.cnpj, active: x.active });

export async function listGroupEntities(ctx) {
  return ctx.uow.loadAll('GroupEntity', await query('SELECT * FROM group_entities')).sort(byName).map(groupDto);
}

export async function saveGroupEntity(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), 'Informe o nome.', 'name');
  const cnpj = Cnpj.require(input.text('cnpj'), 'cnpj');
  const active = input.bool('active', true);
  input.done();
  const clash = await query('SELECT id FROM group_entities WHERE cnpj = ?', cnpj);
  if (clash.some((r) => r.id !== id)) throw new BusinessRuleError('Já existe um CNPJ do Grupo cadastrado com este número.', 'cnpj');

  const item = id ? await getById(ctx.uow, 'GroupEntity', 'group_entities', id) : ctx.uow.add(entity('GroupEntity', {}));
  if (!item) throw new NotFoundError('Registro não encontrado.');
  Object.assign(item, { name, cnpj, active });
  await ctx.uow.save({ action: id ? 'UPDATE' : 'CREATE' });
  return groupDto(item);
}

// ---------------------------------------------------------------- locais de trabalho

/** Locais gerais e unidades de clientes (as excluídas logicamente ficam de fora). */
export async function listWorkLocations(ctx) {
  const items = ctx.uow.loadAll('WorkLocation', await query('SELECT * FROM work_locations WHERE removed_at IS NULL'));
  const clients = new Map((await query('SELECT id, legal_name FROM clients')).map((c) => [c.id, c.legal_name]));
  const clientName = (x) => (x.clientId ? clients.get(x.clientId) ?? '' : '');
  return items
    .sort((a, b) => clientName(a).localeCompare(clientName(b), 'pt-BR')
      || String(a.code ?? '').localeCompare(String(b.code ?? ''), 'pt-BR') || byName(a, b))
    .map((x) => ({
      id: x.id, name: x.name, code: x.code, cnpj: x.cnpj, clientId: x.clientId,
      clientName: x.clientId ? clients.get(x.clientId) ?? null : null, active: x.active,
    }));
}

/** Local geral (sem cliente). Unidades de cliente são mantidas no cadastro do cliente. */
export async function saveWorkLocation(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), 'Informe o nome do local.', 'name');
  const active = input.bool('active', true);
  input.done();
  const item = id
    ? await getById(ctx.uow, 'WorkLocation', 'work_locations', id)
    : ctx.uow.add(entity('WorkLocation', { clientId: null, code: null, cnpj: null, removedAt: null }));
  if (!item) throw new NotFoundError('Registro não encontrado.');
  if (item.clientId) throw new BusinessRuleError('Esta é uma unidade de cliente: altere-a no cadastro do cliente.', 'name');
  item.name = name;
  item.active = active;
  await ctx.uow.save({ action: id ? 'UPDATE' : 'CREATE' });
  return { id: item.id, name: item.name, code: item.code, cnpj: item.cnpj, clientId: null, clientName: null, active: item.active };
}

// ---------------------------------------------------------------- metas de SLA

const MODALITY_ORDER = Object.values(Modality);
const DEMAND_ORDER = Object.values(DemandType);
const slaDto = (x) => ({ id: x.id, modality: x.modality, demandType: x.demandType, days: x.days, validFrom: x.validFrom });

export async function listSlaTargets(ctx) {
  return ctx.uow.loadAll('SlaTarget', await query('SELECT * FROM sla_targets'))
    .sort((a, b) => MODALITY_ORDER.indexOf(a.modality) - MODALITY_ORDER.indexOf(b.modality)
      || DEMAND_ORDER.indexOf(a.demandType) - DEMAND_ORDER.indexOf(b.demandType)
      || b.validFrom.localeCompare(a.validFrom))
    .map(slaDto);
}

/** Metas versionadas: uma nova meta vale para posições abertas a partir de validFrom (RN-19). */
export async function createSlaTarget(ctx, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const modality = input.option('modality', Modality);
  const demandType = input.option('demandType', DemandType);
  const days = input.int('days', { required: true });
  const validFrom = input.date('validFrom');
  input.done();
  if (days < 1) throw new BusinessRuleError('A meta deve ser de pelo menos 1 dia.', 'days');
  const clash = await query('SELECT 1 AS yes FROM sla_targets WHERE modality = ? AND demand_type = ? AND valid_from = ?',
    modality, demandType, validFrom);
  if (clash.length) {
    throw new BusinessRuleError('Já existe meta para esta modalidade e tipo de demanda com a mesma data de vigência.', 'validFrom');
  }
  const item = ctx.uow.add(entity('SlaTarget', { modality, demandType, days, validFrom }));
  await ctx.uow.save({ action: 'CREATE' });
  return slaDto(item);
}

import { query } from '../db/index.js';
import { entity } from '../db/model.js';
import { getById, getContract, listContracts as listContractRows, userHasRole, userNames } from '../db/repository.js';
import { today as todayDate, utcNow, yearOf } from '../domain/dates.js';
import { BusinessRuleError, NotFoundError } from '../domain/errors.js';
import { ContractStatus, Modality, Roles } from '../domain/enums.js';
import { Cnpj, ContractCode, DateGuard, Permissions } from '../domain/guards.js';
import { Input, isId } from './input.js';

/** Clientes (com as unidades) e contratos: COMMERCIAL e ADMIN (matriz 4.1). Sem exclusão, apenas inativação. */

const byCode = (a, b) => String(a.code ?? '').localeCompare(String(b.code ?? ''), 'pt-BR');
const unitDto = (u) => ({ id: u.id, code: u.code, name: u.name, cnpj: u.cnpj });
const clientDto = (c, units) => ({
  id: c.id, legalName: c.legalName, cnpj: c.cnpj, active: c.active, hasMultipleUnits: c.hasMultipleUnits,
  units: [...units].sort(byCode).map(unitDto),
});

export async function listClients(ctx) {
  const units = ctx.uow.loadAll('WorkLocation',
    await query('SELECT * FROM work_locations WHERE client_id IS NOT NULL AND removed_at IS NULL'));
  const clients = ctx.uow.loadAll('Client', await query('SELECT * FROM clients'));
  return clients.sort((a, b) => a.legalName.localeCompare(b.legalName, 'pt-BR'))
    .map((c) => clientDto(c, units.filter((u) => u.clientId === c.id)));
}

export async function saveClient(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial, Roles.Admin);
  const input = new Input(body);
  const legalName = DateGuard.requireText(input.text('legalName'), 'Informe a razão social.', 'legalName');
  const cnpj = Cnpj.require(input.text('cnpj'), 'cnpj');
  const active = input.bool('active', true);
  const hasMultipleUnits = input.bool('hasMultipleUnits', false);
  const unitsRaw = input.raw('units');
  if (unitsRaw !== null && !Array.isArray(unitsRaw)) input.fail('units', 'Lista de unidades inválida.');
  input.done();

  const clash = await query('SELECT id FROM clients WHERE cnpj = ?', cnpj);
  if (clash.some((r) => r.id !== id)) throw new BusinessRuleError('Já existe um cliente cadastrado com este CNPJ.', 'cnpj');

  const client = id ? await getById(ctx.uow, 'Client', 'clients', id) : ctx.uow.add(entity('Client', {}));
  if (!client) throw new NotFoundError('Cliente não encontrado.');
  client.legalName = legalName;
  client.cnpj = cnpj;
  client.active = active;
  const units = await saveUnits(ctx, client, !id, hasMultipleUnits, unitsRaw);
  client.hasMultipleUnits = hasMultipleUnits;
  await ctx.uow.save({ action: id ? 'UPDATE' : 'CREATE' });
  return clientDto(client, units);
}

/**
 * Sincroniza as unidades (locais de trabalho do cliente) com a lista enviada: cria as novas, atualiza as existentes
 * e exclui logicamente as que saíram (RN-26). Tudo na mesma gravação do cliente. Lista ausente = mantém como está.
 */
async function saveUnits(ctx, client, isNew, hasMultipleUnits, unitsRaw) {
  const current = isNew ? [] : ctx.uow.loadAll('WorkLocation',
    await query('SELECT * FROM work_locations WHERE client_id = ? AND removed_at IS NULL', client.id));
  const desired = unitsRaw === null
    ? current.map((u) => ({ id: u.id, code: u.code, name: u.name, cnpj: u.cnpj }))
    : unitsRaw.map((u) => ({
      id: u?.id ?? null, code: u?.code ?? null, name: u?.name ?? null, cnpj: u?.cnpj ?? null,
    }));

  if (!hasMultipleUnits && desired.length > 0) {
    throw new BusinessRuleError('Exclua as unidades antes de desmarcar "Cliente possui múltiplas unidades".', 'hasMultipleUnits');
  }
  const codes = new Set();
  for (const unit of desired) {
    if (!String(unit.code ?? '').trim() || !String(unit.name ?? '').trim()) {
      throw new BusinessRuleError('Informe o código e o nome de cada unidade.', 'units');
    }
    const code = String(unit.code).trim();
    if (codes.has(code.toLowerCase())) throw new BusinessRuleError(`O código de unidade "${code}" está repetido.`, 'units');
    codes.add(code.toLowerCase());
    if (unit.cnpj && String(unit.cnpj).trim() && !Cnpj.isValid(unit.cnpj)) {
      throw new BusinessRuleError(`CNPJ inválido na unidade "${code}".`, 'units');
    }
    if (unit.id && (!isId(unit.id) || !current.some((c) => c.id === unit.id))) {
      throw new BusinessRuleError('Unidade não encontrada para este cliente.', 'units');
    }
  }

  const removing = current.filter((c) => !desired.some((d) => d.id === c.id));
  if (removing.length) {
    const inUse = await query(
      `SELECT name, contracting_unit_id FROM contracts WHERE status = 'ACTIVE'
          AND contracting_unit_id IN (${removing.map(() => '?').join(', ')})`, ...removing.map((r) => r.id));
    if (inUse.length) {
      const unit = removing.find((r) => r.id === inUse[0].contracting_unit_id);
      throw new BusinessRuleError(
        `A unidade "${unit.code}" é a unidade contratante do contrato ${inUse[0].name}. Encerre o contrato antes de excluir a unidade.`,
        'units');
    }
  }
  const now = utcNow();
  for (const removed of removing) {
    removed.removedAt = now;
    removed.active = false;
  }

  const result = [];
  for (const unit of desired) {
    let item = unit.id ? current.find((c) => c.id === unit.id) : null;
    if (!item) {
      item = ctx.uow.add(entity('WorkLocation', { clientId: client.id, active: true, removedAt: null }));
    }
    item.code = String(unit.code).trim();
    item.name = String(unit.name).trim();
    item.cnpj = unit.cnpj && String(unit.cnpj).trim() ? Cnpj.normalize(unit.cnpj) : null;
    result.push(item);
  }
  return result;
}

// ---------------------------------------------------------------- contratos

const contractDto = (c, owners) => ({
  id: c.id,
  clientId: c.clientId,
  clientName: c.client?.legalName ?? '',
  name: c.name,
  contractingUnitId: c.contractingUnitId,
  contractingUnitCode: c.contractingUnit?.code ?? null,
  contractingUnitName: c.contractingUnit?.name ?? null,
  groupEntityId: c.groupEntityId,
  groupEntityName: c.groupEntity?.name ?? '',
  modalities: c.modalities,
  startDate: c.startDate,
  endDate: c.endDate,
  commercialOwnerId: c.commercialOwnerId,
  commercialOwnerName: owners.get(c.commercialOwnerId) ?? null,
  slaNewDays: c.slaNewDays,
  slaReplacementDays: c.slaReplacementDays,
  status: c.status,
});

export async function listContracts(ctx, { clientId, onlyActive }) {
  const list = await listContractRows(ctx.uow, { clientId, onlyActive });
  const owners = await userNames(list.map((c) => c.commercialOwnerId));
  return list.map((c) => contractDto(c, owners));
}

export async function getContractDto(ctx, id) {
  const contract = await getContract(ctx.uow, id);
  if (!contract) throw new NotFoundError('Contrato não encontrado.');
  return contractDto(contract, await userNames([contract.commercialOwnerId]));
}

/** O identificador não é informado: o sistema gera o código ao criar o contrato. */
export async function saveContract(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Commercial, Roles.Admin);
  const input = new Input(body);
  const clientId = input.id('clientId', { message: 'Selecione o cliente.' });
  const contractingUnitId = input.id('contractingUnitId', { required: false });
  const groupEntityId = input.id('groupEntityId', { message: 'Selecione o CNPJ do Grupo.' });
  const modalities = input.options('modalities', Modality);
  const startDate = input.date('startDate', { message: 'Informe a data de início.' });
  const endDate = input.date('endDate', { required: false });
  const commercialOwnerId = input.id('commercialOwnerId', { message: 'Selecione o responsável comercial.' });
  const slaNewDays = input.int('slaNewDays');
  const slaReplacementDays = input.int('slaReplacementDays');
  const status = input.option('status', ContractStatus, { required: false }) ?? ContractStatus.ACTIVE;
  input.done();

  if (!modalities.length) throw new BusinessRuleError('Selecione ao menos uma modalidade.', 'modalities');
  if (endDate && endDate < startDate) {
    throw new BusinessRuleError('A data fim do contrato deve ser igual ou posterior à data de início.', 'endDate');
  }
  if ((slaNewDays !== null && slaNewDays < 1) || (slaReplacementDays !== null && slaReplacementDays < 1)) {
    throw new BusinessRuleError('As metas contratuais de SLA devem ser de pelo menos 1 dia.', 'slaNewDays');
  }
  const client = await getById(ctx.uow, 'Client', 'clients', clientId);
  if (!client) throw new BusinessRuleError('Cliente não encontrado.', 'clientId');
  const unit = await validateContractingUnit(ctx, client, contractingUnitId);
  if (!(await getById(ctx.uow, 'GroupEntity', 'group_entities', groupEntityId))) {
    throw new BusinessRuleError('CNPJ do Grupo não encontrado.', 'groupEntityId');
  }
  if (!(await userHasRole(commercialOwnerId, Roles.Commercial))) {
    throw new BusinessRuleError('O responsável comercial deve ser um usuário com perfil Comercial.', 'commercialOwnerId');
  }

  let contract;
  if (!id) {
    contract = ctx.uow.add(entity('Contract', {
      clientId: client.id,
      contractingUnitId: unit?.id ?? null,
      name: await nextContractCode(unit?.code ?? client.legalName),
    }));
  } else {
    contract = await getById(ctx.uow, 'Contract', 'contracts', id);
    if (!contract) throw new NotFoundError('Contrato não encontrado.');
    // O código foi gerado a partir do cliente e da unidade: os dois ficam fixos depois de criado o contrato.
    if (contract.clientId !== clientId || (contract.contractingUnitId ?? null) !== (contractingUnitId ?? null)) {
      throw new BusinessRuleError(
        'O cliente e a unidade contratante não mudam depois de criado o contrato. Encerre este contrato e crie outro.',
        'contractingUnitId');
    }
  }
  Object.assign(contract, {
    groupEntityId,
    modalities: Object.values(Modality).filter((m) => modalities.includes(m)),
    startDate,
    endDate,
    commercialOwnerId,
    slaNewDays,
    slaReplacementDays,
    status,
  });
  await ctx.uow.save({ action: id ? 'UPDATE' : 'CREATE' });
  return getContractDto(ctx, contract.id);
}

/**
 * Cliente com unidades exige a unidade contratante, que precisa ser dele e estar ativa; cliente sem unidades fica
 * vinculado ao cliente principal (sem unidade).
 */
async function validateContractingUnit(ctx, client, unitId) {
  const units = ctx.uow.loadAll('WorkLocation',
    await query('SELECT * FROM work_locations WHERE client_id = ? AND removed_at IS NULL', client.id));
  if (units.length === 0) {
    if (unitId) {
      throw new BusinessRuleError('Este cliente não tem unidades: o contrato fica vinculado ao cliente principal.', 'contractingUnitId');
    }
    return null;
  }
  if (!unitId) throw new BusinessRuleError('Selecione a unidade contratante.', 'contractingUnitId');
  const unit = units.find((u) => u.id === unitId);
  if (!unit) throw new BusinessRuleError('A unidade contratante não pertence a este cliente.', 'contractingUnitId');
  return unit;
}

/** CT-AAAA-UNIDADE-SEQUENCIAL, com o ano do registro e o sequencial por ano e unidade. */
async function nextContractCode(segmentSource) {
  const prefix = ContractCode.prefix(yearOf(todayDate()), ContractCode.segment(segmentSource));
  const existing = await query('SELECT name FROM contracts WHERE name LIKE ?', `${prefix}%`);
  return prefix + String(ContractCode.nextSequence(prefix, existing.map((r) => r.name))).padStart(4, '0');
}

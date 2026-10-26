import { CLOSED_STATUSES, PositionStatus } from '../domain/enums.js';
import { inList, query, queryOne } from './index.js';

/**
 * Leitura dos agregados para a unidade de trabalho: carrega as linhas e pendura as relações que as regras e as telas
 * usam (o papel dos Include do EF Core na versão .NET). Tudo em lotes — `WHERE id IN (...)` por tabela —, nunca uma
 * consulta por linha.
 *
 * Os objetos passam pelo mapa de identidade da unidade de trabalho: a mesma posição lida como "reposição de" e como
 * "posição do pedido" é o MESMO objeto, e uma alteração feita por um caminho aparece pelo outro.
 */

async function rowsIn(table, column, values, extra = '') {
  const list = inList(values);
  if (!list.params.length) return [];
  return query(`SELECT * FROM ${table} WHERE ${column} IN (${list.sql}) ${extra}`, ...list.params);
}

// ---------------------------------------------------------------- cadastros

/** Contratos com cliente, unidade contratante e CNPJ do Grupo. */
export async function attachContractRefs(uow, contracts) {
  const clients = uow.loadAll('Client', await rowsIn('clients', 'id', contracts.map((c) => c.clientId)));
  const units = uow.loadAll('WorkLocation', await rowsIn('work_locations', 'id', contracts.map((c) => c.contractingUnitId)));
  const groups = uow.loadAll('GroupEntity', await rowsIn('group_entities', 'id', contracts.map((c) => c.groupEntityId)));
  for (const c of contracts) {
    c.client = clients.find((x) => x.id === c.clientId) ?? null;
    c.contractingUnit = units.find((x) => x.id === c.contractingUnitId) ?? null;
    c.groupEntity = groups.find((x) => x.id === c.groupEntityId) ?? null;
  }
  return contracts;
}

export async function getContract(uow, id) {
  const contract = uow.load('Contract', await queryOne('SELECT * FROM contracts WHERE id = ?', id));
  if (contract) await attachContractRefs(uow, [contract]);
  return contract;
}

export async function listContracts(uow, { clientId = null, onlyActive = false } = {}) {
  const where = [];
  const params = [];
  if (clientId) {
    where.push('client_id = ?');
    params.push(clientId);
  }
  if (onlyActive) where.push("status = 'ACTIVE'");
  const rows = await query(`SELECT * FROM contracts ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params);
  const contracts = await attachContractRefs(uow, uow.loadAll('Contract', rows));
  return contracts.sort((a, b) => cmp(a.client?.legalName, b.client?.legalName) || cmp(a.name, b.name));
}

export const getById = async (uow, kind, table, id) =>
  (id ? uow.load(kind, await queryOne(`SELECT * FROM ${table} WHERE id = ?`, id)) : null);

/** Valores por cargo com contrato (e cliente) e cargo. */
export async function attachRateRefs(uow, rates) {
  const contracts = uow.loadAll('Contract', await rowsIn('contracts', 'id', rates.map((r) => r.contractId)));
  await attachContractRefs(uow, contracts);
  const roles = uow.loadAll('JobRole', await rowsIn('job_roles', 'id', rates.map((r) => r.jobRoleId)));
  // Pedido que propôs o valor (fluxo integrado): só número e situação, sem carregar o pedido inteiro.
  const orders = await rowsIn('orders', 'id', rates.map((r) => r.orderId).filter(Boolean));
  for (const r of rates) {
    r.contract = contracts.find((c) => c.id === r.contractId) ?? null;
    r.jobRole = roles.find((j) => j.id === r.jobRoleId) ?? null;
    const order = orders.find((o) => o.id === r.orderId);
    r.originOrder = order ? { id: order.id, number: Number(order.number), approvalStatus: order.approval_status } : null;
  }
  return rates;
}

/** Versão com maior valid_from ≤ data (a vigente na data); `validatedOnly` ignora pendentes e rejeitadas. */
export async function findEffectiveRate(uow, contractId, jobRoleId, date, validatedOnly = false) {
  const row = await queryOne(
    `SELECT * FROM contract_rates WHERE contract_id = ? AND job_role_id = ? AND valid_from <= ?
       ${validatedOnly ? "AND status = 'VALIDATED'" : ''} ORDER BY valid_from DESC LIMIT 1`,
    contractId, jobRoleId, date);
  return uow.load('ContractRate', row);
}

// ---------------------------------------------------------------- pedidos

/** Contrato (com cliente, unidade e Grupo), cargo, local de trabalho e analistas de RH do pedido. */
async function attachOrderRefs(uow, orders) {
  const contracts = uow.loadAll('Contract', await rowsIn('contracts', 'id', orders.map((o) => o.contractId)));
  await attachContractRefs(uow, contracts);
  const roles = uow.loadAll('JobRole', await rowsIn('job_roles', 'id', orders.map((o) => o.jobRoleId)));
  const locations = uow.loadAll('WorkLocation', await rowsIn('work_locations', 'id', orders.map((o) => o.workLocationId)));
  const analysts = uow.loadAll('OrderRhAnalyst', await rowsIn('order_rh_analysts', 'order_id', orders.map((o) => o.id),
    'ORDER BY assigned_at, id'));
  const reviews = uow.loadAll('OrderReview', await rowsIn('order_reviews', 'order_id', orders.map((o) => o.id),
    'ORDER BY occurred_at, id'));
  const rates = uow.loadAll('ContractRate', await rowsIn('contract_rates', 'id', orders.map((o) => o.rateId).filter(Boolean)));
  for (const o of orders) {
    o.contract = contracts.find((c) => c.id === o.contractId) ?? null;
    o.jobRole = roles.find((j) => j.id === o.jobRoleId) ?? null;
    o.workLocation = locations.find((l) => l.id === o.workLocationId) ?? null;
    o.rhAnalysts = analysts.filter((a) => a.orderId === o.id);
    o.reviews = reviews.filter((r) => r.orderId === o.id);
    o.rate = rates.find((r) => r.id === o.rateId) ?? null;
    if (o.rate) {
      o.rate.contract ??= o.contract;
      o.rate.jobRole ??= roles.find((j) => j.id === o.rate.jobRoleId) ?? null;
    }
  }
  return orders;
}

/** Pedidos completos: referências e TODAS as posições, cada uma com desligamentos, pausas, valor e candidatos. */
async function loadOrderAggregates(uow, rows) {
  const orders = await attachOrderRefs(uow, uow.loadAll('Order', rows));
  const positions = uow.loadAll('Position', await rowsIn('positions', 'order_id', orders.map((o) => o.id),
    'ORDER BY sequence'));
  for (const o of orders) o.positions = positions.filter((p) => p.orderId === o.id);
  for (const p of positions) p.order = orders.find((o) => o.id === p.orderId);
  await attachPositionRefs(uow, positions);
  return orders;
}

export async function getOrder(uow, id) {
  const row = await queryOne('SELECT * FROM orders WHERE id = ?', id);
  return row ? (await loadOrderAggregates(uow, [row]))[0] : null;
}

export async function listOrders(uow, { clientId = null, contractId = null } = {}) {
  const where = [];
  const params = [];
  if (clientId) {
    where.push('contract_id IN (SELECT id FROM contracts WHERE client_id = ?)');
    params.push(clientId);
  }
  if (contractId) {
    where.push('contract_id = ?');
    params.push(contractId);
  }
  const rows = await query(`SELECT * FROM orders ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`, ...params);
  return loadOrderAggregates(uow, rows);
}

// ---------------------------------------------------------------- posições

/**
 * Relações de cada posição: pedido (com referências), desligamento de origem (reposição) com a posição de origem,
 * desligamento do ocupante com a reposição criada, pausas com o motivo, valor por cargo, candidatos e evidências.
 */
export async function attachPositionRefs(uow, positions) {
  if (!positions.length) return positions;
  const ids = positions.map((p) => p.id);

  const missingOrders = positions.filter((p) => !p.order).map((p) => p.orderId);
  if (missingOrders.length) {
    const orders = await attachOrderRefs(uow, uow.loadAll('Order', await rowsIn('orders', 'id', missingOrders)));
    for (const p of positions) p.order ??= orders.find((o) => o.id === p.orderId) ?? null;
  }

  const terminations = uow.loadAll('Termination', [
    ...(await rowsIn('terminations', 'id', positions.map((p) => p.terminationId))),
    ...(await rowsIn('terminations', 'origin_position_id', ids)),
  ]);
  const linked = uow.loadAll('Position', [
    ...(await rowsIn('positions', 'id', terminations.map((t) => t.originPositionId).filter((id) => !uow.get('Position', id)))),
    ...(await rowsIn('positions', 'termination_id', terminations.map((t) => t.id))),
  ]);
  for (const t of terminations) {
    t.originPosition = uow.get('Position', t.originPositionId);
    t.replacementPosition = [...positions, ...linked].find((x) => x.terminationId === t.id) ?? null;
  }

  const pauses = uow.loadAll('Pause', await rowsIn('pauses', 'position_id', ids, 'ORDER BY start_date'));
  const reasons = uow.loadAll('PauseReason', await rowsIn('pause_reasons', 'id', pauses.map((x) => x.reasonId)));
  for (const pause of pauses) pause.reason = reasons.find((r) => r.id === pause.reasonId) ?? null;

  const rates = uow.loadAll('ContractRate', await rowsIn('contract_rates', 'id', positions.map((p) => p.rateId)));
  const candidates = uow.loadAll('Candidate', await rowsIn('candidates', 'position_id', ids, 'ORDER BY created_at, id'));
  const evidences = uow.loadAll('PositionEvidence', await rowsIn('position_evidences', 'position_id', ids,
    'ORDER BY created_at, id'));

  for (const p of positions) {
    p.termination = terminations.find((t) => t.id === p.terminationId) ?? null;
    p.exitTermination = terminations.find((t) => t.originPositionId === p.id) ?? null;
    p.pauses = pauses.filter((x) => x.positionId === p.id);
    p.rate = rates.find((r) => r.id === p.rateId) ?? null;
    p.candidates = candidates.filter((c) => c.positionId === p.id);
    p.evidences = evidences.filter((e) => e.positionId === p.id);
  }
  // Posições ligadas (origem e reposição) carregadas só pela linha: relações vazias em vez de indefinidas.
  for (const x of linked) {
    x.pauses ??= [];
    x.candidates ??= await rowsCandidates(uow, x.id);
    x.evidences ??= [];
  }
  return positions;
}

async function rowsCandidates(uow, positionId) {
  return uow.loadAll('Candidate', await query('SELECT * FROM candidates WHERE position_id = ? ORDER BY created_at, id', positionId));
}

export async function getPosition(uow, id) {
  const p = uow.load('Position', await queryOne('SELECT * FROM positions WHERE id = ?', id));
  if (!p) return null;
  await attachPositionRefs(uow, [p]);
  return p;
}

/** Filtros da lista de posições (o PositionFilter da versão .NET). */
export async function listPositions(uow, f = {}) {
  const where = [];
  const params = [];
  const add = (sql, ...values) => {
    where.push(sql);
    params.push(...values);
  };
  if (f.openedFrom) add('p.opened_at >= ?', f.openedFrom);
  if (f.openedTo) add('p.opened_at <= ?', f.openedTo);
  if (f.clientId) add('c.client_id = ?', f.clientId);
  if (f.contractId) add('o.contract_id = ?', f.contractId);
  if (f.orderId) add('p.order_id = ?', f.orderId);
  if (f.modality) add('o.modality = ?', f.modality);
  if (f.jobRoleId) add('o.job_role_id = ?', f.jobRoleId);
  if (f.demandType) add('p.demand_type = ?', f.demandType);
  if (f.groupEntityId) add('c.group_entity_id = ?', f.groupEntityId);
  if (f.workLocationId) add('o.work_location_id = ?', f.workLocationId);
  if (f.statuses?.length) {
    const list = inList(f.statuses);
    add(`p.status IN (${list.sql})`, ...list.params);
  }
  if (f.onlyOpen) add(`p.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(', ')})`, ...CLOSED_STATUSES);
  if (f.rhAnalystId) {
    add('EXISTS (SELECT 1 FROM order_rh_analysts a WHERE a.order_id = p.order_id AND a.user_id = ? AND a.removed_at IS NULL)',
      f.rhAnalystId);
  }
  if (f.commercialOwnerId) add('c.commercial_owner_id = ?', f.commercialOwnerId);
  if (f.rhUnassigned) {
    add('NOT EXISTS (SELECT 1 FROM order_rh_analysts a WHERE a.order_id = p.order_id AND a.removed_at IS NULL)');
  }
  if (f.currentCycleOnly) add('NOT EXISTS (SELECT 1 FROM terminations t WHERE t.origin_position_id = p.id)');
  if (f.search?.trim()) {
    const term = `%${f.search.trim().toLowerCase()}%`;
    // O nome do colaborador só é gravado no 1º dia; antes dele, a busca acha o candidato ativo da posição.
    add(`(lower(COALESCE(p.employee_name, '')) LIKE ? OR lower(COALESCE(p.employee_registration, '')) LIKE ?
          OR lower(COALESCE(o.jobconvo_code, '')) LIKE ? OR lower(cl.legal_name) LIKE ? OR lower(j.name) LIKE ?
          OR EXISTS (SELECT 1 FROM candidates ca WHERE ca.position_id = p.id AND ca.withdrawn_at IS NULL
                       AND lower(ca.full_name) LIKE ?))`,
    term, term, term, term, term, term);
  }
  const rows = await query(
    `SELECT p.* FROM positions p
       JOIN orders o ON o.id = p.order_id
       JOIN contracts c ON c.id = o.contract_id
       JOIN clients cl ON cl.id = c.client_id
       JOIN job_roles j ON j.id = o.job_role_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`,
    ...params);
  return attachPositionRefs(uow, uow.loadAll('Position', rows));
}

/** Posições abertas FIXED_END com data fim anterior a hoje (encerramento pela rotina diária). */
export async function listExpiredFixedEnd(uow, today) {
  const rows = await query(
    `SELECT * FROM positions WHERE term_type = 'FIXED_END' AND term_end_date < ?
        AND status NOT IN (${CLOSED_STATUSES.map(() => '?').join(', ')})`, today, ...CLOSED_STATUSES);
  return attachPositionRefs(uow, uow.loadAll('Position', rows));
}

/** Posições FILLED sem desligamento, para a busca do colaborador (por nome ou matrícula). */
export async function searchFilled(uow, term, take) {
  const params = [PositionStatus.FILLED];
  let filter = '';
  if (term?.trim()) {
    const like = `%${term.trim().toLowerCase()}%`;
    filter = "AND (lower(COALESCE(p.employee_name, '')) LIKE ? OR lower(COALESCE(p.employee_registration, '')) LIKE ?)";
    params.push(like, like);
  }
  const rows = await query(
    `SELECT p.* FROM positions p
      WHERE p.status = ? AND NOT EXISTS (SELECT 1 FROM terminations t WHERE t.origin_position_id = p.id) ${filter}
      ORDER BY p.employee_name LIMIT ${Number(take)}`, ...params);
  const positions = uow.loadAll('Position', rows);
  const orders = await attachOrderRefs(uow, uow.loadAll('Order', await rowsIn('orders', 'id', positions.map((p) => p.orderId))));
  for (const p of positions) p.order = orders.find((o) => o.id === p.orderId) ?? null;
  return positions;
}

/** Posições abertas sem valor que passam a usar uma versão nova do valor (vigente na abertura). */
export async function listWithoutRate(uow, contractId, jobRoleId, openedFrom) {
  const rows = await query(
    `SELECT p.* FROM positions p JOIN orders o ON o.id = p.order_id
      WHERE p.rate_id IS NULL AND o.contract_id = ? AND o.job_role_id = ? AND p.opened_at >= ?
        AND p.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(', ')})`,
    contractId, jobRoleId, openedFrom, ...CLOSED_STATUSES);
  return uow.loadAll('Position', rows);
}

/** Próxima sequência interna do pedido, considerando também as posições ainda não gravadas desta operação. */
export async function nextSequence(uow, orderId, pending = []) {
  const row = await queryOne('SELECT MAX(sequence) AS last FROM positions WHERE order_id = ?', orderId);
  const pendingMax = Math.max(0, ...pending.filter((p) => p.orderId === orderId).map((p) => p.sequence ?? 0));
  return Math.max(Number(row?.last ?? 0), pendingMax) + 1;
}

/** Outra posição aberta em que o CPF é o candidato selecionado (o mesmo candidato não ocupa duas). */
export async function findOpenWithCandidateCpf(cpf, exceptPositionId) {
  return queryOne(
    `SELECT p.slot_number, o.number AS order_number FROM positions p
       JOIN orders o ON o.id = p.order_id
       JOIN candidates c ON c.position_id = p.id AND c.withdrawn_at IS NULL
      WHERE c.cpf = ? AND p.id <> ? AND p.status NOT IN (${CLOSED_STATUSES.map(() => '?').join(', ')})
      LIMIT 1`, cpf, exceptPositionId, ...CLOSED_STATUSES);
}

export async function hasTermination(originPositionId) {
  return Boolean(await queryOne('SELECT 1 AS yes FROM terminations WHERE origin_position_id = ?', originPositionId));
}

// ---------------------------------------------------------------- usuários

export async function usersByIds(ids) {
  const rows = await rowsIn('users', 'id', ids);
  return new Map(rows.map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));
}

/** Usuários ATIVOS entre os informados (destinatários de avisos: quem foi desativado não recebe). */
export async function activeUsersByIds(ids) {
  const rows = await rowsIn('users', 'id', ids);
  return new Map(rows.filter((u) => Number(u.active) === 1).map((u) => [u.id, { id: u.id, name: u.name, email: u.email }]));
}

/** Usuários ATIVOS com algum dos perfis. */
export async function activeUsersByRoles(roles) {
  const list = inList(roles);
  if (!list.params.length) return [];
  return query(
    `SELECT DISTINCT u.id, u.name, u.email FROM users u JOIN user_roles r ON r.user_id = u.id
      WHERE u.active = 1 AND r.role IN (${list.sql})`, ...list.params);
}

export async function userHasRole(userId, role) {
  return Boolean(await queryOne(
    'SELECT 1 AS yes FROM users u JOIN user_roles r ON r.user_id = u.id WHERE u.id = ? AND u.active = 1 AND r.role = ?',
    userId, role));
}

/** Nomes dos usuários por id (para "registrado por", "confirmado por"...). */
export async function userNames(ids) {
  const map = await usersByIds(ids);
  return new Map([...map].map(([id, u]) => [id, u.name]));
}

const cmp = (a, b) => String(a ?? '').localeCompare(String(b ?? ''), 'pt-BR');

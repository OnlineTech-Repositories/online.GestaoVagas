import { randomBytes } from 'node:crypto';

/**
 * Mapa das entidades: tabela, colunas (em camelCase; a coluna é o snake_case) e tipo de cada uma.
 *
 * É o que permite à unidade de trabalho (unit-of-work.js) gravar o objeto inteiro e auditar campo a campo sem uma
 * linha de SQL por operação — o mesmo trabalho que o EF Core fazia na versão .NET. As regras continuam em domain/,
 * operando sobre objetos simples; quem decide o que vai para o banco é este mapa.
 *
 * Tipos: text, int, bool (INTEGER 0/1), date ('AAAA-MM-DD'), datetime (ISO UTC), decimal, list ("A,B"), blob.
 */

const BASE = { id: 'text', createdAt: 'datetime', createdBy: 'text', updatedAt: 'datetime', updatedBy: 'text', version: 'int' };

const define = (table, columns, options = {}) => ({ table, columns: { ...BASE, ...columns }, audited: true, ...options });

export const ENTITIES = {
  User: define('users', {
    name: 'text', email: 'text', passwordHash: 'text', passwordSalt: 'text', active: 'bool', mustChangePassword: 'bool',
    failedAttempts: 'int', lockoutEnd: 'datetime',
  }),
  GroupEntity: define('group_entities', { name: 'text', cnpj: 'text', active: 'bool' }),
  Client: define('clients', { legalName: 'text', cnpj: 'text', active: 'bool', hasMultipleUnits: 'bool' }),
  JobRole: define('job_roles', { name: 'text', active: 'bool' }),
  WorkLocation: define('work_locations', {
    name: 'text', clientId: 'text', active: 'bool', code: 'text', cnpj: 'text', removedAt: 'datetime',
  }),
  PauseReason: define('pause_reasons', { name: 'text', active: 'bool' }),
  SlaTarget: define('sla_targets', { modality: 'text', demandType: 'text', days: 'int', validFrom: 'date' }),
  SystemParameter: define('system_parameters', { paramKey: 'text', paramValue: 'text', description: 'text' }),
  Contract: define('contracts', {
    clientId: 'text', contractingUnitId: 'text', name: 'text', groupEntityId: 'text', modalities: 'list',
    startDate: 'date', endDate: 'date', commercialOwnerId: 'text', slaNewDays: 'int', slaReplacementDays: 'int',
    status: 'text',
  }),
  ContractRate: define('contract_rates', {
    contractId: 'text', jobRoleId: 'text', monthlyValue: 'decimal', feeValue: 'decimal', validFrom: 'date',
    status: 'text', validatedBy: 'text', validatedAt: 'datetime', rejectionReason: 'text',
  }),
  Order: define('orders', {
    number: 'int', contractId: 'text', modality: 'text', jobRoleId: 'text', quantity: 'int', workLocationId: 'text',
    clientRequestDate: 'date', desiredStartDate: 'date', termType: 'text', termEndDate: 'date', termDurationDays: 'int',
    notes: 'text', jobDescription: 'text', isLegacy: 'bool', registeredAt: 'date', approvalStatus: 'text',
    clientDecisionDate: 'date', approvalRecordedAt: 'datetime', approvalRecordedBy: 'text', notApprovedReason: 'text',
    jobconvoPublished: 'bool', jobconvoCode: 'text', jobconvoPublishedAt: 'date', jobconvoNotes: 'text',
    jobconvoRecordedAt: 'datetime', jobconvoRecordedBy: 'text',
  }),
  Position: define('positions', {
    orderId: 'text', sequence: 'int', slotNumber: 'int', cycle: 'int', demandType: 'text', originPositionId: 'text',
    terminationId: 'text', status: 'text', previousStatus: 'text', desiredStartDate: 'date', openedAt: 'date',
    candidateApprovedAt: 'date', admissionAt: 'date', admissionRegistration: 'text', firstDayAt: 'date',
    employeeName: 'text', employeeRegistration: 'text', firstDayJustification: 'text', firstDayConfirmedAt: 'datetime',
    firstDayConfirmedBy: 'text', closedAt: 'date', cancellationReason: 'text', termType: 'text', termEndDate: 'date',
    termDurationDays: 'int', termAdjustJustification: 'text', rateId: 'text', slaTargetDays: 'int',
    slaTargetSource: 'text', hasRetroactiveDates: 'bool',
  }),
  Termination: define('terminations', {
    originPositionId: 'text', lastWorkedDay: 'date', source: 'text', terminationType: 'text', notes: 'text',
    clientDecision: 'text', clientDecisionAt: 'date', registeredAt: 'date',
  }),
  Pause: define('pauses', { positionId: 'text', reasonId: 'text', startDate: 'date', endDate: 'date' }),
  OrderRhAnalyst: define('order_rh_analysts', {
    orderId: 'text', userId: 'text', userName: 'text', assignedAt: 'datetime', assignedBy: 'text',
    removedAt: 'datetime', removedBy: 'text',
  }),
  Candidate: define('candidates', {
    positionId: 'text', fullName: 'text', birthDate: 'date', sex: 'text', cpf: 'text', approvedAt: 'date',
    withdrawnAt: 'datetime', withdrawalReason: 'text',
  }),
  PositionEvidence: define('position_evidences', {
    positionId: 'text', kind: 'text', fileName: 'text', contentType: 'text', sizeBytes: 'int', storageKey: 'text',
  }),
  EvidenceFile: {
    table: 'evidence_files', columns: { id: 'text', content: 'blob', createdAt: 'datetime' }, audited: false, plain: true,
  },
  Notification: define('notifications', {
    userId: 'text', type: 'text', entityId: 'text', message: 'text', readAt: 'datetime',
  }, { audited: false }),
  EmailMessage: define('email_messages', {
    toAddress: 'text', subject: 'text', htmlBody: 'text', status: 'text', attempts: 'int', lastError: 'text',
    sentAt: 'datetime',
  }, { audited: false }),
  JobRun: define('job_runs', {
    jobName: 'text', runDate: 'date', startedAt: 'datetime', finishedAt: 'datetime', summary: 'text',
  }, { audited: false }),
};

/**
 * Relações que a unidade de trabalho percorre para achar entidades novas penduradas em entidades já conhecidas
 * (o candidato criado dentro da posição, a reposição criada pelo desligamento...). A ordem das chaves é a ordem
 * de inserção: pais antes dos filhos, por causa das chaves estrangeiras.
 */
export const RELATIONS = {
  Order: ['positions', 'rhAnalysts'],
  Position: ['exitTermination', 'pauses', 'candidates', 'evidences'],
  Termination: ['replacementPosition'],
  PositionEvidence: ['file'],
};

/** Ordem de inserção entre tipos (pais primeiro). */
export const INSERT_ORDER = [
  'User', 'GroupEntity', 'Client', 'JobRole', 'WorkLocation', 'PauseReason', 'SlaTarget', 'SystemParameter', 'Contract',
  'ContractRate', 'Order', 'Position', 'Termination', 'Pause', 'OrderRhAnalyst', 'Candidate', 'EvidenceFile',
  'PositionEvidence', 'Notification', 'EmailMessage', 'JobRun',
];

/** Campos que não entram no histórico (técnicos ou sensíveis). */
export const IGNORED_FIELDS = new Set([
  'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'version', 'passwordHash', 'passwordSalt', 'failedAttempts',
]);

/** Marca do tipo da entidade no objeto (não enumerável: não aparece no JSON nem no Object.keys). */
export const KIND = Symbol('kind');

export function entity(kind, props) {
  const obj = { ...props };
  Object.defineProperty(obj, KIND, { value: kind, enumerable: false });
  if (!obj.id) obj.id = uuidv7();
  return obj;
}

export const kindOf = (obj) => obj?.[KIND];

export const snake = (name) => name.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
export const pascal = (name) => name[0].toUpperCase() + name.slice(1);

/** Linha do banco → entidade (tipos de volta ao JavaScript). */
export function fromRow(kind, row) {
  const def = ENTITIES[kind];
  const obj = {};
  for (const [prop, type] of Object.entries(def.columns)) obj[prop] = fromDb(type, row[snake(prop)]);
  Object.defineProperty(obj, KIND, { value: kind, enumerable: false });
  return obj;
}

export function fromDb(type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'bool': return value === true || value === 1 || value === '1' || value === 1n;
    case 'int': return Number(value);
    case 'decimal': return Number(value);
    case 'list': return String(value).split(',').filter(Boolean);
    case 'blob': return Buffer.from(value);
    default: return String(value);
  }
}

export function toDb(type, value) {
  if (value === null || value === undefined) return null;
  switch (type) {
    case 'bool': return value ? 1 : 0;
    case 'int': return Math.trunc(Number(value));
    case 'decimal': return Number(value);
    case 'list': return value.join(',');
    default: return value;
  }
}

/**
 * Valor no formato do log de auditoria — o mesmo da versão .NET, para o histórico continuar legível pela tela:
 * datas como estão, booleanos "True"/"False", listas separadas por vírgula.
 */
export function auditFormat(type, value) {
  if (value === null || value === undefined) return null;
  if (type === 'bool') return value ? 'True' : 'False';
  if (type === 'list') return value.join(',');
  if (type === 'blob') return null;
  return String(value);
}

/**
 * UUID v7 (RFC 9562): 48 bits de milissegundos + aleatório. Ordena pelo tempo de criação, como os Guid v7 da versão
 * .NET — o log de auditoria usa isso para desempatar registros do mesmo instante. O contador garante a ordem também
 * dentro do mesmo milissegundo.
 */
let lastMs = 0;
let counter = 0;
export function uuidv7() {
  let ms = Date.now();
  if (ms <= lastMs) {
    counter += 1;
    if (counter > 0xfff) {
      lastMs += 1;
      counter = 0;
    }
    ms = lastMs;
  } else {
    lastMs = ms;
    counter = 0;
  }
  const bytes = randomBytes(16);
  bytes.writeUIntBE(ms, 0, 6);
  bytes[6] = 0x70 | (counter >> 8);
  bytes[7] = counter & 0xff;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

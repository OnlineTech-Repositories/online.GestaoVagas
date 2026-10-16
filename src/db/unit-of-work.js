import { ConflictError } from '../domain/errors.js';
import { utcNow } from '../domain/dates.js';
import { execute, LOCK, lock, queryOne, transaction } from './index.js';
import {
  auditFormat, ENTITIES, fromDb, fromRow, IGNORED_FIELDS, INSERT_ORDER, kindOf, pascal, RELATIONS, snake, toDb, uuidv7,
} from './model.js';

/**
 * Unidade de trabalho de uma operação: lembra o estado de cada entidade lida, descobre as novas penduradas nelas e,
 * no save(), grava tudo numa transação — com o log de auditoria campo a campo (seção 12 da SPEC).
 *
 * É o trabalho que o EF Core e o interceptor de auditoria faziam na versão .NET, e existe pelo mesmo motivo: as
 * regras (domain/) mudam objetos simples e não sabem de SQL; sem um ponto único de gravação, cada serviço teria de
 * lembrar de auditar cada campo, e o que fosse esquecido simplesmente sumiria do histórico.
 *
 * Concorrência: todo UPDATE leva `WHERE version = ?`. Se outra requisição gravou o mesmo registro depois da
 * leitura, nenhuma linha muda e a operação inteira é desfeita com 409 — em vez de responder sucesso às duas e a
 * segunda apagar a primeira sem ninguém perceber.
 */
export class UnitOfWork {
  /** @param {{ userId?: string|null, ip?: string|null }} actor */
  constructor(actor = {}) {
    this.actor = { userId: actor.userId ?? null, ip: actor.ip ?? null };
    this.identity = new Map();
    this.snapshots = new Map();
    this.added = [];
    this.manualLogs = [];
  }

  /** Linha lida do banco → entidade rastreada. A mesma linha lida duas vezes devolve o mesmo objeto. */
  load(kind, row) {
    if (!row) return null;
    const key = `${kind}:${row.id}`;
    const existing = this.identity.get(key);
    if (existing) return existing;
    const obj = fromRow(kind, row);
    this.identity.set(key, obj);
    this.snapshots.set(obj, snapshotOf(kind, obj));
    return obj;
  }

  loadAll(kind, rows) {
    return rows.map((r) => this.load(kind, r));
  }

  get(kind, id) {
    return id ? this.identity.get(`${kind}:${id}`) ?? null : null;
  }

  /** Entidade nova (as penduradas em entidades conhecidas são descobertas sozinhas no save). */
  add(obj) {
    if (!kindOf(obj)) throw new Error('add() recebeu um objeto que não é entidade.');
    if (!obj.id) obj.id = uuidv7();
    if (!this.isKnown(obj)) this.added.push(obj);
    return obj;
  }

  /** Registro manual no log (perfis de usuário, que não são uma entidade com colunas). */
  log(entry) {
    this.manualLogs.push(entry);
  }

  isKnown(obj) {
    return this.snapshots.has(obj) || this.added.includes(obj);
  }

  /**
   * Grava inserções, alterações e o log de auditoria numa transação.
   * @param {{ action?: string, justification?: string|null }} options
   */
  async save({ action = null, justification = null } = {}) {
    this.discoverNew();
    const now = utcNow();
    const { userId, ip } = this.actor;
    const cleanJustification = justification?.trim() ? justification.trim() : null;
    const logs = [];
    const newLog = (entity, entityId, logAction, field, oldValue, newValue) => logs.push({
      id: uuidv7(), userId, occurredAt: now, ip, entity, entityId, action: logAction, field,
      oldValue: truncate(oldValue), newValue: truncate(newValue), justification: cleanJustification,
    });

    await transaction(async () => {
      const inserts = [...this.added].sort((a, b) => INSERT_ORDER.indexOf(kindOf(a)) - INSERT_ORDER.indexOf(kindOf(b)));
      for (const obj of inserts) {
        const kind = kindOf(obj);
        const def = ENTITIES[kind];
        if (!def.plain) {
          obj.createdAt = now;
          obj.createdBy ??= userId;
          obj.updatedAt = null;
          obj.updatedBy = null;
          obj.version = 0;
        } else {
          obj.createdAt ??= now;
        }
        if (kind === 'Order' && !obj.number) obj.number = await nextOrderNumber();
        await insert(kind, obj);
        if (def.audited) {
          newLog(kind, obj.id, action ?? 'CREATE', null, null, JSON.stringify(auditSnapshot(kind, obj)));
        }
      }

      for (const [obj, before] of this.snapshots) {
        if (this.added.includes(obj)) continue;
        const kind = kindOf(obj);
        const def = ENTITIES[kind];
        const changed = Object.keys(def.columns).filter((prop) =>
          !['id', 'createdAt', 'createdBy', 'updatedAt', 'updatedBy', 'version'].includes(prop)
          && !same(toDb(def.columns[prop], obj[prop]), before[prop]));
        if (changed.length === 0) continue;

        obj.updatedAt = now;
        obj.updatedBy = userId;
        const sets = [...changed, 'updatedAt', 'updatedBy'];
        const result = await execute(
          `UPDATE ${def.table} SET ${sets.map((p) => `${snake(p)} = ?`).join(', ')}, version = version + 1
            WHERE id = ? AND version = ?`,
          ...sets.map((p) => toDb(def.columns[p], obj[p])), obj.id, before.version,
        );
        if (result.changes !== 1) throw new ConflictError();
        obj.version = before.version + 1;

        if (!def.audited) continue;
        for (const prop of changed) {
          if (IGNORED_FIELDS.has(prop)) continue;
          const type = def.columns[prop];
          newLog(kind, obj.id, action ?? 'UPDATE', pascal(prop),
            auditFormat(type, fromDb(type, before[prop])), auditFormat(type, obj[prop]));
        }
      }

      for (const m of this.manualLogs) {
        newLog(m.entity, m.entityId, m.action ?? action ?? 'UPDATE', m.field ?? null, m.oldValue ?? null, m.newValue ?? null);
      }
      for (const log of logs) await insert('AuditLog', log);
    });

    // Depois do COMMIT: o estado gravado passa a ser a referência para o próximo save().
    for (const obj of this.added) {
      this.identity.set(`${kindOf(obj)}:${obj.id}`, obj);
      this.snapshots.set(obj, snapshotOf(kindOf(obj), obj));
    }
    for (const obj of this.snapshots.keys()) this.snapshots.set(obj, snapshotOf(kindOf(obj), obj));
    this.added = [];
    this.manualLogs = [];
  }

  /** Percorre as relações das entidades conhecidas atrás de entidades novas (como o EF Core faz). */
  discoverNew() {
    const queue = [...this.snapshots.keys(), ...this.added];
    const seen = new Set(queue);
    while (queue.length) {
      const obj = queue.shift();
      for (const rel of RELATIONS[kindOf(obj)] ?? []) {
        const value = obj[rel];
        for (const child of Array.isArray(value) ? value : value ? [value] : []) {
          if (!kindOf(child) || seen.has(child)) continue;
          seen.add(child);
          if (!this.isKnown(child)) this.added.push(child);
          queue.push(child);
        }
      }
    }
  }
}

const AUDIT_COLUMNS = {
  id: 'text', userId: 'text', occurredAt: 'datetime', ip: 'text', entity: 'text', entityId: 'text', action: 'text',
  field: 'text', oldValue: 'text', newValue: 'text', justification: 'text',
};

async function insert(kind, obj) {
  const columns = kind === 'AuditLog' ? AUDIT_COLUMNS : ENTITIES[kind].columns;
  const table = kind === 'AuditLog' ? 'audit_logs' : ENTITIES[kind].table;
  const props = Object.keys(columns);
  await execute(
    `INSERT INTO ${table} (${props.map(snake).join(', ')}) VALUES (${props.map(() => '?').join(', ')})`,
    ...props.map((p) => toDb(columns[p], obj[p])),
  );
}

/**
 * Número sequencial do pedido, exibido ao usuário. Lido e gravado na mesma transação, sob trava: sem ela, dois
 * pedidos criados ao mesmo tempo pegavam o mesmo número e o segundo falhava na unicidade.
 */
async function nextOrderNumber() {
  await lock(LOCK.ORDER_NUMBER);
  const row = await queryOne('SELECT COALESCE(MAX(number), 0) AS last FROM orders');
  return Number(row.last) + 1;
}

function snapshotOf(kind, obj) {
  const def = ENTITIES[kind];
  const snap = {};
  for (const [prop, type] of Object.entries(def.columns)) snap[prop] = type === 'blob' ? null : toDb(type, obj[prop]);
  return snap;
}

function auditSnapshot(kind, obj) {
  const def = ENTITIES[kind];
  const values = {};
  for (const [prop, type] of Object.entries(def.columns)) {
    if (IGNORED_FIELDS.has(prop) || type === 'blob') continue;
    values[pascal(prop)] = auditFormat(type, obj[prop]);
  }
  return values;
}

const same = (a, b) => (a === null || a === undefined ? b === null || b === undefined : a === b);
const truncate = (v) => (typeof v === 'string' && v.length > 4000 ? v.slice(0, 4000) : v);

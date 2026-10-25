import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { config } from '../config.js';
import { assertPortable } from './dialect.js';

/**
 * Driver SQLite (node:sqlite), para desenvolvimento e testes.
 *
 * O node:sqlite é síncrono; a interface aqui é assíncrona para ser a mesma do driver PostgreSQL. Envolver chamada
 * síncrona em Promise não custa E/S: o trabalho já terminou quando a Promise resolve.
 */
export function createSqliteDriver() {
  if (config.dbFile !== ':memory:') mkdirSync(dirname(config.dbFile), { recursive: true });
  const db = new DatabaseSync(config.dbFile);

  // foreign_keys é OFF por padrão no SQLite e precisa ser ligado por conexão; sem isso as chaves do schema não valem.
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');

  const prepare = (sql) => {
    assertPortable(sql);
    return db.prepare(sql);
  };

  return {
    name: 'sqlite',
    /** Uma conexão só: a transação não precisa de conexão dedicada. */
    needsTransactionConnection: false,

    async all(sql, params) {
      return prepare(sql).all(...params);
    },
    async one(sql, params) {
      return prepare(sql).get(...params) ?? null;
    },
    async run(sql, params) {
      const r = prepare(sql).run(...params);
      return { changes: Number(r.changes) };
    },
    async execRaw(sql) {
      db.exec(sql);
    },
    async begin() {
      db.exec('BEGIN');
    },
    async commit() {
      db.exec('COMMIT');
    },
    async rollback() {
      db.exec('ROLLBACK');
    },

    async tableExists(table) {
      return Boolean(db.prepare("SELECT 1 AS yes FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
    },
    async columnExists(table, column) {
      return db.prepare(`PRAGMA table_info(${table})`).all().some((c) => c.name === column);
    },
    async tableColumns(table) {
      return db.prepare(`PRAGMA table_info(${table})`).all().map((c) => ({ name: c.name, notnull: Boolean(c.notnull) }));
    },

    async close() {
      db.close();
    },
  };
}

import { AsyncLocalStorage } from 'node:async_hooks';
import { config } from '../config.js';
import { describePostgres } from './driver-postgres.js';

/**
 * Porta única para o banco. Quem chama não sabe — nem precisa saber — se por baixo está SQLite ou PostgreSQL.
 *
 * Os drivers são carregados sob demanda: import estático de node:sqlite seria exigido mesmo numa instalação que
 * usa PostgreSQL, e uma dependência que a instalação não escolheu não deve impedir a partida.
 */
async function loadDriver() {
  if (config.dbDriver === 'postgres') return (await import('./driver-postgres.js')).createPostgresDriver();
  return (await import('./driver-sqlite.js')).createSqliteDriver();
}

let driver = null;

/** Abre a conexão (pool no PostgreSQL). Chamado na partida; a falha sobe para o modo degradado do server.js. */
export async function connect() {
  if (!driver) driver = await loadDriver();
  return driver;
}

export async function disconnect() {
  const d = driver;
  driver = null;
  await d?.close();
}

export const driverName = () => driver?.name ?? config.dbDriver;

/** Destino do banco para o log e para a resposta 503 — sem a senha. */
export const describeDatabase = () =>
  config.dbDriver === 'postgres' ? describePostgres(config.databaseUrl) : `SQLite — ${config.dbFile}`;

/**
 * Conexão da transação em curso. No PostgreSQL BEGIN/COMMIT valem para UMA conexão do pool; como o código chama
 * query/execute sem receber a conexão, é o contexto assíncrono que amarra cada consulta à transação certa. Sem isso,
 * duas requisições simultâneas embaralhariam transações.
 */
const context = new AsyncLocalStorage();
const target = () => {
  const current = context.getStore() ?? driver;
  if (!current) throw new Error('Banco de dados não conectado.');
  return current;
};

export const query = (sql, ...params) => target().all(sql, params);
export const queryOne = (sql, ...params) => target().one(sql, params);
export const execute = (sql, ...params) => target().run(sql, params);
export const execRaw = (sql) => target().execRaw(sql);

/** Executa `fn` numa transação, revertendo em caso de erro. Transação aninhada reaproveita a de fora. */
export async function transaction(fn) {
  if (context.getStore()) return fn();
  const connection = driver.needsTransactionConnection ? await driver.openConnection() : driver;
  await connection.begin();
  try {
    const result = await context.run(connection, () => fn());
    await connection.commit();
    return result;
  } catch (error) {
    try {
      await connection.rollback();
    } catch {
      // Se o ROLLBACK falhar, o erro original é o que importa.
    }
    throw error;
  } finally {
    await connection.release?.();
  }
}

/** Classes de trava: o par (classe, chave) identifica o recurso disputado. */
export const LOCK = {
  /** Número sequencial do pedido. */
  ORDER_NUMBER: 1,
};

/**
 * Serializa um trecho ler-decidir-gravar entre requisições simultâneas (pg_advisory_xact_lock, solto no COMMIT ou
 * ROLLBACK). Sem ela, dois pedidos criados ao mesmo tempo liam o mesmo maior número e o segundo falhava na
 * unicidade. No SQLite não faz nada: uma conexão só, as escritas já são serializadas.
 */
export async function lock(lockClass, key = 0) {
  if (driverName() !== 'postgres') return;
  if (!context.getStore()) throw new Error('lock() precisa estar dentro de transaction().');
  await context.getStore().execRaw(`SELECT pg_advisory_xact_lock(${Number(lockClass)}, ${Number(key)})`);
}

export const db = {
  tableExists: (t) => driver.tableExists(t),
  columnExists: (t, c) => driver.columnExists(t, c),
  /** Colunas da tabela no SQLite: [{ name, notnull }] (PRAGMA table_info). */
  tableColumns: (t) => driver.tableColumns(t),
  prepareSchema: () => driver.prepareSchema?.(),
};

/** Lista de valores para `IN (...)`: devolve os marcadores e os parâmetros. */
export function inList(values) {
  const list = [...new Set(values)].filter((v) => v !== null && v !== undefined);
  return { sql: list.length ? list.map(() => '?').join(', ') : 'NULL', params: list };
}

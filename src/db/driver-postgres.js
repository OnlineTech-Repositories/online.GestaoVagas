import pg from 'pg';
import { config } from '../config.js';
import { assertPortable, toPostgres } from './dialect.js';

/**
 * Driver PostgreSQL (produção).
 *
 * NUMERIC e BIGINT chegam do pg como texto, para não perder precisão. O sistema faz conta de valores em JavaScript
 * (em centavos inteiros, ver domain/money.js): sem a conversão aqui, `valor * 2` viraria concatenação de texto — o
 * tipo de erro que passa por um teste superficial e aparece no relatório de faturamento perdido.
 */
pg.types.setTypeParser(1700, (v) => (v === null ? null : Number(v)));
pg.types.setTypeParser(20, (v) => (v === null ? null : Number(v)));

function connectionOf(client) {
  const send = (sql, params) => {
    assertPortable(sql);
    return client.query(toPostgres(sql), params.map(toParam));
  };
  return {
    async all(sql, params) {
      return (await send(sql, params)).rows;
    },
    async one(sql, params) {
      return (await send(sql, params)).rows[0] ?? null;
    },
    async run(sql, params) {
      return { changes: (await send(sql, params)).rowCount ?? 0 };
    },
    async execRaw(sql) {
      await client.query(sql);
    },
    async begin() {
      await client.query('BEGIN');
    },
    async commit() {
      await client.query('COMMIT');
    },
    async rollback() {
      await client.query('ROLLBACK');
    },
  };
}

/** Uint8Array do node:sqlite e Buffer do pg são equivalentes para BYTEA; o resto passa como está. */
const toParam = (v) => (v instanceof Uint8Array && !Buffer.isBuffer(v) ? Buffer.from(v) : v);

export function createPostgresDriver() {
  if (!config.databaseUrl) {
    throw new Error(
      'DB_DRIVER=postgres exige a conexão em DATABASE_URL, no formato postgresql://usuario:senha@servidor:5432/banco ' +
        '(no Render, a Internal Database URL do banco, colada como está).',
    );
  }
  // Sem esta conferência, o pg resolve o texto inválido contra 'postgres://base' e o erro vira "ENOTFOUND base".
  if (!isPostgresUrl(config.databaseUrl)) {
    throw new Error(
      'A DATABASE_URL não está no formato postgresql://usuario:senha@servidor/banco. No Render, copie a Internal ' +
        'Database URL do banco e cole como está, sem aspas (ela começa com postgresql://)',
    );
  }

  const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    // Com sslmode=require na URL exigimos TLS e validamos o certificado; a URL interna do Render não usa TLS.
    ssl: config.postgresStrictSsl ? { rejectUnauthorized: true } : undefined,
    max: config.postgresMaxConnections,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    // O schema vai na abertura da conexão: um SET no evento 'connect' não é aguardado e disputa a primeira consulta.
    options: `-c search_path=${config.postgresSchema},public`,
  });

  // Um erro em conexão ociosa (o servidor derrubou a conexão) não pode derrubar o processo: o pool reconecta.
  pool.on('error', (error) => console.error('[postgres] erro em conexão ociosa:', error.message));

  return {
    name: 'postgres',
    /** BEGIN vale por conexão, não por pool: a transação precisa de conexão dedicada. */
    needsTransactionConnection: true,
    ...connectionOf(pool),

    async openConnection() {
      const client = await pool.connect();
      return { ...connectionOf(client), release: async () => client.release() };
    },

    async tableExists(table) {
      const r = await pool.query(
        'SELECT 1 FROM information_schema.tables WHERE table_schema = current_schema() AND table_name = $1', [table]);
      return r.rowCount > 0;
    },
    async columnExists(table, column) {
      const r = await pool.query(
        `SELECT 1 FROM information_schema.columns
          WHERE table_schema = current_schema() AND table_name = $1 AND column_name = $2`, [table, column]);
      return r.rowCount > 0;
    },
    async prepareSchema() {
      await pool.query(`CREATE SCHEMA IF NOT EXISTS "${config.postgresSchema}"`);
    },

    async close() {
      // Schema de teste é descartado: lixo acumulado deixaria a suíte mais lenta a cada execução.
      if (config.postgresTemporarySchema) {
        await pool.query(`DROP SCHEMA IF EXISTS "${config.postgresSchema}" CASCADE`).catch((e) =>
          console.error('[postgres] falha ao descartar o schema de teste:', e.message));
      }
      await pool.end();
    },
  };
}

/** URL postgres:// ou postgresql:// com servidor. Exportada para teste. */
export function isPostgresUrl(url) {
  try {
    const u = new URL(url);
    return /^postgres(ql)?:$/i.test(u.protocol) && u.hostname !== '';
  } catch {
    return false;
  }
}

/** Destino da conexão para o log e para a resposta 503 — nunca a senha. */
export function describePostgres(url) {
  try {
    const u = new URL(url);
    return `PostgreSQL — ${u.hostname}${u.port ? `:${u.port}` : ''}${u.pathname}`;
  } catch {
    return 'PostgreSQL — DATABASE_URL inválida';
  }
}

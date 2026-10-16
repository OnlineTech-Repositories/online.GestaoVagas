import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { db, driverName, execRaw } from './index.js';

/**
 * Migrações idempotentes, aplicadas na partida (no modelo da aplicação financeira): o push basta para publicar uma
 * mudança de estrutura, sem passo manual no banco.
 *
 *   1. ADDED_COLUMNS acrescenta colunas novas em tabelas que já existem (o CREATE TABLE IF NOT EXISTS não altera
 *      tabela existente). O DEFAULT de cada entrada é o que preserva o comportamento dos registros antigos.
 *   2. schema.sql cria o que falta: tabelas e índices.
 *   3. Gatilhos de proteção, na sintaxe de cada banco.
 *
 * Rodar várias vezes não causa efeito: cada passo confere o estado antes de agir.
 */

const here = dirname(fileURLToPath(import.meta.url));

/** [tabela, coluna, tipo com DEFAULT]. Acrescentar aqui E no schema.sql. */
export const ADDED_COLUMNS = [];

/** Banco da versão .NET: recusado aqui e no script de produção (production-script.js). */
export const DOTNET_DATABASE_ERROR =
  'Este banco foi criado pela versão .NET do sistema (tabela __ef_migrations_history). A versão Node usa outro '
  + 'schema: aponte DATABASE_URL para um banco novo e vazio.';

/** Tabelas de negócio: sem exclusão física (RN-26). A remoção é lógica (removed_at, withdrawn_at, inativo). */
export const NO_DELETE_TABLES = [
  'clients', 'contracts', 'contract_rates', 'orders', 'positions', 'terminations', 'pauses', 'group_entities',
  'job_roles', 'work_locations', 'pause_reasons', 'sla_targets', 'system_parameters', 'users', 'order_rh_analysts',
  'candidates', 'position_evidences', 'evidence_files',
];

export async function migrate() {
  const postgres = driverName() === 'postgres';
  if (postgres) await db.prepareSchema();

  // O banco da versão .NET (EF Core) tem tabelas com os mesmos nomes e colunas diferentes: o CREATE TABLE IF NOT
  // EXISTS passaria por cima em silêncio e cada tela quebraria num erro de coluna. Melhor não subir, dizendo o motivo.
  if (await db.tableExists('__ef_migrations_history')) throw new Error(DOTNET_DATABASE_ERROR);

  for (const [table, column, type] of ADDED_COLUMNS) {
    if ((await db.tableExists(table)) && !(await db.columnExists(table, column))) {
      await execRaw(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
      console.log(`[migração] coluna adicionada: ${table}.${column}`);
    }
  }

  await execRaw(readSchema(postgres));

  await execRaw(postgres ? postgresTriggers() : sqliteTriggers());
}

/**
 * schema.sql no dialeto do banco de destino (os comentários ficam como estão). Fim de linha normalizado: o Git no
 * Windows entrega o arquivo com CRLF num checkout novo, e o script de produção gerado sairia com fins de linha
 * misturados — diferente do gerado em outra máquina.
 */
export function readSchema(postgres) {
  const schema = readFileSync(join(here, 'schema.sql'), 'utf8').replace(/\r\n/g, '\n');
  if (!postgres) return schema;
  return schema.split('\n').map((line) => (line.trimStart().startsWith('--') ? line : line.replace(/\bBLOB\b/g, 'BYTEA')))
    .join('\n');
}

function sqliteTriggers() {
  const statements = [
    `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_update BEFORE UPDATE ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'audit_logs é somente inclusão: UPDATE não permitido'); END;`,
    `CREATE TRIGGER IF NOT EXISTS trg_audit_logs_no_delete BEFORE DELETE ON audit_logs
       BEGIN SELECT RAISE(ABORT, 'audit_logs é somente inclusão: DELETE não permitido'); END;`,
  ];
  for (const table of NO_DELETE_TABLES) {
    statements.push(`CREATE TRIGGER IF NOT EXISTS trg_${table}_prevent_delete BEFORE DELETE ON ${table}
       BEGIN SELECT RAISE(ABORT, 'Exclusão física não permitida em ${table} (RN-26)'); END;`);
  }
  return statements.join('\n');
}

export function postgresTriggers() {
  const statements = [
    `CREATE OR REPLACE FUNCTION fn_audit_logs_append_only() RETURNS trigger AS $$
     BEGIN RAISE EXCEPTION 'audit_logs é somente inclusão: % não permitido', TG_OP; END; $$ LANGUAGE plpgsql;`,
    `CREATE OR REPLACE TRIGGER trg_audit_logs_append_only BEFORE UPDATE OR DELETE OR TRUNCATE ON audit_logs
       FOR EACH STATEMENT EXECUTE FUNCTION fn_audit_logs_append_only();`,
    `CREATE OR REPLACE FUNCTION fn_prevent_delete() RETURNS trigger AS $$
     BEGIN RAISE EXCEPTION 'Exclusão física não permitida em % (RN-26)', TG_TABLE_NAME; END; $$ LANGUAGE plpgsql;`,
  ];
  // CREATE OR REPLACE TRIGGER existe a partir do PostgreSQL 14 (o Render oferece 16 ou mais novo).
  for (const table of NO_DELETE_TABLES) {
    statements.push(`CREATE OR REPLACE TRIGGER trg_${table}_prevent_delete BEFORE DELETE ON ${table}
       FOR EACH ROW EXECUTE FUNCTION fn_prevent_delete();`);
  }
  return statements.join('\n');
}

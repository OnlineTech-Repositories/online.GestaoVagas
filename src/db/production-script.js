import { ADDED_COLUMNS, DOTNET_DATABASE_ERROR, postgresTriggers, readSchema } from './migrations.js';

/**
 * Script SQL de criação e atualização do banco PostgreSQL, para executar no servidor sem depender da partida da
 * aplicação (producao/criar-banco-postgres.sql, gerado por `npm run script:producao`).
 *
 * Sai das MESMAS fontes que migrate() aplica na partida: schema.sql, ADDED_COLUMNS e os gatilhos. Um script escrito
 * à mão divergiria do schema na primeira coluna nova, e o banco criado por ele quebraria a tela que usa a coluna.
 * test/production-script.test.js recusa o arquivo desatualizado.
 *
 * Parâmetros padrão e o primeiro ADMIN ficam de fora de propósito: a senha precisa do hash da aplicação e toda
 * criação vai para o log de auditoria (seção 12 da SPEC). A aplicação os cria na primeira partida.
 */
export const PRODUCTION_SCRIPT_PATH = 'producao/criar-banco-postgres.sql';

export function buildProductionScript() {
  const literal = (text) => `'${text.replace(/'/g, "''")}'`;
  const addedColumns = ADDED_COLUMNS.length
    ? ADDED_COLUMNS.map(([table, column, type]) => `ALTER TABLE IF EXISTS ${table} ADD COLUMN IF NOT EXISTS ${column} ${type};`)
    : ['-- (nenhuma até aqui)'];

  return [
    '-- =================================================================================================================',
    '-- Controle de Vagas — criação e atualização do banco PostgreSQL',
    '--',
    '-- ARQUIVO GERADO por `npm run script:producao` a partir de src/db/schema.sql e src/db/migrations.js. NÃO EDITE À',
    '-- MÃO: altere as fontes e gere de novo (o teste test/production-script.test.js recusa o arquivo desatualizado).',
    '--',
    '-- Serve para banco novo e para banco existente: cada comando confere o estado antes de agir (IF NOT EXISTS,',
    '-- CREATE OR REPLACE), então rodar de novo não altera nem apaga dados. Tudo numa transação: se um comando falhar,',
    '-- nada é aplicado.',
    '--',
    '-- Executar (PostgreSQL 14 ou mais novo), no Render com a External Database URL do banco:',
    '--   psql "postgresql://usuario:senha@servidor/banco" -v ON_ERROR_STOP=1 -f producao/criar-banco-postgres.sql',
    '--',
    '-- Os parâmetros padrão e o primeiro ADMIN (ADMIN_EMAIL / ADMIN_SENHA) são criados pela aplicação na primeira',
    '-- partida, porque a senha precisa do hash da aplicação e a criação vai para o log de auditoria.',
    '-- =================================================================================================================',
    '',
    '-- O arquivo é UTF-8; sem isto, o psql no Windows o lê na codificação do console e grava as mensagens dos',
    '-- gatilhos com acentuação trocada.',
    "SET client_encoding = 'UTF8';",
    '-- Sem os avisos "already exists, skipping" de cada objeto que já existe (numa atualização, quase todos).',
    'SET client_min_messages = warning;',
    '',
    'BEGIN;',
    '',
    '-- Banco da versão .NET: tabelas com os mesmos nomes e colunas diferentes. Recusa em vez de misturar os dois.',
    'DO $$',
    'BEGIN',
    "  IF EXISTS (SELECT 1 FROM information_schema.tables",
    "             WHERE table_schema = current_schema() AND table_name = '__ef_migrations_history') THEN",
    `    RAISE EXCEPTION ${literal(DOTNET_DATABASE_ERROR)};`,
    '  END IF;',
    'END $$;',
    '',
    '-- ---- 1. Colunas acrescentadas a tabelas existentes -------------------------------------------------------------',
    ...addedColumns,
    '',
    '-- ---- 2. Tabelas e índices ------------------------------------------------------------------------------------',
    '',
    readSchema(true).trim(),
    '',
    '-- ---- 3. Gatilhos: log de auditoria somente inclusão e sem exclusão física (RN-26) ----------------------------',
    '',
    postgresTriggers(),
    '',
    'COMMIT;',
    '',
  ].join('\n');
}

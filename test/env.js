import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

/**
 * Ambiente dos testes. Precisa ser o PRIMEIRO import de cada arquivo de teste: config.js e o banco leem o ambiente
 * no momento da importação.
 *
 * Cada arquivo roda em processo próprio (node --test) e ganha um banco isolado, para os arquivos rodarem em paralelo:
 *   SQLite      um arquivo em diretório temporário;
 *   PostgreSQL  um SCHEMA com nome aleatório, descartado no fim (DB_DRIVER=postgres e DATABASE_URL explícitos).
 *
 * Recusa rodar no PostgreSQL sem DATABASE_URL explícita: a suíte cria e apaga tabelas, e apontar para o banco errado
 * seria irreversível.
 */
process.env.ENV_FILE = join(tmpdir(), 'controle-vagas-sem-env');
process.env.NODE_ENV = 'development';
process.env.ROTINAS_ATIVAS = '0';
// Vários usuários fazem login em sequência no mesmo arquivo de teste; o limite de 10 por minuto tem teste próprio.
process.env.LIMITE_LOGIN_POR_MINUTO ??= '1000';
delete process.env.RENDER;
delete process.env.WEBSITE_SITE_NAME;

if ((process.env.DB_DRIVER ?? '').toLowerCase() === 'postgres') {
  if (!process.env.DATABASE_URL) throw new Error('Testes no PostgreSQL exigem DATABASE_URL explícita.');
  process.env.POSTGRES_SCHEMA = `teste_${randomBytes(6).toString('hex')}`;
  process.env.POSTGRES_SCHEMA_TEMPORARIO = '1';
} else {
  process.env.DB_DRIVER = 'sqlite';
  delete process.env.DATABASE_URL;
  delete process.env.ConnectionStrings__Default;
  process.env.DB_FILE = join(mkdtempSync(join(tmpdir(), 'controle-vagas-')), 'teste.db');
}

/** Senha dos usuários de demonstração (gerada a cada execução; nunca fixa no código). */
export const DEMO_PASSWORD = `Demo-${randomBytes(6).toString('hex')}!A1`;
process.env.SENHA_DEMO = DEMO_PASSWORD;

import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { NO_DELETE_TABLES } from '../src/db/migrations.js';
import { buildProductionScript, PRODUCTION_SCRIPT_PATH } from '../src/db/production-script.js';

/** O script versionado precisa ser o que as fontes geram hoje: senão o banco do servidor fica atrás da aplicação. */
test('o script de produção está atualizado com o schema', () => {
  // Fim de linha normalizado: o Git no Windows pode trocar LF por CRLF no checkout.
  const versioned = readFileSync(join(config.root, PRODUCTION_SCRIPT_PATH), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(versioned, buildProductionScript(), 'Rode `npm run script:producao` e versione o arquivo gerado.');
});

test('o script de produção roda numa transação, recusa o banco .NET e traz os gatilhos', () => {
  const script = buildProductionScript();
  assert.match(script, /^BEGIN;$/m);
  assert.match(script, /^COMMIT;$/m);
  assert.match(script, /__ef_migrations_history/);
  const code = script.split('\n').filter((line) => !line.trimStart().startsWith('--')).join('\n');
  assert.doesNotMatch(code, /\bBLOB\b/, 'BLOB não existe no PostgreSQL: deve sair como BYTEA');
  assert.match(code, /content BYTEA NOT NULL/);
  assert.match(script, /trg_audit_logs_append_only/);
  for (const table of NO_DELETE_TABLES) assert.match(script, new RegExp(`trg_${table}_prevent_delete`));
});

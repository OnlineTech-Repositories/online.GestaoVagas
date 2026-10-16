import './env.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connectionStringToUrl } from '../src/config.js';
import { isPostgresUrl } from '../src/db/driver-postgres.js';

/**
 * Formatos de conexão que chegaram (ou podem chegar) pelo painel da plataforma. No primeiro deploy no Render, a
 * DATABASE_URL no formato Host=...;Database=... fez o pg procurar o servidor "base" (ENOTFOUND base).
 */
const URL_RENDER = 'postgresql://vagas_user:xyz@dpg-abc123-a/vagas';

test('URL da plataforma passa como está', () => {
  assert.equal(connectionStringToUrl(URL_RENDER), URL_RENDER);
  assert.equal(connectionStringToUrl(`  ${URL_RENDER}  `), URL_RENDER);
  assert.ok(isPostgresUrl(URL_RENDER));
});

test('aspas coladas junto com a URL são removidas', () => {
  assert.equal(connectionStringToUrl(`"${URL_RENDER}"`), URL_RENDER);
  assert.equal(connectionStringToUrl(`'${URL_RENDER}'`), URL_RENDER);
});

test('formato Host=...;Database=... vira URL, com a senha codificada', () => {
  const url = connectionStringToUrl('Host=dpg-abc123-a;Port=5432;Database=vagas;Username=vagas_user;Password=a@b');
  assert.equal(url, 'postgresql://vagas_user:a%40b@dpg-abc123-a:5432/vagas');
  assert.ok(isPostgresUrl(url));
  assert.equal(new URL(url).hostname, 'dpg-abc123-a');
});

test('formato não reconhecido volta como veio e é recusado pelo driver', () => {
  for (const valor of ['vagas_user:xyz@dpg-abc123-a/vagas', 'Database=vagas;Username=vagas_user', 'base']) {
    assert.equal(connectionStringToUrl(valor), valor);
    assert.equal(isPostgresUrl(valor), false, valor);
  }
  assert.equal(isPostgresUrl('mysql://u:p@servidor/banco'), false);
});

test('variável ausente ou vazia não define conexão', () => {
  assert.equal(connectionStringToUrl(undefined), '');
  assert.equal(connectionStringToUrl('   '), '');
  assert.equal(connectionStringToUrl('""'), '');
});

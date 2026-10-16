import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Nenhum segredo nos arquivos versionados. O repositório é público: em 16/10/2026 o usuário SMTP real do MailerSend
 * entrou num teste (como exemplo do formato do remetente) e o robô do MailerSend o achou no GitHub no mesmo dia.
 * Exemplos em teste e documentação usam sempre valores fictícios.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PATTERNS = [
  ['usuário SMTP do MailerSend', /MS_[A-Za-z0-9]{6,}@[A-Za-z0-9.-]+\.[a-z]{2,}/],
  ['chave da API do MailerSend', /mlsn\.[A-Za-z0-9]{20,}/],
  ['chave da API do SendGrid', /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/],
  ['URL de banco do Render com senha', /postgres(ql)?:\/\/[^:\s/]+:[^@\s/]+@dpg-[a-z0-9]+-a(\.[a-z0-9-]+)*\.render\.com/],
];

function trackedFiles() {
  try {
    return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
  } catch {
    return null; // fora de um checkout Git (ex.: pacote publicado): não há o que conferir
  }
}

test('nenhum segredo nos arquivos versionados', (t) => {
  const files = trackedFiles();
  if (!files) return t.skip('fora de um repositório Git');
  const found = [];
  for (const file of files.filter((f) => !/\.(png|jpe?g|gif|ico|pdf|woff2?)$/i.test(f))) {
    let text;
    try {
      text = readFileSync(join(root, file), 'utf8');
    } catch {
      continue; // removido da pasta e ainda não do índice
    }
    for (const [name, pattern] of PATTERNS) {
      const match = pattern.exec(text);
      if (match) found.push(`${file}: ${name} (${match[0].slice(0, 12)}…)`);
    }
  }
  assert.deepEqual(found, [], `Segredo em arquivo versionado — troque por um valor fictício:\n${found.join('\n')}`);
});

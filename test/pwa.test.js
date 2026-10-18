import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * PWA (aplicativo instalável): o manifesto atende aos critérios de instalação do Chrome e cada ícone declarado existe,
 * é PNG e tem o tamanho que o manifesto diz. Sem o manifesto, o celular criava um atalho do navegador (com o selo do
 * Chrome) em vez de instalar o aplicativo. Os ícones saem de public/img/logo.png por scripts/generate-pwa-icons.ps1.
 */

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');
const manifest = JSON.parse(readFileSync(join(publicDir, 'manifest.json'), 'utf8'));

/** Largura e altura lidas do cabeçalho IHDR do PNG. */
function pngSize(path) {
  const buffer = readFileSync(path);
  assert.equal(buffer.subarray(0, 8).toString('hex'), '89504e470d0a1a0a', `${path} não é PNG`);
  return `${buffer.readUInt32BE(16)}x${buffer.readUInt32BE(20)}`;
}

test('manifesto atende aos critérios de instalação do Chrome', () => {
  assert.ok(manifest.name && manifest.short_name);
  assert.ok(manifest.short_name.length <= 18, 'nome curto cabe sob o ícone na tela inicial');
  assert.equal(manifest.start_url, '/');
  assert.equal(manifest.display, 'standalone');
  assert.ok(!manifest.prefer_related_applications);
  const sizes = manifest.icons.map((i) => i.sizes);
  assert.ok(sizes.includes('192x192') && sizes.includes('512x512'), 'ícones de 192 e 512 px');
  assert.ok(manifest.icons.some((i) => i.purpose === 'maskable'), 'ícone maskable para o recorte do Android');
});

test('cada ícone do manifesto existe, é PNG e tem o tamanho declarado', () => {
  for (const icon of manifest.icons) {
    assert.equal(pngSize(join(publicDir, icon.src)), icon.sizes, icon.src);
    assert.equal(icon.type, 'image/png');
  }
});

test('o index.html aponta o manifesto, o favicon e o ícone do iPhone, e os arquivos existem', () => {
  const html = readFileSync(join(publicDir, 'index.html'), 'utf8');
  assert.match(html, /<link rel="manifest" href="\/manifest\.json" \/>/);
  assert.match(html, /<meta name="theme-color" content="#[0-9a-f]{6}" \/>/i);
  assert.equal(pngSize(join(publicDir, /rel="icon"[^>]*href="([^"]+)"/.exec(html)[1])), '32x32');
  assert.equal(pngSize(join(publicDir, /rel="apple-touch-icon" href="([^"]+)"/.exec(html)[1])), '180x180');
});

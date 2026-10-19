import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { deflateRawSync } from 'node:zlib';
import { config } from '../src/config.js';
import { query } from '../src/db/index.js';
import { BusinessRuleError } from '../src/domain/errors.js';
import { readXlsx } from '../src/services/xlsx-reader.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Correções da revisão de segurança de 19/10/2026 (itens A1, M3 e M4 do relatório):
 *   A1  o IP do usuário atrás de dois proxies (Cloudflare + balanceador do Render), sem aceitar IP forjado;
 *   M3  trocar a própria senha encerra as outras sessões;
 *   M4  planilha com tamanhos falsos no índice do ZIP é recusada sem se expandir na memória.
 */

let server;
const root = fileURLToPath(new URL('..', import.meta.url));

before(async () => {
  // Como no Render: a aplicação confia em dois proxies (o createApp lê a configuração ao montar o Express).
  config.trustProxy = true;
  config.proxyHops = 2;
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

test('A1: o IP gravado é o do usuário, contado a partir dos proxies; o que o cliente forja no cabeçalho é ignorado', async () => {
  const c = new Client(server.url);
  await c.get('/api/saude');
  // O cliente mandou "10.9.9.9" forjado; a Cloudflare acrescentou o IP real (203.0.113.7) e o balanceador, o da borda.
  const r = await c.request('POST', '/api/auth/login', { email: 'dp@demo.local', password: DEMO_PASSWORD },
    { headers: { 'X-Forwarded-For': '10.9.9.9, 203.0.113.7, 198.51.100.20' } });
  assert.equal(r.status, 200);
  const sessions = await query("SELECT s.ip FROM sessions s JOIN users u ON u.id = s.user_id WHERE u.email = 'dp@demo.local'");
  assert.deepEqual(sessions.map((s) => s.ip), ['203.0.113.7']);
});

test('A1: padrões no Render — dois proxies e 60 logins por minuto por IP; fora da plataforma, nenhum proxy', () => {
  // Processo à parte: o config lê o ambiente na importação, e os testes sobem com o limite de login alto (env.js).
  const read = (extra) => {
    const env = { ...process.env, ENV_FILE: 'nao-existe', ...extra };
    delete env.LIMITE_LOGIN_POR_MINUTO;
    delete env.PROXY_SALTOS;
    delete env.PROXY_CONFIAVEL;
    if (!extra.RENDER) delete env.RENDER;
    const code = "const { config } = await import('./src/config.js');"
      + 'console.log(JSON.stringify([config.trustProxy, config.proxyHops, config.loginRateLimitPerMinute, config.maxLoginAttempts]))';
    return JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e', code], { env, cwd: root }).toString());
  };
  assert.deepEqual(read({ RENDER: '1' }), [true, 2, 60, 5]);
  assert.deepEqual(read({}).slice(0, 2), [false, 1]);
});

test('M3: trocar a própria senha encerra as outras sessões e mantém a atual', async () => {
  const first = new Client(server.url);
  const second = new Client(server.url);
  assert.equal((await first.login('controladoria@demo.local', DEMO_PASSWORD)).status, 200);
  assert.equal((await second.login('controladoria@demo.local', DEMO_PASSWORD)).status, 200);

  const changed = await first.post('/api/auth/change-password', { currentPassword: DEMO_PASSWORD, newPassword: 'Nova#Senha2026' });
  assert.equal(changed.status, 200);
  assert.equal((await first.get('/api/positions')).status, 200, 'a sessão que trocou a senha continua');
  assert.equal((await second.get('/api/positions')).status, 401, 'a outra sessão foi encerrada');
});

/** ZIP com entradas .xml cujo tamanho descompactado declarado (1 byte) é falso. */
function lyingZip(entries, realSize) {
  const compressed = deflateRawSync(Buffer.alloc(realSize));
  const local = [];
  const central = [];
  let offset = 0;
  for (let i = 0; i < entries; i += 1) {
    const name = Buffer.from(`xl/x${i}.xml`);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(8, 8); lh.writeUInt32LE(compressed.length, 18);
    lh.writeUInt32LE(1, 22); lh.writeUInt16LE(name.length, 26);
    local.push(lh, name, compressed);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(8, 10); ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(1, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + compressed.length;
  }
  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries, 8); end.writeUInt16LE(entries, 10);
  end.writeUInt32LE(directory.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, directory, end]);
}

test('M4: ZIP com tamanho declarado falso é recusado pelo tamanho real, sem se expandir na memória', () => {
  const bomb = lyingZip(12, 15 * 1024 * 1024); // ~180 MB reais, declarados como 12 bytes
  const before = process.memoryUsage().rss;
  assert.throws(() => readXlsx(bomb), (e) => e instanceof BusinessRuleError && /grande demais/.test(e.message));
  const grown = (process.memoryUsage().rss - before) / 1048576;
  assert.ok(grown < 80, `memória cresceu ${Math.round(grown)} MB`);

  assert.throws(() => readXlsx(lyingZip(501, 10)), (e) => e instanceof BusinessRuleError && /entradas demais/.test(e.message));
});

test('M4: pela API, a planilha manipulada recebe a mensagem de arquivo inválido', async () => {
  const c = new Client(server.url);
  assert.equal((await c.login('gestor.rh@demo.local', DEMO_PASSWORD)).status, 200);
  const order = (await c.get('/api/dashboard/rh')).data.orders.find((o) => o.approvalStatus === 'APPROVED');
  const form = new FormData();
  form.append('file', new Blob([lyingZip(12, 15 * 1024 * 1024)]), 'bomba.xlsx');
  const r = await c.request('POST', `/api/orders/${order.orderId}/candidates-import/preview`, undefined, { form });
  assert.equal(r.status, 422);
  assert.match(r.data.detail, /grande demais/);
});

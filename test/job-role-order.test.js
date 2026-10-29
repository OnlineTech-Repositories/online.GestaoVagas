import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { execute, queryOne } from '../src/db/index.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Cargo novo cadastrado pelo Comercial durante a criação do pedido (melhoria de 29/10/2026): só cadastrar (editar e
 * inativar seguem com o Administrador); nome igual, ignorando maiúsculas e acentos, é recusado; parecido pede
 * confirmação.
 */

let server;
const clients = new Map();

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function as(user) {
  if (clients.has(user)) return clients.get(user);
  const c = new Client(server.url);
  assert.equal((await c.login(`${user}@demo.local`, DEMO_PASSWORD)).status, 200, `login de ${user}`);
  clients.set(user, c);
  return c;
}

const PATH = '/api/orders/job-roles';

test('o Comercial cadastra o cargo pelo pedido; editar e inativar continuam com o Administrador', async () => {
  const comercial = await as('comercial');
  assert.equal((await (await as('rh')).post(PATH, { name: 'Repositor Noturno' })).status, 403);
  assert.ok((await comercial.post(PATH, { name: '  ' })).data.campos?.name, 'nome obrigatório');

  const created = await comercial.post(PATH, { name: '  Repositor   Noturno ' });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.deepEqual([created.data.name, created.data.active], ['Repositor Noturno', true]);
  assert.ok((await comercial.get('/api/catalogs/job-roles')).data.some((j) => j.id === created.data.id), 'entra no catálogo');
  const log = await queryOne(
    "SELECT a.user_id FROM audit_logs a WHERE a.entity_id = ? AND a.action = 'CREATE_JOB_ROLE_FROM_ORDER' LIMIT 1", created.data.id);
  assert.equal(log.user_id, (await queryOne("SELECT id FROM users WHERE email = 'comercial@demo.local'")).id, 'quem cadastrou');

  // Editar e inativar: só o Administrador, em Cadastros auxiliares.
  assert.equal((await comercial.put(`/api/catalogs/job-roles/${created.data.id}`, { name: 'Outro', active: false })).status, 403);
  assert.equal((await comercial.post('/api/catalogs/job-roles', { name: 'Outro cargo' })).status, 403);
});

test('duplicidade: igual sem acento ou maiúscula é recusado; parecido pede confirmação', async () => {
  const comercial = await as('comercial');
  const same = await comercial.post(PATH, { name: 'OPERADOR DE EMPILHADEIRA' });
  assert.equal(same.status, 422);
  assert.match(same.data.campos?.name ?? '', /Já existe o cargo "Operador de empilhadeira": escolha-o na lista/);

  await comercial.post(PATH, { name: 'Conferente Fiscal' });
  await execute("UPDATE job_roles SET active = 0 WHERE name = 'Conferente Fiscal'");
  assert.match((await comercial.post(PATH, { name: 'conferente fiscal' })).data.campos?.name ?? '', /inativo: peça ao administrador/);

  const similar = await comercial.request('POST', PATH, { name: 'Estoquista Líder' }, { confirm: false });
  assert.equal(similar.status, 422);
  assert.deepEqual(similar.data.avisos.map((a) => a.tipo), ['DUPLICATE']);
  assert.match(similar.data.avisos[0].mensagem, /"Estoquista"/);
  assert.equal(await queryOne("SELECT id FROM job_roles WHERE name = 'Estoquista Líder'"), null, 'nada gravado sem confirmar');
  const confirmed = await comercial.post(PATH, { name: 'Estoquista Líder' });
  assert.equal(confirmed.status, 201, JSON.stringify(confirmed.data));
});

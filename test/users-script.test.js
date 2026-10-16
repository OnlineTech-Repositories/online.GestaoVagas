import './env.js';
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { config } from '../src/config.js';
import { connect, disconnect, query, queryOne } from '../src/db/index.js';
import { verifyPassword } from '../src/services/auth.js';

/**
 * scripts/users.js executado como o operador faria (processo próprio), no banco isolado deste arquivo de teste. No
 * PostgreSQL o schema de teste é descartado ao desconectar: o filho não pode herdar isso, senão apagaria o schema ao
 * terminar cada comando (quem descarta é este processo, no fim).
 */
function run(...args) {
  const env = { ...process.env, POSTGRES_SCHEMA_TEMPORARIO: '' };
  const r = spawnSync(process.execPath, [join(config.root, 'scripts', 'users.js'), ...args], { env, encoding: 'utf8' });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

after(() => disconnect());

test('cria usuário com senha provisória gerada, que funciona no login e exige troca', async () => {
  const r = run('criar', '--nome', 'Maria Silva', '--email', 'Maria@Empresa.com.br', '--perfis', 'nacc, dp');
  assert.equal(r.code, 0, r.out);
  const password = r.out.match(/Senha provisória .*: (\S+)/)?.[1];
  assert.ok(password, r.out);

  await connect();
  const user = await queryOne('SELECT * FROM users WHERE email = ?', 'maria@empresa.com.br');
  assert.ok(verifyPassword(password, user.password_hash, user.password_salt));
  assert.equal(Number(user.must_change_password), 1);
  const roles = (await query('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', user.id)).map((x) => x.role);
  assert.deepEqual(roles, ['DP', 'NACC']);
  const audit = await query("SELECT * FROM audit_logs WHERE entity_id = ? AND action = 'CREATE_USER'", user.id);
  assert.ok(audit.length > 0 && audit.every((a) => a.user_id === null && a.ip === 'script'));
});

test('aceita a senha provisória informada, se atender à política', async () => {
  const r = run('criar', '--nome', 'João Souza', '--email', 'joao@empresa.com.br', '--perfis', 'ADMIN', '--senha', 'Inicial-2026!');
  assert.equal(r.code, 0, r.out);
  assert.doesNotMatch(r.out, /Senha provisória/);
  const user = await queryOne('SELECT * FROM users WHERE email = ?', 'joao@empresa.com.br');
  assert.ok(verifyPassword('Inicial-2026!', user.password_hash, user.password_salt));
});

test('recusa e-mail repetido, perfil inválido, senha fraca e dados faltando', () => {
  const casos = [
    [['criar', '--nome', 'Outra', '--email', 'maria@empresa.com.br', '--perfis', 'DP'], /Já existe um usuário/],
    [['criar', '--nome', 'Ana', '--email', 'ana@empresa.com.br', '--perfis', 'DIRETOR'], /Perfil inválido/],
    [['criar', '--nome', 'Ana', '--email', 'ana@empresa.com.br', '--perfis', 'DP', '--senha', 'fraca'], /pelo menos 8 caracteres/],
    [['criar', '--nome', 'Ana', '--email', 'ana@empresa.com.br'], /Informe --perfis/],
  ];
  for (const [args, message] of casos) {
    const r = run(...args);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, message);
  }
});

test('lista os usuários com perfis e a troca de senha pendente', () => {
  const r = run('listar');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /Maria Silva <maria@empresa\.com\.br> — DP, NACC \(troca de senha pendente\)/);
  assert.doesNotMatch(r.out, /ana@empresa/);
});

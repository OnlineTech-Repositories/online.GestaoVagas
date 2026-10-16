import crypto from 'node:crypto';
import { parseArgs } from 'node:util';
import { assertSafeConfig } from '../src/config.js';
import { connect, describeDatabase, disconnect, query } from '../src/db/index.js';
import { migrate } from '../src/db/migrations.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { ALL_ROLES, Roles } from '../src/domain/enums.js';
import { createUser } from '../src/services/users.js';

/**
 * Criação de usuários (login e senha) pela linha de comando — para a carga inicial (seção 13 da SPEC) e para quando
 * não há ADMIN com acesso à tela.
 *
 * Usa o MESMO serviço da tela de Administração (createUser): política de senha, e-mail único, perfis válidos, troca
 * obrigatória no primeiro acesso e registro no log de auditoria. Um INSERT direto no banco pularia tudo isso — e a
 * senha precisa do hash scrypt da aplicação, que SQL nenhum produz.
 *
 *   npm run usuarios -- criar --nome "Maria Silva" --email maria@empresa.com.br --perfis NACC,DP
 *   npm run usuarios -- listar
 *
 * O banco é o da configuração (DATABASE_URL no ambiente ou no .env); o destino aparece antes de qualquer gravação.
 */

const HELP = `
Uso:
  npm run usuarios -- criar --nome "<nome>" --email <e-mail> --perfis <PERFIL,PERFIL> [--senha "<senha provisória>"]
  npm run usuarios -- listar

Sem --senha, uma senha provisória forte é gerada e mostrada uma única vez.
A senha é sempre provisória: o usuário define a dele no primeiro acesso.
Política: 8+ caracteres, com letra maiúscula, número e caractere especial.

Perfis: ${ALL_ROLES.join(', ')}

Banco: DATABASE_URL (no ambiente ou no .env). Para o banco do Render, use a External Database URL.
`;

/** Senha provisória que sempre atende à política (seção 12): maiúscula, minúscula, número e especial garantidos. */
function generatePassword() {
  return `Vg-${crypto.randomBytes(9).toString('base64url')}#7A`;
}

async function create(values) {
  const missing = ['nome', 'email', 'perfis'].filter((k) => !values[k]);
  if (missing.length) throw new Error(`Informe ${missing.map((k) => `--${k}`).join(', ')}.${HELP}`);

  const generated = !values.senha;
  const password = values.senha || generatePassword();
  const roles = values.perfis.split(',').map((r) => r.trim()).filter(Boolean);

  // Ator do log de auditoria: sem usuário (aparece como "Sistema"), com a origem identificada.
  const ctx = { user: { id: null, roles: [Roles.Admin] }, ip: 'script', uow: new UnitOfWork({ userId: null, ip: 'script' }) };
  const user = await createUser(ctx, { name: values.nome, email: values.email, roles, temporaryPassword: password });

  console.log(`  Usuário criado: ${user.name} <${user.email}>`);
  console.log(`  Perfis:         ${user.roles.join(', ')}`);
  if (generated) console.log(`  Senha provisória (anote agora, não será mostrada de novo): ${password}`);
  console.log('  No primeiro acesso, o sistema exige a troca da senha.');
}

async function list() {
  const users = await query('SELECT id, name, email, active, must_change_password FROM users');
  const roles = await query('SELECT user_id, role FROM user_roles');
  if (!users.length) return console.log('  Nenhum usuário cadastrado.');
  users.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  for (const u of users) {
    const own = roles.filter((r) => r.user_id === u.id).map((r) => r.role).sort().join(', ');
    const flags = [!Number(u.active) && 'INATIVO', Number(u.must_change_password) && 'troca de senha pendente'].filter(Boolean);
    console.log(`  ${u.name} <${u.email}> — ${own || 'sem perfil'}${flags.length ? ` (${flags.join('; ')})` : ''}`);
  }
}

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: { nome: { type: 'string' }, email: { type: 'string' }, perfis: { type: 'string' }, senha: { type: 'string' } },
  });
  const command = positionals[0];
  if (!['criar', 'listar'].includes(command)) {
    console.log(HELP);
    return command ? 1 : 0;
  }

  assertSafeConfig();
  await connect();
  console.log(`\n  Banco: ${describeDatabase()}\n`);
  try {
    // Banco novo: cria a estrutura antes, como a aplicação faria na partida.
    await migrate();
    if (command === 'criar') await create(values);
    else await list();
  } finally {
    await disconnect();
  }
  console.log('');
  return 0;
}

main().then((code) => process.exit(code), (error) => {
  console.error(`\n  ERRO: ${error.message}\n`);
  process.exit(1);
});

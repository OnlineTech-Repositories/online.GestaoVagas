import { randomInt } from 'node:crypto';
import { execute, query, queryOne, transaction } from '../db/index.js';
import { entity } from '../db/model.js';
import { activeUsersByRoles } from '../db/repository.js';
import { utcNow } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import { ALL_ROLES, Roles } from '../domain/enums.js';
import { DateGuard, Permissions } from '../domain/guards.js';
import { hashPassword, passwordErrors, verifyPassword } from './auth.js';
import { Input } from './input.js';

/** Gestão de usuários e perfis (ADMIN) e troca da própria senha. */

async function rolesOf(userId) {
  return (await query('SELECT role FROM user_roles WHERE user_id = ? ORDER BY role', userId)).map((r) => r.role);
}

async function toDto(u) {
  return {
    id: u.id,
    name: u.name,
    email: u.email,
    roles: await rolesOf(u.id),
    active: u.active,
    mustChangePassword: u.mustChangePassword,
    lockedOut: Boolean(u.lockoutEnd && u.lockoutEnd > utcNow()),
  };
}

export async function listUsers(ctx) {
  Permissions.require(ctx.user, Roles.Admin);
  const users = ctx.uow.loadAll('User', await query('SELECT * FROM users'));
  users.sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'));
  return Promise.all(users.map(toDto));
}

/** Usuários ativos de um perfil (ex.: responsável comercial do contrato, analistas de RH). */
export async function listByRole(ctx, role) {
  if (!ALL_ROLES.includes(role)) throw new BusinessRuleError('Perfil inválido.', 'roles');
  return (await activeUsersByRoles([role]))
    .sort((a, b) => a.name.localeCompare(b.name, 'pt-BR'))
    .map((u) => ({ id: u.id, name: u.name }));
}

export async function createUser(ctx, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), 'Informe o nome.', 'name');
  const email = normalizeEmail(input.text('email'));
  const roles = validateRoles(input.raw('roles'));
  const { password, generated } = readTemporaryPassword(input);
  input.done();
  await ensureEmailFree(email, null);

  const { hash, salt } = hashPassword(password);
  const user = ctx.uow.add(entity('User', {
    name, email, passwordHash: hash, passwordSalt: salt, active: true, mustChangePassword: true, failedAttempts: 0,
    lockoutEnd: null,
  }));
  // Usuário e perfis na mesma transação: sem perfil, o usuário criado não conseguiria fazer nada.
  await transaction(async () => {
    await ctx.uow.save({ action: 'CREATE_USER' });
    await setRoles(ctx, user.id, roles, 'CREATE_USER');
  });
  // A senha gerada volta só nesta resposta, para ser mostrada uma única vez: no banco fica apenas o hash.
  return { ...(await toDto(user)), temporaryPassword: generated ? password : null };
}

export async function updateUser(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const user = await load(ctx, id);
  const input = new Input(body);
  const name = DateGuard.requireText(input.text('name'), 'Informe o nome.', 'name');
  const email = normalizeEmail(input.text('email'));
  const roles = validateRoles(input.raw('roles'));
  const active = input.bool('active', true);
  input.done();
  if (id === ctx.user.id && (!active || !roles.includes(Roles.Admin))) {
    throw new BusinessRuleError('Você não pode desativar o próprio usuário nem remover o seu perfil de administrador.');
  }
  await ensureEmailFree(email, id);
  Object.assign(user, { name, email, active });
  await transaction(async () => {
    await ctx.uow.save({ action: 'UPDATE_USER' });
    await setRoles(ctx, id, roles, 'UPDATE_USER');
  });
  // Perfis e inativação valem na próxima requisição: a sessão relê usuário e perfis do banco a cada chamada.
  return toDto(user);
}

/**
 * Redefinição pelo ADMIN: senha gerada (padrão) ou definida (com confirmação). Encerra as sessões do usuário, exige
 * a troca no próximo acesso e registra no histórico quem redefiniu, de quem e quando — nunca a senha nem o hash.
 * A senha gerada volta só nesta resposta (a rota responde sem cache), para ser mostrada uma única vez.
 */
export async function resetPassword(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const user = await load(ctx, id);
  const input = new Input(body);
  const { password, generated } = readTemporaryPassword(input);
  input.done();
  const { hash, salt } = hashPassword(password);
  Object.assign(user, { passwordHash: hash, passwordSalt: salt, mustChangePassword: true, lockoutEnd: null, failedAttempts: 0 });
  // O hash fica fora do log de auditoria (IGNORED_FIELDS): o registro da redefinição é explícito, sem a senha.
  ctx.uow.log({
    entity: 'User', entityId: user.id, action: 'RESET_PASSWORD', field: 'Password',
    newValue: generated ? 'Senha provisória gerada automaticamente' : 'Senha provisória definida pelo administrador',
  });
  await ctx.uow.save({ action: 'RESET_PASSWORD' });
  // Senha redefinida pelo administrador: as sessões abertas com a senha antiga deixam de valer.
  await execute('DELETE FROM sessions WHERE user_id = ?', id);
  return { userName: user.name, mustChangePassword: true, temporaryPassword: generated ? password : null };
}

// ---------------------------------------------------------------- senha provisória

/** Sem caracteres que se confundem ao ditar ou ler (0/O, 1/l/I) e com especiais fáceis de digitar. */
const PASSWORD_SETS = ['ABCDEFGHJKLMNPQRSTUVWXYZ', 'abcdefghijkmnpqrstuvwxyz', '23456789', '!@#$%&*?-+'];
export const GENERATED_PASSWORD_LENGTH = 12;

/** 12 caracteres aleatórios (crypto), com ao menos uma maiúscula, minúscula, número e especial: atende a política. */
export function generateTemporaryPassword() {
  const all = PASSWORD_SETS.join('');
  const chars = PASSWORD_SETS.map((set) => set[randomInt(set.length)]);
  while (chars.length < GENERATED_PASSWORD_LENGTH) chars.push(all[randomInt(all.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}

/**
 * Modo da senha provisória: GENERATE (padrão) gera; MANUAL exige a senha e a confirmação iguais, na política. Sem o
 * modo e com a senha informada (script de usuários, chamadas antigas), vale a senha informada.
 */
function readTemporaryPassword(input) {
  const mode = input.option('passwordMode', { GENERATE: 'GENERATE', MANUAL: 'MANUAL' }, { required: false });
  const typed = input.text('temporaryPassword') ?? '';
  const confirmation = input.text('passwordConfirmation');
  if (mode === 'GENERATE' || (!mode && !typed)) return { password: generateTemporaryPassword(), generated: true };
  checkPassword(typed, 'temporaryPassword');
  if (mode === 'MANUAL' && confirmation !== typed) {
    throw new BusinessRuleError('A confirmação não confere com a senha informada.', 'passwordConfirmation');
  }
  return { password: typed, generated: false };
}

export async function changeOwnPassword(ctx, body) {
  if (!ctx.user?.id) throw new ForbiddenError();
  const user = await load(ctx, ctx.user.id);
  const input = new Input(body);
  const current = input.text('currentPassword') ?? '';
  const next = input.text('newPassword') ?? '';
  if (!verifyPassword(current, user.passwordHash, user.passwordSalt)) {
    throw new BusinessRuleError('A senha atual está incorreta.', 'currentPassword');
  }
  checkPassword(next, 'newPassword');
  const { hash, salt } = hashPassword(next);
  Object.assign(user, { passwordHash: hash, passwordSalt: salt, mustChangePassword: false });
  await ctx.uow.save({ action: 'CHANGE_PASSWORD' });
}

/**
 * Primeiro ADMIN, criado na partida quando não há nenhum. As credenciais vêm de configuração segura (variáveis de
 * ambiente); a senha é provisória e precisa ser trocada no primeiro acesso.
 */
export async function ensureFirstAdmin(uow, { name, email, password }) {
  const existing = await queryOne(`SELECT 1 AS yes FROM user_roles WHERE role = '${Roles.Admin}' LIMIT 1`);
  if (existing) return null;
  if (!email || !password) {
    console.warn('[partida] Nenhum administrador cadastrado. Defina ADMIN_EMAIL e ADMIN_SENHA para criar o primeiro ADMIN.');
    return null;
  }
  const errors = passwordErrors(password);
  if (errors.length) throw new Error(`Falha ao criar o ADMIN inicial: ${errors.join(' ')}`);
  const { hash, salt } = hashPassword(password);
  const admin = uow.add(entity('User', {
    name, email: email.trim().toLowerCase(), passwordHash: hash, passwordSalt: salt, active: true,
    mustChangePassword: true, failedAttempts: 0, lockoutEnd: null,
  }));
  await transaction(async () => {
    await uow.save({ action: 'SEED' });
    await execute('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', admin.id, Roles.Admin);
  });
  console.log(`[partida] Administrador inicial criado: ${admin.email}. A senha deverá ser trocada no primeiro acesso.`);
  return admin;
}

// ---------------------------------------------------------------- auxiliares

async function load(ctx, id) {
  const user = ctx.uow.load('User', await queryOne('SELECT * FROM users WHERE id = ?', id));
  if (!user) throw new NotFoundError('Usuário não encontrado.');
  return user;
}

/** Perfis: troca a lista e registra no log cada perfil incluído ou retirado. */
async function setRoles(ctx, userId, roles, action) {
  const current = await rolesOf(userId);
  for (const role of current.filter((r) => !roles.includes(r))) {
    await execute('DELETE FROM user_roles WHERE user_id = ? AND role = ?', userId, role);
    ctx.uow.log({ entity: 'UserRole', entityId: userId, action, oldValue: role });
  }
  for (const role of roles.filter((r) => !current.includes(r))) {
    await execute('INSERT INTO user_roles (user_id, role) VALUES (?, ?)', userId, role);
    ctx.uow.log({ entity: 'UserRole', entityId: userId, action, newValue: role });
  }
  await ctx.uow.save({ action });
}

function normalizeEmail(raw) {
  const email = DateGuard.requireText(raw, 'Informe o e-mail.', 'email').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+$/.test(email)) throw new BusinessRuleError(`O e-mail '${email}' é inválido.`, 'email');
  return email;
}

async function ensureEmailFree(email, exceptId) {
  const row = await queryOne('SELECT id FROM users WHERE email = ?', email);
  if (row && row.id !== exceptId) throw new BusinessRuleError(`Já existe um usuário com o e-mail '${email}'.`, 'email');
}

function checkPassword(password, field) {
  const errors = passwordErrors(password);
  if (errors.length) throw new BusinessRuleError(errors.join(' '), field);
}

function validateRoles(raw) {
  const list = [...new Set((Array.isArray(raw) ? raw : []).map((r) => String(r).trim().toUpperCase()))];
  if (!list.length) throw new BusinessRuleError('Selecione ao menos um perfil.', 'roles');
  if (list.some((r) => !ALL_ROLES.includes(r))) throw new BusinessRuleError('Perfil inválido.', 'roles');
  return list;
}

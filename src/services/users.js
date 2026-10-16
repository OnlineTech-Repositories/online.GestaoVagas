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
  const password = input.text('temporaryPassword') ?? '';
  input.done();
  await ensureEmailFree(email, null);
  checkPassword(password, 'temporaryPassword');

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
  return toDto(user);
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

export async function resetPassword(ctx, id, body) {
  Permissions.require(ctx.user, Roles.Admin);
  const user = await load(ctx, id);
  const password = new Input(body).text('temporaryPassword') ?? '';
  checkPassword(password, 'temporaryPassword');
  const { hash, salt } = hashPassword(password);
  Object.assign(user, { passwordHash: hash, passwordSalt: salt, mustChangePassword: true, lockoutEnd: null, failedAttempts: 0 });
  await ctx.uow.save({ action: 'RESET_PASSWORD' });
  // Senha redefinida pelo administrador: as sessões abertas com a senha antiga deixam de valer.
  await execute('DELETE FROM sessions WHERE user_id = ?', id);
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

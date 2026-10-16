import crypto from 'node:crypto';
import { config } from '../config.js';
import { execute, query, queryOne } from '../db/index.js';
import { utcNow } from '../domain/dates.js';
import { ParameterKeys, SEE_AGGREGATED_VALUES, SEE_DETAILED_VALUES } from '../domain/enums.js';
import { getBool } from './parameters.js';

/**
 * Autenticação e sessão, sem biblioteca: scrypt (node:crypto) para a senha e sessão em tabela própria.
 *
 * Senha: scrypt (RFC 7914), salt aleatório de 16 bytes por usuário, formato N:r:p:hash — os parâmetros de custo
 * podem subir no futuro sem invalidar as senhas existentes. Comparação em tempo constante.
 *
 * Sessão: token aleatório de 32 bytes no cookie HttpOnly; no banco fica só o SHA-256 dele. Perfil alterado ou
 * usuário inativado valem na requisição seguinte, porque usuário e perfis são lidos do banco a cada requisição
 * (na versão .NET, até 1 minuto depois).
 */

const SCRYPT = { N: 16384, r: 8, p: 1, length: 64 };
export const SESSION_COOKIE = 'vagas.session';

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(String(password).normalize('NFKC'), salt, SCRYPT.length,
    { N: SCRYPT.N, r: SCRYPT.r, p: SCRYPT.p, maxmem: 256 * 1024 * 1024 }).toString('hex');
  return { hash: `${SCRYPT.N}:${SCRYPT.r}:${SCRYPT.p}:${derived}`, salt };
}

export function verifyPassword(password, stored, salt) {
  const parts = String(stored).split(':');
  if (parts.length !== 4) return false;
  const [N, r, p, expected] = [Number(parts[0]), Number(parts[1]), Number(parts[2]), parts[3]];
  let derived;
  try {
    derived = crypto.scryptSync(String(password).normalize('NFKC'), salt, expected.length / 2,
      { N, r, p, maxmem: 256 * 1024 * 1024 });
  } catch {
    return false;
  }
  const expectedBuffer = Buffer.from(expected, 'hex');
  return derived.length === expectedBuffer.length && crypto.timingSafeEqual(derived, expectedBuffer);
}

/**
 * Política de senha (seção 12): mínimo de 8 caracteres, maiúscula, número e caractere especial. Mensagens na ordem
 * e com o texto da versão .NET.
 */
export function passwordErrors(password) {
  const s = String(password ?? '');
  const errors = [];
  if (s.length < 8) errors.push('A senha deve ter pelo menos 8 caracteres.');
  if (!/[^\p{L}\p{N}]/u.test(s)) errors.push('A senha deve conter ao menos um caractere especial.');
  if (!/\p{N}/u.test(s)) errors.push('A senha deve conter ao menos um número.');
  if (!/\p{Lu}/u.test(s)) errors.push('A senha deve conter ao menos uma letra maiúscula.');
  return errors;
}

// Hash calculado uma vez: o login de e-mail inexistente gasta o mesmo tempo que o de senha errada, para que o tempo
// de resposta não revele quais e-mails têm conta.
const DUMMY = hashPassword(crypto.randomBytes(12).toString('hex'));

const INVALID = 'E-mail ou senha inválidos.';
const LOCKED = 'Usuário bloqueado temporariamente por excesso de tentativas. Tente novamente em 15 minutos.';

/**
 * Confere as credenciais. Bloqueio de 15 minutos na 5ª falha seguida (a própria tentativa que bloqueia já responde
 * "bloqueado", como o Identity). As tentativas são gravadas direto no banco, fora do log de auditoria.
 * @returns {{ user?: object, error?: string }}
 */
export async function checkCredentials(email, password) {
  const user = await queryOne('SELECT * FROM users WHERE email = ?', String(email ?? '').trim().toLowerCase());
  if (!user || !Number(user.active)) {
    verifyPassword(password ?? '', DUMMY.hash, DUMMY.salt);
    return { error: INVALID };
  }
  const now = utcNow();
  if (user.lockout_end && user.lockout_end > now) return { error: LOCKED };

  if (!verifyPassword(password ?? '', user.password_hash, user.password_salt)) {
    const attempts = Number(user.failed_attempts) + 1;
    if (attempts >= config.maxLoginAttempts) {
      const until = new Date(Date.parse(now) + config.lockoutMin * 60_000).toISOString();
      await execute('UPDATE users SET failed_attempts = 0, lockout_end = ? WHERE id = ?', until, user.id);
      return { error: LOCKED };
    }
    await execute('UPDATE users SET failed_attempts = ? WHERE id = ?', attempts, user.id);
    return { error: INVALID };
  }
  if (Number(user.failed_attempts) || user.lockout_end) {
    await execute('UPDATE users SET failed_attempts = 0, lockout_end = NULL WHERE id = ?', user.id);
  }
  return { user };
}

const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

export async function createSession(userId, ip, userAgent) {
  const token = crypto.randomBytes(32).toString('hex');
  const now = utcNow();
  await execute(
    'INSERT INTO sessions (token_hash, user_id, created_at, last_access, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?)',
    sha256(token), userId, now, now, ip ?? null, String(userAgent ?? '').slice(0, 300) || null);
  return token;
}

export async function endSession(token) {
  if (token) await execute('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
}

/**
 * Usuário da sessão, com os perfis. Sessão parada há mais que o tempo limite (30 min, seção 12) é descartada; a
 * sessão em uso é renovada (expiração por inatividade, não por tempo desde o login).
 */
export async function sessionUser(token) {
  if (!token) return null;
  const hash = sha256(token);
  const session = await queryOne('SELECT * FROM sessions WHERE token_hash = ?', hash);
  if (!session) return null;
  const now = Date.now();
  if (now - Date.parse(session.last_access) > config.sessionTimeoutMin * 60_000) {
    await execute('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  const user = await queryOne('SELECT * FROM users WHERE id = ? AND active = 1', session.user_id);
  if (!user) {
    await execute('DELETE FROM sessions WHERE token_hash = ?', hash);
    return null;
  }
  // Renova no máximo uma vez por minuto: uma escrita por requisição seria custo sem ganho.
  if (now - Date.parse(session.last_access) > 60_000) {
    await execute('UPDATE sessions SET last_access = ? WHERE token_hash = ?', new Date(now).toISOString(), hash);
  }
  const roles = (await query('SELECT role FROM user_roles WHERE user_id = ?', user.id)).map((r) => r.role).sort();
  return {
    id: user.id, name: user.name, email: user.email, roles, mustChangePassword: Boolean(Number(user.must_change_password)),
  };
}

/** Limpa as sessões vencidas (chamado pela rotina de manutenção). */
export async function purgeExpiredSessions() {
  const limit = new Date(Date.now() - config.sessionTimeoutMin * 60_000).toISOString();
  await execute('DELETE FROM sessions WHERE last_access < ?', limit);
}

/** O usuário da sessão como a tela consome (GET /api/auth/me). */
export async function meDto(user) {
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    roles: user.roles,
    mustChangePassword: user.mustChangePassword,
    canSeeDetailedValues: user.roles.some((r) => SEE_DETAILED_VALUES.includes(r)),
    canSeeAggregatedValues: user.roles.some((r) => SEE_AGGREGATED_VALUES.includes(r)),
    initialLoadOpen: await getBool(ParameterKeys.InitialLoadOpen),
  };
}

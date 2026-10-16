import crypto from 'node:crypto';
import { config } from './config.js';
import { UnitOfWork } from './db/unit-of-work.js';
import { BusinessRuleError, ConflictError, ForbiddenError, NotFoundError, ValidationError } from './domain/errors.js';
import { SESSION_COOKIE, sessionUser } from './services/auth.js';

/**
 * Middlewares da API: cookies, sessão, CSRF, cabeçalhos de segurança e o tratador central de erros.
 *
 * Os nomes dos cookies e o contrato de erro são os da API .NET: o front-end (public/js/api.js) não mudou.
 */

/** Parser de cookies enxuto: só lemos a sessão e o token CSRF. */
export function readCookies(req, _res, next) {
  req.cookies = {};
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const key = part.slice(0, eq).trim();
    if (!key) continue;
    try {
      req.cookies[key] = decodeURIComponent(part.slice(eq + 1).trim());
    } catch {
      req.cookies[key] = part.slice(eq + 1).trim();
    }
  }
  next();
}

/**
 * Cookie Secure: sempre fora de development (a plataforma termina o HTTPS e avisa pelo X-Forwarded-Proto, que o
 * Express lê quando o proxy é confiável). Em development, acompanha a requisição — localmente roda em http://.
 */
const secure = (req) => !config.isDevelopment || req.secure;

export function appendCookie(res, cookie) {
  const current = res.getHeader('Set-Cookie');
  res.setHeader('Set-Cookie', [...(current ? (Array.isArray(current) ? current : [current]) : []), cookie]);
}

export function setSessionCookie(req, res, token) {
  // Cookie de sessão do navegador (sem Max-Age): a validade por inatividade é conferida no servidor a cada uso.
  appendCookie(res, [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', ...(secure(req) ? ['Secure'] : [])]
    .join('; '));
}

export function clearSessionCookie(res) {
  appendCookie(res, `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Expires=Thu, 01 Jan 1970 00:00:00 GMT`);
}

/**
 * Proteção CSRF por double-submit: o cookie XSRF-TOKEN é emitido nos GET da API e o front-end o devolve no
 * cabeçalho X-XSRF-TOKEN em toda escrita. Complementa o cookie de sessão SameSite=Strict.
 */
export const CSRF_COOKIE = 'XSRF-TOKEN';
const SAFE = new Set(['GET', 'HEAD', 'OPTIONS']);

export function issueCsrfToken(req, res) {
  const token = crypto.randomBytes(24).toString('hex');
  appendCookie(res, [`${CSRF_COOKIE}=${token}`, 'Path=/', 'SameSite=Strict', ...(secure(req) ? ['Secure'] : [])].join('; '));
  req.cookies[CSRF_COOKIE] = token;
}

export function protectCsrf(req, res, next) {
  if (!req.path.startsWith('/api/')) return next();
  if (SAFE.has(req.method)) {
    if (!req.cookies[CSRF_COOKIE]) issueCsrfToken(req, res);
    return next();
  }
  if (req.path === '/api/auth/login') return next();
  const header = req.get('x-xsrf-token');
  const cookie = req.cookies[CSRF_COOKIE];
  const ok = header && cookie && header.length === cookie.length
    && crypto.timingSafeEqual(Buffer.from(header), Buffer.from(cookie));
  if (!ok) {
    return problem(res, 400, 'Requisição inválida', 'Sessão expirada ou token de segurança inválido. Recarregue a página.');
  }
  next();
}

/**
 * Resolve a sessão e monta o contexto da requisição (usuário, IP e a unidade de trabalho). O try/catch não é
 * defensivismo: este middleware consulta o banco antes do tratador de erro, e uma falha de conexão não pode virar
 * rejeição não tratada.
 */
export async function loadUser(req, _res, next) {
  // Arquivos do front-end não precisam de sessão: sem consulta ao banco por imagem ou script.
  if (!req.path.startsWith('/api/')) return next();
  try {
    req.user = await sessionUser(req.cookies[SESSION_COOKIE]);
    const ip = req.ip ?? req.socket?.remoteAddress ?? null;
    req.ctx = { user: req.user ?? { id: null, roles: [] }, ip, uow: new UnitOfWork({ userId: req.user?.id ?? null, ip }) };
    next();
  } catch (error) {
    next(error);
  }
}

const ANONYMOUS = new Set(['/api/saude', '/api/auth/login']);

/** Toda a API exige sessão, menos a saúde e o login (a política padrão da versão .NET). */
export function requireLogin(req, res, next) {
  if (!req.path.startsWith('/api/') || ANONYMOUS.has(req.path) || req.user) return next();
  return res.status(401).json({ status: 401, title: 'Não autorizado', detail: 'Sessão expirada ou inexistente. Faça login novamente.' });
}

const MUST_CHANGE_ALLOWED = ['/api/saude', '/api/auth/me', '/api/auth/change-password', '/api/auth/logout', '/api/auth/login'];

/** Com senha provisória, o usuário só acessa a troca de senha, o "me" e o logout. */
export function requirePasswordChange(req, res, next) {
  if (req.path.startsWith('/api/') && req.user?.mustChangePassword && !MUST_CHANGE_ALLOWED.includes(req.path)) {
    return problem(res, 403, 'Troca de senha obrigatória', 'Defina uma nova senha para continuar.');
  }
  next();
}

/** Cabeçalhos de segurança. HSTS só quando a conexão chegou em HTTPS (a declaração de que há TLS na frente). */
export function securityHeaders(req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  res.setHeader('Content-Security-Policy',
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self'; "
    + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
  next();
}

/**
 * Limite de tentativas de login por IP: 10 por minuto (janela fixa), como a API .NET. O bloqueio por conta (5
 * erros) não impede o ataque distribuído entre várias contas; este fecha essa brecha. Em memória de propósito:
 * volátil por natureza, some no reinício e não polui o banco.
 */
const loginWindows = new Map();
export function limitLogin(req, res, next) {
  const ip = req.ip ?? 'desconhecido';
  const now = Date.now();
  const windowStart = Math.floor(now / 60_000);
  const entry = loginWindows.get(ip);
  if (!entry || entry.window !== windowStart) loginWindows.set(ip, { window: windowStart, count: 1 });
  else entry.count += 1;
  if (loginWindows.size > 10_000) {
    for (const [key, value] of loginWindows) if (value.window !== windowStart) loginWindows.delete(key);
  }
  if (loginWindows.get(ip).count > config.loginRateLimitPerMinute) return res.status(429).end();
  next();
}

/** Envolve handlers async para que rejeições cheguem ao tratador de erros (Express 4). */
export const route = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function problem(res, status, title, detail, extra = {}) {
  return res.status(status).type('application/problem+json').json({ status, title, detail, ...extra });
}

/**
 * Tratador central: exceções conhecidas viram ProblemDetails ({ status, title, detail, campos? }); o resto vira 500
 * com mensagem genérica e o detalhe só no log.
 */
export function handleErrors(error, req, res, _next) {
  if (error instanceof ValidationError) {
    return problem(res, 400, error.title, error.message, { campos: error.fields });
  }
  if (error instanceof BusinessRuleError) {
    return problem(res, 422, error.title, error.message, error.field ? { campos: { [error.field]: error.message } } : {});
  }
  if (error instanceof NotFoundError || error instanceof ForbiddenError || error instanceof ConflictError) {
    return problem(res, error.status, error.title, error.message);
  }
  if (error?.type === 'entity.parse.failed') {
    return problem(res, 400, 'Requisição inválida', 'O corpo da requisição não é um JSON válido.');
  }
  if (error?.code === 'LIMIT_FILE_SIZE') {
    return problem(res, 422, 'Regra de negócio', 'A evidência deve ter no máximo 10 MB.', { campos: { evidence: 'A evidência deve ter no máximo 10 MB.' } });
  }
  if (isUniqueViolation(error)) {
    // Violação de unicidade que escapou da validação (duas requisições simultâneas).
    return problem(res, 422, 'Regra de negócio', uniqueMessage(error));
  }
  console.error(`[erro] ${req.method} ${req.path}`, error);
  return problem(res, 500, 'Erro interno', 'Ocorreu um erro inesperado. Tente novamente ou contate o administrador.');
}

const isUniqueViolation = (e) => e?.code === '23505' || /UNIQUE constraint failed/i.test(e?.message ?? '');

function uniqueMessage(e) {
  const text = `${e?.constraint ?? ''} ${e?.message ?? ''}`;
  if (/terminations/.test(text)) return 'Já existe um desligamento registrado para esta posição.';
  if (/pauses/.test(text)) return 'A posição já possui uma pausa ativa.';
  if (/contracts/.test(text)) return 'Outro contrato foi gravado ao mesmo tempo com este código. Salve novamente.';
  return 'Registro duplicado: já existe um cadastro com estes dados.';
}

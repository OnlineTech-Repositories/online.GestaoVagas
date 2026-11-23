import { execute, query, queryOne } from '../db/index.js';
import { uuidv7 } from '../db/model.js';
import { addDays, isDate, localDayStartUtc, today, utcNow } from '../domain/dates.js';
import { Roles } from '../domain/enums.js';
import { BusinessRuleError } from '../domain/errors.js';
import { Permissions } from '../domain/guards.js';
import { Input } from './input.js';

/**
 * Histórico de acessos (melhoria pedida pelo usuário em 23/11/2026). Registra o login, a senha incorreta, o bloqueio por
 * tentativas, a saída ("Sair") e o fim da sessão (inatividade, duração máxima, troca ou redefinição de senha), com o IP
 * e o navegador. Fica fora do log de auditoria, só o ADMIN consulta (Usuários e perfis) e a rotina apaga os registros
 * com mais de 1 ano (LGPD) — decisões do usuário.
 */

export const AccessEvents = Object.freeze({
  Login: 'LOGIN',
  LoginFailed: 'LOGIN_FAILED',
  Locked: 'LOCKED',
  Logout: 'LOGOUT',
  SessionExpired: 'SESSION_EXPIRED',
  SessionEnded: 'SESSION_ENDED',
});
const EVENTS = Object.values(AccessEvents);

export const ACCESS_LOG_RETENTION_DAYS = 365;
const PAGE_SIZE = 100;

/** Grava um evento. Falha ao gravar não impede o login nem a saída: só fica no log do servidor. */
export async function recordAccess({
  event, userId = null, email = null, ip = null, userAgent = null, detail = null, occurredAt = utcNow(),
}) {
  try {
    await execute(
      'INSERT INTO access_logs (id, occurred_at, event, user_id, email, ip, user_agent, detail) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      uuidv7(), occurredAt, event, userId,
      email ? String(email).trim().toLowerCase().slice(0, 200) || null : null,
      ip ?? null, String(userAgent ?? '').slice(0, 300) || null, detail);
  } catch (error) {
    console.error('[acessos] falha ao registrar o evento:', error.message);
  }
}

/** Retenção de 1 ano (chamada pela limpeza periódica das sessões). */
export async function purgeOldAccessLogs(now = Date.now()) {
  const limit = new Date(now - ACCESS_LOG_RETENTION_DAYS * 86_400_000).toISOString();
  await execute('DELETE FROM access_logs WHERE occurred_at < ?', limit);
}

/** Navegador e sistema em poucas palavras (ex.: "Chrome · Windows"), a partir do User-Agent. */
export function deviceLabel(userAgent) {
  const ua = String(userAgent ?? '');
  if (!ua) return null;
  const browser = /Edg\//.test(ua) ? 'Edge'
    : /OPR\/|Opera/.test(ua) ? 'Opera'
      : /Firefox\//.test(ua) ? 'Firefox'
        : /Chrome\/|CriOS\//.test(ua) ? 'Chrome'
          : /Safari\//.test(ua) && /Version\//.test(ua) ? 'Safari'
            : 'Outro navegador';
  const system = /Windows/.test(ua) ? 'Windows'
    : /Android/.test(ua) ? 'Android'
      : /iPhone|iPad|iPod/.test(ua) ? 'iOS'
        : /Mac OS X|Macintosh/.test(ua) ? 'macOS'
          : /Linux/.test(ua) ? 'Linux'
            : null;
  return [browser, system].filter(Boolean).join(' · ');
}

/** Último login de cada usuário (coluna "Último acesso" da lista de usuários). */
export async function lastLogins() {
  const rows = await query(`SELECT user_id, MAX(occurred_at) AS last FROM access_logs
    WHERE event = '${AccessEvents.Login}' AND user_id IS NOT NULL GROUP BY user_id`);
  return new Map(rows.map((r) => [r.user_id, r.last]));
}

/**
 * Consulta do ADMIN: filtros por usuário, tipo de evento e período (datas no horário de Brasília), do mais recente para
 * o mais antigo, 100 por página.
 */
export async function listAccessLogs(ctx, params = {}) {
  Permissions.require(ctx.user, Roles.Admin);
  const input = new Input(params);
  const userId = input.text('userId');
  const event = input.text('event');
  const from = input.text('from');
  const to = input.text('to');
  const page = Math.max(1, Number.parseInt(input.text('page') ?? '1', 10) || 1);
  input.done();
  if (event && !EVENTS.includes(event)) throw new BusinessRuleError('Tipo de evento inválido.', 'event');
  for (const [field, value] of [['from', from], ['to', to]]) {
    if (value && !isDate(value)) throw new BusinessRuleError('Data inválida.', field);
  }
  if (from && to && from > to) throw new BusinessRuleError('A data inicial deve ser igual ou anterior à final.', 'to');

  const where = [];
  const args = [];
  if (userId) { where.push('a.user_id = ?'); args.push(userId); }
  if (event) { where.push('a.event = ?'); args.push(event); }
  if (from) { where.push('a.occurred_at >= ?'); args.push(localDayStartUtc(from)); }
  if (to) { where.push('a.occurred_at < ?'); args.push(localDayStartUtc(addDays(to, 1))); }
  const filter = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number((await queryOne(`SELECT COUNT(*) AS n FROM access_logs a ${filter}`, ...args)).n);
  const rows = await query(`SELECT a.*, u.name AS user_name FROM access_logs a LEFT JOIN users u ON u.id = a.user_id
    ${filter} ORDER BY a.occurred_at DESC, a.id DESC LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`, ...args);
  return {
    page,
    pageSize: PAGE_SIZE,
    total,
    retentionDays: ACCESS_LOG_RETENTION_DAYS,
    today: today(),
    items: rows.map((r) => ({
      id: r.id,
      occurredAt: r.occurred_at,
      event: r.event,
      userId: r.user_id,
      userName: r.user_name ?? null,
      email: r.email,
      ip: r.ip,
      device: deviceLabel(r.user_agent),
      detail: r.detail,
    })),
  };
}

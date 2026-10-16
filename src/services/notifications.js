import { config } from '../config.js';
import { query, queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { activeUsersByRoles, usersByIds } from '../db/repository.js';
import { utcNow } from '../domain/dates.js';
import { ForbiddenError, NotFoundError } from '../domain/errors.js';
import { EmailStatus } from '../domain/enums.js';

/**
 * Notificações internas e e-mails (seção 10.1 da SPEC). O e-mail vai para a caixa de saída na MESMA transação da
 * operação e é enviado em segundo plano (jobs.js): uma falha do SendGrid não desfaz o registro de uma admissão.
 */

/** Links da aplicação nos e-mails: o front-end roteia por hash (#/rota). */
export const links = {
  position: (id) => `${config.baseUrl}/#/posicoes/${id}`,
  order: (id) => `${config.baseUrl}/#/pedidos/${id}`,
  contractRates: () => `${config.baseUrl}/#/valores`,
  dashboard: () => `${config.baseUrl}/#/`,
};

/** Só o e-mail, sem notificação interna (o resumo diário). Não grava: entra no save() da operação. */
export function queueEmail(uow, recipient, subject, htmlBody) {
  uow.add(entity('EmailMessage', {
    toAddress: recipient.email, subject: `[Controle de Vagas] ${subject}`, htmlBody,
    status: EmailStatus.PENDING, attempts: 0, lastError: null, sentAt: null,
  }));
}

/**
 * Registra o evento para os usuários ativos dos perfis e/ou os usuários informados (sem duplicar quem está nos
 * dois). Não grava: entra no save() da operação.
 * @param {{ type: string, entityId?: string|null, subject: string, message: string, link?: string|null }} event
 */
export async function notify(uow, event, { roles = null, userIds = null } = {}) {
  const recipients = new Map();
  if (roles?.length) for (const u of await activeUsersByRoles(roles)) recipients.set(u.id, u);
  if (userIds?.length) for (const u of (await usersByIds(userIds)).values()) recipients.set(u.id, u);

  for (const r of recipients.values()) {
    uow.add(entity('Notification', {
      userId: r.id, type: event.type, entityId: event.entityId ?? null, message: event.message, readAt: null,
    }));
    queueEmail(uow, r, event.subject, renderEmail(r.name, event));
  }
}

const toDto = (n) => ({
  id: n.id, type: n.type, entityId: n.entity_id, message: n.message, createdAt: n.created_at, readAt: n.read_at,
});

export async function listMine(ctx, unreadOnly) {
  const userId = requireUser(ctx);
  const rows = await query(
    `SELECT * FROM notifications WHERE user_id = ? ${unreadOnly ? 'AND read_at IS NULL' : ''}
      ORDER BY created_at DESC, id DESC LIMIT 50`, userId);
  return rows.map(toDto);
}

export async function countUnread(ctx) {
  const row = await queryOne('SELECT COUNT(*) AS total FROM notifications WHERE user_id = ? AND read_at IS NULL', requireUser(ctx));
  return Number(row.total);
}

export async function markRead(ctx, id) {
  const userId = requireUser(ctx);
  const n = ctx.uow.load('Notification', await queryOne('SELECT * FROM notifications WHERE id = ?', id));
  if (!n || n.userId !== userId) throw new NotFoundError('Notificação não encontrada.');
  n.readAt ??= utcNow();
  await ctx.uow.save();
}

export async function markAllRead(ctx) {
  const userId = requireUser(ctx);
  const now = utcNow();
  for (const n of ctx.uow.loadAll('Notification',
    await query('SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL', userId))) n.readAt = now;
  await ctx.uow.save();
}

function requireUser(ctx) {
  if (!ctx.user?.id) throw new ForbiddenError();
  return ctx.user.id;
}

export const html = (text) => String(text ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

function renderEmail(recipientName, event) {
  const link = event.link
    ? `<p><a href="${html(event.link)}" style="color:#1565c0">Abrir no sistema</a></p>`
    : '';
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
  <p>Olá, ${html(recipientName)}.</p>
  <p>${html(event.message)}</p>
  ${link}
  <p style="color:#777;font-size:12px">Mensagem automática do Sistema de Controle de Vagas — Grupo ON LINE.</p>
</div>`;
}

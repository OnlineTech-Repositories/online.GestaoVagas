import { activeUsersByRoles } from '../db/repository.js';
import { diffDays, formatBr, localDateOf } from '../domain/dates.js';
import { Labels, PositionStatus as S, Roles, SlaSituation } from '../domain/enums.js';
import { idleDays, lastActivity, nextAction, plural } from './alerts.js';
import { html, links, queueEmail } from './notifications.js';
import { describe } from './positions.js';

/**
 * Resumo diário por e-mail (seção 10.2, item 3): posições abertas por status e cliente; vencidas e em risco;
 * reposições aguardando cliente; pausas sem fim; posições sem atualização.
 *
 * Vai para os perfis operacionais e de gestão. Não traz valores em R$: o e-mail é o mesmo para todos, e a matriz 4.2
 * esconde valores de NACC, DP e RH.
 */

/** Perfis operacionais e de gestão que recebem o resumo (o ADMIN só administra o sistema). */
export const DIGEST_ROLES = Object.freeze([
  Roles.Commercial, Roles.Nacc, Roles.Dp, Roles.Rh, Roles.RhManager, Roles.Manager, Roles.Controllership,
]);

/** Itens por seção no e-mail; o restante aparece como "e mais N" com o link para o sistema. */
const MAX_ITEMS = 30;

/** @param {{ p: object, m: object }[]} rows posições abertas com as métricas de hoje */
export function buildDigest(rows, today, staleDays) {
  const byClient = new Map();
  for (const { p } of rows) {
    const client = p.order.contract?.client?.legalName ?? '—';
    const entry = byClient.get(client) ?? { client, total: 0, byStatus: new Map() };
    const label = Labels.positionStatus[p.status];
    entry.total += 1;
    entry.byStatus.set(label, (entry.byStatus.get(label) ?? 0) + 1);
    byClient.set(client, entry);
  }

  const critical = rows
    .filter(({ m }) => m.slaSituation === SlaSituation.OVERDUE || m.slaSituation === SlaSituation.AT_RISK)
    .sort((a, b) => a.m.slaDeadline.localeCompare(b.m.slaDeadline) || b.m.uncoveredDays - a.m.uncoveredDays)
    .map(({ p, m }) => ({
      position: describe(p),
      situation: m.slaSituation === SlaSituation.OVERDUE ? 'Vencido' : 'Em risco',
      deadline: m.slaDeadline,
      days: diffDays(today, m.slaDeadline),
      uncovered: m.uncoveredDays,
      next: nextAction(p)?.label ?? (p.status === S.PAUSED ? 'Pausada: aguardando o cliente' : '—'),
    }));

  const awaitingClient = rows
    .filter(({ p }) => p.status === S.AWAITING_CONFIRMATION)
    .map(({ p }) => ({
      position: describe(p),
      lastWorkedDay: p.termination?.lastWorkedDay ?? null,
      waiting: p.termination?.registeredAt ? diffDays(p.termination.registeredAt, today) : null,
    }))
    .sort((a, b) => (b.waiting ?? 0) - (a.waiting ?? 0));

  const openPauses = rows
    .flatMap(({ p }) => (p.pauses ?? []).filter((x) => !x.endDate).map((x) => ({
      position: describe(p), reason: x.reason?.name ?? '—', since: x.startDate, days: diffDays(x.startDate, today),
    })))
    .sort((a, b) => b.days - a.days);

  const stale = rows
    .filter(({ p }) => nextAction(p) && idleDays(p, today) >= staleDays)
    .map(({ p }) => ({
      position: describe(p), since: localDateOf(lastActivity(p)), days: idleDays(p, today), next: nextAction(p).label,
    }))
    .sort((a, b) => b.days - a.days);

  return {
    today,
    staleDays,
    openCount: rows.length,
    byClient: [...byClient.values()].sort((a, b) => b.total - a.total || a.client.localeCompare(b.client, 'pt-BR')),
    critical,
    awaitingClient,
    openPauses,
    stale,
  };
}

/** Enfileira o resumo para cada destinatário. Sem posição aberta não há o que resumir: nada é enviado. */
export async function queueDigest(uow, digest) {
  if (digest.openCount === 0) return 0;
  const recipients = await activeUsersByRoles(DIGEST_ROLES);
  const n = digest.openCount;
  const subject = `Resumo diário de ${formatBr(digest.today)} — ${n} ${n === 1 ? 'posição aberta' : 'posições abertas'}`;
  for (const r of recipients) queueEmail(uow, r, subject, renderDigest(r.name, digest));
  return recipients.length;
}

// ---------------------------------------------------------------- HTML do e-mail

const CELL = 'padding:4px 8px;border-bottom:1px solid #e0e0e0;text-align:left;vertical-align:top';

function table(headers, items, row) {
  if (!items.length) return '<p style="color:#777">Nenhuma.</p>';
  const shown = items.slice(0, MAX_ITEMS);
  const more = items.length > shown.length
    ? `<p style="color:#777">… e mais ${items.length - shown.length}. Veja todas no sistema.</p>`
    : '';
  return `<table style="border-collapse:collapse;font-size:13px;margin:4px 0 8px">
  <tr>${headers.map((h) => `<th style="${CELL};background:#f5f5f5">${html(h)}</th>`).join('')}</tr>
  ${shown.map((item) => `<tr>${row(item).map((v) => `<td style="${CELL}">${html(v)}</td>`).join('')}</tr>`).join('\n  ')}
</table>${more}`;
}

const section = (title, count, body) =>
  `<h3 style="font-size:15px;margin:18px 0 4px">${html(title)} (${count})</h3>\n${body}`;

export function renderDigest(recipientName, d) {
  const statusText = (entry) => [...entry.byStatus].map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ');
  return `<div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
  <p>Olá, ${html(recipientName)}.</p>
  <p>Resumo das posições em ${html(formatBr(d.today))}: <strong>${d.openCount}</strong> em aberto,
  <strong>${d.critical.filter((c) => c.situation === 'Vencido').length}</strong> vencidas e
  <strong>${d.critical.filter((c) => c.situation === 'Em risco').length}</strong> em risco.</p>
  ${section('Posições abertas por cliente', d.byClient.length,
    table(['Cliente', 'Abertas', 'Por status'], d.byClient, (e) => [e.client, e.total, statusText(e)]))}
  ${section('Vencidas e em risco', d.critical.length,
    table(['Posição', 'Situação', 'Prazo', 'Dias', 'Dias descobertos', 'Próxima ação'], d.critical, (c) => [
      c.position, c.situation, formatBr(c.deadline),
      c.days < 0 ? `${-c.days} em atraso` : c.days === 0 ? 'vence hoje' : `faltam ${c.days}`, c.uncovered, c.next,
    ]))}
  ${section('Reposições aguardando o cliente', d.awaitingClient.length,
    table(['Posição', 'Último dia trabalhado', 'Aguardando há'], d.awaitingClient, (a) => [
      a.position, formatBr(a.lastWorkedDay) || '—', a.waiting === null ? '—' : plural(a.waiting, 'dia'),
    ]))}
  ${section('Pausas sem fim', d.openPauses.length,
    table(['Posição', 'Motivo', 'Desde', 'Dias'], d.openPauses, (x) => [x.position, x.reason, formatBr(x.since), x.days]))}
  ${section(`Sem atualização há ${d.staleDays} dias ou mais`, d.stale.length,
    table(['Posição', 'Última atualização', 'Dias', 'Próxima ação'], d.stale, (s) => [s.position, formatBr(s.since), s.days, s.next]))}
  <p><a href="${html(links.dashboard())}" style="color:#1565c0">Abrir o painel</a></p>
  <p style="color:#777;font-size:12px">Resumo automático do Sistema de Controle de Vagas — Grupo ON LINE, enviado nos dias úteis.</p>
</div>`;
}

import { activeUsersByRoles } from '../db/repository.js';
import { diffDays, formatBr, localDateOf } from '../domain/dates.js';
import { Labels, PositionStatus as S, Roles, SlaSituation } from '../domain/enums.js';
import { idleDays, isStale, lastActivity, nextAction, plural } from './alerts.js';
import { dataTable, mutedText, renderLayout, sectionTitle } from './email-layout.js';
import { links, queueEmail } from './notifications.js';
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
    .filter(({ p }) => isStale(p, today, staleDays))
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

/** Seção do resumo: título com a contagem e a tabela (até MAX_ITEMS linhas; o resto fica para o sistema). */
function section(title, items, headers, row) {
  if (!items.length) return `${sectionTitle(`${title} (0)`)}${mutedText('Nenhuma.')}`;
  const shown = items.slice(0, MAX_ITEMS);
  const more = items.length > shown.length ? mutedText(`… e mais ${items.length - shown.length}. Veja todas no sistema.`) : '';
  return `${sectionTitle(`${title} (${items.length})`)}${dataTable(headers, shown.map(row))}${more}`;
}

/** Resumo diário no modelo padrão dos e-mails: números do dia em destaque e as listas em tabelas. */
export function renderDigest(recipientName, d) {
  const statusText = (entry) => [...entry.byStatus].map(([label, n]) => `${n} ${label.toLowerCase()}`).join(', ');
  const overdue = d.critical.filter((c) => c.situation === 'Vencido').length;
  const atRisk = d.critical.filter((c) => c.situation === 'Em risco').length;
  return renderLayout({
    recipientName,
    title: `Resumo diário das posições · ${formatBr(d.today)}`,
    summary: 'A situação das posições em aberto hoje, com as que pedem atenção primeiro.',
    status: overdue ? { label: `${overdue} vencida(s)`, tone: 'danger' } : atRisk ? { label: `${atRisk} em risco`, tone: 'warning' }
      : { label: 'Nenhuma vencida', tone: 'success' },
    fields: [
      ['Posições em aberto', String(d.openCount), { strong: true }],
      ['Vencidas', String(overdue), overdue ? { tone: 'danger' } : {}],
      ['Em risco', String(atRisk), atRisk ? { tone: 'warning' } : {}],
      ['Reposições aguardando o cliente', String(d.awaitingClient.length)],
    ],
    bodyHtml: [
      section('Posições abertas por cliente', d.byClient, ['Cliente', 'Abertas', 'Por status'], (e) => [e.client, e.total, statusText(e)]),
      section('Vencidas e em risco', d.critical, ['Posição', 'Situação', 'Prazo', 'Dias', 'Descobertos', 'Próxima ação'], (c) => [
        c.position, c.situation, formatBr(c.deadline),
        c.days < 0 ? `${-c.days} em atraso` : c.days === 0 ? 'vence hoje' : `faltam ${c.days}`, c.uncovered, c.next,
      ]),
      section('Reposições aguardando o cliente', d.awaitingClient, ['Posição', 'Último dia trabalhado', 'Aguardando há'], (a) => [
        a.position, formatBr(a.lastWorkedDay) || '—', a.waiting === null ? '—' : plural(a.waiting, 'dia'),
      ]),
      section('Pausas sem fim', d.openPauses, ['Posição', 'Motivo', 'Desde', 'Dias'], (x) => [x.position, x.reason, formatBr(x.since), x.days]),
      section(`Sem atualização há ${d.staleDays} dias ou mais`, d.stale, ['Posição', 'Última atualização', 'Dias', 'Próxima ação'],
        (st) => [st.position, formatBr(st.since), st.days, st.next]),
    ].join('\n'),
    button: 'Abrir o painel',
    link: links.dashboard(),
    footerNote: 'Resumo automático do Sistema de Controle de Vagas — Grupo ON LINE, enviado nos dias úteis.',
  });
}

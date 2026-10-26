import { queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { listPositions } from '../db/repository.js';
import { diffDays, formatBr, localTime, localWeekday, today as todayDate, utcNow } from '../domain/dates.js';
import { ForbiddenError } from '../domain/errors.js';
import { DemandType, NotificationTypes, ParameterKeys, PositionStatus as S, Roles } from '../domain/enums.js';
import { hasAnyRole, Phone } from '../domain/guards.js';
import { isApproved } from '../domain/order.js';
import * as P from '../domain/position.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { dataTable, mutedText, renderLayout, sectionTitle } from './email-layout.js';
import { links, notify, queueEmail, resolveRecipients } from './notifications.js';
import { orderFields, unitLabel } from './notice-fields.js';
import { getText } from './parameters.js';

/**
 * Admissões pendentes (melhoria pedida pelo usuário em 26/10/2026): os candidatos selecionados aguardando a admissão,
 * para o perfil "Responsável por Admissões", que passa a ser o único a registrá-las (decisão do usuário).
 *
 * Entram as posições "Candidato selecionado" do ciclo atual, de pedido aprovado, com candidato ativo — vagas novas e
 * reposições (na reposição, o candidato atual do ciclo vigente; os anteriores ficam no histórico). Admitida, com
 * desistência ou cancelada, a posição muda de status e sai da relação, dos avisos e dos próximos resumos.
 *
 * Comunicação: aviso de nova pendência a cada seleção (a seleção em lote gera um aviso só por pedido) e resumo diário
 * por e-mail no horário ADMISSIONS_DIGEST_TIME, nos dias úteis, enquanto houver pendência — uma vez por dia
 * (job_runs ADMISSIONS_DIGEST), sem repetir para o mesmo destinatário.
 */

export const ADMISSIONS_DIGEST_JOB = 'ADMISSIONS_DIGEST';
/** Linhas do resumo por e-mail (o restante fica na tela): o Gmail corta mensagens acima de ~100 KB. */
export const ADMISSIONS_DIGEST_MAX_ROWS = 100;

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;
const kindOf = (p) => (p.demandType === DemandType.NEW ? 'Vaga nova' : 'Reposição');
const waitingLabel = (days) => (days <= 0 ? 'Desde hoje' : n(days, 'dia', 'dias'));

/** Quem consulta a relação: quem admite, o Gestor de RH (acompanhamento) e o Administrador. */
const canView = (user) => hasAnyRole(user, [Roles.Admissions, Roles.RhManager, Roles.Admin]);

function head(order) {
  const contract = order.contract;
  return {
    orderId: order.id, orderNumber: order.number, client: contract?.client?.legalName ?? '—', unit: unitLabel(contract),
    contract: contract?.name ?? null, jobRole: order.jobRole?.name ?? null, workLocation: order.workLocation?.name ?? null,
  };
}

function itemOf(p, today) {
  const candidate = P.activeCandidate(p);
  const selectedAt = candidate.approvedAt ?? p.candidateApprovedAt;
  const waitingDays = selectedAt ? Math.max(0, diffDays(selectedAt, today)) : 0;
  return {
    positionId: p.id,
    position: `${p.order.number}-${p.slotNumber}${p.cycle > 1 ? ` (reposição nº ${p.cycle - 1})` : ''}`,
    slotNumber: p.slotNumber,
    candidateId: candidate.id,
    candidateName: candidate.fullName,
    phone: candidate.phone ? Phone.format(candidate.phone) : null,
    demandType: p.demandType,
    kind: kindOf(p),
    selectedAt,
    waitingDays,
    waitingLabel: waitingLabel(waitingDays),
  };
}

/** Posições aguardando a admissão: as mesmas em que "Registrar admissão" aparece. */
const isPending = (p) => P.isCurrentCycle(p) && p.status === S.CANDIDATE_APPROVED && isApproved(p.order) && Boolean(P.activeCandidate(p));

/** Pendências por pedido (cliente e número); em cada pedido, as que esperam há mais tempo primeiro. */
export async function collectPendingAdmissions(uow, today) {
  const positions = (await listPositions(uow, { statuses: [S.CANDIDATE_APPROVED] })).filter(isPending);
  const groups = new Map();
  for (const p of positions) {
    if (!groups.has(p.order.id)) groups.set(p.order.id, { ...head(p.order), items: [] });
    groups.get(p.order.id).items.push(itemOf(p, today));
  }
  const list = [...groups.values()].sort((a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.orderNumber - b.orderNumber);
  for (const g of list) g.items.sort((a, b) => b.waitingDays - a.waitingDays || a.slotNumber - b.slotNumber);
  const all = list.flatMap((g) => g.items);
  return {
    today,
    groups: list,
    summary: {
      total: all.length,
      orders: list.length,
      replacements: all.filter((i) => i.demandType !== DemandType.NEW).length,
      oldestDays: all.reduce((max, i) => Math.max(max, i.waitingDays), 0),
    },
  };
}

export async function getAdmissionsPending(ctx) {
  if (!canView(ctx.user)) throw new ForbiddenError('A relação de admissões pendentes é do Responsável por Admissões.');
  return collectPendingAdmissions(ctx.uow, todayDate());
}

// ---------------------------------------------------------------- aviso de nova pendência

const TABLE_HEADERS = ['Posição', 'Candidato', 'Telefone', 'Tipo', 'Seleção', 'Aguardando'];
const tableRow = (i) => [i.position, i.candidateName, i.phone ?? '—', i.kind, formatBr(i.selectedAt), i.waitingLabel];

/**
 * Aviso aos Responsáveis por Admissões quando candidatos ficam disponíveis para admissão. Uma chamada por evento: a
 * seleção individual avisa uma posição; a importação em lote, todas as do pedido num aviso só.
 */
export async function notifyNewAdmissions(uow, order, positions, today = todayDate()) {
  const items = positions.filter(isPending).map((p) => itemOf(p, today));
  if (!items.length) return;
  const single = items.length === 1 ? items[0] : null;
  const subject = single
    ? `Candidato aguardando admissão · Pedido ${order.number} · posição ${single.position}`
    : `${items.length} candidatos aguardando admissão · Pedido ${order.number}`;
  await notify(uow, {
    type: NotificationTypes.AdmissionPending,
    entityId: single ? single.positionId : order.id,
    subject,
    message: single
      ? `Pedido ${order.number}, posição ${single.position}: ${single.candidateName} foi selecionado(a) e aguarda o registro da admissão.`
      : `Pedido ${order.number}: ${items.length} candidatos selecionados aguardam o registro da admissão.`,
    link: single ? links.position(single.positionId) : links.admissionsPending(),
    email: {
      title: single ? 'Candidato aguardando admissão' : 'Candidatos aguardando admissão',
      summary: single
        ? 'O RH selecionou o candidato desta posição. Registre a admissão quando ela acontecer.'
        : 'O RH selecionou estes candidatos de uma vez. Registre as admissões, uma a uma ou em lote no pedido.',
      status: { label: n(items.length, 'admissão pendente', 'admissões pendentes'), tone: 'info' },
      fields: [...orderFields(order), ...(single ? [['Candidato', single.candidateName, { strong: true }],
        ['Telefone', single.phone], ['Tipo', single.kind], ['Seleção', formatBr(single.selectedAt)]] : [])],
      bodyHtml: single ? '' : dataTable(TABLE_HEADERS, items.map(tableRow)),
      action: 'Responsável por Admissões: registre a admissão com nascimento, CPF, data e matrícula.',
      button: single ? 'Registrar admissão' : 'Consultar admissões pendentes',
    },
  }, { roles: [Roles.Admissions] });
}

// ---------------------------------------------------------------- resumo diário

function digestHtml(recipientName, pending) {
  let rows = 0;
  let hidden = 0;
  const sections = pending.groups.map((g) => {
    const room = Math.max(0, ADMISSIONS_DIGEST_MAX_ROWS - rows);
    const shown = g.items.slice(0, room);
    rows += shown.length;
    hidden += g.items.length - shown.length;
    if (!shown.length) return '';
    return sectionTitle(`Pedido ${g.orderNumber} · ${g.client} · ${g.unit}${g.jobRole ? ` · ${g.jobRole}` : ''}`)
      + dataTable(TABLE_HEADERS, shown.map(tableRow));
  });
  const { total, orders, replacements, oldestDays } = pending.summary;
  return renderLayout({
    recipientName,
    title: `Admissões pendentes · ${formatBr(pending.today)}`,
    summary: 'Candidatos selecionados que aguardam o registro da admissão, por pedido e cliente/unidade.',
    status: { label: n(total, 'admissão pendente', 'admissões pendentes'), tone: oldestDays >= 3 ? 'warning' : 'info' },
    fields: [
      ['Admissões pendentes', String(total), { strong: true }],
      ['Pedidos', String(orders)],
      ['Reposições', String(replacements)],
      ['Maior espera', waitingLabel(oldestDays), oldestDays >= 3 ? { tone: 'warning' } : {}],
    ],
    action: 'Registre as admissões na posição ou em lote no pedido (planilha de admissões).',
    bodyHtml: sections.join('\n') + (hidden ? mutedText(`… e mais ${n(hidden, 'admissão', 'admissões')}. Consulte todas no sistema.`) : ''),
    button: 'Consultar admissões pendentes',
    link: links.admissionsPending(),
    footerNote: 'Resumo automático do Sistema de Controle de Vagas — Grupo ON LINE, enviado nos dias úteis enquanto houver admissão pendente.',
  });
}

/**
 * Resumo diário aos Responsáveis por Admissões: uma vez por dia (o registro em job_runs impede repetição, mesmo com
 * a rotina chamada de novo), e só quando há pendência.
 * @returns {Promise<number>} destinatários
 */
export async function runAdmissionsDigest(today = todayDate()) {
  const uow = new UnitOfWork({ userId: null, ip: null });
  if (await queryOne('SELECT 1 AS yes FROM job_runs WHERE job_name = ? AND run_date = ?', ADMISSIONS_DIGEST_JOB, today)) return 0;
  const pending = await collectPendingAdmissions(uow, today);
  const recipients = pending.summary.total ? [...(await resolveRecipients({ roles: [Roles.Admissions] })).values()] : [];
  const subject = `Admissões pendentes de ${formatBr(today)} — ${n(pending.summary.total, 'candidato', 'candidatos')}`;
  for (const r of recipients) queueEmail(uow, r, subject, digestHtml(r.name, pending));
  const now = utcNow();
  uow.add(entity('JobRun', {
    jobName: ADMISSIONS_DIGEST_JOB, runDate: today, startedAt: now, finishedAt: now,
    summary: `Admissões pendentes: ${pending.summary.total}. Destinatários: ${recipients.length}.`,
  }));
  await uow.save({ action: 'DAILY_JOB' });
  return recipients.length;
}

/** Na conferência de cada minuto da rotina: dias úteis, a partir do horário configurado. */
export async function admissionsDigestTick() {
  const weekday = localWeekday();
  if (weekday === 0 || weekday === 6) return;
  if (localTime() < (await getText(ParameterKeys.AdmissionsDigestTime))) return;
  await runAdmissionsDigest();
}

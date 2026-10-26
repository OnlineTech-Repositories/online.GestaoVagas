import { inList, query } from '../db/index.js';
import { entity } from '../db/model.js';
import { diffDays, formatBr, localDateOf, utcNow } from '../domain/dates.js';
import { AlertKind, Labels, NotificationTypes, OrderApprovalStatus, PositionStatus as S, Roles, SlaSituation } from '../domain/enums.js';
import { activeRhAnalysts } from '../domain/order.js';
import { dataTable, mutedText, sectionTitle } from './email-layout.js';
import { deliver, links, notify, resolveRecipients } from './notifications.js';
import { clientUnit, positionFields, unitLabel } from './notice-fields.js';
import { describe } from './positions.js';

/**
 * Alertas da rotina diária (seção 10.1 da SPEC): posição que entra Em risco, posição Vencida (escalonamento) e
 * posição sem atualização há STALE_DAYS.
 *
 * Cada alerta dispara UMA vez — "nunca a cada execução do job". O que já foi avisado fica em position_alerts, com
 * chave única: a rotina pode rodar de novo no mesmo dia (ou o servidor reiniciar no meio dela) sem repetir aviso.
 * Em risco e Vencido valem uma vez por posição (fase 2: "o escalonamento dispara uma única vez por posição"); vaga
 * parada, uma vez por período parado — a referência é o instante da última atualização. As vagas paradas vão num
 * aviso por pedido e destinatário (melhoria pedida pelo usuário em 22/10/2026), não um por posição.
 */

/** Escalonamento (Vencido): Coordenação de RH (Gestor de RH), Diretor Comercial (Gestor) e Controladoria. */
export const ESCALATION_ROLES = Object.freeze([Roles.RhManager, Roles.Manager, Roles.Controllership]);

/** Equipe de RH do pedido: os analistas responsáveis e os Gestores de RH, que respondem por qualquer pedido. */
const rhTeam = (order) => ({ roles: [Roles.RhManager], userIds: activeRhAnalysts(order).map((a) => a.userId) });

/**
 * Quem responde pela próxima ação da posição (seção 6). Pausada fica de fora: a espera é do cliente, e o resumo
 * diário lista as pausas sem fim à parte.
 * @returns {{ label: string, roles: string[], userIds?: string[] } | null}
 */
export function nextAction(p) {
  const order = p.order;
  if (p.status === S.AWAITING_CONFIRMATION) return { label: 'NACC: registrar a decisão do cliente (repor ou não)', roles: [Roles.Nacc] };
  if (p.status === S.AWAITING_FIRST_DAY) return { label: 'NACC: confirmar o 1º dia', roles: [Roles.Nacc] };
  if (p.status === S.PAUSED || !order) return null;
  if (order.approvalStatus === OrderApprovalStatus.AWAITING_CONTROLLERSHIP) {
    return order.controllershipStatus === 'RETURNED'
      ? { label: 'Comercial: ajustar o pedido e reenviar à Controladoria', roles: [], userIds: [order.createdBy].filter(Boolean) }
      : { label: 'Controladoria: validar o cargo e os valores do pedido', roles: [Roles.Controllership] };
  }
  if (order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL) {
    return { label: 'Comercial: registrar a aprovação do cliente', roles: [], userIds: [order.contract?.commercialOwnerId].filter(Boolean) };
  }
  const team = rhTeam(order);
  switch (p.status) {
    case S.OPEN: return { label: 'RH: publicar a vaga no JobConvo', ...team };
    case S.RECRUITING: return { label: 'RH: selecionar o candidato', ...team };
    case S.CANDIDATE_APPROVED: return { label: 'Admissões: registrar a admissão', roles: [Roles.Admissions] };
    case S.IN_ADMISSION: return {
      label: 'Admissões, RH ou DP: informar a matrícula da admissão', roles: [...team.roles, Roles.Dp, Roles.Admissions], userIds: team.userIds,
    };
    default: return null;
  }
}

/** Última atualização da posição (instante ISO): qualquer marco, pausa ou correção grava updated_at. */
export const lastActivity = (p) => p.updatedAt ?? p.createdAt;

/** Dias sem atualização, em dias corridos no calendário de São Paulo. */
export const idleDays = (p, today) => diffDays(localDateOf(lastActivity(p)), today);

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

/** Posição parada: tem próxima ação (não está pausada) e está sem atualização há `staleDays` dias ou mais. */
export const isStale = (p, today, staleDays) => Boolean(nextAction(p)) && idleDays(p, today) >= staleDays;

/** Linhas da tabela do aviso consolidado (decisão do usuário): o Gmail corta mensagens acima de ~100 KB. */
export const STALE_EMAIL_MAX_ROWS = 100;

const key = (positionId, kind, reference = '') => `${positionId}|${kind}|${reference}`;

async function sentAlerts(positionIds) {
  if (!positionIds.length) return new Set();
  const list = inList(positionIds);
  const rows = await query(`SELECT position_id, kind, reference FROM position_alerts WHERE position_id IN (${list.sql})`, ...list.params);
  return new Set(rows.map((r) => key(r.position_id, r.kind, r.reference)));
}

/**
 * Dispara os alertas devidos e registra cada um em position_alerts. Não grava: entra no save() da rotina, na mesma
 * transação das notificações — ou vai tudo, ou nada (sem aviso registrado e não enviado, nem enviado duas vezes).
 * @param {{ p: object, m: object }[]} rows posições abertas com as métricas de hoje
 */
export async function runAlerts(uow, rows, today, staleDays) {
  const sent = await sentAlerts(rows.map((r) => r.p.id));
  const record = (p, kind, reference = '') => {
    sent.add(key(p.id, kind, reference));
    uow.add(entity('PositionAlert', { positionId: p.id, kind, reference, createdAt: utcNow() }));
  };
  const counts = { atRisk: 0, overdue: 0, stale: 0, staleMessages: 0 };
  const stale = [];

  for (const { p, m } of rows) {
    const action = nextAction(p);
    const next = action ? ` Próxima ação: ${action.label}.` : '';
    const target = `meta de ${plural(p.slaTargetDays, 'dia')}${m.pausedDays ? `, com ${plural(m.pausedDays, 'dia')} de pausa` : ''}`;

    if (m.slaSituation === SlaSituation.OVERDUE && !sent.has(key(p.id, AlertKind.OVERDUE))) {
      record(p, AlertKind.OVERDUE);
      counts.overdue += 1;
      await notify(uow, {
        type: NotificationTypes.SlaOverdue,
        entityId: p.id,
        subject: `SLA vencido · Pedido ${p.order.number} · posição ${p.slotNumber}`,
        message: `${describe(p)}: o prazo do SLA venceu em ${formatBr(m.slaDeadline)} (${target}) e está `
          + `${plural(diffDays(m.slaDeadline, today), 'dia')} em atraso. Dias descobertos até hoje: ${m.uncoveredDays}.${next}`,
        link: links.position(p.id),
        email: {
          title: 'SLA vencido: escalonamento',
          summary: 'O prazo de preenchimento desta posição venceu. O aviso vai ao RH, ao Gestor de RH e à gestão.',
          status: { label: `Vencido há ${plural(diffDays(m.slaDeadline, today), 'dia')}`, tone: 'danger' },
          fields: [...positionFields(p), ['Prazo do SLA', formatBr(m.slaDeadline), { tone: 'danger' }], ['Meta', target],
            ['Dias descobertos até hoje', String(m.uncoveredDays), { strong: true }], ['Próxima ação', action?.label]],
          action: action ? `${action.label}.` : null,
          button: 'Consultar posição',
        },
      }, { roles: ESCALATION_ROLES });
    } else if (m.slaSituation === SlaSituation.AT_RISK && !sent.has(key(p.id, AlertKind.AT_RISK))) {
      record(p, AlertKind.AT_RISK);
      counts.atRisk += 1;
      const left = diffDays(today, m.slaDeadline);
      await notify(uow, {
        type: NotificationTypes.SlaAtRisk,
        entityId: p.id,
        subject: `SLA em risco · Pedido ${p.order.number} · posição ${p.slotNumber}`,
        message: `${describe(p)}: o prazo do SLA vence em ${formatBr(m.slaDeadline)} (${target}). `
          + `${left === 0 ? 'Vence hoje.' : `${left === 1 ? 'Falta' : 'Faltam'} ${plural(left, 'dia')}.`}${next}`,
        link: links.position(p.id),
        email: {
          title: 'Posição em risco de vencer o SLA',
          summary: 'O prazo de preenchimento desta posição está perto de vencer.',
          status: { label: left === 0 ? 'Vence hoje' : `Vence em ${plural(left, 'dia')}`, tone: 'warning' },
          fields: [...positionFields(p), ['Prazo do SLA', formatBr(m.slaDeadline), { tone: 'warning' }], ['Meta', target],
            ['Dias descobertos até hoje', String(m.uncoveredDays)], ['Próxima ação', action?.label]],
          action: action ? `${action.label}.` : null,
          button: 'Consultar posição',
        },
      }, rhTeam(p.order));
    }

    // "Aguardando 1º dia" vai no lembrete consolidado ao NACC (first-day-pending.js) e "Candidato selecionado" no
    // resumo diário das admissões (admissions-pending.js), não no alerta de parada.
    if (p.status !== S.AWAITING_FIRST_DAY && p.status !== S.CANDIDATE_APPROVED && isStale(p, today, staleDays)) {
      const reference = lastActivity(p);
      const isNew = !sent.has(key(p.id, AlertKind.STALE, reference));
      if (isNew) {
        record(p, AlertKind.STALE, reference);
        counts.stale += 1;
      }
      stale.push({ p, action, idle: idleDays(p, today), since: localDateOf(reference), isNew });
    }
  }
  counts.staleMessages = await notifyStale(uow, stale, staleDays);
  return counts;
}

/**
 * Posições paradas, consolidadas: um aviso por pedido e destinatário, com as posições do pedido pelas quais ele
 * responde (a próxima ação define quem: RH do pedido, NACC ou Comercial). Sai só quando há posição parada nova para
 * ele; a tabela traz todas as paradas, com as novas marcadas (decisão do usuário). As novas já foram para
 * position_alerts na mesma transação: a rotina rodada de novo no ciclo não repete o aviso.
 * @returns {Promise<number>} avisos enviados
 */
async function notifyStale(uow, stale, staleDays) {
  const audiences = new Map();
  const audience = async ({ roles, userIds = [] }) => {
    const cacheKey = JSON.stringify([roles, userIds]);
    if (!audiences.has(cacheKey)) audiences.set(cacheKey, await resolveRecipients({ roles, userIds }));
    return audiences.get(cacheKey);
  };

  const byOrder = new Map();
  for (const item of stale) {
    const { order } = item.p;
    if (!byOrder.has(order.id)) byOrder.set(order.id, { order, people: new Map() });
    const { people } = byOrder.get(order.id);
    for (const user of (await audience(item.action)).values()) {
      if (!people.has(user.id)) people.set(user.id, { user, items: [] });
      people.get(user.id).items.push(item);
    }
  }

  const reduced = await reducedByOrder([...byOrder.keys()]);
  let messages = 0;
  for (const { order, people } of byOrder.values()) {
    const current = order.quantity - (reduced.get(order.id) ?? 0);
    for (const { user, items } of people.values()) {
      if (!items.some((i) => i.isNew)) continue;
      deliver(uow, user, staleEvent(order, items, staleDays, current));
      messages += 1;
    }
  }
  return messages;
}

/** Posições retiradas do quadro por pedido, para a quantidade vigente (solicitada − reduzidas). */
async function reducedByOrder(orderIds) {
  if (!orderIds.length) return new Map();
  const list = inList(orderIds);
  const rows = await query(
    `SELECT order_id, COUNT(*) AS n FROM positions WHERE status = ? AND order_id IN (${list.sql}) GROUP BY order_id`,
    S.CLOSED_HEADCOUNT_REDUCED, ...list.params);
  return new Map(rows.map((r) => [r.order_id, Number(r.n)]));
}

/** Aviso consolidado do pedido para um destinatário: as mais antigas primeiro, dias sem movimentação por posição. */
export function staleEvent(order, items, staleDays, current) {
  const sorted = [...items].sort((a, b) => b.idle - a.idle || a.p.slotNumber - b.p.slotNumber || a.p.cycle - b.p.cycle);
  const total = sorted.length;
  const fresh = sorted.filter((i) => i.isNew).length;
  const marked = fresh < total;
  const shown = sorted.slice(0, STALE_EMAIL_MAX_ROWS);
  const count = `${total} ${total === 1 ? 'posição' : 'posições'} sem atualização`;
  const actions = [...new Set(sorted.map((i) => i.action.label))];
  const contract = order.contract;
  const rest = total - shown.length;
  return {
    type: NotificationTypes.OrderPositionsStale,
    entityId: order.id,
    subject: `Pedido ${order.number} — ${count}`,
    message: `Pedido ${order.number} · ${clientUnit(contract)}: ${count} há ${plural(staleDays, 'dia')} ou mais`
      + `${marked ? ` (${fresh} ${fresh === 1 ? 'nova' : 'novas'} neste aviso)` : ''}. Próxima ação: ${actions.join('; ')}.`,
    link: links.orderStale(order.id),
    email: {
      title: 'Posições sem atualização',
      summary: `Nenhuma etapa foi registrada nestas posições do pedido há ${plural(staleDays, 'dia')} ou mais. `
        + 'A próxima ação delas é sua.',
      status: { label: `Até ${plural(sorted[0].idle, 'dia')} sem atualização`, tone: 'warning' },
      fields: [
        ['Pedido', `Nº ${order.number}`, { strong: true }],
        ['Cliente', contract?.client?.legalName],
        ['Unidade', unitLabel(contract)],
        ['Contrato', contract?.name],
        ['Cargo', order.jobRole?.name],
        ['Local de trabalho', order.workLocation?.name],
        ['Posições vigentes do pedido', String(current)],
        ['Exigem atualização', String(total), { tone: 'warning' }],
      ],
      action: `${actions.join('; ')}. Se a etapa já aconteceu, registre-a no sistema.`,
      bodyHtml: sectionTitle(`Posições sinalizadas (${total})`)
        + dataTable(['Posição', 'Status atual', 'Última atualização', 'Dias sem movimentação'], shown.map((i) => [
          `${order.number}-${i.p.slotNumber}${i.p.cycle > 1 ? ` (reposição nº ${i.p.cycle - 1})` : ''}${marked && i.isNew ? ' · novo aviso' : ''}`,
          Labels.positionStatus[i.p.status], formatBr(i.since), String(i.idle),
        ]))
        + (marked ? mutedText('"Novo aviso": posição que ficou parada depois do último aviso deste pedido.') : '')
        + (rest ? mutedText(`… e mais ${rest} ${rest === 1 ? 'posição' : 'posições'}. Consulte todas no sistema.`) : ''),
      button: 'Consultar posições do pedido',
    },
  };
}

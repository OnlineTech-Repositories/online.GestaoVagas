import { inList, query } from '../db/index.js';
import { entity } from '../db/model.js';
import { diffDays, formatBr, localDateOf, utcNow } from '../domain/dates.js';
import { AlertKind, NotificationTypes, OrderApprovalStatus, PositionStatus as S, Roles, SlaSituation } from '../domain/enums.js';
import { activeRhAnalysts } from '../domain/order.js';
import { links, notify } from './notifications.js';
import { positionFields } from './notice-fields.js';
import { describe } from './positions.js';

/**
 * Alertas da rotina diária (seção 10.1 da SPEC): posição que entra Em risco, posição Vencida (escalonamento) e
 * posição sem atualização há STALE_DAYS.
 *
 * Cada alerta dispara UMA vez — "nunca a cada execução do job". O que já foi avisado fica em position_alerts, com
 * chave única: a rotina pode rodar de novo no mesmo dia (ou o servidor reiniciar no meio dela) sem repetir aviso.
 * Em risco e Vencido valem uma vez por posição (fase 2: "o escalonamento dispara uma única vez por posição"); vaga
 * parada, uma vez por período parado — a referência é o instante da última atualização.
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
  if (order.approvalStatus === OrderApprovalStatus.AWAITING_CLIENT_APPROVAL) {
    return { label: 'Comercial: registrar a aprovação do cliente', roles: [], userIds: [order.contract?.commercialOwnerId].filter(Boolean) };
  }
  const team = rhTeam(order);
  switch (p.status) {
    case S.OPEN: return { label: 'RH: publicar a vaga no JobConvo', ...team };
    case S.RECRUITING: return { label: 'RH: selecionar o candidato', ...team };
    case S.CANDIDATE_APPROVED: return { label: 'RH: registrar a admissão', ...team };
    case S.IN_ADMISSION: return { label: 'RH ou DP: informar a matrícula da admissão', roles: [...team.roles, Roles.Dp], userIds: team.userIds };
    default: return null;
  }
}

/** Última atualização da posição (instante ISO): qualquer marco, pausa ou correção grava updated_at. */
export const lastActivity = (p) => p.updatedAt ?? p.createdAt;

/** Dias sem atualização, em dias corridos no calendário de São Paulo. */
export const idleDays = (p, today) => diffDays(localDateOf(lastActivity(p)), today);

export const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;

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
  const counts = { atRisk: 0, overdue: 0, stale: 0 };

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

    const reference = lastActivity(p);
    const idle = idleDays(p, today);
    if (action && idle >= staleDays && !sent.has(key(p.id, AlertKind.STALE, reference))) {
      record(p, AlertKind.STALE, reference);
      counts.stale += 1;
      await notify(uow, {
        type: NotificationTypes.PositionStale,
        entityId: p.id,
        subject: `Posição sem atualização há ${plural(idle, 'dia')} · Pedido ${p.order.number} · posição ${p.slotNumber}`,
        message: `${describe(p)}: sem atualização desde ${formatBr(localDateOf(reference))} (${plural(idle, 'dia')}).${next}`,
        link: links.position(p.id),
        email: {
          title: 'Posição sem atualização',
          summary: 'Nenhuma etapa desta posição foi registrada nos últimos dias.',
          status: { label: `Parada há ${plural(idle, 'dia')}`, tone: 'warning' },
          fields: [...positionFields(p), ['Última atualização', formatBr(localDateOf(reference)), { strong: true }],
            ['Próxima ação', action.label]],
          action: `${action.label}. Se a etapa já aconteceu, registre-a no sistema.`,
          button: 'Consultar posição',
        },
      }, { roles: action.roles, userIds: action.userIds });
    }
  }
  return counts;
}

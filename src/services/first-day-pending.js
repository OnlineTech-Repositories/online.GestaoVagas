import { queryOne } from '../db/index.js';
import { listPositions } from '../db/repository.js';
import { addDays, diffDays, formatBr, localDateOf, today as todayDate } from '../domain/dates.js';
import { ForbiddenError } from '../domain/errors.js';
import { NotificationTypes, ParameterKeys, PositionStatus as S, Roles } from '../domain/enums.js';
import { hasAnyRole } from '../domain/guards.js';
import * as P from '../domain/position.js';
import { dataTable, mutedText, sectionTitle } from './email-layout.js';
import { deliver, links, resolveRecipients } from './notifications.js';
import { unitLabel } from './notice-fields.js';
import { getInt } from './parameters.js';

/**
 * Confirmações do 1º dia pendentes (melhoria pedida pelo usuário em 25/10/2026): a relação dos admitidos que aguardam
 * a confirmação do NACC, por pedido e cliente/unidade, e o lembrete consolidado da rotina diária.
 *
 * Entram as posições "Aguardando 1º dia" (o NACC já pode confirmar) e, à parte, as "Em admissão" sem matrícula, que
 * dependem do RH ou do DP (decisões do usuário). A situação vem da data da admissão: futura = início previsto; hoje ou
 * antes = confirmação devida. Confirmada, ou com "não compareceu" registrado, a posição sai da lista sozinha (muda de
 * status); o histórico fica. A falta de confirmação é pendência de verificação, nunca falta do colaborador.
 */

export const Situation = Object.freeze({ DUE: 'DUE', SCHEDULED: 'SCHEDULED', NO_REGISTRATION: 'NO_REGISTRATION' });

/** Linhas de posições no e-mail (o restante fica na tela): o Gmail corta mensagens acima de ~100 KB. */
export const REMINDER_MAX_ROWS = 100;

const n = (count, one, many) => `${count} ${count === 1 ? one : many}`;

function situationOf(p, today) {
  if (p.status === S.IN_ADMISSION) return { situation: Situation.NO_REGISTRATION, situationLabel: 'Aguardando matrícula (RH ou DP)', days: null };
  if (p.admissionAt && p.admissionAt > today) {
    return { situation: Situation.SCHEDULED, situationLabel: `Início previsto para ${formatBr(p.admissionAt)}`, days: diffDays(today, p.admissionAt) };
  }
  const days = p.admissionAt ? diffDays(p.admissionAt, today) : 0;
  return {
    situation: Situation.DUE,
    situationLabel: days === 0 ? 'Confirmação devida desde hoje' : `Confirmação devida há ${n(days, 'dia', 'dias')}`,
    days,
  };
}

/**
 * Pendências agrupadas por pedido (cliente, unidade, contrato, cargo e local), as devidas há mais tempo primeiro em
 * cada pedido; os pedidos por cliente e número. As sem matrícula vêm à parte, numa lista só.
 */
export async function collectPending(uow, today) {
  const positions = (await listPositions(uow, { statuses: [S.AWAITING_FIRST_DAY, S.IN_ADMISSION] })).filter(P.isCurrentCycle);
  const groups = new Map();
  const withoutRegistration = [];
  for (const p of positions) {
    const order = p.order;
    const contract = order.contract;
    const head = {
      orderId: order.id, orderNumber: order.number, client: contract?.client?.legalName ?? '—', unit: unitLabel(contract),
      contract: contract?.name ?? null, jobRole: order.jobRole?.name ?? null, workLocation: order.workLocation?.name ?? null,
    };
    const item = {
      positionId: p.id,
      position: `${order.number}-${p.slotNumber}${p.cycle > 1 ? ` (reposição nº ${p.cycle - 1})` : ''}`,
      slotNumber: p.slotNumber,
      employeeName: P.activeCandidate(p)?.fullName ?? null,
      registration: p.admissionRegistration ?? null,
      admissionAt: p.admissionAt,
      status: p.status,
      ...situationOf(p, today),
    };
    if (item.situation === Situation.NO_REGISTRATION) {
      withoutRegistration.push({ ...head, ...item });
      continue;
    }
    if (!groups.has(order.id)) groups.set(order.id, { ...head, items: [] });
    groups.get(order.id).items.push(item);
  }
  const rank = (i) => (i.situation === Situation.DUE ? -i.days : 1_000_000 + i.days);
  const byClient = (a, b) => a.client.localeCompare(b.client, 'pt-BR') || a.orderNumber - b.orderNumber;
  const list = [...groups.values()].sort(byClient);
  for (const g of list) g.items.sort((a, b) => rank(a) - rank(b) || a.slotNumber - b.slotNumber);
  withoutRegistration.sort((a, b) => byClient(a, b) || a.slotNumber - b.slotNumber);
  const all = list.flatMap((g) => g.items);
  return {
    today,
    groups: list,
    withoutRegistration,
    summary: {
      due: all.filter((i) => i.situation === Situation.DUE).length,
      scheduled: all.filter((i) => i.situation === Situation.SCHEDULED).length,
      withoutRegistration: withoutRegistration.length,
      orders: list.length,
    },
  };
}

/** Relação para a tela "Confirmações do 1º dia": NACC (quem confirma) e Administrador. */
export async function getFirstDayPending(ctx) {
  if (!hasAnyRole(ctx.user, [Roles.Nacc, Roles.Admin])) {
    throw new ForbiddenError('A relação de confirmações do 1º dia é do NACC.');
  }
  return collectPending(ctx.uow, todayDate());
}

/** Dias úteis (segunda a sexta) depois de `from` até `to`, inclusive. */
export function businessDaysBetween(from, to) {
  let count = 0;
  for (let d = addDays(from, 1); d <= to; d = addDays(d, 1)) {
    const weekday = new Date(`${d}T12:00:00Z`).getUTCDay();
    if (weekday !== 0 && weekday !== 6) count += 1;
  }
  return count;
}

/**
 * Lembrete consolidado ao NACC, na rotina diária: a cada FIRST_DAY_REMINDER_DAYS dias úteis (0 desliga), enquanto
 * houver pendência. O último envio é a última notificação do tipo: rodar a rotina de novo no dia não repete.
 * @returns {Promise<number>} destinatários
 */
export async function queueFirstDayReminder(uow, today) {
  const every = await getInt(ParameterKeys.FirstDayReminderDays);
  if (!(every > 0)) return 0;
  const pending = await collectPending(uow, today);
  const { due, scheduled, withoutRegistration } = pending.summary;
  if (!due && !scheduled && !withoutRegistration) return 0;
  const last = await queryOne('SELECT MAX(created_at) AS at FROM notifications WHERE type = ?', NotificationTypes.FirstDayPending);
  if (last?.at && businessDaysBetween(localDateOf(last.at), today) < every) return 0;
  const recipients = await resolveRecipients({ roles: [Roles.Nacc] });
  const event = reminderEvent(pending);
  for (const r of recipients.values()) deliver(uow, r, event);
  return recipients.size;
}

function reminderEvent(pending) {
  const { due, scheduled, withoutRegistration, orders } = pending.summary;
  const counts = [
    due ? n(due, 'confirmação devida', 'confirmações devidas') : null,
    scheduled ? n(scheduled, 'início previsto', 'inícios previstos') : null,
    withoutRegistration ? n(withoutRegistration, 'admissão aguardando matrícula', 'admissões aguardando matrícula') : null,
  ].filter(Boolean);

  let rows = 0;
  let hidden = 0;
  const take = (list) => {
    const room = Math.max(0, REMINDER_MAX_ROWS - rows);
    rows += Math.min(room, list.length);
    hidden += Math.max(0, list.length - room);
    return list.slice(0, room);
  };
  const orderSections = pending.groups.map((g) => {
    const shown = take(g.items);
    if (!shown.length) return '';
    return sectionTitle(`Pedido ${g.orderNumber} · ${g.client} · ${g.unit}${g.jobRole ? ` · ${g.jobRole}` : ''}`)
      + dataTable(['Posição', 'Colaborador', 'Matrícula', 'Admissão', 'Situação'], shown.map((i) => [
        i.position, i.employeeName ?? '—', i.registration ?? '—', formatBr(i.admissionAt), i.situationLabel,
      ]));
  });
  const noRegistration = take(pending.withoutRegistration);
  const noRegistrationSection = noRegistration.length
    ? sectionTitle(`Aguardando matrícula do RH ou DP (${withoutRegistration})`)
      + mutedText('Ainda não podem ser confirmadas: a matrícula precisa ser informada antes.')
      + dataTable(['Posição', 'Colaborador', 'Cliente / unidade', 'Admissão'], noRegistration.map((i) => [
        i.position, i.employeeName ?? '—', `${i.client} · ${i.unit}`, formatBr(i.admissionAt),
      ]))
    : '';

  return {
    type: NotificationTypes.FirstDayPending,
    entityId: null,
    subject: `Confirmações do 1º dia pendentes — ${counts.join(', ')}`,
    message: `Confirmações do 1º dia pendentes: ${counts.join(', ')}${orders ? `, em ${n(orders, 'pedido', 'pedidos')}` : ''}. `
      + 'A falta de confirmação não é falta do colaborador: confira antes de registrar.',
    link: links.firstDayPending(),
    email: {
      title: 'Confirmações do 1º dia pendentes',
      summary: 'Colaboradores admitidos que aguardam a confirmação do 1º dia efetivo. A falta de confirmação é uma '
        + 'pendência de verificação, não uma falta do colaborador: o comparecimento só é registrado pelo NACC.',
      status: due ? { label: n(due, 'confirmação devida', 'confirmações devidas'), tone: 'warning' }
        : scheduled ? { label: n(scheduled, 'início previsto', 'inícios previstos'), tone: 'info' }
          : { label: n(withoutRegistration, 'aguardando matrícula', 'aguardando matrícula'), tone: 'neutral' },
      fields: [
        ['Confirmações devidas', String(due), due ? { tone: 'warning' } : {}],
        ['Inícios previstos (data futura)', String(scheduled)],
        ['Aguardando matrícula (RH ou DP)', String(withoutRegistration)],
        ['Pedidos com confirmação pendente', String(orders)],
      ],
      action: 'Confirme o 1º dia de quem já começou, na posição ou em lote no pedido. Quem ainda não começou segue '
        + 'pendente; o "não compareceu" só deve ser registrado depois da conferência.',
      bodyHtml: [...orderSections, noRegistrationSection].join('\n')
        + (hidden ? mutedText(`… e mais ${n(hidden, 'posição', 'posições')}. Consulte todas no sistema.`) : ''),
      button: 'Consultar confirmações pendentes',
    },
  };
}

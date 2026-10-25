import { api } from '../api.js';
import { el, clear, panel, panelNoPadding, table, loading, date, indicator, number, button } from '../ui.js';
import { navigate } from '../app.js';

/**
 * Confirmações do 1º dia pendentes (melhoria de 25/10/2026): os admitidos aguardando a confirmação do NACC, por pedido
 * e cliente/unidade, com a confirmação individual (clique na linha) e em lote (no pedido). As "Em admissão" sem
 * matrícula aparecem à parte: dependem do RH ou do DP. A falta de confirmação é pendência de verificação, não falta.
 */

const SITUATION_TAG = { DUE: 'amarela', SCHEDULED: 'azul', NO_REGISTRATION: 'cinza' };

const situationTag = (i) => el('span', { class: `etiqueta ${SITUATION_TAG[i.situation]}` }, i.situationLabel);

export async function firstDayPendingScreen(target) {
  clear(target).append(loading());
  const d = await api.get('/api/positions/first-day-pending');
  const s = d.summary;
  const open = (i) => navigate(`/posicoes/${i.positionId}`);

  const cards = el('div', { class: 'grade grade-4' },
    indicator({ label: 'Confirmações devidas', value: number(s.due), highlight: s.due ? 'alerta' : null,
      note: 'admissão hoje ou antes' }),
    indicator({ label: 'Inícios previstos', value: number(s.scheduled), note: 'admissão em data futura' }),
    indicator({ label: 'Aguardando matrícula', value: number(s.withoutRegistration), note: 'RH ou DP precisa informar' }),
    indicator({ label: 'Pedidos', value: number(s.orders), note: 'com confirmação pendente' }));

  const notice = el('div', { class: 'mensagem info' },
    'A falta de confirmação é uma pendência de verificação, não uma falta do colaborador. Confirme o 1º dia de quem já '
    + 'começou — na posição (clique na linha) ou em lote no pedido; o "não compareceu" só depois da conferência.');

  const groups = d.groups.map((g) => panelNoPadding(
    `Pedido ${g.orderNumber} · ${g.client} · ${g.unit}`,
    el('div', {},
      el('div', { class: 'aviso-painel' }, [g.jobRole, g.workLocation, g.contract].filter(Boolean).join(' · ')),
      table([
        { title: 'Posição', cls: 'nowrap', field: 'position' },
        { title: 'Colaborador', render: (i) => i.employeeName ?? '—' },
        { title: 'Matrícula', cls: 'nowrap', render: (i) => i.registration ?? '—' },
        { title: 'Admissão', cls: 'nowrap', render: (i) => date(i.admissionAt) },
        { title: 'Situação', render: situationTag },
      ], g.items, { onClick: open, dense: true, rowClass: (i) => (i.situation === 'DUE' ? 'linha-alerta' : '') })),
    [button(`Confirmar em lote (${g.items.length})`, () => navigate(`/pedidos/${g.orderId}?confirmar=1`), 'pequeno')],
  ));

  const withoutRegistration = d.withoutRegistration.length
    ? panelNoPadding(`Aguardando matrícula do RH ou DP (${d.withoutRegistration.length})`, el('div', {},
      el('div', { class: 'aviso-painel' }, 'Ainda não podem ser confirmadas: o RH do pedido ou o DP precisa informar a matrícula.'),
      table([
        { title: 'Posição', cls: 'nowrap', field: 'position' },
        { title: 'Colaborador', render: (i) => i.employeeName ?? '—' },
        { title: 'Cliente / unidade', render: (i) => `${i.client} · ${i.unit}` },
        { title: 'Cargo', render: (i) => i.jobRole ?? '—' },
        { title: 'Admissão', cls: 'nowrap', render: (i) => date(i.admissionAt) },
      ], d.withoutRegistration, { onClick: open, dense: true })))
    : null;

  const empty = !d.groups.length && !d.withoutRegistration.length
    ? panel('Confirmações do 1º dia', el('p', { class: 'texto-fraco mb-0' }, 'Nenhum admitido aguardando a confirmação do 1º dia.'))
    : null;

  // append(null) escreveria "null" na tela: os blocos ausentes entram como texto vazio.
  clear(target).append(cards, notice, empty ?? '', ...groups, withoutRegistration ?? '');
}

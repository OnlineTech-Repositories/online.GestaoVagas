import { api } from '../api.js';
import { el, clear, indicator, panelNoPadding, table, loading, money, number, date, positionColumns, positionRowClass, button } from '../ui.js';
import { navigate, state } from '../app.js';

/** Painel (seção 9): cards de situação e a lista de vencidas/em risco, ordenada por dias descobertos. */
export async function dashboardScreen(target) {
  const area = el('div', {}, loading());
  clear(target).append(area);

  async function reload() {
    clear(area).append(loading());
    const d = await api.get('/api/dashboard');
    const showMoney = state.user.canSeeDetailedValues;

    const cards = el(
      'div',
      { class: 'grade grade-4' },
      indicator({ label: 'Posições abertas', value: number(d.openPositions), onClick: () => navigate('/posicoes?onlyOpen=true') }),
      indicator({ label: 'Vencidas', value: number(d.overdue), highlight: d.overdue ? 'erro' : null,
        onClick: () => navigate('/posicoes?sla=OVERDUE') }),
      indicator({ label: 'Em risco', value: number(d.atRisk), highlight: d.atRisk ? 'alerta' : null,
        onClick: () => navigate('/posicoes?sla=AT_RISK') }),
      indicator({ label: 'Aguardando cliente', value: number(d.awaitingClient),
        onClick: () => navigate('/posicoes?status=AWAITING_CONFIRMATION') }),
      indicator({ label: 'Aguardando aprovação do cliente', value: number(d.awaitingApproval),
        highlight: d.awaitingApproval ? 'alerta' : null, note: 'posições sem SLA até a aprovação',
        onClick: () => navigate('/pedidos?aprovacao=AWAITING_CLIENT_APPROVAL') }),
      indicator({ label: 'Aguardando atribuição do RH', value: number(d.awaitingRhAssignment),
        highlight: d.awaitingRhAssignment ? 'alerta' : null, note: 'pedidos sem analista de RH responsável',
        onClick: () => navigate('/pedidos?rh=UNASSIGNED') }),
      indicator({ label: 'Pausadas', value: number(d.paused), onClick: () => navigate('/posicoes?status=PAUSED') }),
      indicator({ label: 'Dias descobertos no mês', value: number(d.uncoveredDaysInMonth), note: `desde ${date(d.monthStart)}` }),
      d.lostInMonth !== null
        ? indicator({
          label: 'Faturamento perdido no mês',
          value: money(d.lostInMonth),
          highlight: d.lostInMonth > 0 ? 'erro' : null,
          note: d.pendingValidationCount > 0
            ? `+ ${money(d.pendingValidationInMonth)} pendente(s) de validação, fora do total`
            : 'Somente valores validados',
        })
        : null,
      d.deferredInMonth !== null
        ? indicator({ label: 'Faturamento postergado no mês', value: money(d.deferredInMonth), note: 'Vigência de duração preservada' })
        : null,
    );

    clear(area).append(
      cards,
      el('div', { class: 'espaco' }),
      panelNoPadding(
        'Vencidas e em risco',
        el(
          'div',
          {},
          el('div', { class: 'aviso-painel' },
            `Situação em ${date(d.today)}, ordenada por dias descobertos. Indicador gerencial: não é base de cobrança.`),
          table(positionColumns({ money: showMoney }), d.critical, {
            onClick: (p) => navigate(`/posicoes/${p.id}`),
            rowClass: positionRowClass,
            empty: 'Nenhuma posição vencida ou em risco.',
            dense: true,
          }),
        ),
        button('Atualizar', reload, 'secundario pequeno'),
      ),
    );
  }

  await reload();
}

import { api } from '../api.js';
import { el, clear, panel, panelNoPadding, table, loading, date, indicator, number, button } from '../ui.js';
import { navigate, state, hasRole } from '../app.js';

/**
 * Admissões pendentes (melhoria de 26/10/2026): os candidatos selecionados aguardando a admissão, por pedido, para o
 * Responsável por Admissões — clique na linha para "Registrar admissão" na posição; "Admitir em lote" abre a
 * importação da planilha de admissões no pedido. O Gestor de RH e o Administrador acompanham, sem registrar.
 */

const waitingClass = (i) => (i.waitingDays >= 3 ? 'linha-alerta' : '');

export async function admissionsPendingScreen(target) {
  clear(target).append(loading());
  const d = await api.get('/api/positions/admissions-pending');
  const s = d.summary;
  const canAdmit = hasRole(state.user, 'ADMISSIONS');
  const open = (i) => navigate(`/posicoes/${i.positionId}`);

  const cards = el('div', { class: 'grade grade-4' },
    indicator({ label: 'Admissões pendentes', value: number(s.total), highlight: s.total ? 'alerta' : null }),
    indicator({ label: 'Pedidos', value: number(s.orders), note: 'com admissão pendente' }),
    indicator({ label: 'Reposições', value: number(s.replacements), note: 'substituição de colaborador' }),
    indicator({ label: 'Maior espera', value: s.oldestDays ? `${s.oldestDays} dia${s.oldestDays === 1 ? '' : 's'}` : '—',
      note: 'desde a seleção do candidato' }));

  const groups = d.groups.map((g) => panelNoPadding(
    `Pedido ${g.orderNumber} · ${g.client} · ${g.unit}`,
    el('div', {},
      el('div', { class: 'aviso-painel' }, [g.jobRole, g.workLocation, g.contract].filter(Boolean).join(' · ')),
      table([
        { title: 'Posição', cls: 'nowrap', field: 'position' },
        { title: 'Candidato', field: 'candidateName' },
        { title: 'Telefone', cls: 'nowrap', render: (i) => i.phone ?? '—' },
        { title: 'Tipo', cls: 'nowrap', field: 'kind' },
        { title: 'Seleção', cls: 'nowrap', render: (i) => date(i.selectedAt) },
        { title: 'Aguardando', cls: 'nowrap', field: 'waitingLabel' },
      ], g.items, { onClick: open, dense: true, rowClass: waitingClass })),
    canAdmit ? [button(`Admitir em lote (${g.items.length})`, () => navigate(`/pedidos/${g.orderId}?admitir=1`), 'pequeno')] : null,
  ));

  const notice = el('div', { class: 'mensagem info' }, canAdmit
    ? 'Clique na linha para registrar a admissão na posição, ou use "Admitir em lote" para a planilha de admissões do pedido. '
      + 'Admitido, o candidato sai desta relação.'
    : 'Acompanhamento: o registro das admissões é do Responsável por Admissões.');

  const empty = !d.groups.length
    ? panel('Admissões pendentes', el('p', { class: 'texto-fraco mb-0' }, 'Nenhum candidato selecionado aguardando admissão.'))
    : null;

  // append(null) escreveria "null" na tela: o bloco ausente entra como texto vazio.
  clear(target).append(cards, notice, empty ?? '', ...groups);
}

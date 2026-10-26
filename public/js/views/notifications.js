import { api } from '../api.js';
import { el, clear, panelNoPadding, loading, dateTime, toast, button } from '../ui.js';
import { navigate, updateCounters } from '../app.js';

const ORDER_TYPES = ['ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_NOT_APPROVED', 'RH_ASSIGNED', 'RH_UNASSIGNED',
  'ORDER_REVIEW_PENDING', 'ORDER_REVIEW_RETURNED'];
/** Aviso consolidado de posições paradas: abre o pedido com elas em destaque. */
const ORDER_STALE = 'ORDER_POSITIONS_STALE';
const RATE_TYPES = ['RATE_PENDING', 'RATE_REJECTED', 'RATE_VALIDATED'];

const TITLES = {
  ORDER_CREATED: 'Novo pedido aguardando aprovação',
  ORDER_APPROVED: 'Pedido aprovado pelo cliente',
  ORDER_NOT_APPROVED: 'Pedido não aprovado pelo cliente',
  ORDER_REVIEW_PENDING: 'Pedido aguardando validação da Controladoria',
  ORDER_REVIEW_RETURNED: 'Pedido devolvido pela Controladoria',
  RH_ASSIGNED: 'Você é responsável por um pedido',
  RH_UNASSIGNED: 'Você não é mais responsável por um pedido',
  TERMINATION_REGISTERED: 'Desligamento registrado',
  REPLACEMENT_CONFIRMED: 'Reposição confirmada',
  ADMISSION_REGISTERED: 'Admissão registrada',
  PAUSE_STARTED: 'Posição pausada',
  PAUSE_ENDED: 'Pausa encerrada',
  RATE_PENDING: 'Valor pendente de validação',
  RATE_REJECTED: 'Valor rejeitado',
  RATE_VALIDATED: 'Valor validado',
  CONTRACT_ENDED: 'Encerrada por fim de vigência',
  SLA_AT_RISK: 'Posição em risco de vencer o SLA',
  SLA_OVERDUE: 'Escalonamento: SLA vencido',
  POSITION_STALE: 'Posição sem atualização',
  ORDER_POSITIONS_STALE: 'Posições sem atualização no pedido',
  FIRST_DAY_PENDING: 'Confirmações do 1º dia pendentes',
  ADMISSION_PENDING: 'Candidato aguardando admissão',
};

/** Notificações internas do usuário (seção 10.1); clicar abre o registro e marca como lida. */
export async function notificationsScreen(target) {
  const area = el('div', {}, loading());

  async function reload() {
    clear(area).append(loading());
    const items = await api.get('/api/notifications');
    if (!items.length) {
      clear(area).append(el('div', { class: 'vazio' }, el('span', { class: 'ico' }, '◉'), 'Nenhuma notificação.'));
      return;
    }
    clear(area).append(el('ul', { class: 'lista-notificacoes' }, ...items.map((n) =>
      el('li', { class: n.readAt ? '' : 'nao-lida', onclick: () => open(n) },
        el('div', { class: 'titulo' }, TITLES[n.type] ?? n.type),
        el('div', { class: 'mensagem-txt' }, n.message),
        el('div', { class: 'quando' }, dateTime(n.createdAt))))));
  }

  async function open(n) {
    if (!n.readAt) api.post(`/api/notifications/${n.id}/read`).then(updateCounters).catch(() => {});
    if (n.type === 'FIRST_DAY_PENDING') {
      navigate('/confirmacoes-1o-dia');
      return;
    }
    if (n.type === 'ADMISSION_PENDING') {
      navigate('/admissoes-pendentes');
      return;
    }
    if (!n.entityId) return;
    if (n.type === ORDER_STALE) navigate(`/pedidos/${n.entityId}?paradas=1`);
    else if (ORDER_TYPES.includes(n.type)) navigate(`/pedidos/${n.entityId}`);
    else if (RATE_TYPES.includes(n.type)) navigate('/valores');
    else navigate(`/posicoes/${n.entityId}`);
  }

  async function markAll() {
    try {
      await api.post('/api/notifications/read-all');
      await reload();
      await updateCounters();
    } catch (error) {
      toast(error.message, 'erro');
    }
  }

  clear(target).append(panelNoPadding('Notificações', area, button('Marcar todas como lidas', markAll, 'secundario pequeno')));
  await reload();
}

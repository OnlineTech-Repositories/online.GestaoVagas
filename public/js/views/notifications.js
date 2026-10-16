import { api } from '../api.js';
import { el, clear, panelNoPadding, loading, dateTime, toast, button } from '../ui.js';
import { navigate, updateCounters } from '../app.js';

const ORDER_TYPES = ['ORDER_CREATED', 'ORDER_APPROVED', 'ORDER_NOT_APPROVED', 'RH_ASSIGNED', 'RH_UNASSIGNED'];
const RATE_TYPES = ['RATE_PENDING', 'RATE_REJECTED'];

const TITLES = {
  ORDER_CREATED: 'Novo pedido aguardando aprovação',
  ORDER_APPROVED: 'Pedido aprovado pelo cliente',
  ORDER_NOT_APPROVED: 'Pedido não aprovado pelo cliente',
  RH_ASSIGNED: 'Você é responsável por um pedido',
  RH_UNASSIGNED: 'Você não é mais responsável por um pedido',
  TERMINATION_REGISTERED: 'Desligamento registrado',
  REPLACEMENT_CONFIRMED: 'Reposição confirmada',
  ADMISSION_REGISTERED: 'Admissão registrada',
  PAUSE_STARTED: 'Posição pausada',
  PAUSE_ENDED: 'Pausa encerrada',
  RATE_PENDING: 'Valor pendente de validação',
  RATE_REJECTED: 'Valor rejeitado',
  CONTRACT_ENDED: 'Encerrada por fim de vigência',
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
    if (!n.entityId) return;
    if (ORDER_TYPES.includes(n.type)) navigate(`/pedidos/${n.entityId}`);
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

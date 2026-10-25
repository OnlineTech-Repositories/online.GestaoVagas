import { api, events, setWarningHandler } from './api.js';
import { el, clear, initials, toast, loading, LABELS, confirmWarnings } from './ui.js';
import { loginScreen, changePasswordScreen, openChangePassword } from './views/login.js';
import { dashboardScreen } from './views/dashboard.js';
import { positionsScreen, positionDetailScreen } from './views/positions.js';
import { ordersScreen, newOrderScreen, orderDetailScreen } from './views/orders.js';
import { terminationScreen } from './views/terminations.js';
import { clientsScreen } from './views/clients.js';
import { ratesScreen } from './views/rates.js';
import { usersScreen } from './views/users.js';
import { parametersScreen } from './views/parameters.js';
import { catalogsScreen } from './views/catalogs.js';
import { reportsScreen } from './views/reports.js';
import { rhDashboardScreen } from './views/rh-dashboard.js';
import { firstDayPendingScreen } from './views/first-day-pending.js';
import { notificationsScreen } from './views/notifications.js';

/**
 * Estado da aplicação, rotas, layout e sessão.
 *
 * Roteamento por hash (e não History API): a aplicação pode ser servida de
 * qualquer subdiretório sem configuração no servidor web.
 */

export const state = {
  user: null,
  // Vem de /api/saude: escrita à mão, a versão mente na primeira publicação esquecida.
  version: '',
  unread: 0,
};

const root = document.getElementById('app');

/** O usuário tem ao menos um dos perfis. A guarda do cliente é conveniência; o controle é a API (403). */
export const hasRole = (user, ...roles) => !!user && roles.some((r) => user.roles.includes(r));

/** Matriz 4.1: só COMMERCIAL cria pedido; na carga inicial, o NACC também (seção 13). */
export const canCreateOrder = (u) => hasRole(u, 'COMMERCIAL') || (hasRole(u, 'NACC') && u.initialLoadOpen);

const isAdmin = (u) => hasRole(u, 'ADMIN');
/** Painel de RH: a gestão vê a equipe; o Analista de RH, os próprios pedidos. */
const canSeeRhDashboard = (u) => hasRole(u, 'RH_MANAGER', 'MANAGER', 'ADMIN', 'RH');
/** Confirmações do 1º dia pendentes: quem confirma (NACC) e o Administrador. */
const canSeeFirstDayPending = (u) => hasRole(u, 'NACC', 'ADMIN');

// ---------------------------------------------------------------------
// Rotas
// ---------------------------------------------------------------------

const GUID = '([0-9a-fA-F-]{36})';

const ROUTES = [
  { pattern: /^\/$/, title: 'Painel', section: 'Início', render: dashboardScreen },
  { pattern: /^\/notificacoes$/, title: 'Notificações', section: 'Início', render: notificationsScreen },
  { pattern: /^\/posicoes$/, title: 'Posições', section: 'Operação', render: positionsScreen },
  {
    pattern: new RegExp(`^/posicoes/${GUID}$`),
    title: 'Posição',
    section: 'Operação',
    render: (target, [id]) => positionDetailScreen(target, id),
  },
  { pattern: /^\/pedidos$/, title: 'Pedidos', section: 'Operação', render: ordersScreen },
  { pattern: /^\/pedidos\/novo$/, title: 'Novo pedido', section: 'Operação', render: newOrderScreen, requires: canCreateOrder },
  {
    pattern: new RegExp(`^/pedidos/${GUID}$`),
    title: 'Pedido',
    section: 'Operação',
    render: (target, [id], query) => orderDetailScreen(target, id, query),
  },
  {
    pattern: /^\/desligamentos\/novo$/,
    title: 'Registrar desligamento',
    section: 'Operação',
    render: terminationScreen,
    requires: (u) => hasRole(u, 'DP', 'NACC'),
  },
  {
    pattern: /^\/confirmacoes-1o-dia$/,
    title: 'Confirmações do 1º dia',
    section: 'Operação',
    render: firstDayPendingScreen,
    requires: canSeeFirstDayPending,
  },
  {
    pattern: /^\/painel-rh$/,
    title: 'Painel de RH',
    section: 'Gestão',
    render: rhDashboardScreen,
    requires: canSeeRhDashboard,
  },
  { pattern: /^\/relatorios$/, title: 'Relatórios', section: 'Gestão', render: reportsScreen },
  {
    pattern: /^\/clientes$/,
    title: 'Clientes e contratos',
    section: 'Cadastros',
    render: clientsScreen,
    requires: (u) => hasRole(u, 'COMMERCIAL', 'ADMIN'),
  },
  {
    pattern: /^\/valores$/,
    title: 'Valores por cargo',
    section: 'Cadastros',
    render: ratesScreen,
    requires: (u) => hasRole(u, 'COMMERCIAL', 'CONTROLLERSHIP', 'ADMIN'),
  },
  { pattern: /^\/usuarios$/, title: 'Usuários e perfis', section: 'Administração', render: usersScreen, requires: isAdmin },
  {
    pattern: /^\/parametros$/,
    title: 'Parâmetros e metas de SLA',
    section: 'Administração',
    render: parametersScreen,
    requires: isAdmin,
  },
  { pattern: /^\/cadastros$/, title: 'Cadastros auxiliares', section: 'Administração', render: catalogsScreen, requires: isAdmin },
];

export const navigate = (path) => {
  window.location.hash = `#${path}`;
};

/** Caminho e query do hash: "#/posicoes?sla=OVERDUE" → { path: "/posicoes", query }. */
function currentLocation() {
  const raw = window.location.hash.replace(/^#/, '') || '/';
  const [path, search = ''] = raw.split('?');
  return { path: path || '/', query: new URLSearchParams(search) };
}

function currentRoute() {
  const { path, query } = currentLocation();
  for (const route of ROUTES) {
    const match = route.pattern.exec(path);
    if (match) return { route, params: match.slice(1), query, path };
  }
  return null;
}

// ---------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------

const hasAny = (...roles) => (u) => hasRole(u, ...roles);

const MENU_ITEMS = [
  { group: 'Início' },
  { href: '/', icon: '▦', label: 'Painel' },
  { href: '/notificacoes', icon: '◉', label: 'Notificações', counter: () => state.unread },
  { group: 'Operação' },
  { href: '/posicoes', icon: '▤', label: 'Posições' },
  { href: '/pedidos', icon: '▣', label: 'Pedidos' },
  { href: '/pedidos/novo', icon: '◇', label: 'Novo pedido', visible: canCreateOrder },
  { href: '/confirmacoes-1o-dia', icon: '✓', label: 'Confirmações do 1º dia', visible: canSeeFirstDayPending },
  { href: '/desligamentos/novo', icon: '⊘', label: 'Registrar desligamento', visible: hasAny('DP', 'NACC') },
  { group: 'Gestão' },
  { href: '/painel-rh', icon: '▧', label: 'Painel de RH', visible: canSeeRhDashboard },
  { href: '/relatorios', icon: '◩', label: 'Relatórios' },
  { group: 'Cadastros', visible: hasAny('COMMERCIAL', 'CONTROLLERSHIP', 'ADMIN') },
  { href: '/clientes', icon: '◈', label: 'Clientes e contratos', visible: hasAny('COMMERCIAL', 'ADMIN') },
  { href: '/valores', icon: '◫', label: 'Valores por cargo', visible: hasAny('COMMERCIAL', 'CONTROLLERSHIP', 'ADMIN') },
  { group: 'Administração', visible: isAdmin },
  { href: '/usuarios', icon: '◍', label: 'Usuários', visible: isAdmin },
  { href: '/parametros', icon: '⚙', label: 'Parâmetros', visible: isAdmin },
  { href: '/cadastros', icon: '▥', label: 'Cadastros auxiliares', visible: isAdmin },
];

/** O item ativo é o de caminho mais longo que é prefixo da rota atual (detalhes acendem a lista). */
function activeHref(path) {
  return MENU_ITEMS.filter((i) => i.href && (path === i.href || (i.href !== '/' && path.startsWith(`${i.href}/`))))
    .map((i) => i.href)
    .sort((a, b) => b.length - a.length)[0];
}

function buildMenu(path) {
  const menu = el('nav', { class: 'menu' });
  const active = activeHref(path);

  for (const item of MENU_ITEMS) {
    if (item.visible && !item.visible(state.user)) continue;

    if (item.group) {
      menu.append(el('div', { class: 'menu-grupo' }, item.group));
      continue;
    }

    const count = item.counter?.() ?? 0;
    menu.append(
      el(
        'a',
        { href: `#${item.href}`, class: item.href === active ? 'ativo' : '' },
        el('span', { class: 'ico' }, item.icon),
        el('span', {}, item.label),
        count > 0 ? el('span', { class: 'contador' }, count > 99 ? '99+' : count) : null,
      ),
    );
  }

  return menu;
}

let sidebar = null;

function buildLayout(route, path) {
  const user = state.user;
  const content = el('div', { class: 'pagina' }, loading());

  sidebar = el(
    'aside',
    { class: 'barra-lateral' },
    el(
      'div',
      { class: 'marca' },
      el('div', { class: 'empresa' }, 'Grupo ON LINE'),
      el('div', { class: 'sistema' }, 'Controle de Vagas'),
    ),
    buildMenu(path),
    el('div', { class: 'rodape-lateral' }, `Controladoria${state.version ? ` · v${state.version}` : ''}`),
  );

  const layout = el(
    'div',
    { class: 'layout' },
    sidebar,
    el(
      'div',
      { class: 'conteudo' },
      el(
        'header',
        { class: 'topo' },
        el('div', { class: 'titulo-pagina' }, el('div', { class: 'caminho' }, route.section), el('h1', {}, route.title)),
        user.initialLoadOpen
          ? el('span', { class: 'etiqueta amarela', title: 'Datas retroativas aceitas sem justificativa (seção 13)' },
            'Carga inicial aberta')
          : null,
        el(
          'div',
          { class: 'usuario-box' },
          el('div', { class: 'avatar' }, initials(user.name)),
          el(
            'div',
            {},
            el('div', { class: 'nome' }, user.name),
            el('div', { class: 'perfil' }, user.roles.map((r) => LABELS.role[r] ?? r).join(' · ')),
          ),
          el('button', { class: 'btn secundario pequeno', type: 'button', onclick: openChangePassword, title: 'Trocar a senha' },
            'Senha'),
          el('button', { class: 'btn secundario pequeno', type: 'button', onclick: logout, title: 'Encerrar sessão' }, 'Sair'),
        ),
      ),
      content,
    ),
  );

  return { layout, content };
}

// ---------------------------------------------------------------------
// Renderização
// ---------------------------------------------------------------------

export async function render() {
  if (!state.user) {
    clear(root).append(loginScreen(login));
    root.classList.remove('carregando');
    return;
  }

  // Senha provisória: troca obrigatória antes de usar o sistema (a API também bloqueia).
  if (state.user.mustChangePassword) {
    clear(root).append(
      changePasswordScreen((user) => {
        state.user = user;
        render();
      }, logout),
    );
    root.classList.remove('carregando');
    return;
  }

  const found = currentRoute();
  if (!found) {
    navigate('/');
    return;
  }

  const { route, params, query, path } = found;

  if (route.requires && !route.requires(state.user)) {
    // O estado local pode estar defasado: os perfis podem ter sido alterados
    // pelo Administrador depois que a página carregou. Confere antes de negar.
    const refreshed = await refreshSession();
    if (!refreshed || !route.requires(state.user)) {
      toast('Seu perfil não tem acesso a esta área.', 'erro');
      navigate('/');
      return;
    }
  }

  const { layout, content } = buildLayout(route, path);
  clear(root).append(layout);
  root.classList.remove('carregando');

  try {
    await route.render(content, params, query);
  } catch (error) {
    clear(content).append(
      el('div', { class: 'mensagem erro' }, el('strong', {}, 'Não foi possível carregar esta página.'), error.message),
    );
  }

  updateCounters();
}

/** Recarrega o usuário da sessão. Devolve false se a sessão não existe mais. */
export async function refreshSession() {
  try {
    state.user = await api.session();
    return true;
  } catch {
    return false;
  }
}

/** Mantém o contador do menu em dia. Falha aqui é silenciosa: o contador é informativo. */
export async function updateCounters() {
  try {
    state.unread = (await api.get('/api/notifications/unread-count')) ?? 0;
    const menu = sidebar?.querySelector('.menu');
    if (menu) {
      const fresh = buildMenu(currentLocation().path);
      clear(menu).append(...fresh.childNodes);
    }
  } catch {
    // Sessão expirada ou rede indisponível — tratado no fluxo principal.
  }
}

// ---------------------------------------------------------------------
// Sessão
// ---------------------------------------------------------------------

async function login(user) {
  state.user = user;
  if (!window.location.hash) window.location.hash = '#/';
  await render();
}

async function logout() {
  try {
    await api.logout();
  } catch {
    // Mesmo se a chamada falhar, o estado local é limpo.
  }
  state.user = null;
  window.location.hash = '';
  clear(root).append(loginScreen(login));
}

// Datas passadas, futuras ou fora de sequência: a janela de avisos decide se o envio segue (api.js refaz confirmado).
setWarningHandler(confirmWarnings);

events.addEventListener('session-expired', () => {
  if (!state.user) return;
  state.user = null;
  toast('Sua sessão expirou por inatividade. Faça login novamente.', 'alerta', 8000);
  clear(root).append(loginScreen(login));
});

window.addEventListener('hashchange', render);

// ---------------------------------------------------------------------
// Início
// ---------------------------------------------------------------------

try {
  // /api/saude também emite o cookie CSRF: é a primeira chamada de qualquer sessão.
  state.version = (await api.health())?.versao ?? '';
} catch {
  state.version = '';
}

try {
  state.user = await api.session();
} catch {
  state.user = null;
}

await render();

// Contador de notificações a cada minuto.
setInterval(() => {
  if (state.user && !state.user.mustChangePassword) updateCounters();
}, 60_000);

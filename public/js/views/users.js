import { api } from '../api.js';
import {
  el, clear, field, checkGroup, checkedValues, checkbox, table, panelNoPadding, loading, LABELS, options, requireFields,
  validationError, toast, button, formModal, modal, dateTime, today,
} from '../ui.js';

const PASSWORD_HELP = 'Mínimo de 8 caracteres, com letra maiúscula, número e caractere especial. O usuário troca no 1º acesso.';
const meetsPolicy = (v) => v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);

/** Usuários e perfis (ADMIN). Segregação: quem cadastra valores (Comercial) não os valida. */
export async function usersScreen(target) {
  const area = el('div', {}, loading());

  async function reload() {
    clear(area).append(loading());
    const users = await api.get('/api/users');
    clear(area).append(table(
      [
        { title: 'Nome', field: 'name' },
        { title: 'E-mail', field: 'email' },
        { title: 'Perfis', render: (u) => u.roles.map((r) => LABELS.role[r] ?? r).join(' · ') },
        {
          title: 'Situação',
          render: (u) => el('div', { class: 'barra-botoes' },
            el('span', { class: `etiqueta ${u.active ? 'verde' : 'cinza'}` }, u.active ? 'Ativo' : 'Inativo'),
            u.lockedOut ? el('span', { class: 'etiqueta vermelha' }, 'Bloqueado') : null,
            u.mustChangePassword ? el('span', { class: 'etiqueta amarela' }, 'Senha provisória') : null),
        },
        {
          title: 'Último acesso',
          cls: 'nowrap',
          render: (u) => (u.lastLoginAt ? dateTime(u.lastLoginAt) : el('span', { class: 'texto-fraco' }, 'Sem registro')),
        },
      ],
      users,
      { onClick: openUser, empty: 'Nenhum usuário cadastrado.' },
    ));
  }

  function openUser(user) {
    const password = user ? null : passwordChoice();

    const reference = formModal({
      title: user ? 'Editar usuário' : 'Novo usuário',
      wide: true,
      fields: [
        el('div', { class: 'linha-campos' },
          field({ name: 'name', label: 'Nome', value: user?.name ?? '', required: true }),
          field({ name: 'email', label: 'E-mail', type: 'email', value: user?.email ?? '', required: true })),
        checkGroup({ name: 'roles', label: 'Perfis', required: true, options: options(LABELS.role), values: user?.roles ?? [],
          help: 'Quem cadastra valores (Comercial) não os valida: somente a Controladoria valida.' }),
        user ? checkbox({ name: 'active', label: 'Ativo', checked: user.active }) : null,
        user
          ? el('div', { class: 'campo' }, el('label', {}, 'Senha'),
            el('div', { class: 'barra-botoes' },
              button('Redefinir senha', () => {
                reference.close();
                openResetPassword(user);
              }, 'secundario'),
              el('span', { class: 'texto-fraco texto-pequeno' }, 'Gera ou define uma senha provisória; o usuário troca no próximo acesso.')))
          : el('div', { class: 'campo' }, el('label', {}, 'Senha provisória'), password.block),
      ],
      submit: async (d, form) => {
        const roles = checkedValues(form, 'roles');
        requireFields({ ...d, roles }, { name: 'O nome', email: 'O e-mail', roles: 'Ao menos um perfil' });
        if (user) {
          await api.put(`/api/users/${user.id}`, { name: d.name, email: d.email, roles, active: d.active });
          toast('Usuário salvo.', 'sucesso');
        } else {
          const created = await api.post('/api/users', { name: d.name, email: d.email, roles, ...password.read() });
          if (created.temporaryPassword) showTemporaryPassword(created.name, created.temporaryPassword, 'Usuário criado.');
          else toast(`Usuário criado. ${created.name} trocará a senha no primeiro acesso.`, 'sucesso', 7000);
        }
        await reload();
      },
    });
  }

  /** Redefinição de senha: gerar (padrão) ou definir, com o aviso de que as sessões serão encerradas. */
  function openResetPassword(user) {
    const password = passwordChoice();
    formModal({
      title: `Redefinir senha · ${user.name}`,
      submitText: 'Redefinir senha',
      intro: el('div', {},
        el('div', { class: 'mensagem info' },
          'A senha aparece uma única vez, ao confirmar. O sistema guarda apenas o hash, então ela não poderá ser consultada depois — '
          + 'se for perdida, basta redefinir de novo.'),
        el('div', { class: 'mensagem alerta' },
          `As sessões abertas de ${user.name} (${user.email}) serão encerradas e a troca de senha será exigida no próximo acesso.`)),
      fields: [password.block],
      submit: async () => {
        const done = await api.post(`/api/users/${user.id}/reset-password`, password.read());
        if (done.temporaryPassword) showTemporaryPassword(done.userName, done.temporaryPassword, 'Senha redefinida.');
        else toast(`Senha de ${done.userName} redefinida. A troca será obrigatória no próximo acesso.`, 'sucesso', 7000);
        await reload();
      },
    });
  }

  // Abas: o cadastro e o histórico de acessos (23/11/2026), os dois só para o ADMIN.
  const tabs = el('div', { class: 'abas', role: 'tablist' });
  const body = el('div', {});
  let current = 'usuarios';
  async function show(tab) {
    current = tab;
    clear(tabs).append(...[['usuarios', 'Usuários'], ['acessos', 'Histórico de acessos']].map(([key, text]) => el('button', {
      class: `aba ${key === current ? 'ativa' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(key === current),
      onclick: () => { if (key !== current) show(key); },
    }, text)));
    if (tab === 'usuarios') {
      clear(body).append(panelNoPadding('Usuários e perfis', area, button('+ Novo usuário', () => openUser(null))));
      await reload();
    } else {
      clear(body).append(loading());
      await accessLogPanel(body);
    }
  }
  clear(target).append(tabs, body);
  await show('usuarios');
}

const ACCESS_EVENTS = {
  LOGIN: ['Login', 'verde'],
  LOGIN_FAILED: ['Falha no login', 'amarela'],
  LOCKED: ['Bloqueio por tentativas', 'vermelha'],
  LOGOUT: ['Saída', 'cinza'],
  SESSION_EXPIRED: ['Sessão expirada', 'cinza'],
  SESSION_ENDED: ['Sessão encerrada', 'cinza'],
};

/**
 * Histórico de acessos: login, falha, bloqueio, saída e fim da sessão, com IP e navegador. Filtros por usuário, evento
 * e período; 100 por página, do mais recente para o mais antigo. Registros com mais de 1 ano são apagados (LGPD).
 */
async function accessLogPanel(target) {
  const users = await api.get('/api/users');
  const filters = { userId: '', event: '', from: '', to: '', page: 1 };
  const tableArea = el('div', {}, loading());
  const paging = el('div', { class: 'paginacao' });
  const note = el('p', { class: 'texto-fraco texto-pequeno', style: { margin: '0 16px 12px' } });

  const filter = (name, control) => {
    const input = control.querySelector('select, input');
    input.addEventListener('change', () => {
      filters[name] = input.value;
      filters.page = 1;
      reload();
    });
    return control;
  };

  async function reload() {
    clear(tableArea).append(loading());
    let result;
    try {
      result = await api.get('/api/users/access-logs', filters);
    } catch (error) {
      clear(tableArea).append(el('div', { class: 'mensagem erro', style: { margin: '16px' } }, error.message));
      clear(paging);
      return;
    }
    note.textContent = `Login, falha, bloqueio, saída e fim da sessão de cada usuário, com IP e navegador. Os registros `
      + `ficam ${result.retentionDays} dias e depois são apagados. Visível só para o administrador.`;
    clear(tableArea).append(table([
      { title: 'Data e hora', cls: 'nowrap', render: (a) => dateTime(a.occurredAt) },
      {
        title: 'Usuário',
        render: (a) => el('div', {}, el('div', {}, a.userName ?? el('span', { class: 'texto-fraco' }, 'Sem usuário cadastrado')),
          a.email ? el('div', { class: 'texto-fraco texto-pequeno' }, a.email) : null),
      },
      {
        title: 'Evento',
        render: (a) => el('span', { class: `etiqueta ${ACCESS_EVENTS[a.event]?.[1] ?? 'cinza'}` }, ACCESS_EVENTS[a.event]?.[0] ?? a.event),
      },
      { title: 'Detalhe', render: (a) => a.detail ?? el('span', { class: 'texto-fraco' }, '—') },
      { title: 'IP', cls: 'nowrap', render: (a) => a.ip ?? '—' },
      { title: 'Navegador', cls: 'nowrap', render: (a) => a.device ?? '—' },
    ], result.items, { dense: true, empty: 'Nenhum acesso encontrado com estes filtros.' }));
    const first = result.total ? (result.page - 1) * result.pageSize + 1 : 0;
    const last = Math.min(result.page * result.pageSize, result.total);
    clear(paging).append(
      el('span', {}, `${first}–${last} de ${result.total} registro(s)`),
      el('div', { class: 'barra-botoes' },
        el('button', { class: 'btn secundario pequeno', type: 'button', disabled: filters.page <= 1,
          onclick: () => { filters.page -= 1; reload(); } }, '‹ Anterior'),
        el('button', { class: 'btn secundario pequeno', type: 'button', disabled: last >= result.total,
          onclick: () => { filters.page += 1; reload(); } }, 'Próxima ›')),
    );
  }

  clear(target).append(el('section', { class: 'painel' },
    el('div', { class: 'painel-cabecalho' }, el('h2', {}, 'Histórico de acessos')),
    el('div', { class: 'filtros' },
      filter('userId', field({ name: 'userId', label: 'Usuário', type: 'select',
        options: [{ value: '', label: 'Todos' }, ...users.map((u) => ({ value: u.id, label: u.name }))] })),
      filter('event', field({ name: 'event', label: 'Evento', type: 'select',
        options: [{ value: '', label: 'Todos' }, ...Object.entries(ACCESS_EVENTS).map(([value, [text]]) => ({ value, label: text }))] })),
      filter('from', field({ name: 'from', label: 'De', type: 'date', attributes: { max: today() } })),
      filter('to', field({ name: 'to', label: 'Até', type: 'date', attributes: { max: today() } }))),
    note,
    el('div', { class: 'painel-corpo sem-padding' }, tableArea),
    paging));
  await reload();
}

/**
 * Escolha da senha provisória: gerar automaticamente (padrão, 12 caracteres aleatórios gerados no servidor) ou
 * definir uma específica, com confirmação e a política conferida antes de enviar.
 */
function passwordChoice() {
  const name = `modo-senha-${Math.random().toString(36).slice(2, 8)}`;
  const option = (value, title, help, checked) => el('label', { class: 'opcao-radio' },
    el('input', { type: 'radio', name, value, checked }),
    el('span', {}, el('span', { class: 'opcao-titulo' }, title), el('span', { class: 'texto-fraco texto-pequeno' }, help)));
  const generate = option('GENERATE', 'Gerar senha forte automaticamente', '12 caracteres aleatórios — opção recomendada.', true);
  const manual = option('MANUAL', 'Definir uma senha específica', 'Útil quando você precisa combinar a senha por telefone.', false);
  const typed = field({ name: 'temporaryPassword', label: 'Senha provisória', type: 'password', required: true, help: PASSWORD_HELP,
    attributes: { autocomplete: 'new-password' } });
  const confirmation = field({ name: 'passwordConfirmation', label: 'Confirme a senha', type: 'password', required: true,
    attributes: { autocomplete: 'new-password' } });
  const manualFields = el('div', { class: 'linha-campos oculto' }, typed, confirmation);
  const isManual = () => manual.querySelector('input').checked;
  for (const o of [generate, manual]) {
    o.querySelector('input').addEventListener('change', () => manualFields.classList.toggle('oculto', !isManual()));
  }
  return {
    block: el('div', { class: 'escolha-senha' }, generate, manual, manualFields),
    read() {
      if (!isManual()) return { passwordMode: 'GENERATE' };
      const value = typed.querySelector('input').value;
      const again = confirmation.querySelector('input').value;
      if (!value) throw validationError({ temporaryPassword: 'Informe a senha provisória.' });
      if (!meetsPolicy(value)) throw validationError({ temporaryPassword: 'A senha não atende à política.' });
      if (value !== again) throw validationError({ passwordConfirmation: 'A confirmação não confere com a senha.' });
      return { passwordMode: 'MANUAL', temporaryPassword: value, passwordConfirmation: again };
    },
  };
}

/** Mostra a senha gerada uma única vez, com botão de copiar; ao fechar, ela não pode mais ser consultada. */
function showTemporaryPassword(userName, password, headline) {
  const value = el('code', { class: 'senha-gerada' }, password);
  const copy = button('Copiar senha', async () => {
    try {
      await navigator.clipboard.writeText(password);
      toast('Senha copiada.', 'sucesso');
    } catch {
      window.getSelection()?.selectAllChildren(value);
      toast('Selecione e copie a senha com Ctrl+C.', 'alerta');
    }
  }, 'secundario pequeno');
  const reference = modal({
    title: headline,
    body: el('div', {},
      el('p', {}, `Senha provisória de ${userName}:`),
      el('div', { class: 'senha-gerada-area' }, value, copy),
      el('div', { class: 'mensagem alerta' },
        'Anote ou envie agora por um canal seguro: esta é a única vez que a senha aparece. A troca será obrigatória no próximo acesso.')),
    footer: [button('Concluir', () => reference.close())],
  });
}

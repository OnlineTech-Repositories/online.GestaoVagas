import { api } from '../api.js';
import {
  el, clear, field, checkGroup, checkedValues, checkbox, table, panelNoPadding, loading, LABELS, options, requireFields,
  validationError, toast, button, formModal, modal,
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

  clear(target).append(panelNoPadding('Usuários e perfis', area, button('+ Novo usuário', () => openUser(null))));
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

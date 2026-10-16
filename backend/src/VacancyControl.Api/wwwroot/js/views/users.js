import { api } from '../api.js';
import {
  el, clear, field, checkGroup, checkedValues, checkbox, table, panelNoPadding, loading, LABELS, options, requireFields,
  validationError, toast, button, formModal,
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
    const passwordBlock = field({
      name: user ? 'newTemporaryPassword' : 'temporaryPassword',
      label: user ? 'Nova senha provisória (opcional)' : 'Senha provisória',
      required: !user,
      help: user ? 'Preencha só para redefinir a senha; o usuário trocará no próximo acesso.' : PASSWORD_HELP,
      attributes: { autocomplete: 'new-password' },
    });

    formModal({
      title: user ? 'Editar usuário' : 'Novo usuário',
      wide: true,
      fields: [
        el('div', { class: 'linha-campos' },
          field({ name: 'name', label: 'Nome', value: user?.name ?? '', required: true }),
          field({ name: 'email', label: 'E-mail', type: 'email', value: user?.email ?? '', required: true })),
        checkGroup({ name: 'roles', label: 'Perfis', required: true, options: options(LABELS.role), values: user?.roles ?? [],
          help: 'Quem cadastra valores (Comercial) não os valida: somente a Controladoria valida.' }),
        user ? checkbox({ name: 'active', label: 'Ativo', checked: user.active }) : null,
        passwordBlock,
      ],
      submit: async (d, form) => {
        const roles = checkedValues(form, 'roles');
        requireFields({ ...d, roles }, { name: 'O nome', email: 'O e-mail', roles: 'Ao menos um perfil', ...(user ? {} : { temporaryPassword: 'A senha provisória' }) });

        const password = user ? d.newTemporaryPassword : d.temporaryPassword;
        if (password && !meetsPolicy(password)) {
          throw validationError({ [user ? 'newTemporaryPassword' : 'temporaryPassword']: 'A senha não atende à política.' });
        }

        if (user) {
          await api.put(`/api/users/${user.id}`, { name: d.name, email: d.email, roles, active: d.active });
          if (password) await api.post(`/api/users/${user.id}/reset-password`, { temporaryPassword: password });
        } else {
          await api.post('/api/users', { name: d.name, email: d.email, roles, temporaryPassword: password });
        }
        toast(password && user ? 'Usuário salvo e senha redefinida.' : 'Usuário salvo.', 'sucesso');
        await reload();
      },
    });
  }

  clear(target).append(panelNoPadding('Usuários e perfis', area, button('+ Novo usuário', () => openUser(null))));
  await reload();
}

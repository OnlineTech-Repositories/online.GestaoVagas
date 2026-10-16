import { api } from '../api.js';
import { el, field, applyErrors, infoMessage, formData, toast, formModal, requireFields, validationError } from '../ui.js';

/** Política da seção 12: mínimo de 8 caracteres, com maiúscula, número e caractere especial. */
const PASSWORD_HELP = 'Mínimo de 8 caracteres, com letra maiúscula, número e caractere especial.';
const meetsPolicy = (v) => v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);

function checkNewPassword(data) {
  requireFields(data, { currentPassword: 'A senha atual', newPassword: 'A nova senha', confirmation: 'A confirmação' });
  if (!meetsPolicy(data.newPassword)) throw validationError({ newPassword: 'A senha não atende à política.' });
  if (data.newPassword !== data.confirmation) {
    throw validationError({ confirmation: 'A confirmação não confere com a nova senha.' });
  }
}

const brand = (title) =>
  el(
    'div',
    { class: 'login-marca' },
    el('div', { class: 'logo' }, 'OL'),
    el('div', { class: 'empresa' }, 'Grupo ON LINE · Controladoria'),
    el('div', { class: 'titulo' }, title),
  );

/** Tela de login (seção 3: usuário e senha individuais). */
export function loginScreen(onLogin) {
  const area = el('div', {});

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        button.textContent = 'Entrando...';
        area.replaceChildren();

        const data = formData(form);
        try {
          requireFields(data, { email: 'O e-mail', password: 'A senha' });
          await onLogin(await api.login(data.email, data.password));
        } catch (error) {
          area.replaceChildren(applyErrors(form, error));
          button.disabled = false;
          button.textContent = 'Entrar';
          form.querySelector('[name="password"]').value = '';
        }
      },
    },
    field({
      name: 'email',
      label: 'E-mail corporativo',
      type: 'email',
      required: true,
      attributes: { autocomplete: 'username', autofocus: true },
    }),
    field({ name: 'password', label: 'Senha', type: 'password', required: true, attributes: { autocomplete: 'current-password' } }),
    el('button', { class: 'btn largo', type: 'submit' }, 'Entrar'),
  );

  return el(
    'div',
    { class: 'login-tela' },
    el(
      'div',
      { class: 'login-caixa' },
      brand('Controle de Vagas'),
      area,
      form,
      el(
        'p',
        { class: 'texto-pequeno texto-fraco', style: { marginTop: '18px', marginBottom: '6px', textAlign: 'center' } },
        'Primeiro acesso? Use a senha provisória fornecida pelo Administrador — o sistema pedirá para trocá-la em seguida.',
      ),
      el(
        'p',
        { class: 'texto-pequeno texto-fraco', style: { margin: '0', textAlign: 'center' } },
        'Acesso individual. O compartilhamento de credenciais é vedado pela política de segurança.',
      ),
    ),
  );
}

const passwordFields = () => [
  field({ name: 'currentPassword', label: 'Senha atual', type: 'password', required: true, attributes: { autocomplete: 'current-password' } }),
  field({ name: 'newPassword', label: 'Nova senha', type: 'password', required: true, help: PASSWORD_HELP, attributes: { autocomplete: 'new-password' } }),
  field({ name: 'confirmation', label: 'Confirme a nova senha', type: 'password', required: true, attributes: { autocomplete: 'new-password' } }),
];

/** Troca obrigatória no primeiro acesso e após redefinição pelo Administrador. */
export function changePasswordScreen(onDone, onLogout) {
  const area = el('div', {});

  const form = el(
    'form',
    {
      onsubmit: async (event) => {
        event.preventDefault();
        const button = form.querySelector('button[type="submit"]');
        button.disabled = true;
        area.replaceChildren();

        const data = formData(form);
        try {
          checkNewPassword(data);
          const user = await api.changePassword(data.currentPassword, data.newPassword);
          toast('Senha alterada com sucesso.', 'sucesso');
          onDone(user);
        } catch (error) {
          area.replaceChildren(applyErrors(form, error));
          button.disabled = false;
        }
      },
    },
    passwordFields(),
    el('button', { class: 'btn largo', type: 'submit' }, 'Alterar senha e continuar'),
    el('button', { class: 'btn secundario largo', type: 'button', style: { marginTop: '8px' }, onclick: onLogout }, 'Sair'),
  );

  return el(
    'div',
    { class: 'login-tela' },
    el(
      'div',
      { class: 'login-caixa' },
      brand('Defina sua senha'),
      infoMessage('Por segurança, a senha fornecida precisa ser trocada antes do primeiro uso do sistema.'),
      area,
      form,
    ),
  );
}

/** Troca voluntária da própria senha (botão "Senha" no topo). */
export function openChangePassword() {
  formModal({
    title: 'Trocar senha',
    fields: passwordFields(),
    submitText: 'Alterar senha',
    submit: async (data) => {
      checkNewPassword(data);
      await api.changePassword(data.currentPassword, data.newPassword);
      toast('Senha alterada com sucesso.', 'sucesso');
    },
  });
}

import { config } from '../config.js';

/**
 * Envio de e-mail pela API HTTP do provedor configurado (MailerSend ou SendGrid), com o fetch nativo do Node — sem a
 * biblioteca de nenhum dos dois, que traria dependências para uma única chamada HTTP. Desligado (ou sem chave), o
 * e-mail só é registrado no log.
 *
 * A falha diz à caixa de saída (jobs.js) o que fazer com a mensagem:
 *   - retryLater: limite do provedor (429). Tenta de novo depois, SEM gastar tentativa. O plano gratuito do
 *     MailerSend tem 100 e-mails por dia; com 5 tentativas a cada 30 s, o limite diário descartava a mensagem em
 *     2,5 minutos, e ela se perdia embora fosse ser aceita no dia seguinte.
 *   - permanent: o provedor recusou o conteúdo (remetente não verificado, destinatário inválido ou suprimido). Repetir
 *     só gastaria a cota: a mensagem falha de vez, com o motivo gravado.
 *   - nenhum dos dois: falha passageira (rede, 5xx), tentada de novo até o limite de tentativas.
 */
export class EmailError extends Error {
  constructor(message, { retryLater = false, permanent = false, retryAfterSeconds = null } = {}) {
    super(message);
    this.retryLater = retryLater;
    this.permanent = permanent;
    this.retryAfterSeconds = retryAfterSeconds;
  }
}

const TIMEOUT_MS = 15_000;

export async function sendEmail(to, subject, html) {
  const { enabled, apiKey, fromEmail, provider } = config.email;
  if (!enabled || !apiKey || !fromEmail) {
    console.log(`[e-mail] envio desabilitado. Para: ${to} | Assunto: ${subject}`);
    return;
  }
  await (provider === 'mailersend' ? sendWithMailerSend : sendWithSendGrid)(to, subject, html);
}

/** MailerSend: POST /v1/email, 202 com o x-message-id quando aceita. */
async function sendWithMailerSend(to, subject, html) {
  const { apiKey, fromEmail, fromName } = config.email;
  const response = await fetch('https://api.mailersend.com/v1/email', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ from: { email: fromEmail, name: fromName }, to: [{ email: to }], subject, html }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  const body = await response.text();
  if (response.status === 202) {
    // Aceito, mas com o destinatário na lista de supressão (bounce anterior, descadastro): não foi enviado.
    if (/ALL_SUPPRESSED/.test(body)) {
      throw new EmailError(`MailerSend não enviou: o destinatário está na lista de supressão. ${body.slice(0, 300)}`,
        { permanent: true });
    }
    return;
  }
  throw failure('MailerSend', response, body);
}

/** SendGrid: POST /v3/mail/send, 202 quando aceita. */
async function sendWithSendGrid(to, subject, html) {
  const { apiKey, fromEmail, fromName } = config.email;
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (response.ok) return;
  throw failure('SendGrid', response, await response.text());
}

function failure(provider, response, body) {
  const message = `${provider} retornou ${response.status}: ${body.slice(0, 500)}`;
  if (response.status === 429) {
    const header = response.headers.get('retry-after');
    const seconds = header === null ? NaN : Number(header);
    return new EmailError(message, { retryLater: true, retryAfterSeconds: Number.isFinite(seconds) ? seconds : null });
  }
  // 401/403: chave inválida ou sem permissão de envio. É configuração, não a mensagem: guarda tudo para sair assim
  // que a chave for corrigida, em vez de descartar os avisos.
  if (response.status === 401 || response.status === 403) {
    return new EmailError(`${message} — confira a chave da API e a permissão de envio de e-mail.`, { retryLater: true });
  }
  // 400/422: conteúdo recusado (destinatário inválido, remetente de domínio não verificado). Repetir não resolve.
  return new EmailError(message, { permanent: response.status === 400 || response.status === 422 });
}

import nodemailer from 'nodemailer';
import { blockedSmtpPortHint, config, emailMissing } from '../config.js';

/**
 * Envio de e-mail pelo provedor configurado: SMTP (nodemailer, como na aplicação financeira — com o MailerSend em
 * smtp.mailersend.net) ou a API HTTP do MailerSend ou do SendGrid, com o fetch nativo. Desligado ou incompleto, o
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
  if (emailMissing().length) {
    console.log(`[e-mail] envio desabilitado. Para: ${to} | Assunto: ${subject}`);
    return;
  }
  const send = { smtp: sendWithSmtp, mailersend: sendWithMailerSend, sendgrid: sendWithSendGrid }[config.email.provider];
  await send(to, subject, html);
}

// ---------------------------------------------------------------- SMTP

let transport = null;
let transportKey = '';

/** Uma conexão (pool) por configuração: abrir uma por e-mail gastaria um handshake TLS e um login em cada aviso. */
function smtpTransport() {
  const { host, port, secure, requireTls, user, password } = config.email.smtp;
  const key = JSON.stringify([host, port, secure, requireTls, user, password]);
  if (transport && key === transportKey) return transport;
  transport?.close();
  transport = nodemailer.createTransport({
    host, port, secure, requireTLS: !secure && requireTls, pool: true, maxConnections: 2,
    auth: user ? { user, pass: password } : undefined,
    connectionTimeout: 15_000, greetingTimeout: 15_000, socketTimeout: 30_000,
  });
  transportKey = key;
  return transport;
}

async function sendWithSmtp(to, subject, html) {
  const { fromEmail, fromName } = config.email;
  try {
    await smtpTransport().sendMail({ from: { name: fromName, address: fromEmail }, to, subject, html });
  } catch (error) {
    throw smtpFailure(error);
  }
}

/**
 * Erro SMTP → decisão da caixa de saída. 4xx é temporário pela RFC 5321 (inclui o limite de envio do provedor);
 * 5xx recusa a mensagem; login, TLS e conexão são configuração ou rede — esperar não perde o aviso.
 */
function smtpFailure(error) {
  const code = Number(error.responseCode) || null;
  const detail = `SMTP ${code ?? error.code ?? 'erro'}: ${String(error.response ?? error.message).slice(0, 500)}`;
  if (error.code === 'EAUTH' || code === 530 || code === 534 || code === 535) {
    return new EmailError(`${detail} — confira SMTP_USUARIO e SMTP_SENHA.`, { retryLater: true });
  }
  if (error.code === 'ETLS') return new EmailError(`${detail} — o servidor não ofereceu TLS; confira SMTP_PORTA e SMTP_SEGURO.`, { retryLater: true });
  if (['ECONNECTION', 'ETIMEDOUT', 'EDNS', 'ESOCKET'].includes(error.code) && !code) {
    const hint = blockedSmtpPortHint();
    return new EmailError(`${detail} — sem conexão com ${config.email.smtp.host}:${config.email.smtp.port}`
      + `${hint ? `; ${hint}` : '.'}`, { retryLater: true });
  }
  if (code >= 400 && code < 500) return new EmailError(detail, { retryLater: true });
  if (code >= 500) return new EmailError(detail, { permanent: true });
  return new EmailError(detail);
}

/** Para os testes e o encerramento: fecha a conexão SMTP. */
export function closeSmtp() {
  transport?.close();
  transport = null;
  transportKey = '';
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

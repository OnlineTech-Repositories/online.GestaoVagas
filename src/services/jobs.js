import { config } from '../config.js';
import { query, queryOne } from '../db/index.js';
import { entity } from '../db/model.js';
import { listExpiredFixedEnd } from '../db/repository.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { formatBr, localTime, localWeekday, today as todayDate, utcNow } from '../domain/dates.js';
import { EmailStatus, NotificationTypes, ParameterKeys, Roles } from '../domain/enums.js';
import { closeByContractEnd } from '../domain/position.js';
import { links, notify } from './notifications.js';
import { getText } from './parameters.js';
import { describe } from './positions.js';

/**
 * Rotinas em segundo plano, no próprio processo (como na aplicação financeira): sem agendador externo nem fila.
 *
 *  - Rotina diária (seção 10.2): dias úteis, a partir de DAILY_DIGEST_TIME (America/Sao_Paulo). Confere a cada
 *    minuto; se o servidor estava fora do ar no horário (o plano gratuito do Render adormece), roda ao acordar.
 *  - Caixa de saída de e-mails: a cada 30 s, até 5 tentativas por mensagem.
 *
 * Os timers usam unref(): não seguram o processo aberto no encerramento.
 */

export const DAILY_JOB = 'DAILY';
const MAX_EMAIL_ATTEMPTS = 5;
let timers = [];

export function startJobs() {
  if (!config.jobsEnabled || timers.length) return;
  const guard = (name, fn) => async () => {
    try {
      await fn();
    } catch (error) {
      console.error(`[rotina] falha em ${name}:`, error);
    }
  };
  const daily = guard('rotina diária', dailyTick);
  const outbox = guard('caixa de saída de e-mails', processOutbox);
  timers = [setInterval(daily, 60_000), setInterval(outbox, 30_000)];
  for (const t of timers) t.unref();
  daily();
  outbox();
}

export function stopJobs() {
  for (const t of timers) clearInterval(t);
  timers = [];
}

async function dailyTick() {
  const weekday = localWeekday();
  if (weekday === 0 || weekday === 6) return;
  if (localTime() < (await getText(ParameterKeys.DailyDigestTime))) return;
  if (await hasRun(todayDate())) return;
  await runDailyJob();
}

export async function hasRun(date) {
  const row = await queryOne('SELECT finished_at FROM job_runs WHERE job_name = ? AND run_date = ?', DAILY_JOB, date);
  return Boolean(row?.finished_at);
}

/**
 * Fase 1: encerra posições FIXED_END com vigência vencida. Idempotente: rodar duas vezes no mesmo dia não duplica
 * encerramentos nem notificações (a posição encerrada sai da consulta).
 */
export async function runDailyJob() {
  const uow = new UnitOfWork({ userId: null, ip: null });
  const today = todayDate();
  let run = uow.load('JobRun', await queryOne('SELECT * FROM job_runs WHERE job_name = ? AND run_date = ?', DAILY_JOB, today));
  if (!run) {
    run = uow.add(entity('JobRun', { jobName: DAILY_JOB, runDate: today, startedAt: utcNow(), finishedAt: null, summary: null }));
  }

  let closed = 0;
  for (const p of await listExpiredFixedEnd(uow, today)) {
    if (!closeByContractEnd(p, today)) continue;
    closed += 1;
    const contract = p.order.contract;
    await notify(uow, {
      type: NotificationTypes.ContractEnded,
      entityId: p.id,
      subject: `Posição encerrada por fim de vigência — Pedido ${p.order.number}`,
      message: `${describe(p)}: encerrada automaticamente em ${formatBr(p.closedAt)} `
        + `por fim de vigência (${formatBr(p.termEndDate)}) sem preenchimento.`,
      link: links.position(p.id),
    }, { roles: [Roles.Nacc], userIds: [contract.commercialOwnerId] });
  }
  run.finishedAt = utcNow();
  run.summary = `Posições encerradas por fim de vigência: ${closed}.`;
  await uow.save({ action: 'DAILY_JOB' });
  console.log(`[rotina] rotina diária de ${formatBr(today)} concluída. ${run.summary}`);
}

/** Envia a caixa de saída; uma falha fica registrada na mensagem e é tentada de novo na próxima volta. */
export async function processOutbox() {
  const uow = new UnitOfWork({ userId: null, ip: null });
  const pending = uow.loadAll('EmailMessage', await query(
    'SELECT * FROM email_messages WHERE status = ? AND attempts < ? ORDER BY created_at LIMIT 50',
    EmailStatus.PENDING, MAX_EMAIL_ATTEMPTS));
  for (const message of pending) {
    message.attempts += 1;
    try {
      await sendEmail(message.toAddress, message.subject, message.htmlBody);
      message.status = EmailStatus.SENT;
      message.sentAt = utcNow();
      message.lastError = null;
    } catch (error) {
      console.warn(`[e-mail] falha ao enviar ${message.id} (tentativa ${message.attempts}): ${error.message}`);
      message.lastError = String(error.message).slice(0, 2000);
      if (message.attempts >= MAX_EMAIL_ATTEMPTS) message.status = EmailStatus.FAILED;
    }
    await uow.save();
  }
}

/**
 * Envio pela API v3 do SendGrid, com o fetch nativo do Node — sem a biblioteca do SendGrid, que traria dependências
 * para uma única chamada HTTP. Desligado (ou sem chave), o e-mail só é registrado no log.
 */
export async function sendEmail(to, subject, html) {
  const { enabled, apiKey, fromEmail, fromName } = config.sendgrid;
  if (!enabled || !apiKey) {
    console.log(`[e-mail] envio desabilitado. Para: ${to} | Assunto: ${subject}`);
    return;
  }
  const response = await fetch('https://api.sendgrid.com/v3/mail/send', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      personalizations: [{ to: [{ email: to }] }],
      from: { email: fromEmail, name: fromName },
      subject,
      content: [{ type: 'text/html', value: html }],
    }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`SendGrid retornou ${response.status}: ${(await response.text()).slice(0, 500)}`);
}

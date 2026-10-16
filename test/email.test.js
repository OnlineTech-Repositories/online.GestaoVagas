import './env.js';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSafeConfig, config } from '../src/config.js';
import { query, queryOne } from '../src/db/index.js';
import { entity } from '../src/db/model.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { EmailError, sendEmail } from '../src/services/email.js';
import { processOutbox, resumeOutbox } from '../src/services/jobs.js';
import { startServer } from './server.js';

/**
 * Envio de e-mail pelo MailerSend (e SendGrid) e a caixa de saída diante das respostas do provedor. O fetch é
 * substituído: nada sai para a internet.
 */

let server;
const realFetch = globalThis.fetch;
const original = { ...config.email };
let calls = [];

/** Responde cada chamada com a próxima resposta da lista (status, corpo, cabeçalhos). */
function provider(...responses) {
  calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    const [status, body = '', headers = {}] = responses.shift() ?? [202];
    return new Response(status === 202 && !body ? null : body, { status, headers });
  };
}

before(async () => {
  server = await startServer();
});

afterEach(() => {
  globalThis.fetch = realFetch;
  Object.assign(config.email, original);
  resumeOutbox();
});

after(async () => {
  await server?.close();
});

const mailersend = () => Object.assign(config.email, {
  provider: 'mailersend', enabled: true, apiKey: 'mlsn.teste', fromEmail: 'avisos@empresa.com.br', fromName: 'Controle de Vagas',
});

test('MailerSend: POST /v1/email com Bearer, remetente, destinatário, assunto e HTML', async () => {
  mailersend();
  provider([202, '', { 'x-message-id': 'abc123' }]);
  await sendEmail('maria@empresa.com.br', 'Assunto', '<p>Olá</p>');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.mailersend.com/v1/email');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer mlsn.teste');
  assert.deepEqual(calls[0].body, {
    from: { email: 'avisos@empresa.com.br', name: 'Controle de Vagas' },
    to: [{ email: 'maria@empresa.com.br' }],
    subject: 'Assunto',
    html: '<p>Olá</p>',
  });
});

test('desligado, sem chave ou sem remetente: não chama o provedor', async () => {
  for (const change of [{ enabled: false }, { apiKey: '' }, { fromEmail: '' }]) {
    mailersend();
    Object.assign(config.email, change);
    provider();
    await sendEmail('maria@empresa.com.br', 'Assunto', '<p>x</p>');
    assert.equal(calls.length, 0, JSON.stringify(change));
  }
});

test('respostas do provedor viram a decisão certa para a caixa de saída', async () => {
  mailersend();
  const outcome = async (...response) => {
    provider(response);
    try {
      await sendEmail('maria@empresa.com.br', 'Assunto', '<p>x</p>');
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof EmailError);
      return error.retryLater ? `depois:${error.retryAfterSeconds}` : error.permanent ? 'definitiva' : 'passageira';
    }
  };
  assert.equal(await outcome(202), 'ok');
  assert.equal(await outcome(202, '{"warnings":[{"type":"ALL_SUPPRESSED"}]}'), 'definitiva');
  assert.equal(await outcome(422, '{"message":"The from.email domain must be verified"}'), 'definitiva');
  assert.equal(await outcome(429, '{"message":"limit"}', { 'retry-after': '120' }), 'depois:120');
  assert.equal(await outcome(429, '{"message":"limit"}'), 'depois:null');
  assert.equal(await outcome(401, '{"message":"Unauthenticated."}'), 'depois:null');
  assert.equal(await outcome(500, 'erro'), 'passageira');
});

test('SendGrid continua funcionando quando é o provedor escolhido', async () => {
  Object.assign(config.email, { provider: 'sendgrid', enabled: true, apiKey: 'SG.teste', fromEmail: 'avisos@empresa.com.br' });
  provider([202]);
  await sendEmail('maria@empresa.com.br', 'Assunto', '<p>x</p>');
  assert.equal(calls[0].url, 'https://api.sendgrid.com/v3/mail/send');
  assert.deepEqual(calls[0].body.personalizations, [{ to: [{ email: 'maria@empresa.com.br' }] }]);
});

test('caixa de saída: limite pausa sem gastar tentativa, recusa falha de vez, erro passageiro tenta de novo', async () => {
  mailersend();
  const uow = new UnitOfWork({});
  const ids = ['a@empresa.com.br', 'b@empresa.com.br', 'c@empresa.com.br'].map((to, i) => uow.add(entity('EmailMessage', {
    toAddress: to, subject: `Mensagem ${i + 1}`, htmlBody: '<p>x</p>', status: 'PENDING', attempts: 0, lastError: null, sentAt: null,
  })).id);
  await uow.save();
  const state = async (id) => queryOne('SELECT status, attempts, last_error FROM email_messages WHERE id = ?', id);

  // 1ª aceita; 2ª bate no limite diário: a caixa pausa e a 3ª nem é tentada.
  provider([202], [429, '{"message":"MS42901 daily quota"}', { 'retry-after': '3600' }]);
  await processOutbox();
  assert.deepEqual({ ...(await state(ids[0])), last_error: null }, { status: 'SENT', attempts: 1, last_error: null });
  const limited = await state(ids[1]);
  assert.equal(limited.status, 'PENDING');
  assert.equal(limited.attempts, 0, 'o limite não gasta tentativa');
  assert.match(limited.last_error, /429/);
  assert.equal((await state(ids[2])).attempts, 0);

  provider();
  await processOutbox();
  assert.equal(calls.length, 0, 'pausada: não chama o provedor de novo antes do retry-after');

  // Depois da pausa: a 2ª é recusada de vez (422); a 3ª tem erro passageiro e continua na fila.
  resumeOutbox();
  provider([422, '{"message":"invalid recipient"}'], [503, 'indisponível']);
  await processOutbox();
  assert.deepEqual({ ...(await state(ids[1])), last_error: null }, { status: 'FAILED', attempts: 1, last_error: null });
  assert.deepEqual({ ...(await state(ids[2])), last_error: null }, { status: 'PENDING', attempts: 1, last_error: null });
  const sent = await query("SELECT COUNT(*) AS n FROM email_messages WHERE status = 'SENT'");
  assert.equal(Number(sent[0].n), 1);
});

test('provedor inválido impede a partida', () => {
  config.email.provider = 'mailgun';
  assert.throws(() => assertSafeConfig(), /EMAIL_PROVEDOR="mailgun" é inválido: use mailersend ou sendgrid/);
});

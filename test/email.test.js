import './env.js';
import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { assertSafeConfig, blockedSmtpPortHint, config, configurationWarnings, parseSender } from '../src/config.js';
import { query, queryOne } from '../src/db/index.js';
import { entity } from '../src/db/model.js';
import { UnitOfWork } from '../src/db/unit-of-work.js';
import { closeSmtp, EmailError, sendEmail } from '../src/services/email.js';
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
  assert.throws(() => assertSafeConfig(), /EMAIL_PROVEDOR="mailgun" é inválido: use smtp, mailersend ou sendgrid/);
});

test('no Render, SMTP nas portas 25, 465 ou 587 gera aviso na partida (bloqueadas no plano gratuito); 2525 não', () => {
  const platform = config.platform;
  try {
    config.platform = 'Render';
    for (const [port, blocked] of [[587, true], [465, true], [25, true], [2525, false]]) {
      Object.assign(config.email, {
        provider: 'smtp', enabled: true, fromEmail: 'avisos@empresa.com.br',
        smtp: { host: 'smtp.mailersend.net', port, secure: false, requireTls: true, user: 'usuario-smtp', password: 'x' },
      });
      const warning = configurationWarnings().find((w) => w.startsWith('E-mail por SMTP não vai sair'));
      assert.equal(Boolean(warning), blocked, `porta ${port}`);
      if (blocked) assert.match(warning, new RegExp(`porta ${port}: use SMTP_PORTA=2525`));
    }
    config.platform = null;
    assert.equal(blockedSmtpPortHint(), '', 'fora do Render não há bloqueio a avisar');
  } finally {
    config.platform = platform;
  }
});

test('remetente no formato "Nome <e-mail>" (como na aplicação financeira) ou só o e-mail', () => {
  assert.deepEqual(parseSender('Sistema de Gestão de Vaga <avisos@sistemas.empresa.com.br>'),
    { name: 'Sistema de Gestão de Vaga', email: 'avisos@sistemas.empresa.com.br' });
  assert.deepEqual(parseSender('"Controle de Vagas" <avisos@empresa.com.br>'), { name: 'Controle de Vagas', email: 'avisos@empresa.com.br' });
  assert.deepEqual(parseSender(' avisos@empresa.com.br '), { name: '', email: 'avisos@empresa.com.br' });
  assert.deepEqual(parseSender(undefined), { name: '', email: '' });
});

// ---------------------------------------------------------------- SMTP, contra um servidor simulado

/**
 * Servidor SMTP mínimo (RFC 5321) em porta efêmera: anuncia AUTH, guarda o que recebe e responde cada etapa com o
 * código configurado — para exercitar o nodemailer de verdade, sem rede e sem credencial real.
 */
async function fakeSmtp(replies = {}) {
  const received = [];
  const server = createServer((socket) => {
    const mail = { auth: null, from: null, to: [], data: '' };
    let inData = false;
    let buffer = '';
    const say = (line) => socket.write(`${line}\r\n`);
    say('220 smtp.teste ESMTP');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let index;
      while ((index = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 2);
        if (inData) {
          if (line === '.') {
            inData = false;
            received.push({ ...mail });
            say(replies.data ?? '250 2.0.0 OK enfileirada');
          } else mail.data += `${line}\n`;
          continue;
        }
        const verb = line.split(' ')[0].toUpperCase();
        if (verb === 'EHLO') say('250-smtp.teste\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME');
        else if (verb === 'AUTH') {
          mail.auth = Buffer.from(line.split(' ')[2] ?? '', 'base64').toString('utf8').split('\0').slice(1);
          say(replies.auth ?? '235 2.7.0 Autenticado');
        } else if (verb === 'MAIL') {
          mail.from = line;
          say(replies.mail ?? '250 OK');
        } else if (verb === 'RCPT') {
          mail.to.push(line);
          say(replies.rcpt ?? '250 OK');
        } else if (verb === 'DATA') {
          inData = true;
          say('354 Pode enviar');
        } else if (verb === 'RSET' || verb === 'NOOP') say('250 OK');
        else if (verb === 'QUIT') {
          say('221 Tchau');
          socket.end();
        } else say('502 Comando não implementado');
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: server.address().port, received, close: () => new Promise((resolve) => server.close(resolve)) };
}

const smtpConfig = (port, change = {}) => Object.assign(config.email, {
  provider: 'smtp', enabled: true, apiKey: '', fromEmail: 'avisos@sistemas.empresa.com.br', fromName: 'Sistema de Gestão de Vaga',
  // O servidor simulado não tem TLS: só aqui o STARTTLS deixa de ser exigido.
  smtp: { host: '127.0.0.1', port, secure: false, requireTls: false, user: 'usuario-smtp@sistemas.empresa.com.br', password: 'segredo', ...change },
});

test('SMTP: autentica, envia com o remetente "Nome <e-mail>", destinatário, assunto e HTML', async () => {
  const smtp = await fakeSmtp();
  try {
    smtpConfig(smtp.port);
    await sendEmail('maria@empresa.com.br', 'Posição em risco', '<p>Prazo do SLA</p>');
    assert.equal(smtp.received.length, 1);
    const [mail] = smtp.received;
    assert.deepEqual(mail.auth, ['usuario-smtp@sistemas.empresa.com.br', 'segredo']);
    assert.match(mail.from, /^MAIL FROM:<avisos@sistemas\.empresa\.com\.br>/);
    assert.deepEqual(mail.to, ['RCPT TO:<maria@empresa.com.br>']);
    // Cabeçalho longo pode vir dobrado em duas linhas (RFC 5322): quebra seguida de espaço.
    assert.match(mail.data, /^From: =\?UTF-8\?Q\?Sistema_de_Gest=C3=A3o_de_Vaga\?=\s+<avisos@sistemas\.empresa\.com\.br>$/m);
    assert.match(mail.data, /^Subject: =\?UTF-8\?Q\?Posi=C3=A7=C3=A3o_em_risco\?=$/m);
    assert.match(mail.data, /<p>Prazo do SLA<\/p>/);
  } finally {
    closeSmtp();
    await smtp.close();
  }
});

test('SMTP: login recusado e limite (4xx) esperam; destinatário recusado (5xx) falha de vez; sem conexão espera', async () => {
  const outcome = async (replies, change = {}) => {
    const smtp = await fakeSmtp(replies);
    try {
      smtpConfig(change.port ?? smtp.port, change);
      await sendEmail('maria@empresa.com.br', 'Assunto', '<p>x</p>');
      return 'ok';
    } catch (error) {
      assert.ok(error instanceof EmailError, error.message);
      return error.retryLater ? 'depois' : error.permanent ? 'definitiva' : 'passageira';
    } finally {
      closeSmtp();
      await smtp.close();
    }
  };
  assert.equal(await outcome({}), 'ok');
  assert.equal(await outcome({ auth: '535 5.7.8 Credenciais inválidas' }), 'depois');
  assert.equal(await outcome({ mail: '451 4.7.1 Limite de envio atingido' }), 'depois');
  assert.equal(await outcome({ rcpt: '550 5.1.1 Destinatário inexistente' }), 'definitiva');
  assert.equal(await outcome({ data: '554 5.7.1 Remetente não verificado' }), 'definitiva');
  const closedPort = await fakeSmtp().then(async (s) => {
    await s.close();
    return s.port;
  });
  assert.equal(await outcome({}, { port: closedPort }), 'depois');
});

test('SMTP exige STARTTLS por padrão: servidor sem TLS não recebe a senha', async () => {
  const smtp = await fakeSmtp();
  try {
    smtpConfig(smtp.port, { requireTls: true });
    await assert.rejects(sendEmail('maria@empresa.com.br', 'Assunto', '<p>x</p>'),
      (error) => error instanceof EmailError && error.retryLater && /TLS/.test(error.message));
    assert.equal(smtp.received.length, 0);
  } finally {
    closeSmtp();
    await smtp.close();
  }
});

test('modelo dos e-mails: estrutura padrão, campos vazios fora do quadro e texto de usuário escapado', async () => {
  const { renderLayout } = await import('../src/services/email-layout.js');
  const body = renderLayout({
    recipientName: 'Ana <script>', title: 'Valor por cargo aguardando validação', summary: 'Resumo do evento.',
    status: { label: 'Pendente de validação', tone: 'warning' },
    fields: [['Cargo', 'Auxiliar & Cia'], ['Fee', null], ['Valor mensal', 'R$ 3.763,34', { strong: true }]],
    action: 'Valide o valor.', button: 'Acessar validação', link: 'https://exemplo.invalid/#/valores',
  });
  assert.match(body, /<meta name="viewport" content="width=device-width, initial-scale=1">/, 'leitura no celular');
  assert.match(body, /max-width:600px/);
  assert.match(body, /Olá, Ana &lt;script&gt;\./, 'nome escapado');
  assert.match(body, /Auxiliar &amp; Cia/);
  assert.doesNotMatch(body, />Fee</, 'campo sem valor fica fora do quadro');
  assert.match(body, /Pendente de validação/);
  assert.match(body, /O que fazer:<\/strong> Valide o valor\./);
  assert.match(body, /href="https:\/\/exemplo\.invalid\/#\/valores"[^>]*>Acessar validação</);
  assert.match(body, /Mensagem automática do Sistema de Controle de Vagas — Grupo ON LINE\./);
  assert.match(body, /Controle de Vagas<\/div>/, 'identificação do sistema em texto, mesmo sem a imagem');
});

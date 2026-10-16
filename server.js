import express from 'express';
import { createApp } from './src/app.js';
import { assertSafeConfig, config, configurationWarnings } from './src/config.js';
import { connect, describeDatabase, disconnect } from './src/db/index.js';
import { startJobs, stopJobs } from './src/services/jobs.js';

/**
 * Partida resiliente, no modelo da aplicação financeira.
 *
 * Banco indisponível não pode derrubar o processo: na plataforma isso vira ciclo de reinício — o serviço nunca fica
 * de pé e o log mostra só reinícios, sem o motivo. Aqui o servidor HTTP sobe de qualquer forma, responde 503 com o
 * destino e o erro (sem a senha) e tenta de novo a cada 30 segundos; quando o banco responde, passa a atender
 * normalmente, sem reinício manual.
 *
 * A configuração perigosa, ao contrário, impede a partida (assertSafeConfig): banco SQLite numa plataforma que apaga
 * o disco a cada deploy perderia todos os dados sem aviso.
 */
try {
  assertSafeConfig();
} catch (error) {
  console.error(`
  A APLICAÇÃO NÃO FOI INICIADA: ${error.message}
`);
  process.exit(1);
}

let application = null;
let lastFailure = null;

async function prepare() {
  try {
    await connect();
    application = await createApp();
    lastFailure = null;
    return true;
  } catch (error) {
    lastFailure = error;
    await disconnect().catch(() => {});
    return false;
  }
}

const ready = await prepare();
if (!ready) reportFailure();

const server = express();
server.disable('x-powered-by');
server.use((req, res, next) => {
  if (application) return application(req, res, next);
  const body = {
    status: 503,
    title: 'Serviço indisponível',
    detail: `Banco de dados indisponível (${describeDatabase()}): `
      + `${String(lastFailure?.message ?? 'aguardando conexão').replace(/\.+$/, '')}. Nova tentativa automática a cada 30 s.`,
  };
  res.status(503).setHeader('Retry-After', '30');
  if (req.path.startsWith('/api/')) return res.json(body);
  return res.type('text/plain').send(body.detail);
});

if (!ready) {
  const retry = setInterval(async () => {
    if (await prepare()) {
      clearInterval(retry);
      console.log('  Banco de dados disponível: aplicação operando normalmente.');
      startJobs();
    }
  }, 30_000);
  retry.unref();
}

const listener = server.listen(config.port, config.host, () => {
  console.log('');
  console.log('  Controle de Vagas — Grupo ON LINE');
  console.log(`  Versão:     ${config.version} | ambiente ${config.environment} | plataforma ${config.platform ?? 'local'}`);
  console.log(`  Endereço:   http://localhost:${config.port}`);
  console.log(`  Banco:      ${describeDatabase()}`);
  console.log(`  Estado:     ${application ? 'operando' : 'DEGRADADO — sem banco (respondendo 503)'}`);
  console.log(`  Proxy:      ${config.trustProxy ? 'confiável (X-Forwarded-*)' : 'não confiável'}`);
  const email = config.email;
  console.log(`  E-mail:     ${email.enabled && email.apiKey ? `${email.provider === 'mailersend' ? 'MailerSend' : 'SendGrid'} `
    + `(${email.fromEmail})` : 'desligado (só log)'}`);
  for (const warning of configurationWarnings()) console.log(`  ATENÇÃO:    ${warning}`);
  console.log('');
  if (application) startJobs();
});

function reportFailure() {
  console.error('');
  console.error('  BANCO DE DADOS INDISPONÍVEL — a aplicação subiu em modo degradado (503).');
  console.error(`  Destino: ${describeDatabase()}`);
  console.error(`  Erro:    ${lastFailure?.message}`);
  console.error('  Verifique a DATABASE_URL (no Render, a Internal Database URL do banco, na mesma região do serviço).');
  console.error('  A reconexão é tentada a cada 30 segundos, sem precisar reiniciar.');
  console.error('');
}

function shutdown(signal) {
  console.log(`\n  Encerrando (${signal})...`);
  stopJobs();
  listener.close(async () => {
    await disconnect().catch(() => {});
    process.exit(0);
  });
  // Conexões abertas (keep-alive) podem segurar o fechamento: força a saída.
  setTimeout(() => process.exit(0), 5000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

/**
 * Uma falha de conexão ociosa com o banco chega aqui como rejeição não tratada e derrubaria o servidor por uma falha
 * que não afeta requisição nenhuma: registra e segue (o pool reconecta na próxima consulta).
 */
process.on('unhandledRejection', (reason) => console.error('[falha assíncrona não tratada]', reason));

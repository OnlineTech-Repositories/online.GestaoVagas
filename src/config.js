import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Configuração da aplicação. É o ÚNICO módulo que lê process.env: o resto importa `config`.
 *
 * Nenhuma credencial fica no código. Localmente, um arquivo .env (fora do Git) é lido por um leitor próprio de
 * poucas linhas; em produção, as variáveis do serviço (Render). Variáveis já presentes no ambiente têm precedência
 * sobre o .env, para que a plataforma configure o serviço sem editar arquivo.
 */

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function loadDotEnv() {
  const path = process.env.ENV_FILE || join(root, '.env');
  if (!existsSync(path)) return;
  for (const line of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const text = line.trim();
    if (!text || text.startsWith('#')) continue;
    const eq = text.indexOf('=');
    if (eq === -1) continue;
    const key = text.slice(0, eq).trim();
    let value = text.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = value;
  }
}

loadDotEnv();

const env = process.env;
const num = (value, fallback) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : fallback;
};
const bool = (value, fallback) => (value === undefined || value === '' ? fallback : /^(1|true|sim|yes)$/i.test(value));

/**
 * Plataformas de disco efêmero: o sistema de arquivos é descartado a cada deploy (e, no plano gratuito do Render,
 * quando o serviço adormece). Nelas o banco precisa ser o PostgreSQL — um arquivo SQLite sumiria com todos os dados.
 */
const PLATFORM = env.RENDER ? 'Render' : env.WEBSITE_SITE_NAME ? 'Azure App Service' : null;

/** Versão publicada, lida do package.json: fonte única (exibida no menu pela /api/saude). */
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;

/**
 * Conexão PostgreSQL. A plataforma entrega a URL (postgresql://usuario:senha@host/banco) em DATABASE_URL. O nome da
 * versão .NET (ConnectionStrings__Default) continua aceito, como URL ou no formato Host=...;Database=...: o serviço
 * no Render já tinha sido configurado com ele, e trocar de nome sem aviso deixaria a aplicação sem banco.
 *
 * DATABASE_URL passa pela mesma conversão. No primeiro deploy ela chegou no formato Host=...;Database=... (o guia da
 * versão .NET mandava montar assim) e o pg, que resolve texto sem esquema contra a base fictícia 'postgres://base',
 * respondeu "getaddrinfo ENOTFOUND base" — um erro que não diz nada a quem lê. Aspas coladas junto com o valor no
 * painel da plataforma produziam o mesmo efeito.
 */
const databaseUrl = connectionStringToUrl(env.DATABASE_URL) || connectionStringToUrl(env.ConnectionStrings__Default);

/**
 * Normaliza a conexão para URL. Formato não reconhecido volta como veio: o driver recusa com a mensagem do que
 * corrigir, em vez de a aplicação cair no SQLite em silêncio. Exportada para teste.
 */
export function connectionStringToUrl(value) {
  let text = String(value ?? '').trim();
  if (/^(["']).*\1$/.test(text)) text = text.slice(1, -1).trim();
  if (!text) return '';
  if (/^postgres(ql)?:\/\//i.test(text)) return text;
  const parts = Object.fromEntries(text.split(';').filter((p) => p.includes('=')).map((p) => {
    const eq = p.indexOf('=');
    return [p.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ''), p.slice(eq + 1).trim()];
  }));
  const host = parts.host ?? parts.server;
  if (!host) return text;
  const user = parts.username ?? parts.userid ?? parts.user ?? '';
  const auth = user ? `${encodeURIComponent(user)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ''}@` : '';
  const ssl = parts.sslmode ? `?sslmode=${parts.sslmode.toLowerCase()}` : '';
  return `postgresql://${auth}${host}${parts.port ? `:${parts.port}` : ''}/${encodeURIComponent(parts.database ?? '')}${ssl}`;
}

const environment = (env.NODE_ENV || 'production').trim().toLowerCase();

/** Provedores de e-mail aceitos: SMTP (nodemailer) ou a API HTTP do MailerSend ou do SendGrid (services/email.js). */
export const EMAIL_PROVIDERS = Object.freeze(['smtp', 'mailersend', 'sendgrid']);

/** Remetente "Nome <email@dominio>" (formato da aplicação financeira) ou só o e-mail → { name, email }. */
export function parseSender(value) {
  const text = String(value ?? '').trim();
  const match = /^(.*?)\s*<\s*([^<>\s]+@[^<>\s]+)\s*>$/.exec(text);
  return match ? { name: match[1].replace(/^"|"$/g, '').trim(), email: match[2] } : { name: '', email: text };
}

/**
 * E-mail. EMAIL_PROVEDOR escolhe o serviço; sem ele, vale SMTP se houver SMTP_HOST, senão o MailerSend se houver
 * MAILERSEND_API_KEY, senão o SendGrid.
 *
 * As variáveis SMTP_* e URL_BASE têm os nomes da aplicação financeira: o serviço em homologação foi configurado com
 * eles, copiados de lá, e a aplicação as ignorava — os avisos saíam só no log. SENDGRID_* (e SendGrid__* da versão
 * .NET) continuam aceitos.
 */
function emailConfig() {
  const provider = (env.EMAIL_PROVEDOR || (env.SMTP_HOST ? 'smtp' : env.MAILERSEND_API_KEY ? 'mailersend' : 'sendgrid'))
    .trim().toLowerCase();
  const sender = parseSender(env.EMAIL_REMETENTE || env.SMTP_REMETENTE || env.SENDGRID_REMETENTE || env.SendGrid__FromEmail);
  const port = num(env.SMTP_PORTA, 587);
  return {
    provider,
    enabled: bool(env.EMAIL_ATIVO ?? env.SMTP_ATIVO ?? env.SENDGRID_ATIVO ?? env.SendGrid__Enabled, false),
    apiKey: provider === 'mailersend' ? env.MAILERSEND_API_KEY || ''
      : provider === 'sendgrid' ? env.SENDGRID_API_KEY || env.SendGrid__ApiKey || '' : '',
    smtp: {
      host: env.SMTP_HOST || '',
      port,
      // SMTP_SEGURO=true: TLS desde a conexão (porta 465). false: a conexão começa sem TLS e é EXIGIDO o STARTTLS
      // (porta 587) — sem isso, um servidor que não oferecesse TLS receberia usuário e senha em texto claro.
      secure: bool(env.SMTP_SEGURO, port === 465),
      requireTls: true,
      user: env.SMTP_USUARIO || '',
      password: env.SMTP_SENHA || '',
    },
    fromEmail: sender.email,
    fromName: env.EMAIL_NOME_REMETENTE || sender.name || env.SENDGRID_NOME_REMETENTE || env.SendGrid__FromName
      || 'Controle de Vagas - Grupo ON LINE',
  };
}

/** O que falta para o e-mail sair, pelo nome da variável (vazio = pronto para enviar). */
export function emailMissing(email = config.email) {
  const missing = [];
  if (!email.enabled) missing.push('EMAIL_ATIVO=1 (ou SMTP_ATIVO=true)');
  if (email.provider === 'smtp') {
    if (!email.smtp.host) missing.push('SMTP_HOST');
    if (email.smtp.user && !email.smtp.password) missing.push('SMTP_SENHA');
  } else if (!email.apiKey) {
    missing.push(email.provider === 'mailersend' ? 'MAILERSEND_API_KEY' : 'SENDGRID_API_KEY');
  }
  if (!email.fromEmail) missing.push('EMAIL_REMETENTE (ou SMTP_REMETENTE)');
  return missing;
}

/** Nome do provedor para o log e as mensagens. */
export const emailProviderName = (provider) => ({ smtp: 'SMTP', mailersend: 'MailerSend', sendgrid: 'SendGrid' }[provider] ?? provider);

export const config = {
  root,
  version,
  platform: PLATFORM,
  environment,
  isDevelopment: environment === 'development',

  // PORT é o nome usado pelas plataformas (o Render informa 10000); PORTA vale localmente e tem precedência.
  // `||` e não `??`: variável definida como texto vazio conta como ausente.
  port: num(env.PORTA || env.PORT, 5067),
  host: env.HOST || '0.0.0.0',
  // URL_BASE: o nome da aplicação financeira (o serviço em homologação foi configurado assim).
  baseUrl: (env.BASE_URL || env.URL_BASE || env.App__BaseUrl || '').replace(/\/+$/, ''),

  /**
   * Proxy confiável (X-Forwarded-For/Proto). Na plataforma a aplicação só é alcançável pelo proxy dela, que termina
   * o HTTPS: sem confiar nele, a API se via em HTTP, o cookie Secure não era emitido e o limite de login e a
   * auditoria registravam o IP do proxy para todo mundo.
   */
  trustProxy: bool(env.PROXY_CONFIAVEL, PLATFORM !== null),

  // ---- banco de dados ------------------------------------------------------------------------------------------
  /** 'sqlite' (desenvolvimento e testes) ou 'postgres' (produção). Com a URL definida, o padrão é postgres. */
  dbDriver: (env.DB_DRIVER || (databaseUrl ? 'postgres' : 'sqlite')).trim().toLowerCase(),
  dbFile: env.DB_FILE || join(root, 'dados', 'controle-vagas.db'),
  databaseUrl,
  /** TLS com validação da cadeia quando a URL pede (sslmode=require); a URL interna do Render dispensa. */
  postgresStrictSsl: /sslmode=(require|verify-ca|verify-full)/i.test(databaseUrl),
  postgresMaxConnections: num(env.POSTGRES_MAX_CONEXOES, 10),
  postgresSchema: env.POSTGRES_SCHEMA || 'public',
  postgresTemporarySchema: env.POSTGRES_SCHEMA_TEMPORARIO === '1',
  /** Escape explícito para demonstração com SQLite em plataforma efêmera (os dados somem a cada deploy). */
  allowEphemeralDatabase: bool(env.BANCO_EFEMERO, false),

  // ---- sessão e segurança (seção 12 da SPEC) ---------------------------------------------------------------------
  sessionTimeoutMin: num(env.SESSAO_TIMEOUT_MIN, 30),
  maxLoginAttempts: num(env.MAX_TENTATIVAS_LOGIN, 5),
  lockoutMin: num(env.BLOQUEIO_LOGIN_MIN, 15),
  /** Limite de tentativas de login por IP em 1 minuto (como na API .NET). */
  loginRateLimitPerMinute: num(env.LIMITE_LOGIN_POR_MINUTO, 10),

  // ---- primeiro administrador e dados de demonstração -----------------------------------------------------------
  seed: {
    adminName: env.ADMIN_NOME || env.Seed__AdminName || 'Administrador',
    adminEmail: env.ADMIN_EMAIL || env.Seed__AdminEmail || '',
    adminPassword: env.ADMIN_SENHA || env.Seed__AdminPassword || '',
    demoData: bool(env.DADOS_DEMO ?? env.Seed__DemoData, false),
    demoPassword: env.SENHA_DEMO || env.Seed__DemoPassword || '',
  },

  // ---- e-mail (MailerSend ou SendGrid) -------------------------------------------------------------------------
  email: emailConfig(),

  /** Rotinas em segundo plano (rotina diária e caixa de saída de e-mails). Os testes desligam. */
  jobsEnabled: bool(env.ROTINAS_ATIVAS, true),
};

/**
 * Guardas de partida: recusam configuração que perderia dados sem aviso. Melhor não subir, com a mensagem dizendo o
 * que fazer, do que subir e descobrir no dia seguinte que o banco foi apagado pelo deploy.
 */
export function assertSafeConfig() {
  if (config.platform && config.dbDriver !== 'postgres' && !config.allowEphemeralDatabase) {
    throw new Error(
      `O banco SQLite em ${config.platform} seria apagado a cada deploy ou reinício. ` +
        'Configure o PostgreSQL em DATABASE_URL (a Internal Database URL do banco do Render) ou, só para ' +
        'demonstração, defina BANCO_EFEMERO=1.',
    );
  }
  if (!['sqlite', 'postgres'].includes(config.dbDriver)) {
    throw new Error(`DB_DRIVER="${config.dbDriver}" é inválido: use sqlite ou postgres.`);
  }
  if (!EMAIL_PROVIDERS.includes(config.email.provider)) {
    throw new Error(`EMAIL_PROVEDOR="${config.email.provider}" é inválido: use ${EMAIL_PROVIDERS.slice(0, -1).join(', ')} `
      + `ou ${EMAIL_PROVIDERS.at(-1)}.`);
  }
}

/** Configurações que não impedem a partida, mas desligam uma proteção: ficam visíveis no log de partida. */
export function configurationWarnings() {
  const warnings = [];
  if (config.platform && !config.trustProxy) {
    warnings.push(`PROXY_CONFIAVEL=0 em ${config.platform}: o cookie de sessão não sai como Secure e o IP gravado será o do proxy.`);
  }
  if (!config.isDevelopment && !config.baseUrl) {
    warnings.push('BASE_URL vazio: os links dos e-mails sairão sem endereço.');
  }
  const missing = emailMissing();
  if (missing.length) warnings.push(`E-mail desligado, falta ${missing.join(', ')}: os e-mails ficam só no log.`);
  if (config.dbDriver !== 'postgres' && config.platform) {
    warnings.push('BANCO_EFEMERO ligado: os dados SOMEM a cada deploy. Aceitável só para demonstração.');
  }
  if (config.seed.demoData && !config.isDevelopment) {
    warnings.push('DADOS_DEMO ligado fora de development: usuários de demonstração com senha conhecida.');
  }
  return warnings;
}

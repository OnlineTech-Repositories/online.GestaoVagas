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
 */
const databaseUrl = env.DATABASE_URL || connectionStringToUrl(env.ConnectionStrings__Default);

function connectionStringToUrl(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  if (/^postgres(ql)?:\/\//i.test(text)) return text;
  const parts = Object.fromEntries(text.split(';').filter((p) => p.includes('=')).map((p) => {
    const eq = p.indexOf('=');
    return [p.slice(0, eq).trim().toLowerCase().replace(/\s+/g, ''), p.slice(eq + 1).trim()];
  }));
  const host = parts.host ?? parts.server;
  if (!host) return '';
  const user = parts.username ?? parts.userid ?? parts.user ?? '';
  const auth = user ? `${encodeURIComponent(user)}${parts.password ? `:${encodeURIComponent(parts.password)}` : ''}@` : '';
  const ssl = parts.sslmode ? `?sslmode=${parts.sslmode.toLowerCase()}` : '';
  return `postgresql://${auth}${host}${parts.port ? `:${parts.port}` : ''}/${encodeURIComponent(parts.database ?? '')}${ssl}`;
}

const environment = (env.NODE_ENV || 'production').trim().toLowerCase();

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
  baseUrl: (env.BASE_URL || env.App__BaseUrl || '').replace(/\/+$/, ''),

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

  // ---- e-mail (SendGrid) -----------------------------------------------------------------------------------------
  sendgrid: {
    enabled: bool(env.SENDGRID_ATIVO ?? env.SendGrid__Enabled, false),
    apiKey: env.SENDGRID_API_KEY || env.SendGrid__ApiKey || '',
    fromEmail: env.SENDGRID_REMETENTE || env.SendGrid__FromEmail || '',
    fromName: env.SENDGRID_NOME_REMETENTE || env.SendGrid__FromName || 'Controle de Vagas - Grupo ON LINE',
  },

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
  if (!config.sendgrid.enabled) warnings.push('SENDGRID_ATIVO desligado: os e-mails ficam só no log.');
  if (config.dbDriver !== 'postgres' && config.platform) {
    warnings.push('BANCO_EFEMERO ligado: os dados SOMEM a cada deploy. Aceitável só para demonstração.');
  }
  if (config.seed.demoData && !config.isDevelopment) {
    warnings.push('DADOS_DEMO ligado fora de development: usuários de demonstração com senha conhecida.');
  }
  return warnings;
}

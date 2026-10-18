import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { config } from './config.js';
import { query } from './db/index.js';
import { migrate } from './db/migrations.js';
import { entity } from './db/model.js';
import { UnitOfWork } from './db/unit-of-work.js';
import { PARAMETER_DEFAULTS } from './domain/enums.js';
import {
  handleErrors, loadUser, problem, protectCsrf, readCookies, requireLogin, requirePasswordChange, securityHeaders,
} from './middleware.js';
import { authRoutes, health } from './routes/auth.js';
import { dashboardRoutes, notificationRoutes, terminationRoutes } from './routes/operations.js';
import { orderRoutes } from './routes/orders.js';
import { positionRoutes } from './routes/positions.js';
import { reportRoutes } from './routes/reports.js';
import {
  catalogRoutes, clientRoutes, contractRoutes, parameterRoutes, rateRoutes, userRoutes,
} from './routes/registry.js';
import { seedDemoData } from './db/seed-demo.js';
import { ensureFirstAdmin } from './services/users.js';

const publicDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * Prepara o banco (migrações e dados mínimos) e monta o Express na ordem certa. Devolve o app sem escutar porta:
 * é o que permite aos testes subir a aplicação real em porta efêmera.
 */
export async function createApp() {
  await migrate();
  await seedMinimum();

  const app = express();
  app.disable('x-powered-by');
  // Confiança no proxy só quando declarada (ou detectada a plataforma): com `true` incondicional, qualquer cliente
  // forjaria o X-Forwarded-For e o IP gravado na auditoria.
  app.set('trust proxy', config.trustProxy ? 1 : false);

  app.use(securityHeaders);
  app.use(express.json({ limit: '1mb' }));
  app.use(readCookies);
  app.use(loadUser);
  app.use(protectCsrf);
  app.use(requireLogin);
  app.use(requirePasswordChange);

  app.get('/api/saude', health);
  app.use('/api/auth', authRoutes);
  app.use('/api/orders', orderRoutes);
  app.use('/api/positions', positionRoutes);
  app.use('/api/terminations', terminationRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/notifications', notificationRoutes);
  app.use('/api/clients', clientRoutes);
  app.use('/api/contracts', contractRoutes);
  app.use('/api/contract-rates', rateRoutes);
  app.use('/api/catalogs', catalogRoutes);
  app.use('/api/parameters', parameterRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/reports', reportRoutes);
  app.use('/api', (_req, res) => problem(res, 404, 'Não encontrado', 'Endpoint não encontrado.'));

  // Front-end sem build: os arquivos de public/ são servidos como estão. "no-cache" faz o navegador revalidar (ETag)
  // e pegar a versão nova logo depois de um deploy, em vez de esperar o cache expirar.
  app.use(express.static(publicDir, {
    index: 'index.html',
    etag: true,
    setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
  }));
  app.get('*', (_req, res) => res.sendFile(join(publicDir, 'index.html')));

  app.use(handleErrors); // SEMPRE por último
  return app;
}

/** Parâmetros padrão (D5), o primeiro ADMIN e, se ligados, os dados de demonstração. */
async function seedMinimum() {
  const uow = new UnitOfWork({ userId: null, ip: null });
  const existing = new Set((await query('SELECT param_key FROM system_parameters')).map((r) => r.param_key));
  for (const [key, [value, description]] of Object.entries(PARAMETER_DEFAULTS)) {
    if (!existing.has(key)) uow.add(entity('SystemParameter', { paramKey: key, paramValue: value, description }));
  }
  await uow.save({ action: 'SEED' });
  await ensureFirstAdmin(new UnitOfWork({}), {
    name: config.seed.adminName, email: config.seed.adminEmail, password: config.seed.adminPassword,
  });
  if (config.seed.demoData) await seedDemoData(config.seed.demoPassword);
}

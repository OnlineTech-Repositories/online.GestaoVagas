import { Router } from 'express';
import { route } from '../middleware.js';
import { getDashboard } from '../services/dashboard.js';
import { countUnread, listMine, markAllRead, markRead } from '../services/notifications.js';
import { registerLegacyTermination, registerTermination, searchFilledPositions } from '../services/terminations.js';
import { ID, idParam } from './helpers.js';

export const terminationRoutes = Router();
terminationRoutes.get('/filled-positions', route(async (req, res) =>
  res.json(await searchFilledPositions(req.ctx, req.query.term ?? null))));
terminationRoutes.post('/', route(async (req, res) => res.json(await registerTermination(req.ctx, req.body))));
terminationRoutes.post('/legacy', route(async (req, res) => res.json(await registerLegacyTermination(req.ctx, req.body))));

export const dashboardRoutes = Router();
dashboardRoutes.get('/', route(async (req, res) => res.json(await getDashboard(req.ctx))));

export const notificationRoutes = Router();
notificationRoutes.get('/', route(async (req, res) =>
  res.json(await listMine(req.ctx, /^(true|1)$/i.test(String(req.query.unreadOnly ?? ''))))));
notificationRoutes.get('/unread-count', route(async (req, res) => res.json(await countUnread(req.ctx))));
notificationRoutes.post(`/:id${ID}/read`, route(async (req, res) => {
  await markRead(req.ctx, idParam(req));
  res.status(204).end();
}));
notificationRoutes.post('/read-all', route(async (req, res) => {
  await markAllRead(req.ctx);
  res.status(204).end();
}));

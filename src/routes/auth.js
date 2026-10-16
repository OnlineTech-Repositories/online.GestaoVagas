import { Router } from 'express';
import { config } from '../config.js';
import { clearSessionCookie, issueCsrfToken, limitLogin, problem, route, setSessionCookie } from '../middleware.js';
import { SESSION_COOKIE, checkCredentials, createSession, endSession, meDto, sessionUser } from '../services/auth.js';
import { changeOwnPassword } from '../services/users.js';

export const authRoutes = Router();

/** Saúde e versão: a primeira chamada do front-end (a versão do menu vem daqui) e, por ser GET em /api, emite o CSRF. */
export const health = (_req, res) => res.json({ status: 'ok', versao: config.version });

authRoutes.post('/login', limitLogin, route(async (req, res) => {
  const { user, error } = await checkCredentials(req.body?.email, req.body?.password);
  if (error) return problem(res, 401, 'Não autorizado', error);
  await endSession(req.cookies[SESSION_COOKIE]);
  const token = await createSession(user.id, req.ip, req.get('user-agent'));
  setSessionCookie(req, res, token);
  // Token CSRF novo para a sessão recém-criada.
  issueCsrfToken(req, res);
  res.json(await meDto(await sessionUser(token)));
}));

authRoutes.post('/logout', route(async (req, res) => {
  await endSession(req.cookies[SESSION_COOKIE]);
  clearSessionCookie(res);
  res.status(204).end();
}));

authRoutes.get('/me', route(async (req, res) => {
  res.json(await meDto(req.user));
}));

authRoutes.post('/change-password', route(async (req, res) => {
  await changeOwnPassword(req.ctx, req.body);
  issueCsrfToken(req, res);
  res.json(await meDto(await sessionUser(req.cookies[SESSION_COOKIE])));
}));

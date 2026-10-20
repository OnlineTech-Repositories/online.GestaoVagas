import { Router } from 'express';
import { route } from '../middleware.js';
import * as catalogs from '../services/catalogs.js';
import { getContractDto, listClients, listContracts, saveClient, saveContract } from '../services/clients.js';
import { routeId } from '../services/input.js';
import { listParameters, updateParameter } from '../services/parameters.js';
import { createRate, listRates, rejectRate, updateRate, validateRate } from '../services/rates.js';
import { createUser, listByRole, listUsers, resetPassword, updateUser } from '../services/users.js';
import { RateStatus } from '../domain/enums.js';
import { ID, idParam } from './helpers.js';

/** Cadastros: clientes, contratos, valores por cargo, cadastros auxiliares, parâmetros e usuários. */

const json = (fn) => route(async (req, res) => res.json(await fn(req, res)));

export const clientRoutes = Router();
clientRoutes.get('/', json((req) => listClients(req.ctx)));
clientRoutes.post('/', json((req) => saveClient(req.ctx, null, req.body)));
clientRoutes.put(`/:id${ID}`, json((req) => saveClient(req.ctx, idParam(req), req.body)));

export const contractRoutes = Router();
contractRoutes.get('/', json((req) => listContracts(req.ctx, {
  clientId: routeId(req.query.clientId),
  onlyActive: /^(true|1)$/i.test(String(req.query.onlyActive ?? '')),
})));
contractRoutes.get(`/:id${ID}`, json((req) => getContractDto(req.ctx, idParam(req))));
contractRoutes.post('/', json((req) => saveContract(req.ctx, null, req.body)));
contractRoutes.put(`/:id${ID}`, json((req) => saveContract(req.ctx, idParam(req), req.body)));

export const rateRoutes = Router();
rateRoutes.get('/', json((req) => listRates(req.ctx, {
  contractId: routeId(req.query.contractId),
  status: Object.values(RateStatus).find((s) => s === String(req.query.status ?? '').toUpperCase()) ?? null,
})));
rateRoutes.post('/', json((req) => createRate(req.ctx, req.body)));
rateRoutes.put(`/:id${ID}`, json((req) => updateRate(req.ctx, idParam(req), req.body)));
rateRoutes.post(`/:id${ID}/validate`, json((req) => validateRate(req.ctx, idParam(req))));
rateRoutes.post(`/:id${ID}/reject`, json((req) => rejectRate(req.ctx, idParam(req), req.body)));

export const catalogRoutes = Router();
for (const [path, list, save] of [
  ['job-roles', catalogs.listJobRoles, catalogs.saveJobRole],
  ['pause-reasons', catalogs.listPauseReasons, catalogs.savePauseReason],
  ['group-entities', catalogs.listGroupEntities, catalogs.saveGroupEntity],
  ['work-locations', catalogs.listWorkLocations, catalogs.saveWorkLocation],
]) {
  catalogRoutes.get(`/${path}`, json((req) => list(req.ctx)));
  catalogRoutes.post(`/${path}`, json((req) => save(req.ctx, null, req.body)));
  catalogRoutes.put(`/${path}/:id${ID}`, json((req) => save(req.ctx, idParam(req), req.body)));
}
catalogRoutes.get('/sla-targets', json((req) => catalogs.listSlaTargets(req.ctx)));
catalogRoutes.post('/sla-targets', json((req) => catalogs.createSlaTarget(req.ctx, req.body)));

export const parameterRoutes = Router();
parameterRoutes.get('/', json((req) => listParameters(req.ctx)));
parameterRoutes.put('/:key', json((req) => updateParameter(req.ctx, req.params.key, req.body)));

export const userRoutes = Router();
userRoutes.get('/', json((req) => listUsers(req.ctx)));
userRoutes.get('/by-role/:role', json((req) => listByRole(req.ctx, req.params.role)));
userRoutes.post('/', route(async (req, res) => {
  // A resposta pode trazer a senha provisória gerada: o navegador e proxies não guardam cópia.
  res.setHeader('Cache-Control', 'no-store');
  res.json(await createUser(req.ctx, req.body));
}));
userRoutes.put(`/:id${ID}`, json((req) => updateUser(req.ctx, idParam(req), req.body)));
userRoutes.post(`/:id${ID}/reset-password`, route(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.json(await resetPassword(req.ctx, idParam(req), req.body));
}));

import { Router } from 'express';
import { route } from '../middleware.js';
import {
  addPositions, approveOrder, correctOrderDate, createOrder, getOrderDetail, listJobRolesForContract, listOrdersDto,
  recordJobconvo, rejectOrder, setRhAnalysts,
} from '../services/orders.js';
import { routeId } from '../services/input.js';
import { ID, idParam, queryOf } from './helpers.js';

export const orderRoutes = Router();

orderRoutes.get('/', route(async (req, res) => res.json(await listOrdersDto(req.ctx, queryOf(req)))));

/** Cargos com valor validado no contrato (sem valores em R$: serve a todos os perfis que criam pedido). */
orderRoutes.get('/job-roles', route(async (req, res) => {
  const contractId = routeId(req.query.contractId);
  res.json(contractId ? await listJobRolesForContract(req.ctx, contractId) : []);
}));

orderRoutes.get(`/:id${ID}`, route(async (req, res) => res.json(await getOrderDetail(req.ctx, idParam(req)))));

orderRoutes.post('/', route(async (req, res) => {
  const order = await createOrder(req.ctx, req.body);
  res.status(201).location(`/api/orders/${order.summary.id}`).json(order);
}));

orderRoutes.put(`/:id${ID}/rh-analysts`, route(async (req, res) => res.json(await setRhAnalysts(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/approval`, route(async (req, res) => res.json(await approveOrder(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/rejection`, route(async (req, res) => res.json(await rejectOrder(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/jobconvo`, route(async (req, res) => res.json(await recordJobconvo(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/positions`, route(async (req, res) => res.json(await addPositions(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/date-corrections`, route(async (req, res) =>
  res.json(await correctOrderDate(req.ctx, idParam(req), req.body))));

import { Router } from 'express';
import { route } from '../middleware.js';
import { exportReport, runReport } from '../services/reports.js';

/** Relatórios da seção 11: consulta (JSON) e exportação (.xlsx). O tipo é validado pelo serviço (404 se não existir). */
export const reportRoutes = Router();

reportRoutes.get('/:kind', route(async (req, res) => res.json(await runReport(req.ctx, req.params.kind, req.query))));

reportRoutes.get('/:kind/export', route(async (req, res) => {
  const { fileName, buffer } = await exportReport(req.ctx, req.params.kind, req.query);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  // Relatório com dados de clientes e valores: o navegador e proxies não guardam cópia.
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}));

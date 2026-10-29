import { Router } from 'express';
import multer from 'multer';
import { route } from '../middleware.js';
import { admissionTemplate, confirmAdmissionImport, previewAdmissionImport } from '../services/admission-import.js';
import { candidateTemplate, confirmCandidateImport, previewCandidateImport } from '../services/candidate-import.js';
import {
  BATCH_MAX_FILES, confirmFirstDayBatch, previewFirstDayBatch,
} from '../services/first-day-batch.js';
import { EvidenceFiles } from '../domain/guards.js';
import {
  addPositions, approveOrder, correctOrderDate, createOrder, getOrderDetail, listJobRolesForContract, listOrdersDto,
  recordJobconvo, reducePositions, rejectOrder, setRhAnalysts,
} from '../services/orders.js';
import { routeId } from '../services/input.js';
import { resubmitOrderReview, returnOrderReview, validateOrderReview } from '../services/order-review.js';
import { editOrder } from '../services/order-edit.js';
import { createJobRoleFromOrder } from '../services/catalogs.js';
import { ID, idParam, queryOf } from './helpers.js';

export const orderRoutes = Router();

orderRoutes.get('/', route(async (req, res) => res.json(await listOrdersDto(req.ctx, queryOf(req)))));

/** Cargos com valor validado no contrato (sem valores em R$: serve a todos os perfis que criam pedido). */
orderRoutes.get('/job-roles', route(async (req, res) => {
  const contractId = routeId(req.query.contractId);
  res.json(contractId ? await listJobRolesForContract(req.ctx, contractId) : []);
}));
// Cargo novo cadastrado na criação do pedido (Comercial ou Administrador).
orderRoutes.post('/job-roles', route(async (req, res) => res.status(201).json(await createJobRoleFromOrder(req.ctx, req.body))));

orderRoutes.get(`/:id${ID}`, route(async (req, res) => res.json(await getOrderDetail(req.ctx, idParam(req)))));

orderRoutes.post('/', route(async (req, res) => {
  const order = await createOrder(req.ctx, req.body);
  res.status(201).location(`/api/orders/${order.summary.id}`).json(order);
}));

orderRoutes.put(`/:id${ID}/rh-analysts`, route(async (req, res) => res.json(await setRhAnalysts(req.ctx, idParam(req), req.body))));
// Edição administrativa (ADMIN): prévia dos campos alterados e gravação com justificativa.
orderRoutes.post(`/:id${ID}/admin-edit/preview`, route(async (req, res) => res.json(await editOrder(req.ctx, idParam(req), req.body, { preview: true }))));
orderRoutes.post(`/:id${ID}/admin-edit`, route(async (req, res) => res.json(await editOrder(req.ctx, idParam(req), req.body))));
// Validação da Controladoria (cargo e valores comerciais do pedido).
orderRoutes.post(`/:id${ID}/controllership-validation`, route(async (req, res) => res.json(await validateOrderReview(req.ctx, idParam(req)))));
orderRoutes.post(`/:id${ID}/controllership-return`, route(async (req, res) => res.json(await returnOrderReview(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/controllership-resubmission`, route(async (req, res) => res.json(await resubmitOrderReview(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/approval`, route(async (req, res) => res.json(await approveOrder(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/rejection`, route(async (req, res) => res.json(await rejectOrder(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/jobconvo`, route(async (req, res) => res.json(await recordJobconvo(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/positions`, route(async (req, res) => res.json(await addPositions(req.ctx, idParam(req), req.body))));
// Redução do quadro (ADMIN): JSON ou multipart com a evidência no campo "evidence" (até 10 MB).
const reductionEvidence = multer({ storage: multer.memoryStorage(), limits: { fileSize: EvidenceFiles.MAX_BYTES + 1, files: 1 } });
orderRoutes.post(`/:id${ID}/position-reductions`, (req, res, next) => (req.is('multipart/form-data')
  ? reductionEvidence.single('evidence')(req, res, next)
  : next()), route(async (req, res) => {
  const body = { ...req.body };
  // No multipart a lista vem como texto JSON.
  if (typeof body.positionIds === 'string') {
    try {
      body.positionIds = JSON.parse(body.positionIds);
    } catch {
      body.positionIds = null;
    }
  }
  const file = req.file?.size ? { fileName: req.file.originalname, content: req.file.buffer } : null;
  res.json(await reducePositions(req.ctx, idParam(req), body, file));
}));
orderRoutes.post(`/:id${ID}/date-corrections`, route(async (req, res) =>
  res.json(await correctOrderDate(req.ctx, idParam(req), req.body))));

// ---- candidatos em lote: modelo (.xlsx), prévia e confirmação (o arquivo vai nas duas, em multipart, campo "file")

/** Planilha de candidatos: 2 MB cobrem com folga milhares de linhas (o modelo de 20 posições tem ~10 KB). */
export const SPREADSHEET_MAX_BYTES = 2 * 1024 * 1024;
const spreadsheet = multer({ storage: multer.memoryStorage(), limits: { fileSize: SPREADSHEET_MAX_BYTES + 1, files: 1 } }).single('file');
const uploaded = (req) => (req.file?.size ? { fileName: req.file.originalname, content: req.file.buffer } : null);

orderRoutes.get(`/:id${ID}/candidates-template`, route(async (req, res) => {
  const { fileName, buffer } = await candidateTemplate(req.ctx, idParam(req));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}));
orderRoutes.post(`/:id${ID}/candidates-import/preview`, spreadsheet, route(async (req, res) =>
  res.json(await previewCandidateImport(req.ctx, idParam(req), uploaded(req)))));
orderRoutes.post(`/:id${ID}/candidates-import`, spreadsheet, route(async (req, res) =>
  res.json(await confirmCandidateImport(req.ctx, idParam(req), uploaded(req)))));

// ---- admissões em lote: modelo (.xlsx), conferência e confirmação (mesmo envio multipart, campo "file")

orderRoutes.get(`/:id${ID}/admissions-template`, route(async (req, res) => {
  const { fileName, buffer } = await admissionTemplate(req.ctx, idParam(req));
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
  res.setHeader('Cache-Control', 'no-store');
  res.send(buffer);
}));
orderRoutes.post(`/:id${ID}/admissions-import/preview`, spreadsheet, route(async (req, res) =>
  res.json(await previewAdmissionImport(req.ctx, idParam(req), uploaded(req)))));
orderRoutes.post(`/:id${ID}/admissions-import`, spreadsheet, route(async (req, res) =>
  res.json(await confirmAdmissionImport(req.ctx, idParam(req), uploaded(req)))));

// ---- 1º dia efetivo em lote (NACC): conferência em JSON; gravação em multipart, com a evidência compartilhada no campo
// "shared" e as próprias em "evidence_<id da posição>" (10 MB cada, até BATCH_MAX_FILES arquivos).

const evidences = multer({
  storage: multer.memoryStorage(), limits: { fileSize: EvidenceFiles.MAX_BYTES + 1, files: BATCH_MAX_FILES },
}).any();

orderRoutes.post(`/:id${ID}/first-day-batch/preview`, route(async (req, res) =>
  res.json(await previewFirstDayBatch(req.ctx, idParam(req), req.body))));
orderRoutes.post(`/:id${ID}/first-day-batch`, evidences, route(async (req, res) => {
  const files = { shared: null, own: new Map() };
  for (const f of req.files ?? []) {
    if (!f.size) continue;
    const file = { fileName: f.originalname, content: f.buffer };
    if (f.fieldname === 'shared') files.shared = file;
    else if (f.fieldname.startsWith('evidence_')) files.own.set(f.fieldname.slice('evidence_'.length).toLowerCase(), file);
  }
  res.json(await confirmFirstDayBatch(req.ctx, idParam(req), req.body, files));
}));

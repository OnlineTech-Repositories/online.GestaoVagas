import { Router } from 'express';
import multer from 'multer';
import { EvidenceFiles } from '../domain/guards.js';
import { route } from '../middleware.js';
import { getFirstDayPending } from '../services/first-day-pending.js';
import * as positions from '../services/positions.js';
import { ID, idParam, queryOf } from './helpers.js';

export const positionRoutes = Router();

// Evidência do 1º dia: multipart em memória, com o limite de 10 MB conferido também no upload (413 → mensagem).
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: EvidenceFiles.MAX_BYTES + 1, files: 1 } });

positionRoutes.get('/', route(async (req, res) =>
  res.json(await positions.listPositionsDto(req.ctx, queryOf(req, ['status', 'slaSituation'])))));

// Confirmações do 1º dia pendentes (NACC): por pedido, com as sem matrícula à parte.
positionRoutes.get('/first-day-pending', route(async (req, res) => res.json(await getFirstDayPending(req.ctx))));

positionRoutes.get(`/:id${ID}`, route(async (req, res) => res.json(await positions.getPositionDetail(req.ctx, idParam(req)))));

const action = (path, fn, method = 'post') =>
  positionRoutes[method](`/:id${ID}${path}`, route(async (req, res) => res.json(await fn(req.ctx, idParam(req), req.body))));

action('/decision', positions.decide);
action('/candidate-approval', positions.approveCandidate);
action('/candidate', positions.correctCandidate, 'put');
action('/admission', positions.registerAdmission);
action('/admission-registration', positions.correctRegistration, 'put');
action('/candidate-withdrawal', positions.candidateWithdrew);
action('/admission-no-show', positions.admissionNoShow);
action('/pause', positions.startPause);
action('/pause/end', positions.endPause);
action('/cancellation', positions.cancelPosition);
action('/term', positions.adjustTerm);
action('/date-corrections', positions.correctDate);

/** 1º dia: JSON (sem evidência) ou multipart/form-data (com a evidência no campo "evidence", até 10 MB). */
positionRoutes.post(`/:id${ID}/first-day`, (req, res, next) => (req.is('multipart/form-data')
  ? upload.single('evidence')(req, res, next)
  : next()), route(async (req, res) => {
  const file = req.file?.size ? { fileName: req.file.originalname, content: req.file.buffer } : null;
  res.json(await positions.confirmFirstDay(req.ctx, idParam(req), req.body, file));
}));

positionRoutes.get(`/:id${ID}/evidences/:evidenceId${ID}`, route(async (req, res) => {
  const file = await positions.downloadEvidence(req.ctx, idParam(req), idParam(req, 'evidenceId'));
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.attachment(file.fileName).type(file.contentType).send(file.content);
}));

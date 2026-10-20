import { transaction } from '../db/index.js';
import { entity } from '../db/model.js';
import { getOrder } from '../db/repository.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { positionDateIssues, retroactiveMessage } from '../domain/date-checks.js';
import { today as todayDate, formatBr, isDate, utcNow } from '../domain/dates.js';
import { EvidenceKind, Labels, PositionStatus as S, Roles } from '../domain/enums.js';
import { BusinessRuleError, ForbiddenError, NotFoundError, ValidationError } from '../domain/errors.js';
import { DateGuard, EvidenceFiles, hasRole } from '../domain/guards.js';
import { isApproved } from '../domain/order.js';
import * as P from '../domain/position.js';
import { isId } from './input.js';
import { getOrderDetail } from './orders.js';
import { isInitialLoadOpen } from './parameters.js';

/**
 * Confirmação do 1º dia efetivo em lote, pelo NACC, na tela do pedido (melhoria pedida pelo usuário em 19/10/2026).
 *
 * O NACC marca só quem comprovadamente começou; quem não for marcado continua "Aguardando 1º dia" — a falta de
 * marcação NÃO é "não compareceu", que tem registro próprio na posição. Cada linha passa pela MESMA regra do registro
 * individual (P.confirmFirstDay: candidato, matrícula e justificativa obrigatórios), com os avisos de data. Decisões do
 * usuário: uma evidência compartilhada, vinculada só às linhas marcadas, mais um arquivo próprio opcional por linha; se
 * uma linha tiver erro na hora de gravar, nada é gravado (o lote entra inteiro ou não entra).
 *
 * Duas chamadas: a conferência (JSON, sem arquivos, não grava) e a gravação (multipart com os arquivos), que valida
 * tudo de novo — entre as duas, outra pessoa pode ter confirmado uma das posições.
 */

/** Até 30 linhas e 21 arquivos (1 compartilhado + 20 próprios) por lote: o envio fica em memória (10 MB cada). */
export const BATCH_MAX_ITEMS = 30;
export const BATCH_MAX_FILES = 21;

export const canConfirmFirstDayBatch = (user, order) => hasRole(user, Roles.Nacc) && isApproved(order);

const vaga = (order, p) => `${order.number}-${p.slotNumber}`;

/** Posições aptas: admissão concluída (com matrícula), aguardando o 1º dia, no ciclo atual. */
const eligible = (order) => order.positions
  .filter((p) => P.isCurrentCycle(p) && p.status === S.AWAITING_FIRST_DAY && P.activeCandidate(p) && p.admissionRegistration)
  .sort((a, b) => a.slotNumber - b.slotNumber);

/** O que a tela do pedido mostra: as posições aptas e as admitidas sem matrícula (que precisam da matrícula antes). */
export function firstDayBatchInfo(user, order) {
  if (!canConfirmFirstDayBatch(user, order)) return null;
  const item = (p) => ({
    positionId: p.id, position: vaga(order, p), employeeName: P.activeCandidate(p)?.fullName ?? null,
    registration: p.admissionRegistration, admissionAt: p.admissionAt,
  });
  return {
    items: eligible(order).map(item),
    withoutRegistration: order.positions.filter((p) => P.isCurrentCycle(p) && p.status === S.IN_ADMISSION).map(item),
  };
}

async function loadOrder(ctx, orderId, uow = ctx.uow) {
  const order = await getOrder(uow, orderId);
  if (!order) throw new NotFoundError('Pedido não encontrado.');
  if (!hasRole(ctx.user, Roles.Nacc)) throw new ForbiddenError('A confirmação do 1º dia efetivo é do NACC.');
  if (!isApproved(order)) throw new BusinessRuleError('O pedido aguarda a aprovação do cliente.');
  return order;
}

/** Lê os itens enviados: posição, data, justificativa e se usa a evidência compartilhada. */
function readItems(raw) {
  let items = raw;
  if (typeof raw === 'string') {
    try {
      items = JSON.parse(raw);
    } catch {
      throw new ValidationError({ items: 'Lista de posições inválida.' });
    }
  }
  if (!Array.isArray(items) || !items.length) throw new BusinessRuleError('Selecione ao menos uma posição para confirmar.', 'items');
  if (items.length > BATCH_MAX_ITEMS) {
    throw new BusinessRuleError(`Confirme até ${BATCH_MAX_ITEMS} posições por vez.`, 'items');
  }
  return items.map((i) => ({
    positionId: typeof i?.positionId === 'string' && isId(i.positionId) ? i.positionId.toLowerCase() : null,
    date: typeof i?.date === 'string' ? i.date.trim() : '',
    justification: DateGuard.clean(i?.justification),
    sharedEvidence: i?.sharedEvidence === true,
    ownEvidence: i?.ownEvidence === true,
  }));
}

/**
 * Valida as linhas simulando a confirmação em `order` (carregado numa unidade de trabalho descartável). Devolve cada
 * linha com erros (impedem a gravação) e avisos de data (só informam).
 */
async function validate(order, items) {
  const today = todayDate();
  const loadOpen = await isInitialLoadOpen();
  const apt = new Map(eligible(order).map((p) => [p.id, p]));
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const seen = new Set();
  return items.map((item) => {
    const p = byId.get(item.positionId);
    const row = {
      ...item,
      position: p ? vaga(order, p) : '—',
      employeeName: p ? P.activeCandidate(p)?.fullName ?? null : null,
      registration: p?.admissionRegistration ?? null,
      admissionAt: p?.admissionAt ?? null,
      errors: [],
      warnings: [],
    };
    const fail = (field, message) => row.errors.push({ field, message });
    if (!p || p.orderId !== order.id) fail('position', 'A posição não pertence a este pedido.');
    else if (seen.has(p.id)) fail('position', 'A mesma posição foi selecionada duas vezes.');
    else if (!apt.has(p.id)) {
      fail('position', p.status === S.FILLED
        ? 'O 1º dia desta posição já foi confirmado.'
        : `A posição não está "Aguardando 1º dia" (está "${Labels.positionStatus[p.status]}").`);
    }
    if (p) seen.add(p.id);
    if (!row.date) fail('date', 'Informe a data do 1º dia efetivo.');
    else if (!isDate(row.date)) fail('date', 'Data inválida.');
    if (!row.justification) fail('justification', 'Informe a justificativa da confirmação do 1º dia.');

    if (!row.errors.length) {
      try {
        const before = new Set(positionDateIssues(p, today).map((i) => i.message));
        P.confirmFirstDay(p, row.date, row.justification, null, utcNow());
        if (row.date < today) row.warnings.push(retroactiveMessage('O 1º dia efetivo', row.date));
        row.warnings.push(...positionDateIssues(p, today).filter((i) => !before.has(i.message)).map((i) => i.message));
      } catch (error) {
        if (!(error instanceof BusinessRuleError)) throw error;
        fail(error.field === 'date' ? 'date' : 'position', error.message);
      }
    }
    row.retroactive = !loadOpen && row.date && row.date < today;
    row.status = row.errors.length ? 'error' : 'ready';
    return row;
  });
}

const summarize = (rows) => ({
  selected: rows.length,
  ready: rows.filter((r) => r.status === 'ready').length,
  errors: rows.filter((r) => r.status === 'error').length,
  warnings: rows.filter((r) => r.warnings.length).length,
  canConfirm: rows.length > 0 && rows.every((r) => r.status === 'ready'),
});

/** Conferência: valida as linhas selecionadas e devolve o resumo. Não grava nada. */
export async function previewFirstDayBatch(ctx, orderId, body) {
  const items = readItems(body?.items);
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const rows = await validate(probe, items);
  return { orderNumber: probe.number, rows, summary: summarize(rows) };
}

/**
 * Gravação: valida de novo; com qualquer erro, nada é gravado. Senão, confirma cada posição (quem, quando,
 * justificativa e evidências ficam na posição e no histórico) numa transação, com o registro do lote no pedido.
 * @param {{ shared?: { fileName: string, content: Buffer }, own: Map<string, { fileName: string, content: Buffer }> }} files
 */
export async function confirmFirstDayBatch(ctx, orderId, body, files) {
  const items = readItems(body?.items);
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const rows = await validate(probe, items);
  const summary = summarize(rows);
  if (!summary.canConfirm) {
    throw new BusinessRuleError(`${summary.errors} posição(ões) com erro: corrija ou desmarque e confirme de novo. Nada foi gravado.`, 'items');
  }

  // Evidências validadas pelo CONTEÚDO antes de gravar qualquer coisa (PDF, JPG ou PNG até 10 MB).
  const usesShared = rows.some((r) => r.sharedEvidence);
  if (usesShared && !files.shared) throw new BusinessRuleError('Selecione o arquivo da evidência compartilhada.', 'shared');
  const shared = usesShared ? { ...EvidenceFiles.validate(files.shared), content: files.shared.content } : null;
  const own = new Map();
  for (const r of rows.filter((x) => x.ownEvidence)) {
    const file = files.own.get(r.positionId);
    if (!file) throw new BusinessRuleError(`Selecione o arquivo de evidência da posição ${r.position}.`, 'evidence');
    own.set(r.positionId, { ...EvidenceFiles.validate(file), content: file.content });
  }

  const order = await loadOrder(ctx, orderId);
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const now = utcNow();
  let sharedFile = null;
  await transaction(async () => {
    // Uma gravação por posição, cada uma com a própria justificativa no histórico.
    for (const r of rows) {
      const p = byId.get(r.positionId);
      P.confirmFirstDay(p, r.date, r.justification, ctx.user.id, now);
      if (r.retroactive) P.markRetroactive(p);
      await ctx.uow.save({ action: 'CONFIRM_FIRST_DAY_BATCH', justification: r.justification });
    }
    // Evidências numa gravação só, no fim: o arquivo (sem colunas de alteração) não passa por outra gravação depois de
    // inserido.
    for (const r of rows) {
      const p = byId.get(r.positionId);
      if (shared && r.sharedEvidence) {
        if (!sharedFile) {
          // O arquivo compartilhado é gravado uma vez; as outras posições marcadas apontam para ele.
          sharedFile = P.attachEvidence(p, EvidenceKind.FIRST_DAY, shared.fileName, shared.contentType, shared.content).storageKey;
        } else {
          p.evidences.push(entity('PositionEvidence', {
            positionId: p.id, kind: EvidenceKind.FIRST_DAY, fileName: shared.fileName, contentType: shared.contentType,
            sizeBytes: shared.content.length, storageKey: sharedFile,
          }));
        }
      }
      const file = own.get(p.id);
      if (file) P.attachEvidence(p, EvidenceKind.FIRST_DAY, file.fileName, file.contentType, file.content);
    }
    ctx.uow.log({
      entity: 'Order', entityId: order.id, action: 'CONFIRM_FIRST_DAY_BATCH', field: 'Summary',
      newValue: JSON.stringify({
        confirmed: rows.length, sharedEvidence: shared?.fileName ?? null,
        positions: rows.map((r) => ({ position: r.position, firstDay: r.date, evidence: Boolean((shared && r.sharedEvidence) || own.has(r.positionId)) })),
      }),
    });
    await ctx.uow.save({ action: 'CONFIRM_FIRST_DAY_BATCH' });
  });
  return {
    confirmed: rows.length,
    message: `${rows.length} confirmação(ões) de 1º dia efetivo no pedido ${order.number}: ${rows.map((r) => `${r.position} em ${formatBr(r.date)}`).join(', ')}.`,
    order: await getOrderDetail(ctx, orderId),
  };
}

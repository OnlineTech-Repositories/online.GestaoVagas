import { transaction } from '../db/index.js';
import { getOrder } from '../db/repository.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { positionDateIssues, retroactiveMessage } from '../domain/date-checks.js';
import { today as todayDate, formatBr } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import { Labels, NotificationTypes, PositionStatus as S, Roles } from '../domain/enums.js';
import { DateGuard, RhAccess } from '../domain/guards.js';
import { activeRhAnalysts, isApproved } from '../domain/order.js';
import * as P from '../domain/position.js';
import { dataTable } from './email-layout.js';
import { fileChecks, isBlankLine, readTemplateSheet, summarize } from './import-sheet.js';
import { orderFields } from './notice-fields.js';
import { links, notify } from './notifications.js';
import { getOrderDetail } from './orders.js';
import { isInitialLoadOpen } from './parameters.js';
import { cellDate, cellText } from './xlsx-reader.js';
import { generateXlsx } from './xlsx.js';

/**
 * Registro das admissões em lote, por planilha, no padrão dos candidatos em lote (melhoria pedida pelo usuário em
 * 19/10/2026).
 *
 * O modelo traz uma linha por posição com candidato selecionado aguardando a admissão — "Candidato selecionado", de
 * pedido aprovado, no ciclo atual —, com pedido, vaga e candidato preenchidos e bloqueados. Prévia (valida e não
 * grava) e confirmação (grava tudo numa transação). Decisões do usuário: havendo linha com erro, nada é gravado;
 * linha em branco é ignorada (a posição segue aguardando a admissão); um único aviso ao NACC por importação, com a
 * lista das admissões; o modelo não inclui posições já admitidas sem matrícula.
 *
 * Cada linha passa pela MESMA função de domínio do registro individual (P.registerAdmission): com matrícula, a
 * posição vai para "Aguardando 1º dia"; sem, para "Em admissão". Data passada, futura ou antes da aprovação do
 * candidato avisa e não impede (regra de datas de 19/10/2026); fora da carga inicial, data passada pede justificativa
 * (RN-24). Reenviar o mesmo arquivo não duplica: a posição já admitida deixa de estar apta e a linha vira erro.
 */

const SHEET = 'Admissões';

const COLUMNS = [
  { key: 'order', title: 'Pedido', type: 'int', width: 9 },
  { key: 'position', title: 'Vaga', width: 9 },
  { key: 'candidate', title: 'Candidato', width: 38 },
  { key: 'admissionAt', title: 'Data da admissão *', type: 'date', editable: true, width: 18 },
  { key: 'registration', title: 'Matrícula', editable: true, width: 18 },
  { key: 'justification', title: 'Justificativa', editable: true, width: 46 },
  { key: 'positionId', title: 'ID da posição (não alterar)', hidden: true, width: 38 },
  { key: 'candidateId', title: 'ID do candidato (não alterar)', hidden: true, width: 38 },
  { key: 'orderId', title: 'ID do pedido (não alterar)', hidden: true, width: 38 },
];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.title.replace(' *', '')]));

const vaga = (order, p) => `${order.number}-${p.slotNumber}`;

/** Posições aptas à admissão pela planilha (as mesmas em que o botão "Registrar admissão" aparece). */
export const eligibleForAdmission = (order) => (isApproved(order)
  ? order.positions.filter((p) => P.isCurrentCycle(p) && p.status === S.CANDIDATE_APPROVED && P.activeCandidate(p))
    .sort((a, b) => a.slotNumber - b.slotNumber)
  : []);

/** Quem pode importar: o mesmo do registro individual (analista responsável pelo pedido ou Gestor de RH). */
export const canImportAdmissions = (user, order) => RhAccess.canAct(user, order) && isApproved(order);

async function loadOrder(ctx, orderId, uow = ctx.uow) {
  const order = await getOrder(uow, orderId);
  if (!order) throw new NotFoundError('Pedido não encontrado.');
  if (!RhAccess.canAct(ctx.user, order)) {
    throw new ForbiddenError('Somente o analista de RH responsável pelo pedido ou o Gestor de RH podem registrar admissões.');
  }
  if (!isApproved(order)) {
    throw new BusinessRuleError('O pedido aguarda a aprovação do cliente: as admissões só podem ser registradas depois dela.');
  }
  return order;
}

// ---------------------------------------------------------------- modelo

export async function admissionTemplate(ctx, orderId) {
  const order = await loadOrder(ctx, orderId);
  const positions = eligibleForAdmission(order);
  if (!positions.length) {
    throw new BusinessRuleError('Nenhuma posição deste pedido aguarda admissão: o modelo traz só as posições "Candidato selecionado".');
  }
  const loadOpen = await isInitialLoadOpen();
  const guidance = [
    ['Como usar', `Uma linha por posição do pedido ${order.number} com candidato selecionado aguardando a admissão (${positions.length}). Preencha os campos em amarelo. Linha deixada totalmente em branco é ignorada: a posição continua aguardando a admissão.`],
    ['Pedido, Vaga e Candidato', 'Já preenchidos e bloqueados: identificam a posição e o candidato. Não inclua, exclua nem reordene linhas.'],
    ['Data da admissão *', 'Obrigatória, no formato dd/mm/aaaa. Data passada, futura ou anterior à aprovação do candidato é aceita com aviso na prévia.'],
    ['Matrícula', 'Opcional, até 50 caracteres. A coluna é texto: zeros à esquerda são mantidos. Com a matrícula, a admissão fica concluída e a posição passa a "Aguardando 1º dia"; sem, fica "Em admissão" até o RH ou o DP informá-la.'],
    ['Justificativa', loadOpen
      ? 'Opcional enquanto a carga inicial estiver aberta (situação atual). Com a carga encerrada, passa a ser obrigatória quando a data da admissão for anterior à data da importação.'
      : 'Obrigatória quando a data da admissão for anterior à data da importação (RN-24). Opcional nos demais casos.'],
    ['Importação', 'Na tela do pedido, use "Importar admissões". O sistema mostra a conferência com cada erro (linha, campo e motivo) e os avisos de data, e só grava quando todas as linhas preenchidas estiverem corretas.'],
  ];
  const buffer = generateXlsx([
    {
      name: SHEET,
      protect: true,
      columns: COLUMNS,
      rows: positions.map((p) => {
        const candidate = P.activeCandidate(p);
        return { order: order.number, position: vaga(order, p), candidate: candidate.fullName, positionId: p.id, candidateId: candidate.id, orderId: order.id };
      }),
      validations: [{ key: 'admissionAt', type: 'date', errorTitle: 'Data inválida', error: 'Informe uma data no formato dd/mm/aaaa.' }],
    },
    {
      name: 'Orientações',
      columns: [{ key: 'field', title: 'Campo', width: 24 }, { key: 'help', title: 'Orientação', width: 110, wrap: true }],
      rows: guidance.map(([field, help]) => ({ field, help })),
    },
  ]);
  return { fileName: `admissoes-pedido-${order.number}.xlsx`, buffer };
}

// ---------------------------------------------------------------- leitura e validação

/**
 * Valida as linhas contra o pedido, simulando o registro em `order` (carregado numa unidade de trabalho descartável,
 * que nunca é gravada).
 */
async function validate(order, buffer) {
  const lines = readTemplateSheet(buffer, { sheetName: SHEET, columns: COLUMNS, templateName: 'admissões' });
  const today = todayDate();
  const loadOpen = await isInitialLoadOpen();
  const eligible = new Map(eligibleForAdmission(order).map((p) => [p.id, p]));
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const fileErrors = fileChecks(lines, order);
  const usedPositions = new Set();

  const rows = [];
  for (const { line, raw } of lines) {
    const positionId = cellText(raw.positionId).toLowerCase();
    const p = byId.get(positionId);
    const candidate = p ? P.activeCandidate(p) : null;
    const row = {
      line,
      position: p ? vaga(order, p) : cellText(raw.position) || '—',
      positionId,
      candidate: candidate?.fullName ?? (cellText(raw.candidate) || '—'),
      admissionAt: null,
      // Matrícula digitada como número no Excel perde a formatação de texto: vira o texto do número, sem notação científica.
      registration: cellText(raw.registration) || null,
      justification: cellText(raw.justification) || null,
      status: 'ready',
      errors: [],
      warnings: [],
    };
    const fail = (field, message) => row.errors.push({ field, label: LABEL[field] ?? field, message });
    rows.push(row);

    if (!positionId) continue; // já contada nos erros do arquivo
    if (isBlankLine(raw, COLUMNS)) {
      row.status = 'blank';
      continue;
    }
    if (!p || p.orderId !== order.id) fail('position', 'A posição não pertence a este pedido.');
    else if (usedPositions.has(positionId)) fail('position', 'A mesma posição aparece em mais de uma linha.');
    else if (!eligible.has(positionId)) {
      fail('position', [S.IN_ADMISSION, S.AWAITING_FIRST_DAY, S.FILLED].includes(p.status)
        ? `A admissão desta posição já foi registrada (está "${Labels.positionStatus[p.status]}").`
        : `A posição não está mais "Candidato selecionado" (está "${Labels.positionStatus[p.status]}"). Baixe um modelo atualizado.`);
    } else if (cellText(raw.candidateId).toLowerCase() !== candidate.id) {
      fail('candidate', 'O candidato desta posição mudou depois que o modelo foi baixado. Baixe um modelo atualizado.');
    }
    usedPositions.add(positionId);

    row.admissionAt = cellDate(raw.admissionAt);
    if (row.admissionAt === null) fail('admissionAt', 'Informe a data da admissão.');
    else if (row.admissionAt === undefined) fail('admissionAt', 'Data inválida: use o formato dd/mm/aaaa.');
    else if (!loadOpen && row.admissionAt < today && !row.justification) {
      fail('justification', `A data da admissão (${formatBr(row.admissionAt)}) é anterior a hoje: informe a justificativa.`);
    }
    if (row.registration && row.registration.length > 50) fail('registration', 'A matrícula deve ter no máximo 50 caracteres.');

    // A regra do registro individual, na mesma função de domínio (simulação: o pedido em memória muda).
    if (!row.errors.length) {
      try {
        const before = new Set(positionDateIssues(p, today).map((i) => i.message));
        P.registerAdmission(p, row.admissionAt, row.registration);
        if (row.admissionAt < today) row.warnings.push(retroactiveMessage('A data de admissão', row.admissionAt));
        row.warnings.push(...positionDateIssues(p, today).filter((i) => !before.has(i.message)).map((i) => i.message));
      } catch (error) {
        if (!(error instanceof BusinessRuleError)) throw error;
        fail(error.field && LABEL[error.field] ? error.field : 'position', error.message);
      }
    }
    if (row.errors.length) row.status = 'error';
  }
  return { rows, fileErrors };
}

/** Conferência: lê, valida e devolve cada linha com o resultado e os avisos. Não grava nada. */
export async function previewAdmissionImport(ctx, orderId, file) {
  if (!file?.content?.length) throw new BusinessRuleError('Selecione a planilha preenchida (.xlsx).', 'file');
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const { rows, fileErrors } = await validate(probe, file.content);
  return { orderNumber: probe.number, fileName: file.fileName, fileErrors, rows, summary: summarize(rows, fileErrors) };
}

/**
 * Confirmação: valida de novo (entre a conferência e a confirmação alguém pode ter registrado uma admissão) e, sem
 * nenhum erro, grava todas numa transação — cada linha com a própria justificativa no histórico da posição, mais o
 * registro da importação (quem, quando, o arquivo e as admissões) e um aviso ao NACC com a lista.
 */
export async function confirmAdmissionImport(ctx, orderId, file) {
  if (!file?.content?.length) throw new BusinessRuleError('Selecione a planilha preenchida (.xlsx).', 'file');
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const { rows, fileErrors } = await validate(probe, file.content);
  const summary = summarize(rows, fileErrors);
  if (fileErrors.length) throw new BusinessRuleError(fileErrors[0], 'file');
  if (summary.errors) {
    throw new BusinessRuleError(`A planilha tem ${summary.errors} linha(s) com erro. Corrija e envie de novo: nada foi gravado.`, 'file');
  }
  if (!summary.ready) throw new BusinessRuleError('Nenhuma linha preenchida: preencha ao menos uma admissão.', 'file');

  const order = await loadOrder(ctx, orderId);
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const today = todayDate();
  const loadOpen = await isInitialLoadOpen();
  const ready = rows.filter((r) => r.status === 'ready');
  const done = [];
  await transaction(async () => {
    for (const row of ready) {
      const p = byId.get(row.positionId);
      P.registerAdmission(p, row.admissionAt, row.registration);
      // RN-24: fora da carga inicial, a data passada (com a justificativa já conferida) sinaliza a posição.
      if (!loadOpen && row.admissionAt < today) P.markRetroactive(p);
      done.push({ row, status: p.status });
      await ctx.uow.save({ action: 'IMPORT_ADMISSIONS', justification: DateGuard.clean(row.justification) });
    }
    ctx.uow.log({
      entity: 'Order', entityId: order.id, action: 'IMPORT_ADMISSIONS', field: 'Summary',
      newValue: JSON.stringify({
        file: file.fileName, imported: ready.length,
        admissions: ready.map((r) => ({ position: r.position, admissionAt: r.admissionAt, registration: r.registration })),
      }),
    });
    await notifyNacc(ctx, order, done);
    await ctx.uow.save({ action: 'IMPORT_ADMISSIONS' });
  });
  const withRegistration = done.filter((d) => d.status === S.AWAITING_FIRST_DAY).length;
  return {
    imported: ready.length, awaitingFirstDay: withRegistration, withoutRegistration: ready.length - withRegistration,
    order: await getOrderDetail(ctx, orderId),
  };
}

/** Um aviso por importação (decisão do usuário): a lista das admissões do pedido, para o NACC confirmar o 1º dia. */
function notifyNacc(ctx, order, done) {
  const pendingRegistration = done.filter((d) => d.status === S.IN_ADMISSION).length;
  const message = `Pedido ${order.number}: ${done.length} admissão(ões) registrada(s) por planilha`
    + (pendingRegistration ? `, ${pendingRegistration} sem matrícula.` : '.') + ' Confirme o 1º dia efetivo de cada colaborador.';
  return notify(ctx.uow, {
    type: NotificationTypes.AdmissionRegistered,
    entityId: order.id,
    subject: `${done.length} admissão(ões) registrada(s) · Pedido ${order.number}`,
    message,
    link: links.order(order.id),
    email: {
      title: 'Admissões registradas por planilha',
      summary: `O RH registrou ${done.length} admissão(ões) deste pedido de uma só vez.`,
      status: pendingRegistration
        ? { label: `${pendingRegistration} sem matrícula`, tone: 'warning' } : { label: 'Aguardando 1º dia', tone: 'info' },
      fields: [...orderFields(order), ['Admissões registradas', String(done.length), { strong: true }]],
      bodyHtml: dataTable(['Vaga', 'Candidato', 'Admissão', 'Matrícula'], done.map(({ row }) => [
        row.position, row.candidate, formatBr(row.admissionAt), row.registration ?? 'Não informada',
      ])),
      action: pendingRegistration
        ? 'NACC: confirme o 1º dia efetivo de cada colaborador. Nas posições sem matrícula, o RH do pedido ou o DP precisa informá-la antes.'
        : 'NACC: confirme o 1º dia efetivo de cada colaborador assim que ele começar.',
      button: 'Consultar pedido',
    },
  }, { roles: [Roles.Nacc, Roles.RhManager], userIds: activeRhAnalysts(order).map((a) => a.userId) });
}

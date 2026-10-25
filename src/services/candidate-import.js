import { transaction } from '../db/index.js';
import { getOrder } from '../db/repository.js';
import { UnitOfWork } from '../db/unit-of-work.js';
import { positionDateIssues, retroactiveMessage } from '../domain/date-checks.js';
import { today as todayDate, formatBr } from '../domain/dates.js';
import { BusinessRuleError, ForbiddenError, NotFoundError } from '../domain/errors.js';
import { CandidateSex, PositionStatus as S } from '../domain/enums.js';
import { DateGuard, Phone, RhAccess } from '../domain/guards.js';
import { isApproved } from '../domain/order.js';
import * as P from '../domain/position.js';
import { getOrderDetail } from './orders.js';
import { isInitialLoadOpen } from './parameters.js';
import { fileChecks, isBlankLine, plain, readTemplateSheet, summarize } from './import-sheet.js';
import { cellDate, cellText } from './xlsx-reader.js';
import { generateXlsx } from './xlsx.js';

/**
 * Importação em lote dos candidatos selecionados de um pedido, por planilha (melhoria pedida pelo usuário em
 * 19/10/2026).
 *
 * O modelo traz uma linha por posição apta a receber candidato — em recrutamento, de pedido aprovado, no ciclo atual
 * e sem candidato —, com o pedido e a posição preenchidos e bloqueados. A importação tem prévia (valida tudo e não
 * grava) e confirmação (grava tudo numa transação). Decisões do usuário: havendo qualquer linha com erro, nada é
 * gravado até a planilha ser corrigida; linha totalmente em branco é ignorada e a posição continua pendente.
 *
 * Cada linha passa pelas MESMAS regras do cadastro individual: as funções de domínio (P.approveCandidate, que valida
 * nome, telefone e sexo) rodam numa simulação descartada na prévia e de verdade na confirmação. Nascimento e CPF são
 * da planilha de admissões (melhoria de 25/10/2026). A proteção da planilha só evita erro de digitação — pode ser
 * removida por quem quiser —, então o servidor confere tudo de novo: pedido, posições, quantidade e duplicidade.
 */

const SHEET = 'Candidatos';

/** Colunas do modelo. As de preenchimento são as do formulário individual ("Adicionar Candidato"). */
const COLUMNS = [
  { key: 'order', title: 'Pedido', type: 'int', width: 9 },
  { key: 'position', title: 'Vaga', width: 9 },
  { key: 'approvedAt', title: 'Data de aprovação *', type: 'date', editable: true, width: 18 },
  { key: 'fullName', title: 'Nome completo *', editable: true, width: 38 },
  { key: 'phone', title: 'Telefone com DDD *', editable: true, width: 19 },
  { key: 'sex', title: 'Sexo *', editable: true, width: 16 },
  { key: 'justification', title: 'Justificativa', editable: true, width: 46 },
  { key: 'positionId', title: 'ID da posição (não alterar)', hidden: true, width: 38 },
  { key: 'orderId', title: 'ID do pedido (não alterar)', hidden: true, width: 38 },
];
const LABEL = Object.fromEntries(COLUMNS.map((c) => [c.key, c.title.replace(' *', '')]));

const SEX_LABELS = { FEMALE: 'Feminino', MALE: 'Masculino', NOT_INFORMED: 'Não informado' };
/** "não informado", "NAO INFORMADO", "F", "masc." → código do sexo. */
const SEX_BY_TEXT = new Map([
  ...Object.entries(SEX_LABELS).map(([code, label]) => [plain(label), code]),
  ['f', CandidateSex.FEMALE], ['fem', CandidateSex.FEMALE], ['m', CandidateSex.MALE], ['masc', CandidateSex.MALE],
]);

const vaga = (order, p) => `${order.number}-${p.slotNumber}`;

/** Posições aptas a receber candidato pela importação (as mesmas em que o formulário individual aparece). */
export const eligiblePositions = (order) => (isApproved(order)
  ? order.positions.filter((p) => P.isCurrentCycle(p) && p.status === S.RECRUITING && !P.activeCandidate(p))
    .sort((a, b) => a.slotNumber - b.slotNumber)
  : []);

/** Quem pode importar: o mesmo do cadastro individual (analista responsável pelo pedido ou Gestor de RH). */
export const canImportCandidates = (user, order) => RhAccess.canAct(user, order) && isApproved(order);

async function loadOrder(ctx, orderId, uow = ctx.uow) {
  const order = await getOrder(uow, orderId);
  if (!order) throw new NotFoundError('Pedido não encontrado.');
  if (!RhAccess.canAct(ctx.user, order)) {
    throw new ForbiddenError('Somente o analista de RH responsável pelo pedido ou o Gestor de RH podem cadastrar candidatos.');
  }
  if (!isApproved(order)) {
    throw new BusinessRuleError('O pedido aguarda a aprovação do cliente: os candidatos só podem ser cadastrados depois dela.');
  }
  return order;
}

// ---------------------------------------------------------------- modelo

export async function candidateTemplate(ctx, orderId) {
  const order = await loadOrder(ctx, orderId);
  const positions = eligiblePositions(order);
  if (!positions.length) {
    throw new BusinessRuleError('Nenhuma posição deste pedido aguarda candidato: o modelo traz só as posições "Em recrutamento" sem candidato.');
  }
  const loadOpen = await isInitialLoadOpen();
  const sexList = Object.values(SEX_LABELS);
  const guidance = [
    ['Como usar', `Uma linha por posição do pedido ${order.number} aguardando candidato (${positions.length}). Preencha os campos em amarelo. Linha deixada totalmente em branco é ignorada: a posição continua aguardando candidato.`],
    ['Pedido e Vaga', 'Já preenchidos e bloqueados: identificam a posição. Não inclua, exclua nem reordene linhas.'],
    ['Campos com *', 'Obrigatórios em toda linha preenchida.'],
    ['Data de aprovação *', 'Data em que o candidato foi aprovado, no formato dd/mm/aaaa. Data passada, futura ou anterior à abertura da posição é aceita com aviso na prévia.'],
    ['Nome completo *', 'Nome completo do candidato.'],
    ['Telefone com DDD *', 'Celular com 9 dígitos ou fixo com 8, sempre com o DDD: (11) 91234-5678. Com ou sem pontuação.'],
    ['Sexo *', `Escolha na lista: ${sexList.join(', ')}.`],
    ['Nascimento e CPF', 'Não fazem parte desta planilha: são informados na admissão (planilha de admissões ou "Registrar admissão").'],
    ['Justificativa', loadOpen
      ? 'Opcional enquanto a carga inicial estiver aberta (situação atual). Com a carga encerrada, passa a ser obrigatória quando a data de aprovação for anterior à data da importação.'
      : 'Obrigatória quando a data de aprovação for anterior à data da importação (RN-24). Opcional nos demais casos.'],
    ['Importação', 'Na tela do pedido, use "Importar candidatos". O sistema mostra uma prévia com cada erro (linha, campo e motivo) e só grava quando todas as linhas preenchidas estiverem corretas.'],
  ];
  const buffer = generateXlsx([
    {
      name: SHEET,
      protect: true,
      columns: COLUMNS,
      rows: positions.map((p) => ({ order: order.number, position: vaga(order, p), positionId: p.id, orderId: order.id })),
      validations: [
        { key: 'sex', type: 'list', values: sexList, errorTitle: 'Sexo', error: `Escolha uma opção da lista: ${sexList.join(', ')}.` },
        { key: 'approvedAt', type: 'date', errorTitle: 'Data inválida', error: 'Informe uma data no formato dd/mm/aaaa.' },
      ],
    },
    {
      name: 'Orientações',
      columns: [{ key: 'field', title: 'Campo', width: 24 }, { key: 'help', title: 'Orientação', width: 110, wrap: true }],
      rows: guidance.map(([field, help]) => ({ field, help })),
    },
  ]);
  return { fileName: `candidatos-pedido-${order.number}.xlsx`, buffer };
}

// ---------------------------------------------------------------- leitura e validação

const readTemplate = (buffer) => readTemplateSheet(buffer, { sheetName: SHEET, columns: COLUMNS, templateName: 'candidatos' });

/**
 * Valida as linhas contra o pedido. Simula o cadastro em `order`, mutando os objetos em memória: por isso recebe
 * sempre um pedido carregado numa unidade de trabalho descartável, que nunca é gravada.
 * @returns {{ rows: object[], fileErrors: string[] }}
 */
async function validate(order, buffer) {
  const lines = readTemplate(buffer);
  const today = todayDate();
  const loadOpen = await isInitialLoadOpen();
  const eligible = new Map(eligiblePositions(order).map((p) => [p.id, p]));
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const fileErrors = fileChecks(lines, order);
  const usedPositions = new Set();

  const rows = [];
  for (const { line, raw } of lines) {
    const positionId = cellText(raw.positionId).toLowerCase();
    const p = byId.get(positionId);
    const row = {
      line,
      position: p ? vaga(order, p) : cellText(raw.position) || '—',
      positionId,
      approvedAt: null, fullName: cellText(raw.fullName), phone: '', sex: null, justification: cellText(raw.justification) || null,
      status: 'ready',
      errors: [],
      // Datas fora do esperado (passada, futura, antes da abertura): avisam e não impedem a importação.
      warnings: [],
    };
    const fail = (field, message) => row.errors.push({ field, label: LABEL[field] ?? field, message });
    rows.push(row);

    if (!positionId) continue; // já contada em fileErrors
    if (isBlankLine(raw, COLUMNS)) {
      row.status = 'blank';
      continue;
    }
    if (!p || p.orderId !== order.id) fail('position', 'A posição não pertence a este pedido.');
    else if (usedPositions.has(positionId)) fail('position', 'A mesma posição aparece em mais de uma linha.');
    else if (!eligible.has(positionId)) {
      fail('position', P.activeCandidate(p)
        ? 'A posição já recebeu candidato depois que o modelo foi baixado.'
        : `A posição não está mais "Em recrutamento" (está "${p.status}"). Baixe um modelo atualizado.`);
    }
    usedPositions.add(positionId);

    row.approvedAt = cellDate(raw.approvedAt);
    if (row.approvedAt === null) fail('approvedAt', 'Informe a data de aprovação.');
    else if (row.approvedAt === undefined) fail('approvedAt', 'Data inválida: use o formato dd/mm/aaaa.');
    else if (!loadOpen && row.approvedAt < today && !row.justification) {
      fail('justification', `A data de aprovação (${formatBr(row.approvedAt)}) é anterior a hoje: informe a justificativa.`);
    }

    if (!row.fullName) fail('fullName', 'Informe o nome completo.');
    row.phone = Phone.normalize(cellText(raw.phone));
    if (!row.phone) fail('phone', 'Informe o telefone com DDD.');
    else if (!Phone.isValid(row.phone)) fail('phone', 'Telefone inválido: informe o DDD e o número (celular com 9 dígitos, fixo com 8).');

    const sexText = cellText(raw.sex);
    row.sex = SEX_BY_TEXT.get(plain(sexText)) ?? null;
    if (!sexText) fail('sex', 'Selecione o sexo.');
    else if (!row.sex) fail('sex', `Opção inválida: use ${Object.values(SEX_LABELS).join(', ')}.`);


    // As regras do cadastro individual, na mesma função de domínio (simulação: o pedido em memória muda).
    if (!row.errors.length) {
      try {
        const before = new Set(positionDateIssues(p, today).map((i) => i.message));
        P.approveCandidate(p, row.approvedAt, { fullName: row.fullName, phone: row.phone, sex: row.sex }, today);
        if (row.approvedAt < today) row.warnings.push(retroactiveMessage('A data de aprovação', row.approvedAt));
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

const toDto = (row) => ({
  ...row,
  phone: row.phone && Phone.isValid(row.phone) ? Phone.format(Phone.normalize(row.phone)) : row.phone,
  sexLabel: row.sex ? SEX_LABELS[row.sex] : null,
});

/** Prévia: lê, valida e devolve cada linha com o resultado. Não grava nada. */
export async function previewCandidateImport(ctx, orderId, file) {
  if (!file?.content?.length) throw new BusinessRuleError('Selecione a planilha preenchida (.xlsx).', 'file');
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const { rows, fileErrors } = await validate(probe, file.content);
  return { orderNumber: probe.number, fileName: file.fileName, fileErrors, rows: rows.map(toDto), summary: summarize(rows, fileErrors) };
}

/**
 * Confirmação: valida de novo (o arquivo é reenviado; entre a prévia e a confirmação alguém pode ter cadastrado um
 * candidato) e, sem nenhum erro, grava todos os candidatos numa transação — cada linha com a própria justificativa
 * no log, mais um registro da importação (quem, quando, quantos e o arquivo).
 */
export async function confirmCandidateImport(ctx, orderId, file) {
  if (!file?.content?.length) throw new BusinessRuleError('Selecione a planilha preenchida (.xlsx).', 'file');
  // Valida numa cópia descartável; grava no pedido da unidade de trabalho da requisição, linha por linha.
  const probe = await loadOrder(ctx, orderId, new UnitOfWork({}));
  const { rows, fileErrors } = await validate(probe, file.content);
  const summary = summarize(rows, fileErrors);
  if (fileErrors.length) throw new BusinessRuleError(fileErrors[0], 'file');
  if (summary.errors) {
    throw new BusinessRuleError(`A planilha tem ${summary.errors} linha(s) com erro. Corrija e envie de novo: nada foi gravado.`, 'file');
  }
  if (!summary.ready) throw new BusinessRuleError('Nenhuma linha preenchida: preencha ao menos um candidato.', 'file');

  const order = await loadOrder(ctx, orderId);
  const byId = new Map(order.positions.map((p) => [p.id, p]));
  const today = todayDate();
  const loadOpen = await isInitialLoadOpen();
  const ready = rows.filter((r) => r.status === 'ready');
  await transaction(async () => {
    // Uma gravação por linha (todas na mesma transação): cada candidato entra no log com a própria justificativa.
    for (const row of ready) {
      const p = byId.get(row.positionId);
      P.approveCandidate(p, row.approvedAt, { fullName: row.fullName, phone: row.phone, sex: row.sex }, today);
      // RN-24: fora da carga inicial, a data passada (com a justificativa já conferida na validação) sinaliza a posição.
      if (!loadOpen && row.approvedAt < today) P.markRetroactive(p);
      await ctx.uow.save({ action: 'IMPORT_CANDIDATES', justification: DateGuard.clean(row.justification) });
    }
    ctx.uow.log({
      entity: 'Order', entityId: order.id, action: 'IMPORT_CANDIDATES', field: 'Summary',
      newValue: JSON.stringify({ file: file.fileName, imported: ready.length, positions: ready.map((r) => r.position) }),
    });
    await ctx.uow.save({ action: 'IMPORT_CANDIDATES' });
  });
  return { imported: ready.length, order: await getOrderDetail(ctx, orderId) };
}

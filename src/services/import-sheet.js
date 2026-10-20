import { BusinessRuleError } from '../domain/errors.js';
import { cellText, readXlsx } from './xlsx-reader.js';

/**
 * Peças comuns das importações por planilha (candidatos e admissões): leitura do modelo pelas colunas e o resumo da
 * prévia. Cada importação define as próprias colunas, regras e gravação.
 */

/** Texto sem acento, minúsculo, sem ponto final: compara títulos e opções digitadas de jeitos diferentes. */
export const plain = (text) => String(text ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').trim().toLowerCase().replace(/\.$/, '');

/**
 * Lê a aba do modelo e localiza as colunas pelo título (a ordem pode mudar se alguém reabrir no Google Planilhas).
 * Devolve as linhas com a identificação da posição ou com algo preenchido, com o número da linha no Excel.
 */
export function readTemplateSheet(buffer, { sheetName, columns, templateName }) {
  const editable = columns.filter((c) => c.editable).map((c) => c.key);
  const sheets = readXlsx(buffer);
  const sheet = sheets.find((s) => s.name === sheetName) ?? sheets[0];
  const header = (sheet?.rows[0] ?? []).map((v) => plain(cellText(v)).replace(/\s*\*$/, ''));
  const index = Object.fromEntries(columns.map((c) => [c.key, header.indexOf(plain(c.title).replace(/\s*\*$/, ''))]));
  const missing = columns.filter((c) => index[c.key] < 0);
  if (missing.length) {
    throw new BusinessRuleError(`A planilha não corresponde ao modelo de ${templateName}: faltam as colunas `
      + `${missing.map((c) => `"${c.title.replace(' *', '')}"`).join(', ')}. Baixe o modelo do pedido e preencha nele.`, 'file');
  }
  return sheet.rows.slice(1).map((cells, i) => ({
    line: i + 2,
    raw: Object.fromEntries(columns.map((c) => [c.key, cells[index[c.key]] ?? null])),
  })).filter((r) => r.raw.positionId !== null || editable.some((k) => cellText(r.raw[k]) !== '' || typeof r.raw[k] === 'number'));
}

/** Linha sem nada nas colunas de preenchimento: ignorada (a posição continua pendente). */
export const isBlankLine = (raw, columns) => columns.filter((c) => c.editable)
  .every((c) => cellText(raw[c.key]) === '' && typeof raw[c.key] !== 'number');

/** Resumo da prévia: prontas, com erro, em branco, com aviso e se a confirmação está liberada. */
export function summarize(rows, fileErrors) {
  const count = (status) => rows.filter((r) => r.status === status).length;
  const ready = count('ready');
  const errors = count('error');
  return {
    total: rows.length, ready, errors, blank: count('blank'), warnings: rows.filter((r) => r.warnings?.length).length,
    canConfirm: !fileErrors.length && !errors && ready > 0,
  };
}

/** Planilha de outro pedido ou com linhas fora do modelo: erros do arquivo, antes das linhas. */
export function fileChecks(lines, order) {
  const errors = [];
  const otherOrder = lines.find((l) => l.raw.orderId && cellText(l.raw.orderId) !== order.id);
  if (otherOrder) {
    errors.push(`A planilha é de outro pedido (pedido ${cellText(otherOrder.raw.order) || '?'}). Baixe o modelo deste pedido (${order.number}).`);
  }
  const extra = lines.filter((l) => !l.raw.positionId).length;
  if (extra) {
    errors.push(`${extra} linha(s) foram incluídas fora do modelo (sem a identificação da posição). Use só as linhas do modelo, uma por posição.`);
  }
  return errors;
}

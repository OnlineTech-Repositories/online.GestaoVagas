import { inflateRawSync } from 'node:zlib';
import { BusinessRuleError } from '../domain/errors.js';

/**
 * Leitor de .xlsx sem dependências — o par do gerador (xlsx.js), para a importação de planilhas preenchidas.
 *
 * Lê o que o Excel, o LibreOffice e o Google Planilhas gravam ao salvar, que é diferente do que o gerador escreve:
 * textos na tabela compartilhada (sharedStrings), texto rico em vários trechos, datas como número de série e
 * caracteres de controle escapados como _x000D_. Devolve o valor cru de cada célula (texto ou número); quem
 * interpreta (data, CPF) é quem sabe o que a coluna significa.
 *
 * Um arquivo enviado é entrada não confiável: há teto de tamanho descompactado (ZIP que se expande demais), de
 * linhas e de colunas, e erro de formato vira mensagem para o usuário, nunca exceção crua.
 */

const MAX_UNCOMPRESSED_BYTES = 20 * 1024 * 1024;
const MAX_ROWS = 5000;
const MAX_COLUMNS = 60;

const invalid = (detail) => new BusinessRuleError(`Não foi possível ler a planilha: ${detail} Envie o arquivo .xlsx baixado do sistema.`, 'file');

// ---------------------------------------------------------------- ZIP

/** Entradas do ZIP pelo diretório central (que tem os tamanhos certos mesmo quando o cabeçalho local não tem). */
function unzip(buffer) {
  let end = -1;
  for (let i = buffer.length - 22; i >= Math.max(0, buffer.length - 65_557); i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw invalid('o arquivo não é um .xlsx (ZIP) válido.');
  const count = buffer.readUInt16LE(end + 10);
  let offset = buffer.readUInt32LE(end + 16);
  const files = new Map();
  let total = 0;
  for (let n = 0; n < count; n += 1) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== 0x02014b50) throw invalid('estrutura do arquivo corrompida.');
    const method = buffer.readUInt16LE(offset + 10);
    const compressedSize = buffer.readUInt32LE(offset + 20);
    const size = buffer.readUInt32LE(offset + 24);
    const nameLength = buffer.readUInt16LE(offset + 28);
    const extraLength = buffer.readUInt16LE(offset + 30);
    const commentLength = buffer.readUInt16LE(offset + 32);
    const localOffset = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('utf8', offset + 46, offset + 46 + nameLength);
    offset += 46 + nameLength + extraLength + commentLength;

    total += size;
    if (total > MAX_UNCOMPRESSED_BYTES) throw invalid('o conteúdo descompactado é grande demais.');
    if (!name.endsWith('.xml') && !name.endsWith('.rels')) continue; // imagens e afins não interessam
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) throw invalid('estrutura do arquivo corrompida.');
    const start = localOffset + 30 + buffer.readUInt16LE(localOffset + 26) + buffer.readUInt16LE(localOffset + 28);
    const data = buffer.subarray(start, start + compressedSize);
    let content;
    try {
      if (method === 0) content = data;
      else if (method === 8) content = inflateRawSync(data, { maxOutputLength: MAX_UNCOMPRESSED_BYTES });
      else throw invalid(`compressão não suportada (${method}).`);
    } catch (error) {
      if (error instanceof BusinessRuleError) throw error;
      throw invalid('conteúdo compactado corrompido.');
    }
    files.set(name.replace(/^\/+/, ''), content.toString('utf8'));
  }
  return files;
}

// ---------------------------------------------------------------- XML

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

/** Entidades XML e o escape _xHHHH_ que o Excel usa para caracteres de controle. */
const decode = (text) => text
  .replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, e) => (e[0] === '#'
    ? String.fromCodePoint(e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : Number(e.slice(1)))
    : ENTITIES[e.toLowerCase()]))
  .replace(/_x([0-9a-f]{4})_/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));

const attr = (tag, name) => new RegExp(`\\s${name}="([^"]*)"`).exec(tag)?.[1] ?? null;

/** Texto de um <si> ou <is>: concatena todos os <t> (texto rico vem em vários trechos <r><t>). */
const textOf = (xml) => decode([...xml.matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/g)].map((m) => m[1] ?? '').join(''));

/** "AB12" → índice da coluna (A = 0). */
function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref)?.[0] ?? '';
  return [...letters].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0) - 1;
}

function readSheet(xml, shared) {
  const rows = [];
  for (const rowMatch of xml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>|<row\b([^>]*)\/>/g)) {
    const rowNumber = Number(attr(rowMatch[1] ?? rowMatch[3] ?? '', 'r')) || rows.length + 1;
    if (rowNumber > MAX_ROWS) throw invalid(`a planilha tem mais de ${MAX_ROWS} linhas.`);
    const cells = [];
    for (const c of (rowMatch[2] ?? '').matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = attr(c[1], 'r');
      const index = ref ? columnIndex(ref) : cells.length;
      if (index < 0 || index >= MAX_COLUMNS) continue;
      const type = attr(c[1], 't');
      const body = c[2] ?? '';
      const raw = /<v>([\s\S]*?)<\/v>/.exec(body)?.[1];
      let value = null;
      if (type === 'inlineStr') value = textOf(/<is>([\s\S]*?)<\/is>/.exec(body)?.[1] ?? '');
      else if (type === 's') value = raw === undefined ? null : shared[Number(raw)] ?? null;
      else if (type === 'str' || type === 'e') value = raw === undefined ? null : decode(raw);
      else if (type === 'b') value = raw === '1';
      else if (raw !== undefined && raw !== '') value = Number(raw);
      cells[index] = value;
    }
    rows[rowNumber - 1] = cells;
  }
  return Array.from(rows, (r) => r ?? []);
}

/**
 * @param {Buffer} buffer conteúdo do .xlsx
 * @returns {{ name: string, rows: (string|number|boolean|null)[][] }[]} abas na ordem da pasta de trabalho
 */
export function readXlsx(buffer) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) throw invalid('o arquivo está vazio.');
  if (buffer.length < 22) throw invalid('o arquivo não é um .xlsx (ZIP) válido.');
  const files = unzip(buffer);
  const workbook = files.get('xl/workbook.xml');
  if (!workbook) throw invalid('não é uma pasta de trabalho do Excel.');
  const rels = new Map([...(files.get('xl/_rels/workbook.xml.rels') ?? '').matchAll(/<Relationship\b([^>]*)\/?>/g)]
    .map((m) => [attr(m[1], 'Id'), attr(m[1], 'Target')]));
  const shared = [...(files.get('xl/sharedStrings.xml') ?? '').matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => textOf(m[1]));

  return [...workbook.matchAll(/<sheet\b([^>]*)\/?>/g)].map((m) => {
    const target = rels.get(attr(m[1], 'r:id')) ?? '';
    const path = target.startsWith('/') ? target.slice(1) : `xl/${target.replace(/^\.\//, '')}`;
    const xml = files.get(path);
    return { name: decode(attr(m[1], 'name') ?? ''), rows: xml ? readSheet(xml, shared) : [] };
  });
}

/**
 * Data de célula → 'AAAA-MM-DD' (ou null se vazia). Aceita o número de série do Excel, dd/mm/aaaa (ou com - e .) e
 * AAAA-MM-DD. Formato que não for data devolve undefined, para o chamador dizer "data inválida".
 */
export function cellDate(value) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 1 || value > 2_958_465) return undefined;
    const d = new Date(Date.UTC(1899, 11, 30) + Math.floor(value) * 86_400_000);
    return d.toISOString().slice(0, 10);
  }
  const text = String(value).trim();
  let m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(text);
  let iso = m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
  if (!iso) {
    m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
    iso = m ? text : null;
  }
  if (!iso) return undefined;
  const d = new Date(`${iso}T12:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== iso ? undefined : iso;
}

/** Texto de célula, sem espaços nas pontas; número vira texto sem notação científica (CPF digitado como número). */
export function cellText(value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'number') return Number.isInteger(value) ? BigInt(value).toString() : String(value);
  return String(value).trim();
}

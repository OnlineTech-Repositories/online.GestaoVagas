import { deflateRawSync } from 'node:zlib';

/**
 * Gerador de planilhas .xlsx sem dependências, adaptado do gerador da aplicação financeira (src/lib/xlsx.js).
 *
 * Um .xlsx é um ZIP de XMLs. As bibliotecas prontas arrastavam mais de cem pacotes e, na versão avaliada lá,
 * vulnerabilidades conhecidas; para planilhas tabulares com moeda, data e percentual, o zlib da biblioteca padrão
 * basta. Em relação ao original: várias abas (resumo e detalhe no mesmo arquivo), formatos de percentual e decimal,
 * e o nome da aba cortado ANTES de escapar o XML (cortar depois podia partir uma entidade e invalidar o arquivo).
 *
 * Cada aba: cabeçalho em negrito, primeira linha congelada, filtro automático e largura de coluna.
 * Tipos de coluna: text (padrão), int, decimal (1 casa), money (R$), percent (0,0%) e date ('AAAA-MM-DD').
 *
 * Para modelos de preenchimento (importação): `protect: true` na aba bloqueia as células, menos as das colunas com
 * `editable: true` (texto com formato "@", para o Excel não transformar CPF em número e comer o zero à esquerda; data
 * com dd/mm/aaaa). `validations` cria listas de seleção e validação de data; `hidden: true` oculta a coluna; `wrap:
 * true` quebra o texto (orientações).
 */

// ---------------------------------------------------------------- ZIP

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buffer) {
  let c = 0 ^ -1;
  for (let i = 0; i < buffer.length; i += 1) c = (c >>> 8) ^ CRC_TABLE[(c ^ buffer[i]) & 0xff];
  return (c ^ -1) >>> 0;
}

/** Data/hora no formato MS-DOS usado pelo ZIP. */
function dosTime(d = new Date()) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

/** ZIP de arquivos de texto ({ name, content }). Exportado também para os testes montarem planilhas "como o Excel salva". */
export function zip(files) {
  const { time, date } = dosTime();
  const locals = [];
  const central = [];
  let offset = 0;

  for (const { name, content } of files) {
    const raw = Buffer.from(content, 'utf8');
    const compressed = deflateRawSync(raw, { level: 9 });
    const crc = crc32(raw);
    const nameBuffer = Buffer.from(name, 'utf8');

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); // assinatura
    local.writeUInt16LE(20, 4); // versão necessária
    local.writeUInt16LE(0, 6); // flags
    local.writeUInt16LE(8, 8); // método: deflate
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuffer.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, nameBuffer, compressed);

    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4); // versão de criação
    entry.writeUInt16LE(20, 6); // versão necessária
    entry.writeUInt16LE(0, 8);
    entry.writeUInt16LE(8, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(compressed.length, 20);
    entry.writeUInt32LE(raw.length, 24);
    entry.writeUInt16LE(nameBuffer.length, 28);
    entry.writeUInt16LE(0, 30); // extra
    entry.writeUInt16LE(0, 32); // comentário
    entry.writeUInt16LE(0, 34); // disco
    entry.writeUInt16LE(0, 36); // atributos internos
    entry.writeUInt32LE(0, 38); // atributos externos
    entry.writeUInt32LE(offset, 42);
    central.push(entry, nameBuffer);
    offset += local.length + nameBuffer.length + compressed.length;
  }

  const centralBlock = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBlock.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, centralBlock, end]);
}

// ---------------------------------------------------------------- planilha

const escape = (v) => String(v ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
  // Caracteres de controle quebram o XML e o Excel recusa o arquivo.
  .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '');

/** Nome de aba válido no Excel: até 31 caracteres, sem : \ / ? * [ ]. */
const sheetName = (name, index) => (String(name ?? '').replace(/[:\\/?*[\]]/g, ' ').trim() || `Aba ${index + 1}`).slice(0, 31);

/** Índice de coluna (0) → letra (A, B, ... AA). */
function columnLetter(index) {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** Datas no Excel são dias desde 1899-12-30. */
function dateSerial(value) {
  const d = new Date(`${String(value).slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  return Math.round((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(1899, 11, 30)) / 86_400_000);
}

// Índices dos estilos em styles() — a ordem importa.
const STYLE = { TEXT: 0, HEADER: 1, MONEY: 2, DATE: 3, INT: 4, DECIMAL: 5, PERCENT: 6, EDIT_TEXT: 7, EDIT_DATE: 8, WRAP: 9 };

const STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<numFmts count="3">
<numFmt numFmtId="164" formatCode="&quot;R$&quot;\\ #,##0.00"/>
<numFmt numFmtId="165" formatCode="dd/mm/yyyy"/>
<numFmt numFmtId="166" formatCode="0.0"/>
</numFmts>
<fonts count="2">
<font><sz val="11"/><name val="Calibri"/></font>
<font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
</fonts>
<fills count="4">
<fill><patternFill patternType="none"/></fill>
<fill><patternFill patternType="gray125"/></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FF0F62B4"/><bgColor indexed="64"/></patternFill></fill>
<fill><patternFill patternType="solid"><fgColor rgb="FFFFF8DC"/><bgColor indexed="64"/></patternFill></fill>
</fills>
<borders count="2">
<border><left/><right/><top/><bottom/><diagonal/></border>
<border><left style="thin"><color rgb="FFD0D7DE"/></left><right style="thin"><color rgb="FFD0D7DE"/></right><top style="thin"><color rgb="FFD0D7DE"/></top><bottom style="thin"><color rgb="FFD0D7DE"/></bottom><diagonal/></border>
</borders>
<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
<cellXfs count="10">
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
<xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="center"/></xf>
<xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="166" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="10" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>
<xf numFmtId="49" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>
<xf numFmtId="165" fontId="0" fillId="3" borderId="1" xfId="0" applyNumberFormat="1" applyFill="1" applyBorder="1" applyProtection="1"><protection locked="0"/></xf>
<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment wrapText="1" vertical="top"/></xf>
</cellXfs>
</styleSheet>`;

const NUMERIC_STYLE = { int: STYLE.INT, decimal: STYLE.DECIMAL, money: STYLE.MONEY, percent: STYLE.PERCENT };

function cell(ref, value, column) {
  const type = column.type;
  if (column.editable) {
    // Célula de preenchimento: desbloqueada mesmo vazia, com fundo de destaque.
    if (type === 'date') {
      const serial = value ? dateSerial(value) : null;
      return serial === null ? `<c r="${ref}" s="${STYLE.EDIT_DATE}"/>` : `<c r="${ref}" s="${STYLE.EDIT_DATE}"><v>${serial}</v></c>`;
    }
    return value === null || value === undefined || value === ''
      ? `<c r="${ref}" s="${STYLE.EDIT_TEXT}"/>`
      : `<c r="${ref}" s="${STYLE.EDIT_TEXT}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  }
  if (value === null || value === undefined || value === '') return `<c r="${ref}" s="${column.wrap ? STYLE.WRAP : STYLE.TEXT}"/>`;
  if (column.wrap) return `<c r="${ref}" s="${STYLE.WRAP}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
  if (type in NUMERIC_STYLE) {
    const n = Number(value);
    // Percentual chega de 0 a 100 (como na tela); o formato 0,0% do Excel espera a fração.
    return Number.isFinite(n)
      ? `<c r="${ref}" s="${NUMERIC_STYLE[type]}"><v>${type === 'percent' ? n / 100 : n}</v></c>`
      : `<c r="${ref}" s="${STYLE.TEXT}"/>`;
  }
  if (type === 'date') {
    const serial = dateSerial(value);
    return serial === null
      ? `<c r="${ref}" s="${STYLE.TEXT}" t="inlineStr"><is><t>${escape(value)}</t></is></c>`
      : `<c r="${ref}" s="${STYLE.DATE}"><v>${serial}</v></c>`;
  }
  // Texto vai como inlineStr: nunca é interpretado como fórmula, mesmo começando com "=".
  return `<c r="${ref}" s="${STYLE.TEXT}" t="inlineStr"><is><t xml:space="preserve">${escape(value)}</t></is></c>`;
}

/** Serial do Excel para 31/12/2100: limite superior da validação de data. */
const MAX_DATE_SERIAL = 73415;

/** Listas de seleção e validação de data nas linhas de dados da coluna. */
function dataValidations(columns, rows, validations = []) {
  if (!validations.length || !rows.length) return '';
  const items = validations.map((v) => {
    const letter = columnLetter(columns.findIndex((c) => c.key === v.key));
    const sqref = `${letter}2:${letter}${rows.length + 1}`;
    const message = `showErrorMessage="1" errorTitle="${escape(v.errorTitle ?? 'Valor inválido')}" error="${escape(v.error ?? '')}"`;
    if (v.type === 'list') {
      // Lista inline: entre aspas, separada por vírgula (até 255 caracteres).
      return `<dataValidation type="list" allowBlank="1" ${message} sqref="${sqref}"><formula1>${escape(`"${v.values.join(',')}"`)}</formula1></dataValidation>`;
    }
    return `<dataValidation type="date" operator="between" allowBlank="1" ${message} sqref="${sqref}"><formula1>1</formula1><formula2>${MAX_DATE_SERIAL}</formula2></dataValidation>`;
  });
  return `<dataValidations count="${items.length}">${items.join('')}</dataValidations>`;
}

function worksheet({ columns, rows, protect = false, validations }) {
  const cols = columns.map((c, i) =>
    `<col min="${i + 1}" max="${i + 1}" width="${c.width ?? 18}" customWidth="1"${c.hidden ? ' hidden="1"' : ''}/>`).join('');
  const header = `<row r="1" ht="22" customHeight="1">${columns
    .map((c, i) => `<c r="${columnLetter(i)}1" s="${STYLE.HEADER}" t="inlineStr"><is><t>${escape(c.title)}</t></is></c>`)
    .join('')}</row>`;
  const body = rows.map((row, r) => `<row r="${r + 2}">${columns
    .map((c, i) => cell(`${columnLetter(i)}${r + 2}`, row[c.key], c)).join('')}</row>`).join('');
  // Aba protegida (sem senha: evita erro de digitação; quem valida de verdade é o servidor). Colunas e linhas podem
  // ser redimensionadas; inserir ou excluir linhas, não — o modelo tem uma linha por posição. Sem filtro automático,
  // que a proteção desabilitaria.
  const protection = protect
    ? '<sheetProtection sheet="1" objects="1" scenarios="1" formatColumns="0" formatRows="0"/>'
    : `<autoFilter ref="A1:${columnLetter(columns.length - 1)}${Math.max(rows.length + 1, 1)}"/>`;
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
<sheetFormatPr defaultRowHeight="15"/>
<cols>${cols}</cols>
<sheetData>${header}${body}</sheetData>
${protection}
${dataValidations(columns, rows, validations)}
</worksheet>`;
}

/**
 * @param {{ name: string, columns: { key: string, title: string, type?: string, width?: number }[], rows: object[] }[]} sheets
 * @returns {Buffer} conteúdo do arquivo .xlsx
 */
export function generateXlsx(sheets) {
  if (!sheets.length) throw new Error('A planilha precisa de ao menos uma aba.');
  const names = sheets.map((s, i) => sheetName(s.name, i));
  return zip([
    {
      name: '[Content_Types].xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
${sheets.map((_, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join('\n')}
<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
</Types>`,
    },
    {
      name: '_rels/.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
<sheets>${names.map((n, i) => `<sheet name="${escape(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('')}</sheets>
</workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      content: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
${sheets.map((_, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join('\n')}
<Relationship Id="rId${sheets.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`,
    },
    { name: 'xl/styles.xml', content: STYLES },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, content: worksheet(s) })),
  ]);
}

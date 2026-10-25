import { DEMO_PASSWORD } from './env.js';
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { inflateRawSync } from 'node:zlib';
import { execute, query, queryOne } from '../src/db/index.js';
import { addDays, today as todayDate } from '../src/domain/dates.js';
import { readXlsx } from '../src/services/xlsx-reader.js';
import { generateXlsx, zip } from '../src/services/xlsx.js';
import { Client } from './client.js';
import { startServer } from './server.js';

/**
 * Importação de candidatos em lote por planilha (melhoria de 19/10/2026): modelo com as posições pendentes, prévia
 * com erro por linha e campo, bloqueio enquanto houver erro, linhas em branco ignoradas e gravação com as mesmas
 * regras do cadastro individual. Inclui uma planilha montada no formato que o Excel grava ao salvar.
 */

let server;
const clients = new Map();
const today = todayDate();
let order;

before(async () => {
  server = await startServer({ demo: true });
});

after(async () => {
  await server?.close();
});

async function as(user) {
  if (clients.has(user)) return clients.get(user);
  const c = new Client(server.url);
  assert.equal((await c.login(`${user}@demo.local`, DEMO_PASSWORD)).status, 200, `login de ${user}`);
  clients.set(user, c);
  return c;
}

const cookie = (c) => [...c.jar].map(([k, v]) => `${k}=${v}`).join('; ');

async function download(user, path) {
  const c = await as(user);
  const res = await fetch(server.url + path, { headers: { Cookie: cookie(c) } });
  const buffer = Buffer.from(await res.arrayBuffer());
  let json = null;
  if (!res.ok) {
    try {
      json = JSON.parse(buffer.toString('utf8'));
    } catch {
      json = null;
    }
  }
  return { status: res.status, headers: res.headers, buffer, json };
}

/** Envia a planilha (multipart) para a prévia ou a confirmação. */
async function upload(user, path, buffer, name = 'candidatos.xlsx') {
  const c = await as(user);
  const form = new FormData();
  form.append('file', new Blob([buffer]), name);
  return c.request('POST', path, undefined, { form });
}

/** Lê o modelo e devolve as linhas como objetos, mais um "preencher" que gera a planilha de volta (inlineStr). */
function templateRows(buffer) {
  const [sheet] = readXlsx(buffer);
  const header = sheet.rows[0];
  const keys = ['order', 'position', 'approvedAt', 'fullName', 'phone', 'sex', 'justification', 'positionId', 'orderId'];
  return sheet.rows.slice(1).map((cells) => Object.fromEntries(keys.map((k, i) => [k, cells[i] ?? null]))).filter((r) => r.positionId)
    .map((r) => ({ ...r, header }));
}

/** Colunas do modelo (melhoria de 25/10/2026: telefone no lugar de nascimento e CPF, que passaram para a admissão). */
const TITLES = ['Pedido', 'Vaga', 'Data de aprovação *', 'Nome completo *', 'Telefone com DDD *', 'Sexo *', 'Justificativa',
  'ID da posição (não alterar)', 'ID do pedido (não alterar)'];

/** Planilha "preenchida": as mesmas colunas do modelo, com os valores informados. */
function filled(rows) {
  const columns = TITLES.map((title, i) => ({ key: `c${i}`, title, type: i === 2 ? 'date' : undefined, editable: i === 4 }));
  return generateXlsx([{
    name: 'Candidatos',
    columns,
    rows: rows.map((r) => Object.fromEntries([r.order, r.position, r.approvedAt, r.fullName, r.phone, r.sex, r.justification,
      r.positionId, r.orderId].map((v, i) => [`c${i}`, v]))),
  }]);
}

test('modelo: uma linha por posição pendente, pedido e posição bloqueados, sexo em lista e orientações', async () => {
  const gestor = await as('gestor.rh');
  const { data: orders } = await gestor.get('/api/orders');
  for (const o of orders.items ?? orders) {
    const detail = (await gestor.get(`/api/orders/${o.id}`)).data;
    if (detail.candidateImport?.pending >= 3) {
      order = detail;
      break;
    }
  }
  assert.ok(order, 'a demonstração tem um pedido com ao menos 3 posições em recrutamento sem candidato');

  const res = await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`);
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition'), new RegExp(`candidatos-pedido-${order.summary.number}\\.xlsx`));
  const rows = templateRows(res.buffer);
  assert.equal(rows.length, order.candidateImport.pending);
  assert.ok(rows.every((r) => r.order === order.summary.number && r.orderId === order.summary.id));
  assert.deepEqual(rows[0].header.slice(0, TITLES.length), TITLES, 'sem nascimento nem CPF');

  const sheets = readXlsx(res.buffer).map((s) => s.name);
  assert.deepEqual(sheets, ['Candidatos', 'Orientações']);
  const files = new Map();
  let offset = 0;
  while (res.buffer.readUInt32LE(offset) === 0x04034b50) {
    const size = res.buffer.readUInt32LE(offset + 18);
    const nameLength = res.buffer.readUInt16LE(offset + 26);
    const start = offset + 30 + nameLength + res.buffer.readUInt16LE(offset + 28);
    files.set(res.buffer.toString('utf8', offset + 30, offset + 30 + nameLength), inflateRawSync(res.buffer.subarray(start, start + size)).toString('utf8'));
    offset = start + size;
  }
  const sheet = files.get('xl/worksheets/sheet1.xml');
  assert.match(sheet, /<sheetProtection sheet="1"/, 'aba protegida');
  assert.match(sheet, /type="list".*Feminino,Masculino,Não informado/, 'sexo em lista');
  assert.match(sheet, /hidden="1"/, 'identificadores em colunas ocultas');
  assert.match(files.get('xl/styles.xml'), /<protection locked="0"\/>/, 'campos do candidato desbloqueados');
});

test('só o RH do pedido (analista responsável ou Gestor de RH) baixa o modelo e importa', async () => {
  const res = await download('comercial', `/api/orders/${order.summary.id}/candidates-template`);
  assert.equal(res.status, 403);
  assert.equal((await upload('comercial', `/api/orders/${order.summary.id}/candidates-import/preview`, Buffer.from('x'))).status, 403);
  const detail = (await (await as('comercial')).get(`/api/orders/${order.summary.id}`)).data;
  assert.equal(detail.candidateImport, null, 'a tela do Comercial não mostra a importação');
});

test('prévia: erro por linha e campo, linha em branco ignorada, nada gravado', async () => {
  const rows = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
  const sheet = filled([
    { ...rows[0], approvedAt: today, fullName: 'Ana Souza', phone: '11 91234 5678', sex: 'Feminino' },
    { ...rows[1] }, // em branco: a posição continua pendente
    { ...rows[2], approvedAt: addDays(today, 3), fullName: '', phone: '91234-5678', sex: 'X' },
    ...(rows[3] ? [{ ...rows[3], approvedAt: today, fullName: 'Bia Lima', sex: 'f' }] : []),
  ]);
  const r = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`, sheet);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [ok, blank, bad, noPhone] = r.data.rows;
  assert.equal(ok.status, 'ready');
  assert.equal(ok.phone, '(11) 91234-5678', 'telefone formatado');
  assert.equal(blank.status, 'blank');
  assert.equal(bad.status, 'error');
  assert.equal(bad.line, 4, 'linha do Excel (o cabeçalho é a 1)');
  const fields = Object.fromEntries(bad.errors.map((e) => [e.field, e.message]));
  assert.equal(fields.approvedAt, undefined, 'data futura não é erro: vira aviso');
  assert.match(fields.fullName, /Informe o nome completo/);
  assert.match(fields.phone, /Telefone inválido/);
  assert.match(fields.sex, /Opção inválida/);
  if (noPhone) assert.match(noPhone.errors.find((e) => e.field === 'phone').message, /Informe o telefone com DDD/);
  assert.equal(r.data.summary.canConfirm, false);

  // A linha 2 está correta, mas há linha com erro: a confirmação recusa tudo (decisão do usuário).
  const candidates = async () => Number((await queryOne('SELECT COUNT(*) AS n FROM candidates')).n);
  const before = await candidates();
  const blocked = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import`, sheet);
  assert.equal(blocked.status, 422);
  assert.match(blocked.data.detail, /linha\(s\) com erro.*nada foi gravado/);
  assert.equal(await candidates(), before, 'nem a linha correta foi gravada');
  assert.equal((await queryOne('SELECT status FROM positions WHERE id = ?', rows[0].positionId)).status, 'RECRUITING');
});

test('planilha de outro pedido, linhas fora do modelo e colunas trocadas são recusadas', async () => {
  const rows = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
  const other = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`,
    filled([{ ...rows[0], orderId: '00000000-0000-7000-8000-000000000000', order: 99 }]));
  assert.match(other.data.fileErrors[0], /é de outro pedido \(pedido 99\)/);
  assert.equal(other.data.summary.canConfirm, false);

  const extra = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`,
    filled([{ ...rows[0], positionId: null, fullName: 'Linha incluída' }]));
  assert.match(extra.data.fileErrors[0], /incluídas fora do modelo/);

  const wrong = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`,
    generateXlsx([{ name: 'Candidatos', columns: [{ key: 'a', title: 'Qualquer' }], rows: [{ a: 'x' }] }]));
  assert.equal(wrong.status, 422);
  assert.match(wrong.data.detail, /não corresponde ao modelo/);

  const notXlsx = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`, Buffer.from('nome;cpf\nAna;123'), 'x.csv');
  assert.equal(notXlsx.status, 422);
  assert.match(notXlsx.data.detail, /não é um \.xlsx/);
});

test('planilha salva no formato do Excel (textos compartilhados, texto rico, data em número, telefone digitado como número)', async () => {
  const [row] = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
  const shared = [...TITLES, row.position, 'Feminino', row.positionId, row.orderId];
  const si = (t, i) => (i === 3 ? '<si><r><t>Nome </t></r><r><rPr><b/></rPr><t>completo *</t></r></si>' : `<si><t>${t.replace(/&/g, '&amp;')}</t></si>`);
  const serial = (iso) => Math.round((Date.parse(`${iso}T00:00:00Z`) - Date.UTC(1899, 11, 30)) / 86_400_000);
  const xml = (r, cells) => `<row r="${r}">${cells.join('')}</row>`;
  const s = (ref, i) => `<c r="${ref}" t="s"><v>${i}</v></c>`;
  const n = (ref, v) => `<c r="${ref}"><v>${v}</v></c>`;
  const sheetXml = `<?xml version="1.0" encoding="UTF-8"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>${
    xml(1, TITLES.map((_, i) => s(`${'ABCDEFGHI'[i]}1`, i)))}${
    xml(2, [n('A2', row.order), s('B2', 9), n('C2', serial(today)), `<c r="D2" t="inlineStr"><is><t>Eva_x0020_Nunes</t></is></c>`,
      n('E2', 11987654321), s('F2', 10), s('H2', 11), s('I2', 12)])}</sheetData></worksheet>`;
  const buffer = zip([
    { name: '[Content_Types].xml', content: '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>' },
    { name: 'xl/workbook.xml', content: '<workbook xmlns:r="r"><sheets><sheet name="Candidatos" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships><Relationship Id="rId1" Type="worksheet" Target="/xl/worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', content: `<sst>${shared.map(si).join('')}</sst>` },
    { name: 'xl/worksheets/sheet1.xml', content: sheetXml },
  ]);
  const r = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`, buffer);
  assert.equal(r.status, 200, JSON.stringify(r.data));
  const [line] = r.data.rows;
  assert.deepEqual(line.errors, []);
  assert.equal(line.fullName, 'Eva Nunes', 'escape _x0020_ decodificado');
  assert.equal(line.approvedAt, today);
  assert.equal(line.phone, '(11) 98765-4321', 'telefone digitado como número');
  assert.equal(line.sexLabel, 'Feminino');
});

test('confirmação: grava com as regras do cadastro individual, registra a importação e o novo modelo traz só as que faltam', async () => {
  const rows = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
  const sheet = filled([
    { ...rows[0], approvedAt: today, fullName: '  Ana   Souza ', phone: '(11) 91234-5678', sex: 'Feminino' },
    { ...rows[1], approvedAt: today, fullName: 'Carlos Dias', phone: '(21) 3123-4567', sex: 'Masculino' },
  ]);
  const r = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import`, sheet, 'lote-1.xlsx');
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.equal(r.data.imported, 2);

  const positions = await query('SELECT id, status FROM positions WHERE id IN (?, ?)', rows[0].positionId, rows[1].positionId);
  assert.ok(positions.every((p) => p.status === 'CANDIDATE_APPROVED'));
  const ana = await queryOne('SELECT * FROM candidates WHERE position_id = ?', rows[0].positionId);
  assert.equal(ana.full_name, 'Ana Souza', 'nome normalizado como no cadastro individual');
  assert.deepEqual([ana.phone, ana.cpf, ana.birth_date], ['11912345678', null, null], 'nascimento e CPF ficam para a admissão');

  const summary = await queryOne("SELECT user_id, new_value FROM audit_logs WHERE action = 'IMPORT_CANDIDATES' AND field = 'Summary'");
  assert.match(summary.new_value, /"file":"lote-1\.xlsx","imported":2/);
  assert.ok(summary.user_id, 'registra quem importou');

  const next = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
  assert.equal(next.length, rows.length - 2, 'o novo modelo traz só as posições que faltam');

  const again = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`, sheet);
  assert.match(again.data.rows[0].errors[0].message, /já recebeu candidato/);
});

test('data retroativa com a carga inicial encerrada exige justificativa, gravada no histórico da linha', async () => {
  await execute("UPDATE system_parameters SET param_value = 'false' WHERE param_key = 'INITIAL_LOAD_OPEN'");
  try {
    const [row] = templateRows((await download('gestor.rh', `/api/orders/${order.summary.id}/candidates-template`)).buffer);
    const base = { ...row, approvedAt: addDays(today, -2), fullName: 'Duda Reis', phone: '(31) 99876-5432', sex: 'Não informado' };
    const missing = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import/preview`, filled([base]));
    assert.equal(missing.data.rows[0].errors[0].field, 'justification');
    const ok = await upload('gestor.rh', `/api/orders/${order.summary.id}/candidates-import`,
      filled([{ ...base, justification: 'Aprovado antes da carga no sistema' }]));
    assert.equal(ok.status, 200, JSON.stringify(ok.data));
    const log = await queryOne(
      "SELECT justification FROM audit_logs WHERE action = 'IMPORT_CANDIDATES' AND entity = 'Candidate' AND justification IS NOT NULL ORDER BY occurred_at DESC LIMIT 1");
    assert.equal(log.justification, 'Aprovado antes da carga no sistema');
    const p = await queryOne('SELECT has_retroactive_dates FROM positions WHERE id = ?', row.positionId);
    assert.equal(Number(p.has_retroactive_dates), 1, 'posição sinalizada (RN-24)');
  } finally {
    await execute("UPDATE system_parameters SET param_value = 'true' WHERE param_key = 'INITIAL_LOAD_OPEN'");
  }
});

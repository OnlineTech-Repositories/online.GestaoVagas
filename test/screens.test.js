/**
 * Monta cada tela do front-end de verdade, fora do navegador, contra a API real.
 *
 * Pega a classe de erro "a tela quebra ao abrir" (import esquecido, campo inexistente no caminho
 * de renderização) que os testes do back-end não enxergam. Usa o DOM mínimo do padrão de front-end.
 *
 * Sobe a própria API (createApp, porta efêmera, banco isolado com dados de demonstração). Para rodar contra uma API
 * já no ar, defina API_URL e DEMO_PASSWORD. Execução: npm test (ou node --test test/screens.test.js).
 */
import { DEMO_PASSWORD } from './env.js';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { instalarDom } from './dom-minimo.js';
import { startServer } from './server.js';

let API_URL = process.env.API_URL;
const PASSWORD = API_URL ? process.env.DEMO_PASSWORD : DEMO_PASSWORD;
const FRONT = new URL('../public/js/', import.meta.url);
let server = null;

let skipReason = PASSWORD ? null : 'defina DEMO_PASSWORD com a senha dos usuários de demonstração';
let dom;
let app;
let apiModule;
let ui;
// Um pote de cookies por usuário: cada um faz login uma vez só (a API limita a 10 logins por minuto por IP).
const jars = new Map();
let jar = new Map();

/** fetch do Node com pote de cookies: sessão, antiforgery e o XSRF-TOKEN lido pelo api.js. */
function installFetchBridge() {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (path, init = {}) => {
    const headers = new Headers(init.headers);
    if (jar.size) headers.set('Cookie', [...jar].map(([k, v]) => `${k}=${v}`).join('; '));
    const response = await realFetch(API_URL + path, { ...init, headers, redirect: 'manual' });
    for (const cookie of response.headers.getSetCookie()) {
      const [pair] = cookie.split(';');
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value || /expires=Thu, 01 Jan 1970/i.test(cookie)) jar.delete(name);
      else jar.set(name, value);
    }
    document.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    return response;
  };
  return () => {
    globalThis.fetch = realFetch;
  };
}

let restoreFetch = () => {};

before(async () => {
  if (skipReason) return;
  if (!API_URL) {
    server = await startServer({ demo: true });
    API_URL = server.url;
  }
  try {
    await fetch(`${API_URL}/api/saude`);
  } catch {
    skipReason = `API indisponível em ${API_URL}`;
    return;
  }
  dom = instalarDom();
  restoreFetch = installFetchBridge();
  apiModule = await import(new URL('api.js', FRONT));
  ui = await import(new URL('ui.js', FRONT));
  app = await import(new URL('app.js', FRONT)); // a partida do app roda aqui (saúde, sessão, login)
  // Os avisos de data abrem uma janela que espera um clique: aqui são confirmados sozinhos e registrados (o teste
  // "Avisos de data" clica na janela de verdade).
  apiModule.setWarningHandler(autoConfirm);
});

after(async () => {
  restoreFetch();
  dom?.restaurar();
  await server?.close();
});

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const warningsSeen = [];
const autoConfirm = async (problem) => {
  warningsSeen.push(problem);
  return { justification: 'Confirmado no teste.' };
};
const text = () => document.getElementById('app').textContent;

async function signIn(email) {
  if (jars.has(email)) {
    jar = jars.get(email);
    document.cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    app.state.user = await apiModule.api.session();
    return;
  }
  jar = new Map();
  jars.set(email, jar);
  await apiModule.api.health();
  app.state.user = await apiModule.api.login(email, PASSWORD);
}

/** Abre a rota e confere que a tela montou: título certo e nenhum erro de carregamento. */
async function open(path, expectedTitle) {
  window.location.hash = `#${path}`;
  await app.render();
  await wait(150); // áreas carregadas depois da montagem (ex.: busca do desligamento)
  const root = document.getElementById('app');
  const failure = root.querySelector('.mensagem.erro');
  assert.equal(failure, null, `${path}: ${failure?.textContent}`);
  assert.equal(root.querySelector('h1')?.textContent, expectedTitle, `${path}: título da página`);
  return root;
}

const skip = (t) => {
  if (skipReason) t.skip(skipReason);
  return !!skipReason;
};

test('a partida sem sessão mostra o login', (t) => {
  if (skip(t)) return;
  assert.match(text(), /Controle de Vagas/);
  assert.ok(document.getElementById('app').querySelector('input[name="email"]'));
});

test('Comercial: painel, listas, detalhes, novo pedido, clientes e valores', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');

  const painel = await open('/', 'Painel');
  assert.match(painel.textContent, /Faturamento perdido no mês/, 'o Comercial vê R$ no painel');

  await open('/notificacoes', 'Notificações');
  await open('/posicoes', 'Posições');
  await open('/posicoes?sla=OVERDUE', 'Posições');
  await open('/pedidos', 'Pedidos');
  await open('/pedidos/novo', 'Novo pedido');
  await open('/clientes', 'Clientes e contratos');
  await open('/valores', 'Valores por cargo');

  const { items } = await apiModule.api.get('/api/positions', { pageSize: 1 });
  const detail = await open(`/posicoes/${items[0].id}`, 'Posição');
  assert.match(detail.textContent, /Linha do tempo/);
  await open(`/pedidos/${items[0].orderId}`, 'Pedido');
});

test('NACC: reposição aguardando o cliente, ações em janela e desligamento', async (t) => {
  if (skip(t)) return;
  await signIn('nacc@demo.local');

  const painel = await open('/', 'Painel');
  assert.doesNotMatch(painel.textContent, /Faturamento perdido/, 'o NACC não vê R$');

  const { items } = await apiModule.api.get('/api/positions', { status: 'AWAITING_CONFIRMATION' });
  const root = await open(`/posicoes/${items[0].id}`, 'Posição');

  // Cada ação disponível abre a sua janela sem erro.
  // O DOM mínimo não tem seletor de descendente: parte do corpo do primeiro painel (cabeçalho da posição).
  const actions = root.querySelector('.painel-corpo').querySelectorAll('button');
  assert.ok(actions.length > 0, 'há ações para o NACC');
  for (const action of actions) {
    action.click();
    const modal = document.getElementById('modal-area').querySelector('.modal');
    assert.ok(modal, `janela da ação "${action.textContent}"`);
    modal.querySelector('.modal-fechar').click();
  }

  await open('/desligamentos/novo', 'Registrar desligamento');
});

test('DP, Controladoria e Gestor: telas do próprio perfil', async (t) => {
  if (skip(t)) return;
  await signIn('dp@demo.local');
  await open('/desligamentos/novo', 'Registrar desligamento');

  await signIn('controladoria@demo.local');
  await open('/valores', 'Valores por cargo');

  await signIn('gestor@demo.local');
  await open('/', 'Painel');
});

test('Administrador: usuários, parâmetros e cadastros auxiliares', async (t) => {
  if (skip(t)) return;
  await signIn('admin@demo.local');
  await open('/usuarios', 'Usuários e perfis');
  await open('/parametros', 'Parâmetros e metas de SLA');
  await open('/cadastros', 'Cadastros auxiliares');
});

test('Relatórios: as quatro abas montam com KPIs, resumo e detalhe; R$ conforme o perfil', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const root = await open('/relatorios', 'Relatórios');
  assert.match(root.textContent, /Tempo médio de preenchimento/);
  assert.match(root.textContent, /Faturamento perdido/, 'o Comercial vê o KPI em R$');
  assert.match(root.textContent, /Resumo por cliente/);
  const tabs = [...root.querySelectorAll('button')].filter((b) => String(b.className).includes('aba'));
  assert.deepEqual(tabs.map((b) => b.textContent), ['Posições em aberto', 'SLA por período', 'Faturamento perdido', 'Reposições']);
  for (const tab of tabs.slice(1)) {
    tab.click();
    await wait(250);
    const page = document.getElementById('app');
    assert.equal(page.querySelector('.mensagem.erro'), null, `aba ${tab.textContent}`);
    assert.match(page.textContent, /Detalhe \(\d+\)/, `aba ${tab.textContent}`);
  }

  await signIn('nacc@demo.local');
  const nacc = await open('/relatorios?tipo=loss', 'Relatórios');
  assert.doesNotMatch(nacc.textContent, /R\$\s*\d/, 'o NACC vê dias, sem valores em R$');
  assert.match(nacc.textContent, /sem os valores em R\$/);
});

test('Painel de RH: a gestão vê a equipe e os gráficos; o analista, só os seus pedidos; o Comercial não tem o menu', async (t) => {
  if (skip(t)) return;
  await signIn('gestor.rh@demo.local');
  const root = await open('/painel-rh', 'Painel de RH');
  assert.match(root.textContent, /Vagas por etapa/);
  assert.match(root.textContent, /Pedidos \(\d+\)/);
  assert.match(root.textContent, /Demandas por analista/);
  assert.match(root.textContent, /compartilhado/);
  assert.ok(root.querySelectorAll('.segmento').length > 0, 'barras empilhadas desenhadas');
  await open('/painel-rh?stage=RECRUITING&sla=OVERDUE', 'Painel de RH');
  await open('/posicoes?pedido=00000000-0000-0000-0000-000000000000&etapa=RECRUITING', 'Posições');

  await signIn('rh@demo.local');
  const mine = await open('/painel-rh', 'Painel de RH');
  assert.match(mine.textContent, /Minhas demandas/);
  assert.doesNotMatch(mine.textContent, /Pedidos sem analista de RH/);

  await signIn('comercial@demo.local');
  await open('/', 'Painel');
  assert.doesNotMatch(document.querySelector('.menu')?.textContent ?? '', /Painel de RH/);
});

test('Avisos de data: a janela lista o motivo, pede a justificativa e o envio segue confirmado', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  const contract = contracts.find((c) => c.modalities.includes('MOT'));
  const roles = await apiModule.api.get('/api/orders/job-roles', { contractId: contract.id });
  const day = (n) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

  // A janela de verdade: avisos com o tipo e a mensagem; sem justificativa obrigatória, "Salvar mesmo assim" conclui.
  const shown = ui.confirmWarnings({
    avisos: [{ tipo: 'FUTURE', mensagem: 'A data da aprovação (01/01/2099) é uma data futura.' },
      { tipo: 'SEQUENCE', mensagem: 'O 1º dia efetivo é anterior à etapa precedente.' }],
    justificativa: { campo: 'justification', obrigatoria: true },
  });
  await wait(20);
  const box = document.getElementById('modal-area');
  assert.match(box.textContent, /Registro futuro/);
  assert.match(box.textContent, /Sequência divergente/);
  const save = [...box.querySelectorAll('button')].find((b) => b.textContent === 'Salvar mesmo assim');
  save.click();
  assert.match(box.textContent, /Informe a justificativa/, 'retroativo fora da carga inicial: justificativa obrigatória');
  box.querySelector('textarea').value = 'Cliente aprovou por e-mail.';
  save.click();
  assert.deepEqual(await shown, { justification: 'Cliente aprovou por e-mail.' });

  // Pelo cliente da API: registro antes da solicitação avisa, a confirmação refaz o envio e o pedido é criado.
  warningsSeen.length = 0;
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: 'MOT', jobRoleId: roles[0].id, quantity: 1, workLocationId: contract.contractingUnitId,
    clientRequestDate: day(-2), desiredStartDate: day(5), registeredAt: day(-3), termType: 'INDEFINITE',
  });
  assert.equal(created.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
  assert.equal(warningsSeen.length, 1);
  assert.deepEqual(warningsSeen[0].avisos.map((a) => a.tipo).sort(), ['RETROACTIVE', 'SEQUENCE']);

  // Desistir na janela: nada é gravado e a tela recebe a mensagem.
  apiModule.setWarningHandler(async () => null);
  await assert.rejects(apiModule.api.post(`/api/orders/${created.summary.id}/approval`, { date: day(3) }),
    /Nada foi salvo: confira as datas/);
  apiModule.setWarningHandler(autoConfirm);
  const order = await apiModule.api.get(`/api/orders/${created.summary.id}`);
  assert.equal(order.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');

  // Aprovação futura confirmada: a posição fica "Data futura", com o SLA ainda não iniciado.
  const approved = await apiModule.api.post(`/api/orders/${created.summary.id}/approval`, { date: day(3) });
  const position = await apiModule.api.get(`/api/positions/${approved.positions[0].id}`);
  assert.equal(position.summary.dateFlags.future, true);
  assert.equal(position.summary.slaSituation, null);
  const screen = await open(`/posicoes/${approved.positions[0].id}`, 'Posição');
  assert.match(screen.textContent, /Data futura/);
  assert.match(screen.textContent, /Datas a conferir/);
});

test('Candidatos em lote: o RH vê o painel no pedido e a janela de importação abre; o Comercial não vê', async (t) => {
  if (skip(t)) return;
  await signIn('gestor.rh@demo.local');
  const orders = await apiModule.api.get('/api/orders');
  let target = null;
  for (const o of orders.items ?? orders) {
    const detail = await apiModule.api.get(`/api/orders/${o.id}`);
    if (detail.candidateImport?.pending) {
      target = detail;
      break;
    }
  }
  assert.ok(target, 'há pedido com posição aguardando candidato');
  const root = await open(`/pedidos/${target.summary.id}`, 'Pedido');
  assert.match(root.textContent, /Candidatos em lote/);
  assert.match(root.textContent, /aguardando candidato/);
  const importButton = [...root.querySelectorAll('button')].find((b) => b.textContent === 'Importar candidatos');
  importButton.click();
  const dialog = document.getElementById('modal-area').querySelector('.modal');
  assert.ok(dialog, 'janela de importação');
  assert.match(dialog.textContent, /Importar candidatos · pedido/);
  dialog.querySelector('.modal-fechar').click();

  await signIn('comercial@demo.local');
  const commercial = await open(`/pedidos/${target.summary.id}`, 'Pedido');
  assert.doesNotMatch(commercial.textContent, /Candidatos em lote/);
});

test('Admissões em lote: o Responsável por Admissões vê o painel no pedido e a janela abre; RH e Comercial não veem', async (t) => {
  if (skip(t)) return;
  await signIn('admissoes@demo.local');
  const orders = await apiModule.api.get('/api/orders');
  let target = null;
  for (const o of orders.items ?? orders) {
    const detail = await apiModule.api.get(`/api/orders/${o.id}`);
    if (detail.admissionImport) {
      target = detail;
      break;
    }
  }
  assert.ok(target, 'há pedido aprovado em que o Responsável por Admissões registra admissões');
  const root = await open(`/pedidos/${target.summary.id}`, 'Pedido');
  assert.match(root.textContent, /Admissões em lote/);
  if (target.admissionImport.pending) {
    [...root.querySelectorAll('button')].find((b) => b.textContent === 'Importar admissões').click();
    const dialog = document.getElementById('modal-area').querySelector('.modal');
    assert.match(dialog.textContent, /Importar admissões · pedido/);
    dialog.querySelector('.modal-fechar').click();
  } else {
    assert.match(root.textContent, /Nenhuma posição aguardando admissão/);
  }

  for (const email of ['comercial@demo.local', 'gestor.rh@demo.local']) {
    await signIn(email);
    const other = await open(`/pedidos/${target.summary.id}`, 'Pedido');
    assert.doesNotMatch(other.textContent, /Admissões em lote/, email);
  }
});

test('1º dia em lote: o NACC marca os que compareceram, aplica data e justificativa e revisa antes de gravar', async (t) => {
  if (skip(t)) return;
  await signIn('nacc@demo.local');
  const orders = await apiModule.api.get('/api/orders');
  let target = null;
  for (const o of orders.items ?? orders) {
    const detail = await apiModule.api.get(`/api/orders/${o.id}`);
    if (detail.firstDayBatch?.items.length) {
      target = detail;
      break;
    }
  }
  assert.ok(target, 'há pedido com admitido aguardando o 1º dia');
  const root = await open(`/pedidos/${target.summary.id}`, 'Pedido');
  assert.match(root.textContent, /1º dia efetivo em lote/);
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Confirmar 1º dia efetivo em lote').click();
  const dialog = document.getElementById('modal-area').querySelector('.modal');
  assert.match(dialog.textContent, /Confirmar comparecimento/);
  const checks = [...dialog.querySelectorAll('input[type="checkbox"]')].filter((c) => /Confirmar comparecimento/.test(c.getAttribute('aria-label')));
  assert.ok(checks.length && checks.every((c) => !c.checked), 'todas começam desmarcadas');
  const review = [...dialog.querySelectorAll('button')].find((b) => b.textContent.startsWith('Revisar selecionados'));
  assert.equal(review.disabled, true, 'sem marcação, nada a revisar');
  checks[0].checked = true;
  checks[0].dispatchEvent(new Event('change'));
  assert.match(review.textContent, /Revisar selecionados \(1\)/);
  const byLabel = (pattern) => [...dialog.querySelectorAll('input')].find((i) => pattern.test(i.getAttribute('aria-label') ?? ''));
  byLabel(/^Justificativa para as selecionadas$/).value = 'Cliente confirmou por e-mail.';
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Aplicar às selecionadas').click();
  const firstJustification = byLabel(/^Justificativa de /);
  assert.equal(firstJustification.value, 'Cliente confirmou por e-mail.');
  review.click();
  await wait(200);
  assert.match(dialog.textContent, /confirmação\(ões\) de 1º dia serão gravadas/);
  assert.ok([...dialog.querySelectorAll('button')].some((b) => /^Confirmar selecionados \(1\)$/.test(b.textContent)));
  dialog.querySelector('.modal-fechar').click();

  await signIn('comercial@demo.local');
  assert.doesNotMatch((await open(`/pedidos/${target.summary.id}`, 'Pedido')).textContent, /1º dia efetivo em lote/);
});

test('Redefinir senha: botão na edição, senha gerada por padrão e mostrada uma única vez', async (t) => {
  if (skip(t)) return;
  await signIn('admin@demo.local');
  // Usuário só deste teste: a redefinição encerra as sessões, e os outros testes usam os usuários da demonstração.
  await apiModule.api.post('/api/users', { name: 'Pessoa da Redefinição', email: 'redefinicao@teste.invalid', roles: ['DP'], passwordMode: 'GENERATE' });
  const root = await open('/usuarios', 'Usuários e perfis');
  root.querySelectorAll('tr').find((tr) => tr.textContent.includes('Pessoa da Redefinição')).click();
  let dialog = document.getElementById('modal-area').querySelector('.modal');
  assert.doesNotMatch(dialog.textContent, /Nova senha provisória/, 'o campo de senha saiu da edição');
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Redefinir senha').click();
  await wait(50);
  dialog = document.getElementById('modal-area').querySelector('.modal');
  assert.match(dialog.textContent, /Redefinir senha · Pessoa da Redefinição/);
  assert.match(dialog.textContent, /A senha aparece uma única vez/);
  assert.match(dialog.textContent, /serão encerradas e a troca de senha será exigida/);
  const radios = [...dialog.querySelectorAll('input')].filter((i) => i.getAttribute('type') === 'radio');
  assert.equal(radios.find((r) => r.value === 'GENERATE').checked, true, 'gerar é o padrão');
  [...dialog.querySelectorAll('button')].find((b) => b.textContent === 'Redefinir senha').click();
  await wait(300);
  dialog = document.getElementById('modal-area').querySelector('.modal');
  assert.match(dialog.textContent, /Senha provisória de Pessoa da Redefinição/);
  assert.equal(dialog.querySelector('code').textContent.length, 12);
  assert.match(dialog.textContent, /única vez que a senha aparece/);
  dialog.querySelector('.modal-fechar').click();
});

test('rota sem permissão volta ao painel (a API também nega com 403)', async (t) => {
  if (skip(t)) return;
  await signIn('rh@demo.local');
  await open('/', 'Painel');
  window.location.hash = '#/usuarios';
  await app.render();
  assert.equal(window.location.hash, '#/');
  await assert.rejects(apiModule.api.get('/api/users'), (e) => e.status === 403);
});

test('erro de validação marca o campo e a marca some ao corrigir', (t) => {
  if (skip(t)) return;
  const form = ui.el('form', {}, ui.field({ name: 'reason', label: 'Motivo' }), ui.field({ name: 'date', label: 'Data' }));
  const summary = ui.applyErrors(form, { message: 'Informe o motivo.', fields: { reason: 'Informe o motivo.' } });
  form.prepend(summary);

  const block = form.querySelector('[data-campo="reason"]');
  assert.ok(block.classList.contains('com-erro'));
  assert.equal(block.querySelector('.erro-campo').textContent, 'Informe o motivo.');

  block.querySelector('input').disparar('input');
  assert.ok(!block.classList.contains('com-erro'), 'a marca sai ao digitar');
  assert.equal(form.querySelector('.mensagem.erro'), null, 'o resumo sai junto com o último erro');
});

test('o backend aponta o campo recusado na regra de negócio', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  await assert.rejects(
    apiModule.api.post('/api/clients', { legalName: 'Teste', cnpj: '123', active: true }),
    (e) => e.status === 422 && e.fields.cnpj === 'CNPJ inválido.',
  );
});

/** CNPJ válido a partir de 12 dígitos (só para dados de teste). */
function validCnpj(base12) {
  const digit = (digits, weights) => {
    const rest = [...digits].reduce((sum, c, i) => sum + Number(c) * weights[i], 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const d1 = digit(base12, [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  const d2 = digit(base12 + d1, [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2]);
  return `${base12}${d1}${d2}`;
}

test('Unidades do cliente: cadastra, edita, exclui logicamente e viram locais do pedido', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const base = String(Date.now()).slice(-8).padStart(8, '0');

  const created = await apiModule.api.post('/api/clients', {
    legalName: `Rede Teste ${base}`,
    cnpj: validCnpj(`${base}0001`),
    active: true,
    hasMultipleUnits: true,
    units: [
      { id: null, code: 'LJ-01', name: 'Loja Um', cnpj: validCnpj(`${base}0002`) },
      { id: null, code: 'LJ-02', name: 'Loja Dois', cnpj: validCnpj(`${base}0003`) },
    ],
  });
  assert.equal(created.units.length, 2);

  // CNPJ é obrigatório em toda unidade.
  await assert.rejects(
    apiModule.api.put(`/api/clients/${created.id}`, { ...created, units: [...created.units, { id: null, code: 'LJ-03', name: 'Sem CNPJ' }] }),
    (e) => e.status === 422 && /Informe o CNPJ da unidade "LJ-03"/.test(e.message),
  );

  // Código repetido é recusado e aponta a seção das unidades.
  await assert.rejects(
    apiModule.api.put(`/api/clients/${created.id}`, { ...created, units: [...created.units,
      { id: null, code: 'lj-01', name: 'Outra', cnpj: validCnpj(`${base}0009`) }] }),
    (e) => e.status === 422 && 'units' in e.fields,
  );

  // Edita a primeira e exclui a segunda (exclusão lógica).
  const [first, second] = created.units;
  const updated = await apiModule.api.put(`/api/clients/${created.id}`, {
    legalName: created.legalName, cnpj: created.cnpj, active: true, hasMultipleUnits: true,
    units: [{ ...first, name: 'Loja Um Renomeada' }],
  });
  assert.deepEqual(updated.units.map((u) => u.name), ['Loja Um Renomeada']);

  const locations = await apiModule.api.get('/api/catalogs/work-locations');
  assert.ok(locations.some((l) => l.id === first.id && l.clientId === created.id), 'a unidade é um local do cliente');
  assert.ok(!locations.some((l) => l.id === second.id), 'a unidade excluída sai das listas');

  // Com unidades na lista, não dá para desmarcar a opção.
  await assert.rejects(
    apiModule.api.put(`/api/clients/${created.id}`, { legalName: created.legalName, cnpj: created.cnpj, active: true, hasMultipleUnits: false }),
    (e) => e.status === 422 && 'hasMultipleUnits' in e.fields,
  );

  // A tela abre o cliente com a seção de unidades.
  const root = await open('/clientes', 'Clientes e contratos');
  const row = root.querySelectorAll('tr').find((tr) => tr.textContent.includes(created.legalName));
  row.click();
  const modal = document.getElementById('modal-area').querySelector('.modal');
  assert.ok(modal.querySelector('[data-campo="units"]'), 'seção Unidades do cliente');
  assert.match(modal.textContent, /Cliente possui múltiplas unidades/);
  modal.querySelector('.modal-fechar').click();
});

test('Bandeira/marca: CNPJ central opcional, ao menos uma unidade e CNPJ obrigatório e único por unidade', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const base = String(Date.now() + 3).slice(-8).padStart(8, '0');
  const unit = (code, branch) => ({ id: null, code, name: `Loja ${code}`, cnpj: validCnpj(`${base}${branch}`) });

  // Sem unidade, a bandeira não é salva; com uma, salva sem o CNPJ central e já com "múltiplas unidades".
  await assert.rejects(apiModule.api.post('/api/clients', { legalName: `Bandeira ${base}`, isBrand: true, active: true, units: [] }),
    (e) => e.status === 422 && 'units' in e.fields);
  const brand = await apiModule.api.post('/api/clients', {
    legalName: `Bandeira ${base}`, cnpj: null, isBrand: true, active: true, units: [unit('B-01', '0002')],
  });
  assert.equal(brand.isBrand, true);
  assert.equal(brand.cnpj, null);
  assert.equal(brand.hasMultipleUnits, true);
  // Outra bandeira sem CNPJ central convive com a primeira.
  const other = await apiModule.api.post('/api/clients', {
    legalName: `Outra Bandeira ${base}`, isBrand: true, active: true, units: [unit('O-01', '0003')],
  });
  assert.equal(other.cnpj, null);

  // CNPJ central, quando informado, é validado.
  await assert.rejects(apiModule.api.put(`/api/clients/${brand.id}`, { ...brand, cnpj: '11.111.111/1111-11' }),
    (e) => e.status === 422 && 'cnpj' in e.fields);
  // CNPJ de unidade único no sistema: outra bandeira não reaproveita.
  await assert.rejects(apiModule.api.put(`/api/clients/${other.id}`, { ...other, units: [...other.units, unit('O-02', '0002')] }),
    (e) => e.status === 422 && /já é o da unidade "B-01"/.test(e.message));
  // Desmarcada a bandeira, o CNPJ central volta a ser obrigatório.
  await assert.rejects(apiModule.api.put(`/api/clients/${brand.id}`, { ...brand, isBrand: false }),
    (e) => e.status === 422 && 'cnpj' in e.fields);
  const regular = await apiModule.api.put(`/api/clients/${brand.id}`, { ...brand, isBrand: false, cnpj: validCnpj(`${base}0001`) });
  assert.equal(regular.isBrand, false);
  assert.equal(regular.units.length, 1, 'as unidades continuam');

  // A tela: a opção troca o rótulo e a obrigatoriedade, sem apagar o que foi digitado.
  const root = await open('/clientes', 'Clientes e contratos');
  root.querySelectorAll('button').find((b) => b.textContent.includes('Novo cliente')).click();
  const modal = document.getElementById('modal-area').querySelector('.modal');
  const name = modal.querySelector('[data-campo="legalName"]');
  name.querySelector('input').value = 'Rede Digitada';
  const toggle = modal.querySelector('#campo-isBrand');
  toggle.checked = true;
  toggle.dispatchEvent(new Event('change'));
  assert.match(name.querySelector('label').textContent, /Nome da bandeira\/marca/);
  assert.match(modal.querySelector('[data-campo="cnpj"] label').textContent, /CNPJ \(opcional\)/);
  assert.equal(modal.querySelector('#campo-hasMultipleUnits').checked, true);
  toggle.checked = false;
  toggle.dispatchEvent(new Event('change'));
  assert.match(name.querySelector('label').textContent, /Razão social/);
  assert.equal(name.querySelector('input').value, 'Rede Digitada', 'nada apagado');
  assert.match(modal.textContent, /Código, nome e CNPJ são obrigatórios/);
  modal.querySelector('.modal-fechar').click();
});

test('Contrato: unidade contratante, código gerado e local fixo no pedido', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const base = String(Date.now() + 7).slice(-8).padStart(8, '0');
  const year = new Date().getFullYear();
  const [groups, owners, jobRoles, locations] = await Promise.all([
    apiModule.api.get('/api/catalogs/group-entities'),
    apiModule.api.get('/api/users/by-role/COMMERCIAL'),
    apiModule.api.get('/api/catalogs/job-roles'),
    apiModule.api.get('/api/catalogs/work-locations'),
  ]);

  const client = await apiModule.api.post('/api/clients', {
    legalName: `Supermercados Teste ${base}`, cnpj: validCnpj(`${base}0001`), active: true, hasMultipleUnits: true,
    units: [{ id: null, code: 'Loja 45', name: 'Loja Moema', cnpj: validCnpj(`${base}0002`) },
      { id: null, code: 'LJ-46', name: 'Loja Centro', cnpj: validCnpj(`${base}0003`) }],
  });
  const moema = client.units.find((u) => u.code === 'Loja 45');
  const other = client.units.find((u) => u.code === 'LJ-46');
  const contractBody = (unitId) => ({
    clientId: client.id, contractingUnitId: unitId, groupEntityId: groups[0].id, commercialOwnerId: owners[0].id,
    modalities: ['MOT'], startDate: `${year}-01-01`, endDate: null, status: 'ACTIVE', slaNewDays: 10, slaReplacementDays: 5,
  });

  // Cliente com unidades: a unidade contratante é obrigatória.
  await assert.rejects(apiModule.api.post('/api/contracts', contractBody(null)), (e) => e.status === 422 && 'contractingUnitId' in e.fields);

  const first = await apiModule.api.post('/api/contracts', contractBody(moema.id));
  const second = await apiModule.api.post('/api/contracts', contractBody(moema.id));
  assert.equal(first.name, `CT-${year}-LOJA-45-0001`);
  assert.equal(second.name, `CT-${year}-LOJA-45-0002`, 'sequencial por unidade e ano');
  assert.equal(first.contractingUnitCode, 'Loja 45');

  // O código não muda ao renomear a unidade; a unidade em uso não pode ser excluída.
  const renamed = await apiModule.api.put(`/api/clients/${client.id}`, {
    legalName: client.legalName, cnpj: client.cnpj, active: true, hasMultipleUnits: true,
    units: client.units.map((u) => (u.id === moema.id ? { ...u, name: 'Loja Moema Renomeada' } : u)),
  });
  assert.ok(renamed.units.some((u) => u.name === 'Loja Moema Renomeada'));
  assert.equal((await apiModule.api.get(`/api/contracts/${first.id}`)).name, first.name);
  await assert.rejects(
    apiModule.api.put(`/api/clients/${client.id}`, { legalName: client.legalName, cnpj: client.cnpj, active: true,
      hasMultipleUnits: true, units: client.units.filter((u) => u.id !== moema.id) }),
    (e) => e.status === 422 && 'units' in e.fields,
  );

  // Cliente e unidade ficam fixos depois de criado o contrato.
  await assert.rejects(
    apiModule.api.put(`/api/contracts/${first.id}`, contractBody(other.id)),
    (e) => e.status === 422 && 'contractingUnitId' in e.fields,
  );

  // O pedido do contrato usa a unidade contratante: outro local é recusado.
  const general = locations.find((l) => !l.clientId);
  const order = {
    contractId: first.id, modality: 'MOT', jobRoleId: jobRoles[0].id, quantity: 1, clientRequestDate: `${year}-01-02`,
    desiredStartDate: `${year}-01-05`, termType: 'INDEFINITE', termEndDate: null, termDurationDays: null, notes: null,
    registeredAt: `${year}-01-02`, justification: null,
  };
  // Cargo do pedido = cargo com valor VALIDADO no contrato; antes da validação, a lista vem vazia e o pedido é recusado.
  const role = jobRoles[0];
  assert.deepEqual(await apiModule.api.get('/api/orders/job-roles', { contractId: first.id }), []);
  const rate = await apiModule.api.post('/api/contract-rates', {
    contractId: first.id, jobRoleId: role.id, monthlyValue: 3000, feeValue: null, validFrom: `${year}-01-01` });
  await assert.rejects(apiModule.api.post('/api/orders', { ...order, workLocationId: moema.id }),
    (e) => e.status === 422 && 'jobRoleId' in e.fields);
  await signIn('controladoria@demo.local');
  await apiModule.api.post(`/api/contract-rates/${rate.id}/validate`);
  await signIn('comercial@demo.local');
  // Um reajuste ainda pendente não entra no pedido: vale a versão validada.
  await apiModule.api.post('/api/contract-rates', {
    contractId: first.id, jobRoleId: role.id, monthlyValue: 9000, feeValue: null, validFrom: `${year}-01-02` });
  const available = await apiModule.api.get('/api/orders/job-roles', { contractId: first.id });
  assert.deepEqual(available.map((j) => j.id), [role.id]);
  // O mesmo cargo em outro contrato (sem valor validado) não aparece.
  assert.deepEqual(await apiModule.api.get('/api/orders/job-roles', { contractId: second.id }), []);

  await assert.rejects(apiModule.api.post('/api/orders', { ...order, workLocationId: general.id }),
    (e) => e.status === 422 && 'workLocationId' in e.fields);
  const description = ['Atividades: repor gôndolas.', '', 'Requisitos: ensino médio.', 'Desejável: experiência em varejo.'].join('\n');
  await assert.rejects(apiModule.api.post('/api/orders', { ...order, workLocationId: moema.id, jobDescription: 'x'.repeat(4001) }),
    (e) => e.status === 422 && 'jobDescription' in e.fields);
  const created = await apiModule.api.post('/api/orders', { ...order, quantity: 2, workLocationId: moema.id, jobDescription: description });
  assert.equal(created.workLocationId, moema.id);

  // A descrição fica no pedido e aparece em todas as posições geradas, com os parágrafos preservados.
  assert.equal(created.jobDescription, description);
  for (const position of created.positions) {
    const positionDetail = await apiModule.api.get(`/api/positions/${position.id}`);
    assert.equal(positionDetail.jobDescription, description);
    assert.equal(positionDetail.metrics.dailyValue, 100, 'valor diário da versão validada (3.000 / 30)');
    assert.equal(positionDetail.metrics.moneyStatus, 'VALIDATED');
  }
  const detail = await open(`/posicoes/${created.positions[1].id}`, 'Posição');
  assert.ok(detail.querySelector('.texto-livre')?.textContent.includes('Requisitos: ensino médio.'), 'descrição na tela da posição');
  const orderScreen = await open(`/pedidos/${created.summary.id}`, 'Pedido');
  assert.match(orderScreen.textContent, /Descrição da vaga/);

  // Cliente sem unidades: o código usa o nome do cliente principal.
  const plain = await apiModule.api.post('/api/clients', {
    legalName: `Ácme Teste ${base}`, cnpj: validCnpj(`${base}0009`), active: true, hasMultipleUnits: false, units: [],
  });
  const plainContract = await apiModule.api.post('/api/contracts', { ...contractBody(null), clientId: plain.id });
  assert.equal(plainContract.name, `CT-${year}-ACME-TESTE-${base}-0001`);
  assert.equal(plainContract.contractingUnitId, null);

  // A tela de contratos mostra a unidade contratante e o código.
  const root = await open('/clientes', 'Clientes e contratos');
  assert.match(root.textContent, new RegExp(first.name));
});

test('Aprovação do cliente: pedido aguardando, RH até recrutamento, aprovação e recusa notificam todos', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  assert.ok(contract, 'há contrato com cargo validado nos dados de demonstração');
  const body = {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 2,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  };

  // O pedido nasce aguardando: posições sem abertura e sem SLA.
  const created = await apiModule.api.post('/api/orders', body);
  const orderId = created.summary.id;
  assert.equal(created.summary.approvalStatus, 'AWAITING_CLIENT_APPROVAL');
  assert.equal(created.canDecideApproval, true);
  for (const p of created.positions) {
    assert.equal(p.openedAt, null);
    assert.equal(p.slaSituation, null);
    assert.equal(p.orderApprovalStatus, 'AWAITING_CLIENT_APPROVAL');
  }
  const screen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.match(screen.textContent, /Aguardando aprovação do cliente/);
  const buttons = [...screen.querySelector('.painel-cabecalho').querySelectorAll('button')].map((b) => b.textContent);
  assert.ok(buttons.includes('Registrar aprovação do cliente') && buttons.includes('Cliente não aprovou'), buttons.join(', '));
  const awaitingList = await apiModule.api.get('/api/orders', { approvalStatus: 'AWAITING_CLIENT_APPROVAL' });
  assert.ok(awaitingList.some((o) => o.id === orderId), 'filtro de aprovação na lista');
  await open('/pedidos?aprovacao=AWAITING_CLIENT_APPROVAL', 'Pedidos');

  // A Gestora de RH distribui o pedido para a Rita.
  await signIn('gestor.rh@demo.local');
  const ritaUser = (await apiModule.api.get('/api/users/by-role/RH')).find((u) => u.name === 'Rita RH (demo)');
  await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [ritaUser.id] });
  // Todos os usuários são notificados, com o link para o pedido.
  await signIn('rh@demo.local');
  const created1 = (await apiModule.api.get('/api/notifications')).find((n) => n.type === 'ORDER_CREATED' && n.entityId === orderId);
  assert.ok(created1, 'RH notificado da criação');
  assert.match(created1.message, new RegExp(`Pedido ${created.summary.number}`));
  assert.match(created1.message, /Status: Aguardando aprovação do cliente/);

  // RH prepara até "Em recrutamento"; aprovar candidato espera a aprovação do cliente.
  const [first, second] = created.positions;
  const rhDetail = await apiModule.api.get(`/api/positions/${first.id}`);
  assert.ok(!rhDetail.allowedActions.includes('START_RECRUITING'), 'o recrutamento começa pela publicação no pedido');
  await apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-APROV-1', publishedAt: todayIso, justification: null });
  const recruiting = await apiModule.api.get(`/api/positions/${first.id}`);
  assert.equal(recruiting.summary.status, 'RECRUITING');
  assert.ok(!recruiting.allowedActions.includes('APPROVE_CANDIDATE'), 'sem aprovar candidato antes da aprovação');
  await assert.rejects(apiModule.api.post(`/api/positions/${first.id}/candidate-approval`, { date: todayIso, justification: null }),
    (e) => e.status === 422 && /aguarda a aprovação do cliente/.test(e.message));
  // RH não decide a aprovação do pedido.
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null }),
    (e) => e.status === 403);
  const positionScreen = await open(`/posicoes/${first.id}`, 'Posição');
  assert.match(positionScreen.textContent, /O pedido aguarda a aprovação do cliente/);

  // A Controladoria registra a aprovação: abertura e SLA a partir da data informada.
  await signIn('controladoria@demo.local');
  // Data antes da solicitação: aviso antes de salvar; quem desiste na janela não grava nada.
  apiModule.setWarningHandler(async () => null);
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/approval`, { date: '2000-01-01', justification: 'x' }),
    (e) => e.status === 422 && e.code === 'cancelled');
  apiModule.setWarningHandler(autoConfirm);
  const approved = await apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null });
  assert.equal(approved.summary.approvalStatus, 'APPROVED');
  assert.equal(approved.summary.clientDecisionDate, todayIso);
  assert.equal(approved.approvalRecordedByName, 'Clara Controladoria (demo)');
  assert.ok(approved.approvalRecordedAt);
  for (const p of approved.positions) {
    assert.equal(p.openedAt, todayIso);
    assert.ok(p.slaSituation, 'SLA calculado depois da aprovação');
  }
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null }),
    (e) => e.status === 422, 'não aprova duas vezes');
  const approvedScreen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.match(approvedScreen.textContent, /registrada por Clara Controladoria/);

  await signIn('dp@demo.local');
  const approvedNote = (await apiModule.api.get('/api/notifications')).find((n) => n.type === 'ORDER_APPROVED' && n.entityId === orderId);
  assert.ok(approvedNote, 'DP notificado da aprovação');
  assert.match(approvedNote.message, /Status: Aprovado/);
  await open('/notificacoes', 'Notificações');

  // RH segue o fluxo depois da aprovação.
  await signIn('rh@demo.local');
  assert.ok((await apiModule.api.get(`/api/positions/${first.id}`)).allowedActions.includes('APPROVE_CANDIDATE'));
  assert.equal((await apiModule.api.get(`/api/positions/${second.id}`)).summary.openedAt, todayIso);

  // "Cliente não aprovou": encerra todas as posições, sem perda, e notifica todos.
  await signIn('comercial@demo.local');
  const other = await apiModule.api.post('/api/orders', { ...body, quantity: 1 });
  await assert.rejects(apiModule.api.post(`/api/orders/${other.summary.id}/rejection`, { date: todayIso, reason: ' ' }),
    (e) => e.status === 422 && 'reason' in e.fields);
  const rejected = await apiModule.api.post(`/api/orders/${other.summary.id}/rejection`, { date: todayIso, reason: 'Cliente congelou as contratações' });
  assert.equal(rejected.summary.approvalStatus, 'NOT_APPROVED');
  assert.equal(rejected.notApprovedReason, 'Cliente congelou as contratações');
  for (const p of rejected.positions) {
    assert.equal(p.status, 'CLOSED_CLIENT_CANCELLED');
    if (p.lost !== null) assert.equal(p.lost, 0);
  }
  await assert.rejects(apiModule.api.post(`/api/orders/${other.summary.id}/positions`, { quantity: 1, desiredStartDate: todayIso, justification: null }),
    (e) => e.status === 422);
  const rejectedScreen = await open(`/pedidos/${other.summary.id}`, 'Pedido');
  assert.match(rejectedScreen.textContent, /O cliente não aprovou o pedido/);

  await signIn('nacc@demo.local');
  assert.ok((await apiModule.api.get('/api/notifications')).some((n) => n.type === 'ORDER_NOT_APPROVED' && n.entityId === other.summary.id),
    'NACC notificado da recusa');

  await signIn('gestor@demo.local');
  const painel = await open('/', 'Painel');
  assert.match(painel.textContent, /Aguardando aprovação do cliente/);
});

test('JobConvo no pedido: uma publicação para todas as posições, atualização refletida e herança', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 2,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  });
  const orderId = created.summary.id;
  assert.equal(created.jobconvo, null);
  assert.equal(created.canRecordJobconvo, false, 'só o RH registra a publicação');
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'X', publishedAt: todayIso }),
    (e) => e.status === 403);

  // A Gestora de RH distribui o pedido para a Rita.
  await signIn('gestor.rh@demo.local');
  const ritaUser = (await apiModule.api.get('/api/users/by-role/RH')).find((u) => u.name === 'Rita RH (demo)');
  await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [ritaUser.id] });
  // RH: a ação fica no pedido; a posição não tem mais "Informar vaga no JobConvo".
  await signIn('rh@demo.local');
  const before = await apiModule.api.get(`/api/orders/${orderId}`);
  assert.equal(before.canRecordJobconvo, true);
  assert.ok(before.positions.every((p) => p.status === 'OPEN'));
  const orderScreen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.match(orderScreen.textContent, /Publicação ainda não informada/);
  const publishButton = [...orderScreen.querySelectorAll('button')].find((b) => b.textContent === 'Informar publicação no JobConvo');
  assert.ok(publishButton, 'botão no pedido');
  publishButton.click();
  const modal = document.getElementById('modal-area').querySelector('.modal');
  assert.ok(modal?.querySelector('[data-campo="code"]'), 'janela da publicação');
  modal.querySelector('.modal-fechar').click();
  const positionBefore = await apiModule.api.get(`/api/positions/${created.positions[0].id}`);
  assert.ok(!positionBefore.allowedActions.includes('START_RECRUITING'));

  // Publicado exige código e data; data futura avisa antes de salvar (aqui a janela é recusada: nada gravado).
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: ' ', publishedAt: todayIso }),
    (e) => e.status === 422 && 'code' in e.fields);
  apiModule.setWarningHandler(async () => null);
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-1', publishedAt: '2999-01-01' }),
    (e) => e.status === 422 && e.code === 'cancelled');
  apiModule.setWarningHandler(autoConfirm);

  // Uma publicação: as duas posições entram em recrutamento com o mesmo código.
  const published = await apiModule.api.post(`/api/orders/${orderId}/jobconvo`,
    { published: true, code: 'JC-PED-1', publishedAt: todayIso, justification: 'Publicação única para o pedido.' });
  assert.equal(published.jobconvo.published, true);
  assert.equal(published.jobconvo.recordedByName, 'Rita RH (demo)');
  assert.ok(published.positions.every((p) => p.status === 'RECRUITING' && p.jobconvoCode === 'JC-PED-1'));
  assert.equal(published.summary.jobconvoCode, 'JC-PED-1');

  // Atualizar no pedido reflete em todas as posições.
  await apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-PED-2', publishedAt: todayIso, justification: null });
  for (const position of created.positions) {
    const detail = await apiModule.api.get(`/api/positions/${position.id}`);
    assert.equal(detail.jobconvoCode, 'JC-PED-2');
    assert.equal(detail.jobconvoPublishedAt, todayIso);
  }
  const found = await apiModule.api.get('/api/positions', { search: 'JC-PED-2' });
  assert.equal(found.items.length, 2, 'busca pelo código da publicação');
  const positionScreen = await open(`/posicoes/${created.positions[1].id}`, 'Posição');
  assert.match(positionScreen.textContent, /JC-PED-2 · publicada em/);

  // Posição acrescentada depois herda a publicação.
  await signIn('comercial@demo.local');
  const grown = await apiModule.api.post(`/api/orders/${orderId}/positions`, { quantity: 1, desiredStartDate: todayIso, justification: null });
  const added = grown.positions.find((p) => !created.positions.some((c) => c.id === p.id));
  assert.equal(added.status, 'RECRUITING');
  assert.equal(added.jobconvoCode, 'JC-PED-2');

  // Sem publicação: exige justificativa; o código sai de todas as posições.
  await signIn('rh@demo.local');
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: false, code: null, publishedAt: null, justification: '' }),
    (e) => e.status === 422 && 'justification' in e.fields);
  const notPublished = await apiModule.api.post(`/api/orders/${orderId}/jobconvo`,
    { published: false, code: null, publishedAt: null, justification: 'Candidatos indicados pelo cliente.' });
  assert.equal(notPublished.jobconvo.published, false);
  assert.ok(notPublished.positions.every((p) => p.jobconvoCode === null && p.status === 'RECRUITING'));
  const listScreen = await open('/pedidos', 'Pedidos');
  assert.match(listScreen.textContent, /Sem publicação/);
});

test('RH: Gestor de RH distribui o pedido; o Analista de RH age só nos pedidos atribuídos', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 1,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  });
  const orderId = created.summary.id;
  const positionId = created.positions[0].id;
  assert.equal(created.summary.awaitingRhAssignment, true);
  assert.equal(created.canAssignRh, false, 'só o Gestor de RH distribui');
  const commercialUsers = await apiModule.api.get('/api/users/by-role/COMMERCIAL');

  // Sem responsável: a analista não executa o recrutamento do pedido.
  await signIn('rh@demo.local');
  const unassigned = await apiModule.api.get('/api/orders', { rh: 'UNASSIGNED' });
  assert.ok(unassigned.some((o) => o.id === orderId), 'filtro "Aguardando atribuição do RH"');
  const asAnalyst = await apiModule.api.get(`/api/orders/${orderId}`);
  assert.equal(asAnalyst.canRecordJobconvo, false);
  assert.equal(asAnalyst.canAssignRh, false);
  await assert.rejects(apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-RH', publishedAt: todayIso }),
    (e) => e.status === 403 && /analistas de RH responsáveis/.test(e.message));
  await assert.rejects(apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [] }), (e) => e.status === 403);
  const unassignedScreen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.match(unassignedScreen.textContent, /Aguardando atribuição do RH/);

  // Gestora de RH: só analistas ativos; inclui duas, depois substitui.
  await signIn('gestor.rh@demo.local');
  const analysts = await apiModule.api.get('/api/users/by-role/RH');
  const rita = analysts.find((u) => u.name === 'Rita RH (demo)');
  const renato = analysts.find((u) => u.name === 'Renato RH (demo)');
  const manager = await apiModule.api.get(`/api/orders/${orderId}`);
  assert.equal(manager.canAssignRh, true);
  assert.equal(manager.canRecordJobconvo, true, 'o Gestor de RH também executa');
  await assert.rejects(apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [commercialUsers[0].id] }),
    (e) => e.status === 422 && 'analystIds' in e.fields);
  const both = await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [rita.id, renato.id] });
  assert.deepEqual(both.rhAnalysts.map((a) => a.name).sort(), ['Renato RH (demo)', 'Rita RH (demo)']);
  assert.equal(both.summary.awaitingRhAssignment, false);
  const replaced = await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [renato.id] });
  assert.deepEqual(replaced.rhAnalysts.map((a) => a.name), ['Renato RH (demo)']);
  const ritaHistory = replaced.rhAssignmentHistory.find((h) => h.userId === rita.id);
  assert.ok(ritaHistory.removedAt, 'histórico guarda a remoção');
  assert.equal(ritaHistory.removedByName, 'Helena Gestora de RH (demo)');
  assert.equal(ritaHistory.assignedByName, 'Helena Gestora de RH (demo)');
  const managerScreen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.match(managerScreen.textContent, /Histórico de responsáveis \(2\)/);
  assert.ok([...managerScreen.querySelectorAll('button')].some((b) => b.textContent === 'Alterar analistas'));
  const painel = await open('/', 'Painel');
  assert.match(painel.textContent, /Aguardando atribuição do RH/);

  // Rita foi avisada da inclusão e da remoção; fora da equipe, não age e a tela explica.
  await signIn('rh@demo.local');
  const notes = (await apiModule.api.get('/api/notifications')).filter((n) => n.entityId === orderId);
  assert.ok(notes.some((n) => n.type === 'RH_ASSIGNED'), 'aviso de inclusão');
  assert.ok(notes.some((n) => n.type === 'RH_UNASSIGNED'), 'aviso de remoção');
  const outside = await apiModule.api.get(`/api/positions/${positionId}`);
  assert.equal(outside.canActAsRh, false);
  assert.deepEqual(outside.rhAnalysts.map((a) => a.name), ['Renato RH (demo)']);
  const outsideScreen = await open(`/posicoes/${positionId}`, 'Posição');
  assert.match(outsideScreen.textContent, /Você não está entre os analistas de RH responsáveis/);

  // De volta à equipe, a Rita registra a publicação e vê a posição em "Meus pedidos".
  await signIn('gestor.rh@demo.local');
  await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [renato.id, rita.id] });
  await signIn('rh@demo.local');
  const published = await apiModule.api.post(`/api/orders/${orderId}/jobconvo`,
    { published: true, code: 'JC-RH-1', publishedAt: todayIso, justification: null });
  assert.equal(published.positions[0].status, 'RECRUITING');
  assert.deepEqual([...published.positions[0].rhAnalystNames].sort(), ['Renato RH (demo)', 'Rita RH (demo)']);
  const mine = await apiModule.api.get('/api/positions', { rh: 'MINE' });
  assert.ok(mine.items.some((p) => p.id === positionId), 'filtro "Meus pedidos" nas posições');
  const mineOrders = await apiModule.api.get('/api/orders', { rh: 'MINE' });
  assert.ok(mineOrders.some((o) => o.id === orderId));
  await open('/posicoes?rh=MINE', 'Posições');
});

test('Candidato selecionado: nome, telefone e sexo no cadastro; nascimento e CPF na admissão; correção e dados restritos', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 2,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  });
  const orderId = created.summary.id;
  const [first, second] = created.positions.map((p) => p.id);
  await apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null });

  await signIn('gestor.rh@demo.local');
  const rita = (await apiModule.api.get('/api/users/by-role/RH')).find((u) => u.name === 'Rita RH (demo)');
  await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [rita.id] });

  await signIn('rh@demo.local');
  await apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-CAND', publishedAt: todayIso, justification: null });

  // "Adicionar Candidato" pede só nome, telefone e sexo; nascimento e CPF ficam para a admissão.
  const screen = await open(`/posicoes/${first}`, 'Posição');
  const approveButton = [...screen.querySelectorAll('button')].find((b) => b.textContent === 'Adicionar Candidato');
  approveButton.click();
  const modal = document.getElementById('modal-area').querySelector('.modal');
  for (const name of ['fullName', 'phone', 'sex']) assert.ok(modal.querySelector(`[data-campo="${name}"]`), name);
  for (const name of ['birthDate', 'cpf']) assert.ok(!modal.querySelector(`[data-campo="${name}"]`), `sem ${name}`);
  modal.querySelector('.modal-fechar').click();

  const candidate = { fullName: 'Maria da Silva', phone: '(11) 91234-5678', sex: 'FEMALE' };
  const approve = (id, data) => apiModule.api.post(`/api/positions/${id}/candidate-approval`,
    { date: todayIso, justification: null, ...data });
  await assert.rejects(approve(first, { ...candidate, phone: '1234-5678' }), (e) => e.status === 422 && 'phone' in e.fields);
  await assert.rejects(approve(first, { ...candidate, sex: null }), (e) => e.status === 422 && 'sex' in e.fields);

  const approved = await approve(first, candidate);
  assert.equal(approved.summary.status, 'CANDIDATE_APPROVED');
  assert.deepEqual([approved.candidate.phone, approved.candidate.cpf, approved.candidate.birthDate], ['(11) 91234-5678', null, null]);
  assert.equal(approved.candidate.restricted, false);
  assert.equal(approved.candidate.recordedByName, 'Rita RH (demo)');
  assert.equal(approved.summary.candidateName, 'Maria da Silva');
  const other = await approve(second, { fullName: 'João Pereira', phone: '(21) 3123-4567', sex: 'MALE' });
  assert.equal(other.candidate.fullName, 'João Pereira');
  const pendingScreen = await open(`/posicoes/${first}`, 'Posição');
  assert.match(pendingScreen.textContent, /Informado na admissão/);

  // O RH não registra mais a admissão (perfil próprio desde 26/10/2026).
  assert.ok(![...pendingScreen.querySelectorAll('button')].some((b) => b.textContent === 'Registrar admissão'));

  // "Registrar admissão": nome e sexo para conferência, telefone do cadastro, nascimento e CPF obrigatórios.
  await signIn('admissoes@demo.local');
  const admissionScreen = await open(`/posicoes/${first}`, 'Posição');
  [...admissionScreen.querySelectorAll('button')].find((b) => b.textContent === 'Registrar admissão').click();
  const admissionModal = document.getElementById('modal-area').querySelector('.modal');
  for (const name of ['phone', 'birthDate', 'cpf', 'date', 'registration']) assert.ok(admissionModal.querySelector(`[data-campo="${name}"]`), name);
  assert.equal(admissionModal.querySelector('[data-campo="candidateName"]').querySelector('input').value, 'Maria da Silva');
  assert.equal(admissionModal.querySelector('[data-campo="phone"]').querySelector('input').value, '(11) 91234-5678');
  admissionModal.querySelector('.modal-fechar').click();

  const admit = (id, data) => apiModule.api.post(`/api/positions/${id}/admission`,
    { date: todayIso, registration: null, justification: null, ...data });
  await assert.rejects(admit(first, { cpf: '529.982.247-25' }), (e) => e.status === 422 && 'birthDate' in e.fields);
  await assert.rejects(admit(first, { birthDate: '1995-04-10', cpf: '529.982.247-24' }), (e) => e.status === 422 && 'cpf' in e.fields);
  const admitted = await admit(first, { birthDate: '1995-04-10', cpf: '529.982.247-25' });
  assert.deepEqual([admitted.candidate.id, admitted.candidate.cpf, admitted.candidate.birthDate], [approved.candidate.id, '529.982.247-25', '1995-04-10']);

  // O mesmo CPF não ocupa outra posição aberta: conferido na admissão.
  await assert.rejects(admit(second, { birthDate: '1990-01-01', cpf: '529.982.247-25' }),
    (e) => e.status === 422 && 'cpf' in e.fields && /já é o candidato selecionado da posição/.test(e.message));

  // Correção: quem alterou e quando; os valores anteriores ficam no histórico. Depois da admissão, com nascimento e CPF.
  await signIn('rh@demo.local');
  await assert.rejects(apiModule.api.put(`/api/positions/${first}/candidate`, { ...candidate, justification: null }),
    (e) => e.status === 422 && 'birthDate' in e.fields);
  const corrected = await apiModule.api.put(`/api/positions/${first}/candidate`, {
    fullName: 'Maria da Silva Santos', phone: '(11) 91234-5678', sex: 'NOT_INFORMED', birthDate: '1995-04-10', cpf: '52998224725',
    justification: 'Nome completo',
  });
  assert.equal(corrected.candidate.fullName, 'Maria da Silva Santos');
  assert.equal(corrected.candidate.updatedByName, 'Rita RH (demo)');
  assert.ok(corrected.history.some((h) => h.action === 'CORRECT_CANDIDATE' && h.field === 'FullName'
    && h.oldValue === 'Maria da Silva' && h.newValue === 'Maria da Silva Santos'));
  const detailScreen = await open(`/posicoes/${first}`, 'Posição');
  assert.match(detailScreen.textContent, /Candidato selecionado/);
  assert.match(detailScreen.textContent, /529\.982\.247-25/);
  assert.match(detailScreen.textContent, /\(11\) 91234-5678/);
  assert.ok([...detailScreen.querySelectorAll('button')].some((b) => b.textContent === 'Corrigir dados'));

  // Perfis fora do RH do pedido, NACC e DP: nome e CPF mascarado; telefone, nascimento e sexo restritos, também no histórico.
  await signIn('comercial@demo.local');
  const restricted = await apiModule.api.get(`/api/positions/${first}`);
  assert.equal(restricted.candidate.restricted, true);
  assert.equal(restricted.candidate.cpf, '***.982.247-**');
  assert.deepEqual([restricted.candidate.birthDate, restricted.candidate.sex, restricted.candidate.phone], [null, null, null]);
  const sexChange = restricted.history.find((h) => h.field === 'Sex');
  assert.equal(sexChange.newValue, '(restrito)');
  assert.ok(restricted.history.filter((h) => h.field === 'Phone').every((h) => h.newValue === '(restrito)'));
  assert.ok(!restricted.allowedActions.includes('CORRECT_CANDIDATE'));
  const restrictedScreen = await open(`/posicoes/${first}`, 'Posição');
  assert.match(restrictedScreen.textContent, /\*\*\*\.982\.247-\*\*/);
  assert.doesNotMatch(restrictedScreen.textContent, /529\.982\.247-25|91234-5678/);

  await signIn('nacc@demo.local');
  assert.equal((await apiModule.api.get(`/api/positions/${first}`)).candidate.restricted, false, 'o NACC vê os dados');

  // Desistência: o candidato vai para "anteriores"; o novo começa sem nascimento nem CPF.
  await signIn('rh@demo.local');
  const withdrew = await apiModule.api.post(`/api/positions/${second}/candidate-withdrawal`, { justification: null });
  assert.equal(withdrew.candidate, null);
  assert.equal(withdrew.previousCandidates[0].withdrawalReason, 'Candidato desistiu');
  const again = await approve(second, { ...candidate, fullName: 'Ana Souza' });
  assert.equal(again.candidate.cpf, null);
  assert.equal(again.previousCandidates.length, 1);
});

test('1º dia efetivo: dados do candidato e da admissão preenchidos, justificativa obrigatória e evidência anexada', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 1,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  });
  const orderId = created.summary.id;
  const positionId = created.positions[0].id;
  await apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null });

  await signIn('gestor.rh@demo.local');
  const rita = (await apiModule.api.get('/api/users/by-role/RH')).find((u) => u.name === 'Rita RH (demo)');
  await apiModule.api.put(`/api/orders/${orderId}/rh-analysts`, { analystIds: [rita.id] });

  // RH: candidato aprovado e admissão com a matrícula (opcional).
  await signIn('rh@demo.local');
  await apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-1DIA', publishedAt: todayIso, justification: null });
  await apiModule.api.post(`/api/positions/${positionId}/candidate-approval`, { date: todayIso, justification: null,
    fullName: 'Francisco Teste', phone: '(11) 94444-5555', sex: 'MALE' });
  // Admissão sem matrícula (opcional): o NACC ainda não consegue confirmar.
  await signIn('admissoes@demo.local');
  const admitted = await apiModule.api.post(`/api/positions/${positionId}/admission`,
    { date: todayIso, registration: null, justification: null, birthDate: '1992-07-20', cpf: '935.411.347-80' });
  assert.equal(admitted.admissionRegistration, null);
  assert.equal(admitted.summary.status, 'IN_ADMISSION', 'sem matrícula, a admissão não está concluída');
  assert.ok(!admitted.allowedActions.includes('CONFIRM_FIRST_DAY'));

  await signIn('nacc@demo.local');
  const pending = await open(`/posicoes/${positionId}`, 'Posição');
  assert.match(pending.textContent, /Dados pendentes para a confirmação do 1º dia/);
  await assert.rejects(apiModule.api.post(`/api/positions/${positionId}/first-day`, { date: todayIso, justification: 'Ok' }),
    (e) => e.status === 422 && 'employeeRegistration' in e.fields);
  await assert.rejects(apiModule.api.put(`/api/positions/${positionId}/admission-registration`, { registration: 'X' }),
    (e) => e.status === 403, 'o NACC não altera a matrícula');

  // A correção é na origem: o DP (ou o RH do pedido) informa a matrícula da admissão.
  await signIn('dp@demo.local');
  const withRegistration = await apiModule.api.put(`/api/positions/${positionId}/admission-registration`,
    { registration: 'M-900', justification: 'Matrícula gerada pelo DP' });
  assert.equal(withRegistration.admissionRegistration, 'M-900');
  assert.equal(withRegistration.summary.status, 'AWAITING_FIRST_DAY', 'admissão concluída: aguarda o 1º dia');
  const awaitingList = await apiModule.api.get('/api/positions', { status: 'AWAITING_FIRST_DAY' });
  assert.ok(awaitingList.items.some((p) => p.id === positionId), 'filtro pelo novo status');

  // NACC: nome e matrícula da origem, somente leitura.
  await signIn('nacc@demo.local');
  const screen = await open(`/posicoes/${positionId}`, 'Posição');
  [...screen.querySelectorAll('button')].find((b) => b.textContent === 'Confirmar 1º dia efetivo').click();
  const modal = document.getElementById('modal-area').querySelector('.modal');
  const nameInput = modal.querySelector('[data-campo="employeeName"]').querySelector('input');
  const registrationInput = modal.querySelector('[data-campo="employeeRegistration"]').querySelector('input');
  assert.equal(nameInput.value, 'Francisco Teste');
  assert.equal(registrationInput.value, 'M-900');
  assert.ok(nameInput.hasAttribute('readonly') && registrationInput.hasAttribute('readonly'), 'somente leitura');
  assert.ok(modal.querySelector('[data-campo="evidence"]'), 'campo "Anexar evidência"');
  modal.querySelector('.modal-fechar').click();

  // Mesmo que alguém envie outro nome ou matrícula, o servidor usa os dados da origem.
  const fields = { date: todayIso, employeeName: 'Outro Nome', employeeRegistration: 'ZZZ' };
  await assert.rejects(apiModule.api.post(`/api/positions/${positionId}/first-day`, { ...fields, justification: ' ' }),
    (e) => e.status === 422 && 'justification' in e.fields);
  const formWith = (bytes, name) => {
    const form = new FormData();
    Object.entries({ ...fields, justification: 'Cliente confirmou a presença por e-mail.' }).forEach(([k, v]) => form.append(k, v));
    form.append('evidence', new Blob([bytes]), name);
    return form;
  };
  await assert.rejects(apiModule.api.postForm(`/api/positions/${positionId}/first-day`, formWith(new Uint8Array([0x4d, 0x5a, 0x90, 0]), 'presenca.pdf')),
    (e) => e.status === 422 && 'evidence' in e.fields);
  const pdf = new TextEncoder().encode('%PDF-1.4\n% evidência de teste\n');
  const confirmed = await apiModule.api.postForm(`/api/positions/${positionId}/first-day`, formWith(pdf, 'presenca.pdf'));
  assert.equal(confirmed.summary.status, 'FILLED');
  assert.equal(confirmed.employeeName, 'Francisco Teste', 'nome do cadastro do candidato');
  assert.equal(confirmed.employeeRegistration, 'M-900', 'matrícula da admissão');
  assert.equal(confirmed.firstDay.justification, 'Cliente confirmou a presença por e-mail.');
  assert.equal(confirmed.firstDay.confirmedByName, 'Nina NACC (demo)');
  assert.ok(confirmed.firstDay.confirmedAt);
  assert.equal(confirmed.firstDay.evidence.fileName, 'presenca.pdf');
  assert.equal(confirmed.firstDay.evidence.contentType, 'application/pdf');
  assert.equal(confirmed.firstDay.evidence.canDownload, true);
  assert.ok(confirmed.history.some((h) => h.action === 'CONFIRM_FIRST_DAY'), 'histórico da posição');

  const evidenceUrl = `/api/positions/${positionId}/evidences/${confirmed.firstDay.evidence.id}`;
  const download = await fetch(evidenceUrl);
  assert.equal(download.status, 200);
  assert.equal(download.headers.get('content-type'), 'application/pdf');
  assert.equal(new TextDecoder().decode(await download.arrayBuffer()), '%PDF-1.4\n% evidência de teste\n');
  const filledScreen = await open(`/posicoes/${positionId}`, 'Posição');
  assert.match(filledScreen.textContent, /Confirmação do 1º dia efetivo/);
  assert.match(filledScreen.textContent, /presenca\.pdf/);

  // Depois da confirmação, a matrícula fica preservada.
  await signIn('dp@demo.local');
  await assert.rejects(apiModule.api.put(`/api/positions/${positionId}/admission-registration`, { registration: 'M-901' }),
    (e) => e.status === 422);

  // Fora do RH do pedido, NACC, DP e Gestor: vê que existe evidência, sem baixar.
  await signIn('comercial@demo.local');
  const restricted = await apiModule.api.get(`/api/positions/${positionId}`);
  assert.equal(restricted.firstDay.evidence.canDownload, false);
  assert.equal((await fetch(evidenceUrl)).status, 403);
  await signIn('gestor@demo.local');
  assert.equal((await fetch(evidenceUrl)).status, 200, 'o Gestor baixa');
});

test('Reposição como novo ciclo da vaga: uma linha por vaga, histórico de ocupantes e indicadores', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const todayIso = ui.today();
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let roles = [];
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    roles = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (roles.length) { contract = c; break; }
  }
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: roles[0].id, quantity: 2,
    workLocationId: contract.contractingUnitId, clientRequestDate: todayIso, desiredStartDate: todayIso, termType: 'INDEFINITE',
    termEndDate: null, termDurationDays: null, notes: null, registeredAt: todayIso, justification: null,
  });
  const orderId = created.summary.id;
  const originId = created.positions[0].id;
  await apiModule.api.post(`/api/orders/${orderId}/approval`, { date: todayIso, justification: null });

  // Gestora de RH executa o recrutamento até a admissão com matrícula; NACC confirma o 1º dia.
  await signIn('gestor.rh@demo.local');
  await apiModule.api.post(`/api/orders/${orderId}/jobconvo`, { published: true, code: 'JC-CICLO', publishedAt: todayIso, justification: null });
  await apiModule.api.post(`/api/positions/${originId}/candidate-approval`, { date: todayIso, justification: null,
    fullName: 'Primeiro Ocupante', phone: '(11) 95555-6666', sex: 'MALE' });
  await signIn('admissoes@demo.local');
  await apiModule.api.post(`/api/positions/${originId}/admission`, {
    date: todayIso, registration: 'M-CICLO-1', justification: null, birthDate: '1990-05-05', cpf: '274.628.610-62',
  });
  await signIn('nacc@demo.local');
  await apiModule.api.post(`/api/positions/${originId}/first-day`, { date: todayIso, justification: 'Cliente confirmou.' });

  // DP registra o desligamento: a vaga 1 abre o 2º ciclo, sem criar uma 3ª linha.
  await signIn('dp@demo.local');
  const termination = await apiModule.api.post('/api/terminations', {
    originPositionId: originId, lastWorkedDay: todayIso, source: 'DP', terminationType: 'RESIGNATION',
    notes: 'Pediu demissão', registeredAt: todayIso, justification: null,
  });

  await signIn('comercial@demo.local');
  const order = await apiModule.api.get(`/api/orders/${orderId}`);
  assert.equal(order.slots.length, 2, 'uma linha por vaga contratada');
  const slot = order.slots.find((s) => s.number === 1);
  assert.equal(slot.current.id, termination.replacementPositionId);
  assert.equal(slot.current.slotNumber, 1);
  assert.equal(slot.current.cycle, 2);
  assert.equal(slot.current.status, 'AWAITING_CONFIRMATION');
  assert.equal(slot.replacementCount, 1);
  assert.equal(slot.occupants.length, 2);
  const left = slot.occupants.find((x) => x.cycle === 1);
  assert.equal(left.name, 'Primeiro Ocupante');
  assert.equal(left.registration, 'M-CICLO-1');
  assert.equal(left.leftAt, todayIso);
  assert.equal(left.exitType, 'RESIGNATION');
  assert.equal(left.exitRegisteredByName, 'Davi DP (demo)');
  assert.equal(left.firstDayConfirmedByName, 'Nina NACC (demo)');
  assert.equal(left.replacedByPositionId, termination.replacementPositionId);
  assert.equal(order.summary.filledPositions, 0, 'o desligado não conta como preenchido');
  assert.equal(order.summary.quantity, 2);
  assert.equal(order.summary.replacementCount, 1);

  // Lista geral: só o ciclo atual por padrão; os anteriores com "Incluir ciclos anteriores".
  const current = await apiModule.api.get('/api/positions', { orderId });
  assert.deepEqual(current.items.map((p) => `${p.slotNumber}/${p.cycle}`).sort(), ['1/2', '2/1']);
  const all = await apiModule.api.get('/api/positions', { orderId, allCycles: true });
  assert.equal(all.items.length, 3);

  const orderScreen = await open(`/pedidos/${orderId}`, 'Pedido');
  assert.ok([...orderScreen.querySelectorAll('button')].some((b) => b.textContent === 'Ver histórico de ocupantes (2)'));
  assert.match(orderScreen.textContent, /2 vigentes · 0 preenchidas agora · 1 em reposição · 1 reposição\(ões\) realizada\(s\)/);
  assert.match(orderScreen.textContent, new RegExp(`${order.summary.number}-1`));
  assert.doesNotMatch(orderScreen.textContent, new RegExp(`${order.summary.number}-3`), 'a reposição não vira uma 3ª vaga');

  // O detalhe do ciclo anterior aponta para o ciclo atual.
  const previous = await open(`/posicoes/${originId}`, 'Posição');
  assert.match(previous.textContent, /Ciclo anterior da vaga/);
  const replacementScreen = await open(`/posicoes/${termination.replacementPositionId}`, 'Posição');
  assert.match(replacementScreen.textContent, /Reposição nº 1/);
});

test('Confirmações do 1º dia: a relação do NACC no menu, com os indicadores e a nota de que pendência não é falta', async (t) => {
  if (skip(t)) return;
  await signIn('nacc@demo.local');
  const screen = await open('/confirmacoes-1o-dia', 'Confirmações do 1º dia');
  for (const text of ['Confirmações devidas', 'Inícios previstos', 'Aguardando matrícula', 'não uma falta do colaborador']) {
    assert.ok(screen.textContent.includes(text), text);
  }
  assert.match(document.querySelector('.menu')?.textContent ?? '', /Confirmações do 1º dia/, 'item no menu');

  await signIn('comercial@demo.local');
  await open('/', 'Painel');
  assert.doesNotMatch(document.querySelector('.menu')?.textContent ?? '', /Confirmações do 1º dia/, 'fora do menu do Comercial');
});

test('Revisão geral (S1, F1): trocar de tela fecha a janela aberta; o lote do 1º dia só aparece ao NACC', async (t) => {
  if (skip(t)) return;
  await signIn('gestor.rh@demo.local');
  const positions = await apiModule.api.get('/api/positions', { status: 'RECRUITING' });
  const [first, second] = positions.items ?? positions;
  const screen = await open(`/posicoes/${first.id}`, 'Posição');
  [...screen.querySelectorAll('button')].find((b) => b.textContent === 'Adicionar Candidato').click();
  const area = document.getElementById('modal-area');
  assert.ok(area.querySelector('.modal'), 'janela aberta');
  window.location.hash = `#/posicoes/${second.id}`;
  window.dispatchEvent(new Event('hashchange'));
  assert.equal(area.querySelector('.modal'), null, 'a troca de tela fechou a janela');
  await wait(150);

  await signIn('admin@demo.local');
  const asAdmin = await open('/confirmacoes-1o-dia', 'Confirmações do 1º dia');
  assert.ok(![...asAdmin.querySelectorAll('button')].some((b) => /Confirmar em lote/.test(b.textContent)), 'ADMIN só consulta');
  await signIn('nacc@demo.local');
  const asNacc = await open('/confirmacoes-1o-dia', 'Confirmações do 1º dia');
  const pending = await apiModule.api.get('/api/positions/first-day-pending');
  if (pending.groups.length) assert.ok([...asNacc.querySelectorAll('button')].some((b) => /Confirmar em lote/.test(b.textContent)), 'NACC confirma');
});

test('Pedido com valores comerciais: o valor aprovado vem preenchido, alterar avisa a validação e a Controladoria decide no pedido', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const contracts = await apiModule.api.get('/api/contracts', { onlyActive: true });
  let contract;
  let role;
  for (const c of contracts.filter((x) => x.contractingUnitId)) {
    [role] = await apiModule.api.get('/api/orders/job-roles', { contractId: c.id });
    if (role) { contract = c; break; }
  }
  const root = await open('/pedidos/novo', 'Novo pedido');
  assert.match(root.textContent, /Cargo e valores comerciais/);
  const pick = (name, value) => {
    const select = root.querySelector(`[data-campo="${name}"]`).querySelector('select');
    select.value = value;
    select.dispatchEvent(new Event('change'));
  };
  pick('contractId', contract.id);
  // Cargo com pesquisa: escolhe na lista (mousedown, como o clique do mouse).
  const roleInput = root.querySelector('[data-campo="jobRoleId"]').querySelector('input[type="text"]');
  roleInput.dispatchEvent(new Event('focus'));
  root.querySelector(`[data-valor="${role.id}"]`).dispatchEvent(new Event('mousedown'));
  await wait(150);
  const rate = await apiModule.api.get('/api/contract-rates/current', { contractId: contract.id, jobRoleId: role.id, date: ui.today() });
  const form = root.querySelector('form');
  assert.equal(Number(form.querySelector('input[name="monthlyValue"]').value), Number(rate.monthlyValue), 'valor aprovado preenchido');
  assert.match(root.textContent, /Valor aprovado vigente desde/);
  assert.match(root.textContent, /nasce "Aguardando aprovação do cliente"/);
  form.querySelector('input[name="monthlyValue"]').value = String(Number(rate.monthlyValue) + 1);
  form.dispatchEvent(new Event('input'));
  assert.match(root.textContent, /Valor diferente do aprovado vigente/);
  assert.match(root.textContent, /nasce "Aguardando aprovação da Controladoria"/);

  // Pedido enviado à Controladoria: o bloco mostra os valores e o histórico; a Controladoria valida no próprio pedido.
  const created = await apiModule.api.post('/api/orders', {
    contractId: contract.id, modality: contract.modalities[0], jobRoleId: role.id, quantity: 1, workLocationId: contract.contractingUnitId,
    clientRequestDate: ui.today(), desiredStartDate: ui.today(), termType: 'INDEFINITE', registeredAt: ui.today(),
    monthlyValue: Number(rate.monthlyValue) + 1, feeValue: rate.feeValue, rateValidFrom: ui.today(),
  });
  assert.equal(created.summary.approvalStatus, 'AWAITING_CONTROLLERSHIP');
  const rates = await open('/valores', 'Valores por cargo');
  assert.match(rates.textContent, new RegExp(`Pedido ${created.summary.number} · em validação no pedido`));

  await signIn('controladoria@demo.local');
  const detail = await open(`/pedidos/${created.summary.id}`, 'Pedido');
  assert.match(detail.textContent, /Aguardando aprovação da Controladoria/);
  assert.match(detail.textContent, /Validação da Controladoria/);
  assert.match(detail.textContent, /Enviado à Controladoria · Carla Comercial/);
  assert.ok(![...detail.querySelectorAll('button')].some((b) => b.textContent === 'Registrar aprovação do cliente'));
  [...detail.querySelectorAll('button')].find((b) => b.textContent === 'Validar').click();
  const area = document.getElementById('modal-area');
  assert.match(area.textContent, /segue para a aprovação do cliente/);
  [...area.querySelectorAll('button')].find((b) => b.textContent === 'Validar').click();
  await wait(200);
  const validated = document.getElementById('app');
  assert.match(validated.textContent, /Validado pela Controladoria · Clara Controladoria/);
  assert.ok([...validated.querySelectorAll('button')].some((b) => b.textContent === 'Registrar aprovação do cliente'));
});

test('Local de trabalho no pedido: o Comercial consulta as unidades, cadastra uma nova e ela já fica selecionada', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const base = String(Date.now()).slice(-8).padStart(8, '0');
  const client = await apiModule.api.post('/api/clients', {
    legalName: `Cliente Local ${base}`, cnpj: validCnpj(`${base}0101`), active: true, hasMultipleUnits: false, units: [] });
  const groups = await apiModule.api.get('/api/catalogs/group-entities');
  const contract = await apiModule.api.post('/api/contracts', {
    clientId: client.id, contractingUnitId: null, groupEntityId: groups[0].id, modalities: ['MOT'], startDate: ui.today(),
    endDate: null, commercialOwnerId: app.state.user.id, slaNewDays: null, slaReplacementDays: null });

  const root = await open('/pedidos/novo', 'Novo pedido');
  const select = root.querySelector('[data-campo="contractId"]').querySelector('select');
  select.value = contract.id;
  select.dispatchEvent(new Event('change'));
  await wait(100);
  const register = [...root.querySelectorAll('button')].find((b) => b.textContent === '+ Cadastrar novo local de trabalho');
  assert.ok(register, 'ação ao lado do local');
  register.click();
  const area = document.getElementById('modal-area');
  assert.match(area.textContent, /O cliente ainda não tem unidades cadastradas/);
  const set = (name, value) => { area.querySelector(`[data-campo="${name}"]`).querySelector('input').value = value; };
  set('code', 'LJ-77');
  set('name', 'Loja Setenta e Sete');
  set('cnpj', validCnpj(`${base}0102`));
  [...area.querySelectorAll('button')].find((b) => b.textContent === 'Cadastrar e usar no pedido').click();
  await wait(200);
  const location = root.querySelector('[data-campo="workLocationId"]').querySelector('select');
  const created = (await apiModule.api.get('/api/catalogs/work-locations')).find((l) => l.code === 'LJ-77' && l.clientId === client.id);
  assert.ok(created, 'unidade gravada no cliente');
  // O DOM mínimo não deriva o valor do select da opção marcada: confere a opção.
  assert.equal([...location.querySelectorAll('option')].find((o) => o.value === created.id)?.getAttribute('selected'), '', 'selecionada no pedido');

  // Na próxima vez, a consulta mostra a unidade e permite usá-la direto.
  [...root.querySelectorAll('button')].find((b) => b.textContent === '+ Cadastrar novo local de trabalho').click();
  assert.match(document.getElementById('modal-area').textContent, /LJ-77 — Loja Setenta e Sete/);
  document.getElementById('modal-area').querySelector('.modal-fechar').click();
});

test('Cargo do pedido com pesquisa: filtra em qualquer parte, sem acento nem maiúscula, e escolhe por teclado ou mouse', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const roles = (await apiModule.api.get('/api/catalogs/job-roles')).filter((j) => j.active);
  const root = await open('/pedidos/novo', 'Novo pedido');
  const block = root.querySelector('[data-campo="jobRoleId"]');
  const input = block.querySelector('input[type="text"]');
  const hidden = block.querySelector('input[name="jobRoleId"]');
  const key = (k) => input.dispatchEvent(Object.assign(new Event('keydown'), { key: k }));
  const options = () => [...block.querySelectorAll('li')].map((li) => li.textContent);
  const type = (text) => {
    input.value = text;
    input.dispatchEvent(new Event('input'));
  };

  input.dispatchEvent(new Event('focus'));
  assert.equal(options().length, roles.length, 'ao entrar, a lista mostra todos os cargos disponíveis');

  // Parte do nome, em maiúsculas e sem acento: "Operador de empilhadeira" por "EMPILHA"; "Analista de RH" por "ANÁLIS".
  type('EMPILHA');
  assert.deepEqual(options(), roles.filter((j) => /empilha/i.test(j.name)).map((j) => j.name));
  type('anális');
  assert.ok(options().length && options().every((n) => /analis/i.test(n.normalize('NFD').replace(/[̀-ͯ]/g, ''))));

  // Sem correspondência: a mensagem; a digitação não preenche o campo.
  type('xyz cargo inexistente');
  assert.deepEqual(options(), ['Nenhum cargo encontrado']);
  key('Enter');
  assert.equal(hidden.value, '');
  input.dispatchEvent(new Event('blur'));
  await wait(200); // o fechamento espera um instante (clique na opção chega antes)
  assert.equal(input.value, '', 'sair sem escolher não deixa texto solto');

  // Teclado: setas e Enter escolhem a opção em destaque.
  input.dispatchEvent(new Event('focus'));
  type('a');
  const expected = roles.filter((j) => j.name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().includes('a'));
  key('ArrowDown');
  key('Enter');
  assert.equal(hidden.value, expected[1].id, 'a segunda da lista filtrada');
  assert.equal(input.value, expected[1].name);

  // Digitar de novo e sair sem escolher volta ao cargo escolhido.
  input.dispatchEvent(new Event('focus'));
  type('zzz');
  input.dispatchEvent(new Event('blur'));
  await wait(200); // o fechamento espera um instante (clique na opção chega antes)
  assert.deepEqual([hidden.value, input.value], [expected[1].id, expected[1].name]);
});

test('Editar pedido (ADMIN): revisa os campos alterados, pede justificativa e mostra o histórico', async (t) => {
  if (skip(t)) return;
  await signIn('admin@demo.local');
  const orders = await apiModule.api.get('/api/orders', { approvalStatus: 'APPROVED' });
  const target = (orders.items ?? orders).find((o) => !o.isLegacy);
  const root = await open(`/pedidos/${target.id}`, 'Pedido');
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Editar pedido').click();
  await wait(150);
  const area = document.getElementById('modal-area');
  assert.match(area.textContent, /Editar pedido/);
  // O DOM mínimo não deriva o valor do select da opção marcada: repõe os valores atuais.
  const detail = await apiModule.api.get(`/api/orders/${target.id}`);
  for (const [name, value] of [['modality', detail.summary.modality], ['workLocationId', detail.workLocationId], ['termType', detail.termType]]) {
    area.querySelector(`[data-campo="${name}"]`).querySelector('select').value = value;
  }
  area.querySelector('[data-campo="notes"]').querySelector('textarea').value = 'Observação corrigida pelo administrador.';
  [...area.querySelectorAll('button')].find((b) => b.textContent === 'Revisar alterações').click();
  await wait(200);
  assert.match(area.textContent, /Confira as alterações/);
  assert.match(area.textContent, /Observação corrigida pelo administrador/);
  const saveButton = [...area.querySelectorAll('button')].find((b) => b.textContent === 'Confirmar e salvar');
  saveButton.click();
  assert.match(area.textContent, /Informe a justificativa da alteração/);
  area.querySelector('[data-campo="justification"]').querySelector('textarea').value = 'Texto anterior estava incompleto.';
  saveButton.click();
  await wait(250);
  const updated = document.getElementById('app');
  assert.match(updated.textContent, /Edições administrativas/);
  assert.match(updated.textContent, /Texto anterior estava incompleto/);

  await signIn('comercial@demo.local');
  const asCommercial = await open(`/pedidos/${target.id}`, 'Pedido');
  assert.ok(![...asCommercial.querySelectorAll('button')].some((b) => b.textContent === 'Editar pedido'), 'só o ADMIN edita');
  assert.match(asCommercial.textContent, /Edições administrativas/, 'o histórico é consultado por quem vê o pedido');
});

test('"Não compareceu" orienta e leva à correção da data de admissão quando só a data mudou', async (t) => {
  if (skip(t)) return;
  await signIn('nacc@demo.local');
  const list = await apiModule.api.get('/api/positions', { status: 'AWAITING_FIRST_DAY' });
  const [target] = list.items ?? list;
  assert.ok(target, 'há posição aguardando o 1º dia nos dados de demonstração');
  const root = await open(`/posicoes/${target.id}`, 'Posição');
  [...root.querySelectorAll('button')].find((b) => b.textContent === 'Admitido não compareceu').click();
  const area = document.getElementById('modal-area');
  assert.match(area.textContent, /Use quando o admitido não vai mais assumir a vaga/);
  const link = [...area.querySelectorAll('a')].find((a) => a.textContent === 'corrija a data de admissão');
  assert.ok(link, 'atalho para a correção');
  link.dispatchEvent(new Event('click'));
  assert.match(area.textContent, /Corrigir data de admissão/);
  assert.match(area.textContent, /O candidato continua na posição/);
  assert.doesNotMatch(area.textContent, /Use quando o admitido não vai mais assumir a vaga/, 'a janela do "Não compareceu" fechou');
  area.querySelector('.modal-fechar').click();
});

test('Cadastrar cargo no pedido: o Comercial (sem ser Administrador) cadastra e o cargo já fica escolhido', async (t) => {
  if (skip(t)) return;
  await signIn('comercial@demo.local');
  const root = await open('/pedidos/novo', 'Novo pedido');
  const button = [...root.querySelectorAll('button')].find((b) => b.textContent === '+ Cadastrar cargo');
  assert.ok(button, 'o Comercial vê a ação');
  button.click();
  const area = document.getElementById('modal-area');
  assert.match(area.textContent, /Confira na lista se o cargo já existe/);
  area.querySelector('[data-campo="name"]').querySelector('input').value = 'Auxiliar de Inventário';
  [...area.querySelectorAll('button')].find((b) => b.textContent === 'Salvar').click();
  await wait(250);
  const block = root.querySelector('[data-campo="jobRoleId"]');
  assert.equal(block.querySelector('input[type="text"]').value, 'Auxiliar de Inventário');
  const created = (await apiModule.api.get('/api/catalogs/job-roles')).find((j) => j.name === 'Auxiliar de Inventário');
  assert.equal(block.querySelector('input[name="jobRoleId"]').value, created.id);
});

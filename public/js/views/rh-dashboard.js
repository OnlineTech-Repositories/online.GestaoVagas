import { api } from '../api.js';
import { el, clear, field, table, panelNoPadding, loading, number, date, LABELS, errorMessage, button } from '../ui.js';
import { navigate } from '../app.js';

/**
 * Painel de RH: acompanhamento visual dos pedidos, das vagas e das demandas por analista.
 *
 * O servidor aplica o acesso (o Analista de RH vê só os próprios pedidos) e todos os filtros; a tela desenha. Os
 * gráficos são barras empilhadas em HTML (a CSP não carrega bibliotecas de fora): cada etapa do recrutamento num
 * matiz distinto (a preenchida em azul-marinho, ancorada na base) e as etapas fora do recrutamento (aguardando
 * cliente, pausada) em cinza. A situação do SLA usa as cores de status, sempre com ícone e rótulo. Cada gráfico tem a tabela
 * correspondente logo abaixo.
 */

/** Ordem das etapas na barra: a preenchida ancorada na base, depois o funil de trás para a frente. */
const STAGES = ['FILLED', 'AWAITING_FIRST_DAY', 'IN_ADMISSION', 'CANDIDATE_APPROVED', 'RECRUITING', 'OPEN', 'AWAITING_CLIENT', 'PAUSED'];
const SLA = ['OVERDUE', 'AT_RISK', 'ON_TIME', 'NO_TARGET', 'NOT_STARTED'];
const SLA_LABEL = { ...LABELS.slaFilter, OVERDUE: 'Vencida', NOT_STARTED: 'Não iniciado' };
const SLA_ICON = { OVERDUE: '✕', AT_RISK: '!', ON_TIME: '✓', NO_TARGET: '–', NOT_STARTED: '○' };
const STAGE_SHORT = {
  AWAITING_CLIENT: 'Aguard. cliente', OPEN: 'Aberta', RECRUITING: 'Em recrut.', CANDIDATE_APPROVED: 'Cand. selec.',
  IN_ADMISSION: 'Em admissão', AWAITING_FIRST_DAY: 'Aguard. 1º dia', PAUSED: 'Pausada', FILLED: 'Preenchida',
};

/** Pedidos no gráfico; a tabela traz todos. */
const MAX_CHART_ORDERS = 15;

const plural = (n, one, many) => `${number(n)} ${n === 1 ? one : many}`;
const percent = (v) => (v === null || v === undefined ? '—' : `${number(v, 1)}%`);

const EMPTY = {
  from: '', to: '', clientId: '', unit: '', contractId: '', jobRoleId: '', rh: '', stage: '', sla: '', includeConcluded: false,
};

export async function rhDashboardScreen(target, _params, query) {
  const filters = { ...EMPTY };
  for (const key of Object.keys(EMPTY)) {
    const value = query?.get(key);
    if (value !== null && value !== undefined) filters[key] = key === 'includeConcluded' ? value === 'true' : value;
  }

  const filterArea = el('div', { class: 'filtros' });
  const resultArea = el('div', { class: 'painel-rh' }, loading());
  const tooltip = el('div', { class: 'grafico-dica', role: 'tooltip', hidden: true });
  let running = 0;

  const params = () => Object.fromEntries(Object.entries(filters).filter(([, v]) => v !== '' && v !== false));
  const apply = (changes) => {
    Object.assign(filters, changes);
    reload();
  };

  async function reload() {
    const ticket = ++running;
    clear(resultArea).append(loading());
    let d;
    try {
      d = await api.get('/api/dashboard/rh', params());
    } catch (e) {
      if (ticket === running) clear(resultArea).append(errorMessage(e.message));
      return;
    }
    if (ticket !== running) return; // um filtro mudou antes da resposta: vale a consulta mais recente
    // Os filtros ficam no endereço: ao voltar de uma lista de posições, o painel reabre como estava.
    const qs = new URLSearchParams(params()).toString();
    window.history?.replaceState(null, '', `#/painel-rh${qs ? `?${qs}` : ''}`);
    renderFilters(d);
    renderResult(d);
  }

  // ------------------------------------------------------------ filtros

  function renderFilters(d) {
    const select = (name, text, items, all = 'Todos') => {
      const block = field({ name, label: text, type: 'select', value: filters[name], options: [{ value: '', label: all }, ...items] });
      block.querySelector('select').addEventListener('change', (e) => apply({ [name]: e.target.value }));
      return block;
    };
    const dateField = (name, text) => {
      const block = field({ name, label: text, type: 'date', value: filters[name] });
      block.querySelector('input').addEventListener('change', (e) => apply({ [name]: e.target.value }));
      return block;
    };
    const opts = d.options;
    const analyst = d.analystLocked
      ? field({ name: 'rhFixed', label: 'Analista de RH', value: 'Meus pedidos', attributes: { readonly: true } })
      : select('rh', 'Analista de RH', [
        ...opts.analysts,
        { value: 'UNASSIGNED', label: 'Sem analista' },
      ]);
    const concluded = el('div', { class: 'campo-check', style: { alignSelf: 'end', marginBottom: '8px' } },
      el('input', { type: 'checkbox', id: 'campo-includeConcluded', checked: filters.includeConcluded,
        onchange: (e) => apply({ includeConcluded: e.target.checked }) }),
      el('label', { for: 'campo-includeConcluded' }, 'Incluir pedidos concluídos'));
    const active = Object.entries(filters).some(([k, v]) => v !== EMPTY[k] && !(d.analystLocked && k === 'rh'));

    clear(filterArea).append(
      dateField('from', 'Solicitação de'),
      dateField('to', 'Solicitação até'),
      select('clientId', 'Cliente', opts.clients),
      select('unit', 'Unidade contratante', opts.units, 'Todas'),
      select('contractId', 'Contrato', opts.contracts),
      select('jobRoleId', 'Cargo', opts.jobRoles),
      analyst,
      select('stage', 'Etapa', STAGES.map((s) => ({ value: s, label: LABELS.rhStage[s] })), 'Todas'),
      select('sla', 'Situação do SLA', SLA.map((s) => ({ value: s, label: LABELS.slaFilter[s] })), 'Todas'),
      concluded,
      active ? el('div', { class: 'campo acoes-filtro' },
        button('Limpar filtros', () => apply({ ...EMPTY, rh: d.analystLocked ? filters.rh : '' }), 'secundario pequeno')) : '',
    );
  }

  // ------------------------------------------------------------ resultado

  function renderResult(d) {
    const t = d.totals;
    const scope = filters.includeConcluded ? 'pedidos em andamento e concluídos' : 'pedidos em andamento';
    const slaCard = (key, highlight) => card({
      label: `${SLA_ICON[key]} ${SLA_LABEL[key]}`,
      value: number(t.sla[key]),
      note: key === 'NOT_STARTED' ? 'aguardando aprovação ou decisão do cliente' : key === 'NO_TARGET' ? 'vaga aberta sem prazo de SLA' : 'vagas pendentes',
      highlight: t.sla[key] ? highlight : null,
      selected: filters.sla === key,
      onClick: () => apply({ sla: filters.sla === key ? '' : key }),
    });

    clear(resultArea).append(
      el('p', { class: 'painel-rh-escopo' },
        `Situação em ${date(d.today)} · ${scope}${d.analystLocked ? ' atribuídos a você' : ''}. `
        + 'Cada vaga conta uma vez (o ciclo atual: a reposição ocupa a vaga do desligado); canceladas ficam de fora.'),
      el('div', { class: 'grade grade-5' },
        card({ label: 'Pedidos', value: number(t.orders),
          note: t.sharedOrders ? `${plural(t.sharedOrders, 'compartilhado', 'compartilhados')} entre analistas` : null }),
        card({ label: 'Vagas', value: number(t.positions), note: `${plural(t.filled, 'preenchida', 'preenchidas')} · ${percent(t.percentFilled)}` }),
        card({ label: 'Pendentes', value: number(t.pending), note: 'inclui pausadas e aguardando cliente' }),
        card({ label: 'Pedidos aguardando aprovação', value: number(t.awaitingApproval),
          highlight: t.awaitingApproval ? 'alerta' : null, note: 'do cliente (vagas sem contagem de SLA)',
          onClick: () => navigate('/pedidos?aprovacao=AWAITING_CLIENT_APPROVAL') }),
        d.analystLocked ? '' : card({ label: 'Pedidos sem analista de RH', value: number(t.unassigned),
          highlight: t.unassigned ? 'alerta' : null, note: 'aguardando atribuição pelo Gestor de RH',
          selected: filters.rh === 'UNASSIGNED', onClick: () => apply({ rh: filters.rh === 'UNASSIGNED' ? '' : 'UNASSIGNED' }) }),
      ),
      el('div', { class: 'grade grade-5 painel-rh-sla' },
        slaCard('ON_TIME', 'ok'),
        slaCard('AT_RISK', 'alerta'),
        slaCard('OVERDUE', 'erro'),
        slaCard('NO_TARGET', null),
        slaCard('NOT_STARTED', null),
      ),
      stagesPanel(t),
      ordersPanel(d.orders),
      analystsPanel(d),
    );
  }

  /** Card do painel; o selecionado (filtro ativo) ganha borda. */
  function card({ label, value, note, highlight, onClick, selected }) {
    return el('div', {
      class: ['indicador', highlight ? `destaque-${highlight}` : '', onClick ? 'clicavel' : '', selected ? 'selecionado' : ''].join(' '),
      onclick: onClick, role: onClick ? 'button' : null, tabindex: onClick ? '0' : null,
      onkeydown: onClick ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } } : null,
    },
    el('div', { class: 'rotulo' }, label),
    el('div', { class: 'valor' }, value),
    note ? el('div', { class: 'nota' }, note) : null);
  }

  // ------------------------------------------------------------ gráficos

  /** Dica flutuante das barras: segue o ponteiro, com o mesmo texto do aria-label do segmento. */
  function hover(node, text) {
    node.addEventListener('mousemove', (e) => {
      tooltip.textContent = text;
      tooltip.hidden = false;
      const x = Math.min(e.clientX + 14, window.innerWidth - tooltip.offsetWidth - 8);
      tooltip.style.left = `${x}px`;
      tooltip.style.top = `${e.clientY + 16}px`;
    });
    node.addEventListener('mouseleave', () => { tooltip.hidden = true; });
  }

  /**
   * Barra empilhada: um segmento por chave com valor, largura proporcional ao maior total do gráfico. `onPick` torna
   * os segmentos clicáveis.
   */
  function stackedBar(counts, keys, max, { cls, describe, onPick }) {
    const total = keys.reduce((s, k) => s + (counts[k] ?? 0), 0);
    const bar = el('div', { class: 'barra-empilhada', style: { width: `${max ? (total / max) * 100 : 0}%` } });
    for (const key of keys) {
      const value = counts[key] ?? 0;
      if (!value) continue;
      const text = describe(key, value, total);
      const segment = el(onPick ? 'button' : 'span', {
        class: `segmento ${cls(key)}`, style: { flexGrow: String(value) }, 'aria-label': text,
        type: onPick ? 'button' : null,
        onclick: onPick ? (e) => { e.stopPropagation(); tooltip.hidden = true; onPick(key); } : null,
      });
      hover(segment, text);
      bar.append(segment);
    }
    return bar;
  }

  const stageClass = (k) => `etapa-${k.toLowerCase().replace(/_/g, '-')}`;
  const slaClass = (k) => `sla-${k.toLowerCase().replace(/_/g, '-')}`;

  function legend(keys, cls, labelOf, counts, onPick, selected) {
    return el('div', { class: 'grafico-legenda' }, ...keys.map((k) => el(onPick ? 'button' : 'span', {
      class: `legenda-item ${selected === k ? 'selecionado' : ''}`, type: onPick ? 'button' : null,
      title: onPick ? (selected === k ? 'Remover o filtro' : 'Filtrar por esta etapa') : null,
      onclick: onPick ? () => onPick(k) : null,
    },
    el('span', { class: `amostra ${cls(k)}` }),
    labelOf(k),
    counts ? el('strong', {}, number(counts[k] ?? 0)) : null)));
  }

  /** Vagas por etapa, da equipe toda (ou do analista): uma barra só, com a contagem de cada etapa na legenda. */
  function stagesPanel(t) {
    const pick = (k) => apply({ stage: filters.stage === k ? '' : k });
    return panelNoPadding('Vagas por etapa', el('div', { class: 'grafico' },
      t.positions
        ? el('div', { class: 'grafico-linha grafico-linha-unica' },
          el('div', { class: 'grafico-trilho' }, stackedBar(t.stages, STAGES, t.positions, {
            cls: stageClass, onPick: pick,
            describe: (k, v, total) => `${LABELS.rhStage[k]}: ${plural(v, 'vaga', 'vagas')} (${percent((v / total) * 100)})`,
          })),
          el('div', { class: 'grafico-valor' }, number(t.positions)))
        : el('div', { class: 'vazio' }, 'Nenhuma vaga com estes filtros.'),
      legend(STAGES, stageClass, (k) => LABELS.rhStage[k], t.stages, pick, filters.stage)));
  }

  function ordersPanel(orders) {
    const chartOrders = orders.slice(0, MAX_CHART_ORDERS);
    const max = Math.max(0, ...chartOrders.map((o) => o.positions));
    const toPositions = (o, stage) => {
      const q = new URLSearchParams({ pedido: o.orderId });
      if (stage) q.set('etapa', stage);
      if (filters.sla) {
        q.set('sla', filters.sla);
        q.set('onlyOpen', 'true'); // o SLA do painel é o das pendentes
      }
      navigate(`/posicoes?${q}`);
    };
    const orderLabel = (o) => `Nº ${o.number} · ${o.jobRole} — ${o.client}`;

    const chart = el('div', { class: 'grafico' },
      ...chartOrders.map((o) => el('div', { class: 'grafico-linha' },
        el('button', { class: 'grafico-rotulo', type: 'button', title: `${orderLabel(o)} · ${o.unit}`, onclick: () => toPositions(o) },
          orderLabel(o)),
        el('div', { class: 'grafico-trilho' }, stackedBar(o.stages, STAGES, max, {
          cls: stageClass, onPick: (k) => toPositions(o, k),
          describe: (k, v) => `Pedido nº ${o.number} · ${LABELS.rhStage[k]}: ${plural(v, 'vaga', 'vagas')}`,
        })),
        el('div', { class: 'grafico-valor', title: 'preenchidas / vagas' }, `${number(o.filled)}/${number(o.positions)}`))),
      orders.length > MAX_CHART_ORDERS
        ? el('div', { class: 'grafico-nota' }, `Mostrando os ${MAX_CHART_ORDERS} pedidos mais críticos de ${number(orders.length)}; a tabela abaixo traz todos.`)
        : null,
      legend(STAGES, stageClass, (k) => LABELS.rhStage[k]));

    const columns = [
      { title: 'Pedido', cls: 'nowrap', render: (o) => el('a', { href: `#/pedidos/${o.orderId}`, title: 'Abrir o pedido',
        onclick: (e) => e.stopPropagation() }, `Nº ${o.number}`) },
      { title: 'Cliente', field: 'client' },
      { title: 'Unidade contratante', field: 'unit' },
      { title: 'Cargo', field: 'jobRole' },
      { title: 'Vagas', cls: 'num', render: (o) => number(o.positions) },
      { title: 'Preenchidas', cls: 'num', render: (o) => number(o.filled) },
      { title: 'Pendentes', cls: 'num', render: (o) => number(o.pending) },
      { title: '% preenchido', cls: 'num', render: (o) => percent(o.percentFilled) },
      { title: 'Vencidas', cls: 'num', render: (o) => number(o.sla.OVERDUE) },
      { title: 'Em risco', cls: 'num', render: (o) => number(o.sla.AT_RISK) },
      { title: 'Analistas de RH', render: (o) => (o.analysts.length
        ? el('div', { class: 'lista-analistas' }, ...o.analysts.map((n) => el('div', { class: 'nowrap' }, n)),
          o.shared ? el('span', { class: 'etiqueta cinza compartilhado' }, 'compartilhado') : null)
        : el('span', { class: 'texto-alerta' }, 'Sem analista')) },
    ];

    return panelNoPadding(`Pedidos (${number(orders.length)})`, el('div', {},
      orders.length ? chart : null,
      table(columns, orders, {
        onClick: (o) => toPositions(o),
        rowClass: (o) => (o.sla.OVERDUE ? 'linha-erro' : o.sla.AT_RISK ? 'linha-alerta' : ''),
        empty: 'Nenhum pedido com estes filtros.',
        dense: true,
      })));
  }

  function analystsPanel(d) {
    const rows = d.analysts;
    const t = d.totals;
    const maxStage = Math.max(0, ...rows.map((a) => a.positions));
    const maxSla = Math.max(0, ...rows.map((a) => a.pending));
    const pickAnalyst = (a) => (d.analystLocked ? null : apply({ rh: a.id }));
    const nameCell = (a) => (d.analystLocked
      ? el('span', { class: 'grafico-rotulo' }, a.name)
      : el('button', { class: 'grafico-rotulo', type: 'button', title: `Filtrar o painel por ${a.name}`, onclick: () => pickAnalyst(a) }, a.name));

    const stageChart = el('div', { class: 'grafico' },
      el('h3', { class: 'grafico-titulo' }, 'Vagas por etapa'),
      ...rows.map((a) => el('div', { class: 'grafico-linha' },
        nameCell(a),
        el('div', { class: 'grafico-trilho' }, stackedBar(a.stages, STAGES, maxStage, {
          cls: stageClass,
          onPick: d.analystLocked ? null : (k) => apply({ rh: a.id, stage: k }),
          describe: (k, v) => `${a.name} · ${LABELS.rhStage[k]}: ${plural(v, 'vaga', 'vagas')}`,
        })),
        el('div', { class: 'grafico-valor' }, number(a.positions)))),
      legend(STAGES, stageClass, (k) => LABELS.rhStage[k]));

    const slaChart = el('div', { class: 'grafico' },
      el('h3', { class: 'grafico-titulo' }, 'Pendentes por situação do SLA'),
      ...rows.map((a) => el('div', { class: 'grafico-linha' },
        nameCell(a),
        el('div', { class: 'grafico-trilho' }, a.pending ? stackedBar(a.sla, SLA, maxSla, {
          cls: slaClass,
          onPick: d.analystLocked ? null : (k) => apply({ rh: a.id, sla: k }),
          describe: (k, v) => `${a.name} · ${SLA_ICON[k]} ${SLA_LABEL[k]}: ${plural(v, 'vaga', 'vagas')}`,
        }) : null),
        el('div', { class: 'grafico-valor' }, number(a.pending)))),
      legend(SLA, slaClass, (k) => `${SLA_ICON[k]} ${SLA_LABEL[k]}`));

    const columns = [
      { title: 'Analista', cls: 'nowrap', render: (a) => (a.unassigned ? el('span', { class: 'texto-alerta' }, a.name) : a.name) },
      { title: 'Pedidos', cls: 'num', render: (a) => number(a.orders) },
      { title: 'Compartilhados', cls: 'num', render: (a) => (a.sharedOrders === null || a.sharedOrders === undefined ? '—' : number(a.sharedOrders)) },
      { title: 'Vagas', cls: 'num', render: (a) => number(a.positions) },
      { title: 'Preenchidas', cls: 'num', render: (a) => number(a.filled) },
      { title: 'Pendentes', cls: 'num', render: (a) => number(a.pending) },
      { title: '% preench.', cls: 'num', render: (a) => percent(a.percentFilled) },
      ...STAGES.filter((s) => s !== 'FILLED').map((s) => ({ title: STAGE_SHORT[s], cls: 'num', render: (a) => number(a.stages[s]) })),
      ...SLA.map((s) => ({ title: `${SLA_ICON[s]} ${SLA_LABEL[s]}`, cls: 'num', render: (a) => number(a.sla[s]) })),
    ];
    const total = { ...t, name: 'Total (cada pedido e vaga uma vez)', isTotal: true, unassigned: false };

    return panelNoPadding(d.analystLocked ? 'Minhas demandas' : 'Demandas por analista', el('div', {},
      rows.length ? el('div', { class: 'graficos-lado' }, stageChart, slaChart) : null,
      table(columns, rows.length > 1 ? [...rows, total] : rows, {
        onClick: d.analystLocked ? null : (a) => !a.isTotal && pickAnalyst(a),
        rowClass: (a) => (a.isTotal ? 'linha-total' : a.sla.OVERDUE ? 'linha-erro' : ''),
        empty: 'Nenhuma demanda com estes filtros.',
        dense: true,
      }),
      !d.analystLocked && t.sharedOrders
        ? el('div', { class: 'grafico-nota' },
          'Pedido compartilhado entra na linha de cada analista responsável; o total conta cada pedido e cada vaga uma vez, '
          + 'por isso a soma das linhas pode passar do total.')
        : null));
  }

  clear(target).append(
    el('section', { class: 'painel' },
      el('div', { class: 'painel-cabecalho' }, el('h2', {}, 'Acompanhamento do RH'),
        el('div', { class: 'barra-botoes' }, button('Atualizar', () => reload(), 'secundario pequeno'))),
      filterArea),
    resultArea,
    tooltip,
  );
  await reload();
}

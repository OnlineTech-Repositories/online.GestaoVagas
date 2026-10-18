import { api } from '../api.js';
import {
  el, clear, field, table, panelNoPadding, loading, money, number, date, options, LABELS, locationLabel, today,
  toast, errorMessage, button,
} from '../ui.js';
import { navigate } from '../app.js';

/**
 * Relatórios e KPIs (seção 11): posições em aberto, SLA por período, faturamento perdido e reposições.
 *
 * O servidor devolve as colunas já tipadas e filtradas pelo perfil (R$ só para quem pode ver, seção 4.2): a tela só
 * formata. É a mesma definição que monta o Excel — o que se vê é o que se exporta.
 */

const REPORTS = [
  { kind: 'open', label: 'Posições em aberto' },
  { kind: 'sla', label: 'SLA por período' },
  { kind: 'loss', label: 'Faturamento perdido' },
  { kind: 'replacements', label: 'Reposições' },
];

/** Linhas de detalhe na tela; o Excel leva todas. */
const MAX_ROWS = 300;

const format = {
  int: (v) => number(v),
  decimal: (v) => number(v, 1),
  money: (v) => money(v),
  percent: (v) => `${number(v, 1)}%`,
  date: (v) => date(v),
};
const show = (value, type) => (value === null || value === undefined || value === '' ? '—' : (format[type] ?? String)(value));

const KPI_UNIT = {
  days: (v) => `${number(v, 1)} dia${v === 1 ? '' : 's'}`,
  percent: (v) => `${number(v, 1)}%`,
  int: (v) => number(v),
  money: (v) => money(v),
};
const kpiValue = (k, v) => (v === null || v === undefined ? '—' : KPI_UNIT[k.unit](v));

function kpiCard(k) {
  const highlight = k.status === 'ok' ? 'ok' : k.status === 'bad' ? 'erro' : '';
  const goal = k.target === null
    ? el('div', { class: 'meta sem-meta' }, 'Sem meta')
    : el('div', { class: 'meta' }, `Meta: ${kpiValue(k, k.target)}${k.status === 'ok' ? ' · dentro' : k.status === 'bad' ? ' · fora' : ''}`);
  return el('div', { class: `indicador ${highlight ? `destaque-${highlight}` : ''}`, title: k.note },
    el('div', { class: 'rotulo' }, k.label),
    el('div', { class: 'valor' }, kpiValue(k, k.value)),
    goal,
    el('div', { class: 'nota' }, k.note));
}

/** Colunas que identificam a linha não quebram (a tabela rola na horizontal); as de texto longo quebram. */
const NOWRAP = new Set(['group', 'position', 'client', 'contract', 'registration']);

const columnsOf = (cols) => cols.map((c) => ({
  title: c.title,
  cls: ['int', 'decimal', 'money', 'percent'].includes(c.type) ? 'num' : c.type === 'date' || NOWRAP.has(c.key) ? 'nowrap' : '',
  render: (row) => show(row[c.key], c.type),
}));

const situationClass = (row) => (row.situationKey === 'OVERDUE' ? 'linha-erro' : row.situationKey === 'AT_RISK' ? 'linha-alerta' : '');

export async function reportsScreen(target, _params, query) {
  const start = today().slice(0, 8) + '01';
  const filters = {
    kind: REPORTS.some((r) => r.kind === query?.get('tipo')) ? query.get('tipo') : 'open',
    from: start, to: today(), clientId: '', contractId: '', modality: '', jobRoleId: '', demandType: '',
    groupEntityId: '', workLocationId: '', rhAnalystId: '', commercialOwnerId: '', groupBy: '',
  };
  const params = () => {
    const { kind, ...rest } = filters;
    return rest;
  };

  const [clients, contracts, jobRoles, groups, locations, analysts, commercials] = await Promise.all([
    api.get('/api/clients'),
    api.get('/api/contracts'),
    api.get('/api/catalogs/job-roles'),
    api.get('/api/catalogs/group-entities'),
    api.get('/api/catalogs/work-locations'),
    api.get('/api/users/by-role/RH'),
    api.get('/api/users/by-role/COMMERCIAL'),
  ]);
  const list = (items, text, labelOf = (x) => x.name) => [{ value: '', label: text }, ...items.map((x) => ({ value: x.id, label: labelOf(x) }))];

  const tabs = el('div', { class: 'abas', role: 'tablist' });
  const kpiArea = el('div', { class: 'grade grade-4' });
  const groupSelect = el('div');
  const resultArea = el('div', {}, loading());
  let running = 0;

  async function reload() {
    const ticket = ++running;
    clear(resultArea).append(loading());
    let r;
    try {
      r = await api.get(`/api/reports/${filters.kind}`, params());
    } catch (e) {
      if (ticket === running) clear(resultArea).append(errorMessage(e.message));
      return;
    }
    if (ticket !== running) return; // um filtro mudou antes da resposta: vale a consulta mais recente
    filters.groupBy = r.groupBy;
    renderTabs();
    renderGroupSelect(r);
    clear(kpiArea).append(...r.kpis.filter((k) => !k.hidden).map(kpiCard));

    const rows = r.detail.rows.slice(0, MAX_ROWS);
    clear(resultArea).append(
      panelNoPadding(`Resumo por ${r.groups.find((g) => g.value === r.groupBy)?.label.toLowerCase() ?? 'grupo'}`,
        table(columnsOf(r.summary.columns), r.summary.rows, {
          rowClass: (x) => (x.isTotal ? 'linha-total' : ''),
          empty: 'Nenhuma posição neste período com estes filtros.',
          dense: true,
        })),
      panelNoPadding(`Detalhe (${number(r.detail.rows.length)})`,
        el('div', {},
          table(columnsOf(r.detail.columns), rows, {
            rowClass: situationClass,
            onClick: (x) => x.id && navigate(`/posicoes/${x.id}`),
            empty: 'Nenhuma posição neste período com estes filtros.',
            dense: true,
          }),
          r.detail.rows.length > MAX_ROWS
            ? el('div', { class: 'mensagem info', style: { margin: '12px 16px' } },
              `Mostrando ${MAX_ROWS} de ${number(r.detail.rows.length)} linhas. A exportação para Excel traz todas.`)
            : null)),
      el('section', { class: 'painel' }, el('ul', { class: 'notas-relatorio' }, ...r.notes.map((n) => el('li', {}, n)))),
    );
  }

  function renderTabs() {
    clear(tabs).append(...REPORTS.map((rep) => el('button', {
      class: `aba ${rep.kind === filters.kind ? 'ativa' : ''}`, type: 'button', role: 'tab',
      'aria-selected': rep.kind === filters.kind ? 'true' : 'false',
      onclick: () => {
        if (rep.kind === filters.kind) return;
        filters.kind = rep.kind;
        filters.groupBy = '';
        reload();
      },
    }, rep.label)));
  }

  function renderGroupSelect(r) {
    const block = field({
      name: 'groupBy', label: 'Agrupar por', type: 'select', value: r.groupBy,
      options: r.groups.map((g) => ({ value: g.value, label: g.label })),
    });
    block.querySelector('select').addEventListener('change', (e) => {
      filters.groupBy = e.target.value;
      reload();
    });
    clear(groupSelect).append(block);
  }

  const select = (name, text, items) => {
    const block = field({ name, label: text, type: 'select', value: filters[name], options: items });
    block.querySelector('select').addEventListener('change', (e) => {
      filters[name] = e.target.value;
      reload();
    });
    return block;
  };
  const dateField = (name, text) => {
    const block = field({ name, label: text, type: 'date', value: filters[name] });
    block.querySelector('input').addEventListener('change', (e) => {
      if (!e.target.value) return;
      filters[name] = e.target.value;
      reload();
    });
    return block;
  };

  const exportButton = button('Exportar Excel', async () => {
    exportButton.disabled = true;
    try {
      const { name, blob } = await api.file(`/api/reports/${filters.kind}/export`, params());
      const url = URL.createObjectURL(blob);
      const link = el('a', { href: url, download: name, style: { display: 'none' } });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast(`Planilha gerada: ${name}`, 'sucesso');
    } catch (e) {
      toast(e.message, 'erro');
    } finally {
      exportButton.disabled = false;
    }
  });

  clear(target).append(
    el('section', { class: 'painel' },
      el('div', { class: 'painel-cabecalho' }, el('h2', {}, 'Relatórios e indicadores'), el('div', { class: 'barra-botoes' }, exportButton)),
      el('div', { class: 'painel-corpo' },
        tabs,
        el('div', { class: 'filtros' },
          dateField('from', 'De'),
          dateField('to', 'Até'),
          select('clientId', 'Cliente', list(clients, 'Todos', (c) => c.legalName)),
          select('contractId', 'Contrato', list(contracts, 'Todos')),
          select('modality', 'Modalidade', options(LABELS.modality, 'Todas')),
          select('jobRoleId', 'Cargo', list(jobRoles, 'Todos')),
          select('demandType', 'Tipo de demanda', options(LABELS.demandType, 'Todos')),
          select('groupEntityId', 'CNPJ do Grupo', list(groups, 'Todos')),
          select('workLocationId', 'Local', list(locations, 'Todos', locationLabel)),
          select('rhAnalystId', 'Analista de RH', list(analysts, 'Todos')),
          select('commercialOwnerId', 'Responsável comercial', list(commercials, 'Todos')),
          groupSelect))),
    el('div', { style: { margin: '0 0 16px' } }, kpiArea),
    resultArea,
  );
  renderTabs();
  await reload();
}

/**
 * Biblioteca de interface: criação de elementos, formatação, toasts, modais,
 * formulários, tabelas e os componentes de domínio reaproveitados pelas telas.
 *
 * Todo texto vindo da API entra na página via textContent ou via `element`,
 * nunca por innerHTML — nomes, justificativas e observações são preenchidos
 * por usuários e não podem virar HTML.
 */

/** Cria um elemento. `children` aceita strings, nós e arrays aninhados; null/undefined/false são ignorados. */
export function element(tag, attributes = {}, ...children) {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attributes ?? {})) {
    if (value === null || value === undefined || value === false) continue;

    if (key === 'class') node.className = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style') Object.assign(node.style, value);
    else if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
    }
    // Não existe atalho para innerHTML de propósito: um `html:` aqui viraria,
    // mais cedo ou mais tarde, um XSS armazenado.
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, value);
  }

  const append = (child) => {
    if (child === null || child === undefined || child === false) return;
    if (Array.isArray(child)) return child.forEach(append);
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  };
  children.forEach(append);

  return node;
}

export const el = element;

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

// ---------------------------------------------------------------------
// Formatação
// ---------------------------------------------------------------------

const moneyFormatter = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

export const money = (value) =>
  value === null || value === undefined ? '—' : moneyFormatter.format(Number(value));

export const number = (value, decimals = 0) =>
  new Intl.NumberFormat('pt-BR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals }).format(
    Number(value ?? 0),
  );

/** Datas da API: "AAAA-MM-DD" (DATE, sem fuso) → "DD/MM/AAAA". */
export function date(value) {
  if (!value) return '—';
  const [year, month, day] = String(value).slice(0, 10).split('-');
  if (!year || !month || !day) return String(value);
  return `${day}/${month}/${year}`;
}

/** Data e hora ISO (UTC) → horário local. */
export function dateTime(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' });
}

/** 14 dígitos → 00.000.000/0000-00 (também mascara o valor parcial, durante a digitação). */
/** CPF com máscara (000.000.000-00) enquanto digita. */
export function cpf(value) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, 11)
    .replace(/^(\d{3})(\d)/, '$1.$2')
    .replace(/^(\d{3})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{3})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3-$4');
}

/** Dígitos verificadores do CPF (a API valida de novo). */
export function isValidCpf(value) {
  const d = String(value ?? '').replace(/\D/g, '');
  if (d.length !== 11 || /^(\d)\1{10}$/.test(d)) return false;
  const digit = (base) => {
    const rest = [...base].reduce((sum, c, i) => sum + Number(c) * (base.length + 1 - i), 0) % 11;
    return rest < 2 ? 0 : 11 - rest;
  };
  const first = digit(d.slice(0, 9));
  return first === Number(d[9]) && digit(d.slice(0, 9) + first) === Number(d[10]);
}

export function cnpj(value) {
  return String(value ?? '')
    .replace(/\D/g, '')
    .slice(0, 14)
    .replace(/^(\d{2})(\d)/, '$1.$2')
    .replace(/^(\d{2})\.(\d{3})(\d)/, '$1.$2.$3')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})(\d)/, '$1.$2.$3/$4')
    .replace(/^(\d{2})\.(\d{3})\.(\d{3})\/(\d{4})(\d)/, '$1.$2.$3/$4-$5');
}

export const initials = (name) =>
  String(name ?? '')
    .replace(/\(.*?\)/g, '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');

/** Data de hoje em AAAA-MM-DD, no fuso local. */
export function today() {
  const d = new Date();
  return new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
}

/** Analistas de RH responsáveis pelo pedido; sem nenhum, a indicação "Aguardando atribuição do RH". */
export function rhTeam(names, awaiting) {
  if (names?.length) return element('span', {}, names.join(', '));
  return awaiting ? element('span', { class: 'etiqueta amarela' }, 'Aguardando atribuição do RH') : '—';
}

/** Opções do filtro de analistas de RH (listas de pedidos e posições). */
export function rhFilterOptions(analysts, user) {
  return [
    { value: '', label: 'Todos' },
    { value: 'UNASSIGNED', label: 'Aguardando atribuição do RH' },
    ...(user?.roles?.includes('RH') ? [{ value: 'MINE', label: 'Meus pedidos' }] : []),
    ...analysts.map((a) => ({ value: a.id, label: a.name })),
  ];
}

/** Publicação no JobConvo do pedido, em uma linha (o RH registra uma vez para todas as posições). */
export function jobconvoText(published, code, publishedAt) {
  if (published === true) return `${code} · publicada em ${date(publishedAt)}`;
  if (published === false) return 'Sem publicação no JobConvo';
  return 'Não informada';
}

/** Local de trabalho: unidades de cliente aparecem com o código ("LJ-001 — Loja Centro"). */
export const locationLabel = (l) => (l.code ? `${l.code} — ${l.name}` : l.name);

/** Dias corridos, no singular ou plural. */
export const days = (value) =>
  value === null || value === undefined ? '—' : `${value} ${Math.abs(value) === 1 ? 'dia' : 'dias'}`;

// ---------------------------------------------------------------------
// Rótulos (glossário da SPEC, seção 16)
// ---------------------------------------------------------------------

export const LABELS = {
  modality: { RS: 'R&S', MOT: 'Mão de Obra Temporária', MOE: 'Mão de Obra Efetiva', FAC: 'Facilities' },
  modalityShort: { RS: 'R&S', MOT: 'MOT', MOE: 'MOE', FAC: 'Facilities' },
  demandType: { NEW: 'Vaga nova', REPLACEMENT: 'Reposição' },
  termType: { FIXED_END: 'Data fim fixa', PRESERVED_DURATION: 'Duração preservada', INDEFINITE: 'Indeterminado' },
  positionStatus: {
    AWAITING_CONFIRMATION: 'Aguardando confirmação',
    OPEN: 'Aberta',
    RECRUITING: 'Em recrutamento',
    CANDIDATE_APPROVED: 'Candidato selecionado',
    IN_ADMISSION: 'Em admissão',
    AWAITING_FIRST_DAY: 'Aguardando 1º dia',
    PAUSED: 'Pausada',
    FILLED: 'Preenchida',
    CLOSED_CLIENT_CANCELLED: 'Encerrada: cliente cancelou',
    CLOSED_CONTRACT_ENDED: 'Encerrada: contrato encerrou',
  },
  orderStatus: { IN_PROGRESS: 'Em andamento', FULFILLED: 'Atendido', CANCELLED: 'Cancelado' },
  approvalStatus: {
    AWAITING_CLIENT_APPROVAL: 'Aguardando aprovação do cliente',
    APPROVED: 'Aprovado',
    NOT_APPROVED: 'Não aprovado',
  },
  slaSituation: { ON_TIME: 'No prazo', AT_RISK: 'Em risco', OVERDUE: 'Vencido', NO_TARGET: 'Sem meta' },
  /** Filtro de SLA: as situações e a vaga ainda sem contagem (sem data de abertura). */
  slaFilter: { ON_TIME: 'No prazo', AT_RISK: 'Em risco', OVERDUE: 'Vencido', NO_TARGET: 'Sem meta', NOT_STARTED: 'SLA não iniciado' },
  /** Etapa no acompanhamento do RH: pausa e espera pelo cliente em etapas próprias. */
  rhStage: {
    AWAITING_CLIENT: 'Aguardando cliente',
    OPEN: 'Aberta',
    RECRUITING: 'Em recrutamento',
    CANDIDATE_APPROVED: 'Candidato selecionado',
    IN_ADMISSION: 'Em admissão',
    AWAITING_FIRST_DAY: 'Aguardando 1º dia',
    PAUSED: 'Pausada',
    FILLED: 'Preenchida',
  },
  slaTargetSource: { CONTRACT: 'Meta do contrato', DEFAULT: 'Meta padrão', NONE: 'Sem meta' },
  rateStatus: { PENDING: 'Pendente de validação', VALIDATED: 'Validado', REJECTED: 'Rejeitado' },
  moneyStatus: {
    NOT_APPLICABLE: 'Não se aplica (R&S)',
    NO_RATE: 'Sem valor cadastrado',
    PENDING: 'Pendente de validação',
    VALIDATED: 'Validado',
    REJECTED: 'Valor rejeitado',
  },
  terminationSource: { DP: 'DP', NACC: 'NACC', CLIENT: 'Cliente' },
  terminationType: {
    RESIGNATION: 'Pedido de demissão',
    DISMISSAL: 'Dispensa',
    CONTRACT_END: 'Término de contrato',
    ABANDONMENT: 'Abandono',
    OTHER: 'Outro',
  },
  clientDecision: { REPLACE: 'Repor', NOT_REPLACE: 'Não repor' },
  candidateSex: { FEMALE: 'Feminino', MALE: 'Masculino', NOT_INFORMED: 'Não informado' },
  contractStatus: { ACTIVE: 'Ativo', CLOSED: 'Encerrado' },
  role: {
    COMMERCIAL: 'Comercial',
    NACC: 'NACC',
    DP: 'DP',
    RH: 'Analista de RH (RH / R&S)',
    RH_MANAGER: 'Gestor de RH',
    MANAGER: 'Gestor',
    CONTROLLERSHIP: 'Controladoria',
    ADMIN: 'Administrador',
  },
};

/** Opções de select a partir de um dicionário de rótulos. */
export const options = (labels, emptyLabel) => [
  ...(emptyLabel !== undefined ? [{ value: '', label: emptyLabel }] : []),
  ...Object.entries(labels).map(([value, label]) => ({ value, label })),
];

export const label = (labels, value) => (value ? (labels[value] ?? value) : '—');

// ---------------------------------------------------------------------
// Etiquetas de status
// ---------------------------------------------------------------------

const STATUS_COLORS = {
  AWAITING_CONFIRMATION: 'amarela',
  OPEN: 'azul',
  RECRUITING: 'azul',
  CANDIDATE_APPROVED: 'azul',
  IN_ADMISSION: 'azul',
  AWAITING_FIRST_DAY: 'amarela',
  PAUSED: 'amarela',
  FILLED: 'verde',
  CLOSED_CLIENT_CANCELLED: 'cinza',
  CLOSED_CONTRACT_ENDED: 'cinza',
};

/** `notReplaced` = reposição que o cliente decidiu não repor: a vaga termina ali. */
export const statusTag = (status, notReplaced = false) =>
  element('span', { class: `etiqueta ${STATUS_COLORS[status] ?? 'cinza'}` },
    notReplaced ? 'Encerrada: cliente não repôs' : label(LABELS.positionStatus, status));

/** Número da vaga no pedido (“6-1”); a reposição é um novo ciclo da mesma vaga. */
export const slotLabel = (p) => `${p.orderNumber}-${p.slotNumber}`;
export const cycleLabel = (cycle) => (cycle > 1 ? `Reposição nº ${cycle - 1}` : 'Vaga nova');

/** Situação do SLA: verde (no prazo), amarelo (em risco), vermelho (vencido), cinza (sem meta). */
const SLA_COLORS = { ON_TIME: 'verde', AT_RISK: 'amarela', OVERDUE: 'vermelha', NO_TARGET: 'cinza' };

export function slaTag(situation, stageStatus, approvalStatus) {
  // Antes da aprovação do cliente não há SLA: ele começa na data da aprovação.
  if (approvalStatus === 'AWAITING_CLIENT_APPROVAL') return element('span', { class: 'etiqueta amarela' }, 'Aguardando aprovação');
  if (situation) return element('span', { class: `etiqueta ${SLA_COLORS[situation]}` }, LABELS.slaSituation[situation]);
  if (stageStatus === 'AWAITING_CONFIRMATION') return element('span', { class: 'etiqueta amarela' }, 'Aguardando cliente');
  return '—';
}

/** Aprovação do cliente no pedido: amarelo (aguardando), verde (aprovado), cinza (não aprovado). */
const APPROVAL_COLORS = { AWAITING_CLIENT_APPROVAL: 'amarela', APPROVED: 'verde', NOT_APPROVED: 'cinza' };

export const approvalTag = (status) =>
  element('span', { class: `etiqueta ${APPROVAL_COLORS[status] ?? 'cinza'}` }, label(LABELS.approvalStatus, status));

const RATE_COLORS = { PENDING: 'amarela', VALIDATED: 'verde', REJECTED: 'vermelha' };

export const rateTag = (status) =>
  element('span', { class: `etiqueta ${RATE_COLORS[status] ?? 'cinza'}` }, label(LABELS.rateStatus, status));

/** Valor em R$ de uma posição, sinalizando o que está fora dos totais oficiais (RN-21). */
export function moneyValue(value, moneyStatus) {
  if (moneyStatus === 'NOT_APPLICABLE' || moneyStatus === 'NO_RATE') {
    return element('span', { class: 'texto-fraco texto-pequeno' }, LABELS.moneyStatus[moneyStatus]);
  }
  if (moneyStatus && moneyStatus !== 'VALIDATED') {
    return element('span', { class: 'valor-pendente', title: `${LABELS.moneyStatus[moneyStatus]} — fora dos totais` },
      money(value));
  }
  return money(value);
}

// ---------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------

export function toast(message, type = 'info', duration = 4500) {
  const area = document.getElementById('notificacoes-toast');
  const box = element('div', { class: `toast ${type}` }, message);
  area.append(box);
  setTimeout(() => {
    box.style.opacity = '0';
    box.style.transition = 'opacity .25s';
    setTimeout(() => box.remove(), 250);
  }, duration);
}

// ---------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------

export function modal({ title, body, footer, wide = false, onClose }) {
  const area = document.getElementById('modal-area');

  const close = () => {
    backdrop.remove();
    document.removeEventListener('keydown', onKeyDown);
    onClose?.();
  };

  const onKeyDown = (event) => {
    if (event.key === 'Escape') close();
  };

  const box = element(
    'div',
    { class: `modal ${wide ? 'largo' : ''}`, onclick: (e) => e.stopPropagation() },
    element(
      'div',
      { class: 'modal-cabecalho' },
      element('h2', {}, title),
      element('button', { class: 'modal-fechar', type: 'button', onclick: close, title: 'Fechar' }, '×'),
    ),
    element('div', { class: 'modal-corpo' }, body),
    footer ? element('div', { class: 'modal-rodape' }, footer) : null,
  );

  const backdrop = element('div', { class: 'modal-fundo', onclick: close }, box);

  area.append(backdrop);
  document.addEventListener('keydown', onKeyDown);

  // Foco no primeiro campo, para que o formulário já esteja pronto para uso.
  setTimeout(() => box.querySelector('input, select, textarea')?.focus(), 40);

  return { close, box };
}

/** Confirmação com promessa — substitui window.confirm. */
export function confirm({ title, message, confirmText = 'Confirmar', danger = false }) {
  return new Promise((resolve) => {
    let decided = false;

    const decide = (value) => {
      decided = true;
      reference.close();
      resolve(value);
    };

    const reference = modal({
      title,
      body: element('p', { class: 'mb-0' }, message),
      footer: [
        element('button', { class: 'btn secundario', type: 'button', onclick: () => decide(false) }, 'Cancelar'),
        element('button', { class: `btn ${danger ? 'perigo' : ''}`, type: 'button', onclick: () => decide(true) },
          confirmText),
      ],
      onClose: () => {
        if (!decided) resolve(false);
      },
    });
  });
}

const WARNING_TITLE = { RETROACTIVE: 'Registro retroativo', FUTURE: 'Registro futuro', SEQUENCE: 'Sequência divergente' };

/**
 * Avisos de data antes de salvar (resposta 422 com `avisos`): lista cada um com a data e o motivo e deixa concluir.
 * Quando o lançamento retroativo exige justificativa (fora da carga inicial), ela é pedida aqui mesmo. Resolve com
 * `{ justification }` ao confirmar ou `null` ao desistir.
 */
export function confirmWarnings(problem) {
  return new Promise((resolve) => {
    let decided = false;
    const needsJustification = Boolean(problem.justificativa?.obrigatoria);
    const justification = needsJustification
      ? field({ name: 'avisoJustificativa', label: 'Justificativa da data retroativa', type: 'textarea', required: true,
        help: 'Obrigatória fora da carga inicial: fica no histórico junto com a data informada.' })
      : null;

    const decide = (value) => {
      decided = true;
      reference.close();
      resolve(value);
    };
    const confirmButton = element('button', { class: 'btn', type: 'button', onclick: () => {
      const text = justification?.querySelector('textarea').value.trim() ?? '';
      if (needsJustification && !text) {
        justification.classList.add('com-erro');
        justification.querySelector('.erro-campo')?.remove();
        justification.append(element('div', { class: 'erro-campo' }, 'Informe a justificativa.'));
        return;
      }
      decide({ justification: text || null });
    } }, 'Salvar mesmo assim');

    const reference = modal({
      title: 'Confira as datas antes de salvar',
      body: [
        element('ul', { class: 'lista-avisos' }, ...problem.avisos.map((a) => element('li', { class: `aviso-${a.tipo.toLowerCase()}` },
          element('strong', {}, WARNING_TITLE[a.tipo] ?? 'Aviso'), element('span', {}, a.mensagem)))),
        justification,
      ],
      footer: [
        element('button', { class: 'btn secundario', type: 'button', onclick: () => decide(null) }, 'Voltar e corrigir'),
        confirmButton,
      ],
      onClose: () => {
        if (!decided) resolve(null);
      },
    });
  });
}

/** Selos de data da posição: "datas retroativas" (RN-24), "data futura" e "fora de sequência". */
export function dateBadges(p) {
  return [
    p.hasRetroactiveDates ? element('div', { class: 'selo-data', title: 'Possui datas registradas retroativamente (RN-24)' }, 'datas retroativas') : null,
    p.dateFlags?.future ? element('div', { class: 'selo-data futura', title: 'Há evento com data futura: os tempos contam até hoje' }, 'data futura') : null,
    p.dateFlags?.sequence ? element('div', { class: 'selo-data sequencia', title: 'Há etapa com data antes da etapa precedente' }, 'fora de sequência') : null,
  ];
}

/**
 * Janela de formulário: monta o modal, envia, marca os campos recusados e fecha
 * só quando a operação dá certo. `submit(data)` recebe o formulário lido.
 */
export function formModal({ title, fields, submit, submitText = 'Salvar', wide = false, danger = false, intro }) {
  const form = element('form', { novalidate: true }, intro ?? null, fields);
  // O botão fica no rodapé do modal, fora do <form>: o clique e o Enter no formulário levam ao mesmo envio.
  const button = element('button', { class: `btn ${danger ? 'perigo' : ''}`, type: 'button' }, submitText);

  const send = async (event) => {
    event?.preventDefault();
    form.querySelector('.mensagem.erro')?.remove();
    button.disabled = true;
    try {
      await submit(formData(form), form);
      reference.close();
    } catch (error) {
      form.prepend(applyErrors(form, error));
      button.disabled = false;
    }
  };

  form.addEventListener('submit', send);
  button.addEventListener('click', send);

  const reference = modal({
    title,
    body: form,
    wide,
    footer: [element('button', { class: 'btn secundario', type: 'button', onclick: () => reference.close() }, 'Cancelar'),
      button],
  });
  return reference;
}

// ---------------------------------------------------------------------
// Componentes de formulário
// ---------------------------------------------------------------------

export function field({
  name,
  label: text,
  type = 'text',
  value = '',
  required = false,
  options: items,
  help,
  placeholder,
  disabled = false,
  attributes = {},
}) {
  let input;

  if (type === 'select') {
    input = element(
      'select',
      { name, id: `campo-${name}`, disabled, ...attributes },
      ...(items ?? []).map((o) =>
        element('option', { value: o.value, selected: String(o.value) === String(value ?? '') }, o.label),
      ),
    );
  } else if (type === 'textarea') {
    input = element('textarea', { name, id: `campo-${name}`, placeholder, disabled, ...attributes });
    input.value = value ?? '';
  } else {
    input = element('input', {
      type,
      name,
      id: `campo-${name}`,
      value: value ?? '',
      placeholder,
      disabled,
      ...attributes,
    });
  }

  return element(
    'div',
    { class: 'campo', dataset: { campo: name } },
    element('label', { for: `campo-${name}` }, text, required ? element('span', { class: 'obrigatorio' }, '*') : null),
    input,
    help ? element('div', { class: 'ajuda' }, help) : null,
  );
}

/** Seleção múltipla em caixas de marcar. O valor lido é um array (ver `checkedValues`). */
export function checkGroup({ name, label: text, options: items, values = [], required = false, help }) {
  return element(
    'div',
    { class: 'campo', dataset: { campo: name } },
    element('label', {}, text, required ? element('span', { class: 'obrigatorio' }, '*') : null),
    element(
      'div',
      { class: 'grupo-checks' },
      ...items.map((o) =>
        element(
          'label',
          {},
          element('input', { type: 'checkbox', dataset: { grupo: name }, value: o.value, checked: values.includes(o.value) }),
          o.label,
        ),
      ),
    ),
    help ? element('div', { class: 'ajuda' }, help) : null,
  );
}

export const checkedValues = (form, name) =>
  [...form.querySelectorAll(`input[data-grupo="${name}"]`)].filter((c) => c.checked).map((c) => c.value);

export function checkbox({ name, label: text, checked = false }) {
  return element(
    'div',
    { class: 'campo-check', dataset: { campo: name } },
    element('input', { type: 'checkbox', name, id: `campo-${name}`, checked }),
    element('label', { for: `campo-${name}` }, text),
  );
}

/**
 * Campo monetário com máscara pt-BR: os dígitos preenchem da direita para a
 * esquerda ("150000" → "1.500,00"). O valor canônico ("1500.00") vai num input
 * oculto, sem ambiguidade entre separador de milhar e decimal.
 */
export function moneyField({ name, label: text, value = '', required = false, help, disabled = false }) {
  const format = (cents) => (cents / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const empty = value === '' || value === null || value === undefined;

  const hidden = element('input', { type: 'hidden', name, value: empty ? '' : Number(value).toFixed(2) });
  const input = element('input', {
    type: 'text',
    id: `campo-${name}`,
    value: empty ? '' : format(Math.round(Number(value) * 100)),
    inputmode: 'numeric',
    autocomplete: 'off',
    placeholder: '0,00',
    disabled,
    class: 'entrada-moeda',
  });

  const apply = () => {
    const digits = input.value.replace(/\D/g, '');
    if (!digits) {
      input.value = '';
      hidden.value = '';
      return;
    }
    const cents = Number(digits.slice(0, 15));
    input.value = format(cents);
    hidden.value = (cents / 100).toFixed(2);
  };

  input.addEventListener('input', () => {
    apply();
    const end = input.value.length;
    input.setSelectionRange(end, end);
  });
  input.addEventListener('blur', apply);

  return element(
    'div',
    { class: 'campo', dataset: { campo: name } },
    element('label', { for: `campo-${name}` }, text, required ? element('span', { class: 'obrigatorio' }, '*') : null),
    element('div', { class: 'campo-moeda' }, element('span', { class: 'prefixo-moeda' }, 'R$'), input),
    hidden,
    help ? element('div', { class: 'ajuda' }, help) : null,
  );
}

/** CNPJ com máscara; o valor enviado é o mascarado (a API normaliza para 14 dígitos). */
export function cpfField({ name = 'cpf', label: text = 'CPF', value = '', required = true } = {}) {
  const block = field({
    name,
    label: text,
    value: cpf(value),
    required,
    placeholder: '000.000.000-00',
    attributes: { inputmode: 'numeric', autocomplete: 'off', maxlength: '14' },
  });
  const input = block.querySelector('input');
  input.addEventListener('input', () => {
    input.value = cpf(input.value);
  });
  return block;
}

export function cnpjField({ name = 'cnpj', label: text = 'CNPJ', value = '', required = true }) {
  const block = field({
    name,
    label: text,
    value: cnpj(value),
    required,
    placeholder: '00.000.000/0000-00',
    attributes: { inputmode: 'numeric', autocomplete: 'off', maxlength: '18' },
  });
  const input = block.querySelector('input');
  input.addEventListener('input', () => {
    input.value = cnpj(input.value);
  });
  return block;
}

/**
 * Marca no formulário os campos que o servidor recusou e devolve o resumo.
 *
 * O que já foi preenchido não é tocado. As marcas saem sozinhas assim que o
 * campo é corrigido — sem isso o formulário fica vermelho mesmo depois de
 * corrigido e parece travado quando não está.
 */
export function applyErrors(form, error) {
  form.querySelectorAll('.campo.com-erro').forEach((block) => {
    block.classList.remove('com-erro');
    block.querySelector('.erro-campo')?.remove();
  });

  const summary = errorMessage(error.message);

  for (const [name, message] of Object.entries(error.fields ?? {})) {
    const block = form.querySelector(`[data-campo="${CSS.escape(name)}"]`);
    if (!block) continue;
    block.classList.add('com-erro');
    block.append(element('div', { class: 'erro-campo' }, message));

    const unmark = () => {
      block.classList.remove('com-erro');
      block.querySelector('.erro-campo')?.remove();
      // Corrigido o último campo apontado, o aviso do topo também sai.
      if (!form.querySelector('.campo.com-erro')) summary.remove();
    };

    for (const input of block.querySelectorAll('input, select, textarea')) {
      input.addEventListener('input', unmark, { once: true });
      input.addEventListener('change', unmark, { once: true });
    }
  }

  form.querySelector('.campo.com-erro')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  return summary;
}

export const errorMessage = (text) => element('div', { class: 'mensagem erro' }, text);
export const infoMessage = (text) => element('div', { class: 'mensagem info' }, text);
export const warningMessage = (text) => element('div', { class: 'mensagem alerta' }, text);

/** Lê um formulário como objeto simples (texto aparado; caixas de marcar como booleano). */
export function formData(form) {
  const data = {};
  for (const [key, value] of new FormData(form).entries()) {
    data[key] = typeof value === 'string' ? value.trim() : value;
  }
  for (const check of form.querySelectorAll('input[type="checkbox"]')) {
    if (check.name) data[check.name] = check.checked;
  }
  return data;
}

/** Texto vazio vira null, para a API distinguir "não informado". */
export const orNull = (value) => (value === '' || value === undefined ? null : value);
export const intOrNull = (value) => (value === '' || value === null || value === undefined ? null : Number(value));

/** Cria um ApiError local para validar antes de enviar (mesma marcação dos erros do servidor). */
export function validationError(fields) {
  const error = new Error('Preencha os campos destacados.');
  error.fields = fields;
  return error;
}

/** Exige os campos informados; lança erro de validação com os vazios. */
export function requireFields(data, labels) {
  const missing = {};
  for (const [name, text] of Object.entries(labels)) {
    const value = data[name];
    if (value === '' || value === null || value === undefined || (Array.isArray(value) && !value.length)) {
      // "O motivo" → "Informe o motivo.": a mesma frase serve aos dois gêneros.
      missing[name] = `Informe ${text[0].toLowerCase()}${text.slice(1)}.`;
    }
  }
  if (Object.keys(missing).length) throw validationError(missing);
}

/** Tipo de vigência com os campos dependentes (data fim ou duração) aparecendo conforme o tipo. */
export function termFields(type = 'INDEFINITE', endDate = '', duration = null) {
  const typeField = field({ name: 'termType', label: 'Vigência', type: 'select', value: type, required: true, options: options(LABELS.termType) });
  const end = field({ name: 'termEndDate', label: 'Data fim da vigência', type: 'date', value: endDate ?? '', required: true });
  const length = field({ name: 'termDurationDays', label: 'Duração (dias)', type: 'number', value: duration ?? '', required: true,
    attributes: { min: '1' } });

  const sync = (value) => {
    end.classList.remove('oculto');
    length.classList.remove('oculto');
    if (value !== 'FIXED_END') end.classList.add('oculto');
    if (value !== 'PRESERVED_DURATION') length.classList.add('oculto');
  };
  typeField.querySelector('select').addEventListener('change', (e) => sync(e.target.value));
  sync(type);
  return [typeField, end, length];
}

// ---------------------------------------------------------------------
// Tabela e estrutura
// ---------------------------------------------------------------------

/**
 * @param {Array} columns  { title, field?, cls?, render?(row) }
 */
export function table(columns, rows, { onClick, empty = 'Nenhum registro encontrado.', rowClass, dense = false } = {}) {
  if (!rows?.length) {
    return element('div', { class: 'vazio' }, element('span', { class: 'ico' }, '—'), empty);
  }

  const body = element(
    'tbody',
    {},
    ...rows.map((row) => {
      const tr = element('tr', {
        class: [onClick ? 'clicavel' : '', rowClass?.(row) ?? ''].filter(Boolean).join(' '),
        onclick: onClick ? () => onClick(row) : null,
      });
      for (const column of columns) {
        const content = column.render ? column.render(row) : row[column.field];
        tr.append(element('td', { class: column.cls ?? '' },
          content === null || content === undefined || content === '' ? '—' : content));
      }
      return tr;
    }),
  );

  return element(
    'div',
    { class: `tabela-rolagem ${dense ? 'tabela-densa' : ''}` },
    element(
      'table',
      { class: 'tabela' },
      element('thead', {}, element('tr', {}, ...columns.map((c) => element('th', { class: c.cls ?? '' }, c.title)))),
      body,
    ),
  );
}

const header = (title, actions) =>
  title
    ? element('div', { class: 'painel-cabecalho' }, element('h2', {}, title),
      actions ? element('div', { class: 'barra-botoes' }, actions) : null)
    : null;

export const panel = (title, content, actions) =>
  element('section', { class: 'painel' }, header(title, actions), element('div', { class: 'painel-corpo' }, content));

export const panelNoPadding = (title, content, actions) =>
  element('section', { class: 'painel' }, header(title, actions),
    element('div', { class: 'painel-corpo sem-padding' }, content));

export const indicator = ({ label: text, value, note, highlight, onClick }) =>
  element(
    'div',
    { class: `indicador ${highlight ? `destaque-${highlight}` : ''} ${onClick ? 'clicavel' : ''}`, onclick: onClick },
    element('div', { class: 'rotulo' }, text),
    element('div', { class: 'valor' }, value),
    note ? element('div', { class: 'nota' }, note) : null,
  );

export const detail = (text, value, large = false) =>
  element(
    'div',
    { class: 'detalhe-item' },
    element('div', { class: 'rotulo' }, text),
    element('div', { class: `valor ${large ? 'grande' : ''}` }, value === null || value === undefined || value === '' ? '—' : value),
  );

export const loading = () =>
  element('div', { class: 'vazio' }, element('div', { class: 'spinner', style: { margin: '0 auto' } }));

export const button = (text, onclick, cls = '') => element('button', { class: `btn ${cls}`, type: 'button', onclick }, text);

/** Liga a busca por texto com debounce (~320 ms), como em todas as telas do padrão. */
export function debounce(fn, wait = 320) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  };
}

// ---------------------------------------------------------------------
// Posições (usado no painel, na lista de posições e no pedido)
// ---------------------------------------------------------------------

/** Colunas da tabela de posições; `money` inclui R$ (só para perfis com acesso aos valores). */
export function positionColumns({ money: showMoney = false, employee = false, client = true, rh = true } = {}) {
  return [
    {
      title: 'Posição',
      cls: 'nowrap',
      render: (p) => element('div', {}, slotLabel(p),
        p.cycle > 1 ? element('div', { class: 'texto-fraco texto-pequeno' }, cycleLabel(p.cycle)) : null),
    },
    client
      ? {
        title: 'Cliente / cargo',
        render: (p) => element('div', {}, element('div', {}, p.clientName),
          element('div', { class: 'texto-fraco texto-pequeno' }, `${p.jobRoleName} · ${p.workLocationName}`)),
      }
      : { title: 'Cargo', render: (p) => p.jobRoleName },
    { title: 'Tipo', render: (p) => LABELS.demandType[p.demandType] },
    {
      title: 'Status',
      render: (p) => element('div', {}, statusTag(p.status, p.notReplaced), dateBadges(p)),
    },
    {
      title: 'SLA',
      render: (p) => element('div', {}, slaTag(p.slaSituation, p.stageStatus, p.orderApprovalStatus),
        p.slaDeadline ? element('div', { class: 'texto-fraco texto-pequeno' }, `prazo ${date(p.slaDeadline)}`) : null),
    },
    ...(rh
      ? [{ title: 'Analistas de RH', render: (p) => rhTeam(p.rhAnalystNames,
        !['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED'].includes(p.status)) }]
      : []),
    { title: 'Abertura', cls: 'nowrap', render: (p) => date(p.openedAt) },
    { title: 'Dias descobertos', cls: 'num', render: (p) => String(p.uncoveredDays) },
    { title: 'Preenchimento', cls: 'num', render: (p) => (p.fillTime === null ? '—' : String(p.fillTime)) },
    ...(employee ? [{ title: 'Colaborador / candidato', render: (p) => p.employeeName ?? p.candidateName }] : []),
    ...(showMoney
      ? [{
        title: 'Perdido / postergado',
        cls: 'num',
        render: (p) => element('div', {}, moneyValue(p.lost, p.moneyStatus),
          p.deferred ? element('div', { class: 'texto-fraco texto-pequeno' }, `post. ${money(p.deferred)}`) : null),
      }]
      : []),
  ];
}

/** Faixa lateral nas linhas vencidas (vermelha) e em risco (amarela). */
export const positionRowClass = (p) =>
  p.slaSituation === 'OVERDUE' && !['FILLED'].includes(p.status) ? 'linha-erro'
    : p.slaSituation === 'AT_RISK' ? 'linha-alerta' : '';

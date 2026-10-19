import { api } from '../api.js';
import {
  el, clear, field, table, panel, panelNoPadding, loading, detail, date, dateTime, days, money, label, LABELS, options,
  statusTag, slaTag, approvalTag, slotLabel, cycleLabel, moneyValue, positionColumns, positionRowClass, formModal, requireFields, orNull, intOrNull,
  today, toast, debounce, button, errorMessage, termFields, locationLabel, jobconvoText, rhTeam, rhFilterOptions,
  cpfField, isValidCpf, validationError,
} from '../ui.js';
import { navigate, state, hasRole } from '../app.js';

// ---------------------------------------------------------------------
// Lista de posições
// ---------------------------------------------------------------------

const PAGE_SIZE = 50;

/**
 * Lista com os filtros da seção 9; aceita filtros vindos do painel (?status=, ?sla=, ?onlyOpen=) e do Painel de RH
 * (?pedido=, ?etapa=, ?sla=, ?rh=).
 */
export async function positionsScreen(target, _params, query) {
  const filters = {
    search: '',
    status: query?.get('status') ?? '',
    stage: query?.get('etapa') ?? '',
    orderId: query?.get('pedido') ?? '',
    slaSituation: query?.get('sla') ?? '',
    onlyOpen: query?.get('onlyOpen') === 'true',
    clientId: '',
    contractId: '',
    modality: '',
    jobRoleId: '',
    demandType: '',
    groupEntityId: '',
    workLocationId: '',
    openedFrom: '',
    openedTo: '',
    rh: query?.get('rh') ?? '',
    allCycles: false,
    page: 1,
  };

  const tableArea = el('div', {}, loading());
  const orderChip = el('div', { class: 'filtro-ativo-area' });
  const paging = el('div', { class: 'paginacao' });

  async function reload() {
    clear(tableArea).append(loading());
    const result = await api.get('/api/positions', { ...filters, sort: 'uncovered', pageSize: PAGE_SIZE });
    // Pedido vindo do Painel de RH: um selo com o número, que remove o filtro.
    clear(orderChip);
    if (filters.orderId) {
      const number = result.items[0]?.orderNumber;
      orderChip.append(el('span', { class: 'filtro-ativo' }, number ? `Pedido nº ${number}` : 'Pedido selecionado',
        el('button', { type: 'button', title: 'Remover o filtro do pedido', 'aria-label': 'Remover o filtro do pedido',
          onclick: () => { filters.orderId = ''; filters.page = 1; reload(); } }, '✕')));
    }
    clear(tableArea).append(
      table(positionColumns({ money: state.user.canSeeDetailedValues, employee: true }), result.items, {
        onClick: (p) => navigate(`/posicoes/${p.id}`),
        rowClass: positionRowClass,
        empty: 'Nenhuma posição encontrada com estes filtros.',
        dense: true,
      }),
    );

    const first = result.total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
    const last = Math.min(filters.page * PAGE_SIZE, result.total);
    clear(paging).append(
      el('span', {}, `${first}–${last} de ${result.total} posição(ões)`),
      el(
        'div',
        { class: 'barra-botoes' },
        el('button', { class: 'btn secundario pequeno', type: 'button', disabled: filters.page <= 1,
          onclick: () => { filters.page--; reload(); } }, '‹ Anterior'),
        el('button', { class: 'btn secundario pequeno', type: 'button', disabled: last >= result.total,
          onclick: () => { filters.page++; reload(); } }, 'Próxima ›'),
      ),
    );
  }

  /** Select de filtro: recarrega no change, voltando à primeira página. */
  const filterSelect = (name, text, items, cls = '') => {
    const block = field({ name, label: text, type: 'select', value: filters[name], options: items });
    if (cls) block.classList.add(cls);
    block.querySelector('select').addEventListener('change', (e) => {
      filters[name] = e.target.value;
      filters.page = 1;
      reload();
    });
    return block;
  };

  const filterDate = (name, text) => {
    const block = field({ name, label: text, type: 'date', value: filters[name] });
    block.querySelector('input').addEventListener('change', (e) => {
      filters[name] = e.target.value;
      filters.page = 1;
      reload();
    });
    return block;
  };

  const search = field({ name: 'search', label: 'Buscar', type: 'search', placeholder: 'Colaborador, matrícula, JobConvo, cliente ou cargo' });
  search.classList.add('busca');
  const runSearch = debounce(() => reload());
  search.querySelector('input').addEventListener('input', (e) => {
    filters.search = e.target.value;
    filters.page = 1;
    runSearch();
  });

  const onlyOpen = el('div', { class: 'campo-check', style: { alignSelf: 'end', marginBottom: '8px' } },
    el('input', { type: 'checkbox', id: 'campo-onlyOpen', checked: filters.onlyOpen, onchange: (e) => {
      filters.onlyOpen = e.target.checked;
      filters.page = 1;
      reload();
    } }),
    el('label', { for: 'campo-onlyOpen' }, 'Somente abertas'));

  // Por padrão, uma linha por vaga (o ciclo atual); os ocupantes desligados ficam nos ciclos anteriores.
  const allCycles = el('div', { class: 'campo-check', style: { alignSelf: 'end', marginBottom: '8px' } },
    el('input', { type: 'checkbox', id: 'campo-allCycles', checked: filters.allCycles, onchange: (e) => {
      filters.allCycles = e.target.checked;
      filters.page = 1;
      reload();
    } }),
    el('label', { for: 'campo-allCycles' }, 'Incluir ciclos anteriores'));

  const [clients, contracts, jobRoles, groups, locations, analysts] = await Promise.all([
    api.get('/api/clients'),
    api.get('/api/contracts'),
    api.get('/api/catalogs/job-roles'),
    api.get('/api/catalogs/group-entities'),
    api.get('/api/catalogs/work-locations'),
    api.get('/api/users/by-role/RH'),
  ]);
  const all = (text) => [{ value: '', label: text }];

  clear(target).append(
    el(
      'section',
      { class: 'painel' },
      el('div', { class: 'painel-cabecalho' }, el('h2', {}, 'Posições')),
      el(
        'div',
        { class: 'filtros' },
        search,
        filterSelect('status', 'Status', options(LABELS.positionStatus, 'Todos')),
        filterSelect('stage', 'Etapa', options(LABELS.rhStage, 'Todas')),
        filterSelect('slaSituation', 'Situação do SLA', options(LABELS.slaFilter, 'Todas')),
        filterSelect('rh', 'Analistas de RH', rhFilterOptions(analysts, state.user)),
        onlyOpen,
        allCycles,
      ),
      el(
        'details',
        { class: 'mais-filtros' },
        el('summary', {}, 'Mais filtros'),
        el(
          'div',
          { class: 'filtros' },
          filterSelect('clientId', 'Cliente', [...all('Todos'), ...clients.map((c) => ({ value: c.id, label: c.legalName }))]),
          filterSelect('contractId', 'Contrato',
            [...all('Todos'), ...contracts.map((c) => ({ value: c.id, label: `${c.clientName} — ${c.name}` }))]),
          filterSelect('modality', 'Modalidade', options(LABELS.modality, 'Todas')),
          filterSelect('jobRoleId', 'Cargo', [...all('Todos'), ...jobRoles.map((j) => ({ value: j.id, label: j.name }))]),
          filterSelect('demandType', 'Tipo de demanda', options(LABELS.demandType, 'Todos')),
          filterSelect('groupEntityId', 'CNPJ do Grupo', [...all('Todos'), ...groups.map((g) => ({ value: g.id, label: g.name }))]),
          filterSelect('workLocationId', 'Local / unidade', [...all('Todos'), ...locations.map((l) => ({ value: l.id, label: locationLabel(l) }))]),
          filterDate('openedFrom', 'Aberta de'),
          filterDate('openedTo', 'Aberta até'),
        ),
      ),
      orderChip,
      el('div', { class: 'painel-corpo sem-padding' }, tableArea),
      paging,
    ),
  );

  await reload();
}

// ---------------------------------------------------------------------
// Detalhe da posição
// ---------------------------------------------------------------------

const AUDIT_ACTION = {
  CREATE: 'Criação',
  UPDATE: 'Alteração',
  CREATE_ORDER: 'Pedido criado',
  ADD_POSITIONS: 'Posições acrescentadas',
  REGISTER_TERMINATION: 'Desligamento registrado',
  REGISTER_LEGACY_TERMINATION: 'Desligamento avulso',
  CLIENT_DECISION_REPLACE: 'Cliente decidiu repor',
  CLIENT_DECISION_NOT_REPLACE: 'Cliente decidiu não repor',
  START_RECRUITING: 'Recrutamento iniciado',
  RECORD_JOBCONVO: 'Publicação no JobConvo registrada no pedido',
  APPROVE_ORDER: 'Aprovação do cliente registrada',
  NOT_APPROVE_ORDER: 'Cliente não aprovou o pedido',
  APPROVE_CANDIDATE: 'Candidato selecionado',
  REGISTER_ADMISSION: 'Admissão registrada',
  CONFIRM_FIRST_DAY: '1º dia confirmado',
  CANDIDATE_WITHDREW: 'Candidato desistiu',
  ADMISSION_NO_SHOW: 'Admitido não compareceu',
  START_PAUSE: 'Pausa iniciada',
  END_PAUSE: 'Pausa encerrada',
  CANCEL: 'Cancelamento',
  ADJUST_TERM: 'Vigência ajustada',
  CORRECT_DATE: 'Correção de data',
  ASSIGN_RH: 'Analistas de RH alterados',
  CORRECT_CANDIDATE: 'Dados do candidato corrigidos',
  CORRECT_REGISTRATION: 'Matrícula informada/corrigida',
  DAILY_JOB: 'Rotina diária',
  CREATE_RATE: 'Valor cadastrado',
  UPDATE_RATE: 'Valor corrigido',
  DEMO_SEED: 'Dados de demonstração',
};

const FIELD_LABEL = {
  Status: 'Status',
  PreviousStatus: 'Status anterior',
  OpenedAt: 'Abertura',
  JobconvoCode: 'Código JobConvo',
  JobconvoOpenedAt: 'Abertura no JobConvo',
  CandidateApprovedAt: 'Aprovação do candidato',
  AdmissionAt: 'Admissão',
  FirstDayAt: '1º dia efetivo',
  EmployeeName: 'Colaborador',
  EmployeeRegistration: 'Matrícula',
  ClosedAt: 'Encerramento',
  CancellationReason: 'Motivo do cancelamento',
  TermType: 'Tipo de vigência',
  TermEndDate: 'Fim da vigência',
  TermDurationDays: 'Duração (dias)',
  TermAdjustJustification: 'Justificativa da vigência',
  HasRetroactiveDates: 'Datas retroativas',
  ClientDecision: 'Decisão do cliente',
  ClientDecisionAt: 'Data da decisão',
  LastWorkedDay: 'Último dia trabalhado',
  RegisteredAt: 'Data de registro',
  StartDate: 'Início da pausa',
  EndDate: 'Fim da pausa',
  DesiredStartDate: 'Início desejado',
  RateId: 'Valor por cargo',
  SlaTargetDays: 'Meta de SLA',
  FullName: 'Nome do candidato',
  BirthDate: 'Data de nascimento',
  Sex: 'Sexo',
  Cpf: 'CPF',
  WithdrawnAt: 'Saída do candidato',
  WithdrawalReason: 'Motivo da saída',
  AdmissionRegistration: 'Matrícula (admissão)',
  FirstDayJustification: 'Justificativa do 1º dia',
};

const auditValue = (value) => {
  if (value === null || value === '') return '—';
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return date(value);
  if (/^\d{11}$/.test(value)) return value.replace(/^(\d{3})(\d{3})(\d{3})(\d{2})$/, '$1.$2.$3-$4');
  return LABELS.positionStatus[value] ?? LABELS.termType[value] ?? LABELS.clientDecision[value]
    ?? LABELS.candidateSex[value] ?? value;
};

export async function positionDetailScreen(target, id) {
  const reasons = await api.get('/api/catalogs/pause-reasons');

  async function reload(detailData) {
    const p = detailData ?? (await api.get(`/api/positions/${id}`));
    // Seções opcionais (candidato, 1º dia) vêm nulas quando não se aplicam: append escreveria "null".
    clear(target).append(...renderDetail(p, reasons, reload).filter(Boolean));
  }

  clear(target).append(loading());
  await reload();
}

function renderDetail(p, reasons, reload) {
  const s = p.summary;
  const m = p.metrics;

  const primary = ['DECIDE', 'APPROVE_CANDIDATE', 'REGISTER_ADMISSION', 'CONFIRM_FIRST_DAY', 'END_PAUSE',
    'REGISTER_TERMINATION'];
  // A correção do candidato fica na seção "Candidato selecionado".
  const headerActions = p.allowedActions.filter((a) => a !== 'CORRECT_CANDIDATE');
  const actionButtons = [
    ...headerActions.filter((a) => primary.includes(a)).map((a) => button(actionTitle(a, p), () => openAction(a, p, reasons, reload))),
    ...headerActions.filter((a) => !primary.includes(a)).map((a) =>
      button(actionTitle(a, p), () => openAction(a, p, reasons, reload), 'secundario')),
  ];

  const header = el(
    'section',
    { class: 'painel' },
    el(
      'div',
      { class: 'painel-cabecalho' },
      el('h2', {}, `Posição ${slotLabel(s)} · ${cycleLabel(s.cycle)}`),
      el('div', { class: 'barra-botoes' }, button(`Pedido ${s.orderNumber}`, () => navigate(`/pedidos/${s.orderId}`), 'secundario pequeno')),
    ),
    el(
      'div',
      { class: 'painel-corpo' },
      el(
        'div',
        { class: 'barra-botoes mb-16' },
        statusTag(s.status, s.notReplaced),
        slaTag(m.slaSituation, s.stageStatus, s.orderApprovalStatus),
        s.orderApprovalStatus !== 'APPROVED' ? approvalTag(s.orderApprovalStatus) : null,
        s.hasRetroactiveDates ? el('span', { class: 'etiqueta cinza', title: 'Datas registradas retroativamente (RN-24)' }, 'Datas retroativas') : null,
      ),
      // Ciclo anterior: o ocupante foi desligado e a vaga seguiu numa reposição.
      !s.isCurrentCycle && p.exitTermination
        ? el('div', { class: 'mensagem info' },
          el('strong', {}, `Ciclo anterior da vaga ${slotLabel(s)}.`),
          `O colaborador foi desligado (último dia ${date(p.exitTermination.lastWorkedDay)}) e a vaga seguiu em reposição. `,
          p.exitTermination.replacementPositionId
            ? el('a', { href: `#/posicoes/${p.exitTermination.replacementPositionId}` }, 'Ver o ciclo atual')
            : null)
        : null,
      s.orderApprovalStatus === 'AWAITING_CLIENT_APPROVAL'
        ? el('div', { class: 'mensagem alerta' },
          el('strong', {}, 'O pedido aguarda a aprovação do cliente.'),
          'O RH pode preparar a vaga até "Em recrutamento". O SLA começa na data da aprovação, registrada pelo Comercial ou pela Controladoria no pedido.')
        : null,
      // RN-06: a publicação no JobConvo é registrada uma vez, no pedido, e vale para todas as posições.
      s.stageStatus === 'OPEN' && p.jobconvoPublished === null
        ? el('div', { class: 'mensagem info' },
          el('strong', {}, 'Recrutamento ainda não iniciado.'),
          p.canActAsRh
            ? 'Informe a publicação no JobConvo no pedido: todas as posições abertas dele entram em "Em recrutamento".'
            : 'A posição entra em "Em recrutamento" quando o RH informar a publicação no JobConvo no pedido.')
        : null,
      // O Analista de RH executa o recrutamento só nos pedidos atribuídos a ele.
      hasRole(state.user, 'RH') && !p.canActAsRh && !['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED'].includes(s.status)
        ? el('div', { class: 'mensagem info' },
          el('strong', {}, 'Você não está entre os analistas de RH responsáveis por este pedido.'),
          p.rhAnalysts.length
            ? `As ações de recrutamento ficam com ${p.rhAnalysts.map((a) => a.name).join(', ')} e com o Gestor de RH.`
            : 'O pedido aguarda a atribuição do RH: o Gestor de RH define os analistas responsáveis no pedido.')
        : null,
      s.status === 'IN_ADMISSION' && missingFirstDayData(p).length
        ? el('div', { class: 'mensagem alerta' },
          el('strong', {}, 'Dados pendentes para a confirmação do 1º dia.'),
          missingFirstDayData(p).join(' '))
        : null,
      actionButtons.length
        ? el('div', { class: 'barra-botoes' }, actionButtons)
        : el('p', { class: 'texto-fraco texto-pequeno mb-0' }, 'Nenhuma ação disponível para o seu perfil no status atual.'),
    ),
  );

  const data = panel(
    'Dados',
    el(
      'div',
      { class: 'detalhe-grade' },
      detail('Cliente', s.clientName),
      detail('Contrato', s.contractName),
      detail('CNPJ do Grupo', s.groupEntityName),
      detail('Modalidade', label(LABELS.modality, s.modality)),
      detail('Cargo', s.jobRoleName),
      detail('Local', s.workLocationName),
      detail('Vigência', [
        label(LABELS.termType, p.termType),
        p.termEndDate ? ` até ${date(p.termEndDate)}` : '',
        p.termDurationDays ? ` · ${p.termDurationDays} dias` : '',
      ].join('')),
      p.termAdjustJustification ? detail('Ajuste de vigência', p.termAdjustJustification) : null,
      detail('Analistas de RH responsáveis (do pedido)', rhTeam(p.rhAnalysts.map((a) => a.name),
        !['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED'].includes(s.status))),
      detail('Publicação no JobConvo (do pedido)', jobconvoText(p.jobconvoPublished, p.jobconvoCode, p.jobconvoPublishedAt)),
      p.jobconvoNotes ? detail(p.jobconvoPublished === false ? 'Motivo de não publicar' : 'Observações da publicação', p.jobconvoNotes) : null,
      p.orderNotes ? detail('Observações do pedido', p.orderNotes) : null,
    ),
  );

  const metrics = panel(
    'Indicadores',
    el(
      'div',
      { class: 'detalhe-grade' },
      detail('Dias descobertos', `${m.uncoveredDays} (desde ${date(m.uncoveredStart)})`, true),
      detail('Dias em pausa', days(m.pausedDays)),
      m.registrationTime !== null ? detail('Tempo de cadastro', days(m.registrationTime)) : null,
      m.communicationTime !== null ? detail('Tempo de comunicação', days(m.communicationTime)) : null,
      m.confirmationTime !== null ? detail('Espera pelo cliente', days(m.confirmationTime)) : null,
      m.approvalWaitTime !== null ? detail('Espera pela aprovação do cliente', days(m.approvalWaitTime)) : null,
      detail('Tempo de preenchimento', m.fillTime === null ? '—' : `${days(m.fillTime)} (sem pausas)`),
      detail('Meta de SLA', m.slaTargetDays === null ? 'Sem meta' : `${days(m.slaTargetDays)} · ${label(LABELS.slaTargetSource, m.slaTargetSource)}`),
      detail('Prazo', date(m.slaDeadline)),
      ...(m.moneyStatus
        ? [
          detail('Valor diário', money(m.dailyValue)),
          detail('Faturamento perdido', moneyValue(m.lost, m.moneyStatus)),
          detail('Faturamento postergado', moneyValue(m.deferred, m.moneyStatus)),
          detail('Situação do valor', label(LABELS.moneyStatus, m.moneyStatus)
            + (['PENDING', 'REJECTED'].includes(m.moneyStatus) ? ' — fora dos totais' : '')),
        ]
        : []),
    ),
  );

  const timeline = panel('Linha do tempo', buildTimeline(p));

  const candidatePanel = buildCandidatePanel(p, reasons, reload);
  const firstDayPanel = buildFirstDayPanel(p);

  // A descrição é do pedido: todas as posições dele mostram o mesmo texto.
  const description = panel('Descrição da vaga', p.jobDescription
    ? el('div', { class: 'texto-livre' }, p.jobDescription)
    : el('p', { class: 'texto-fraco mb-0' }, 'Nenhuma descrição informada no pedido.'));

  const t = p.termination;
  const terminationPanel = t
    ? panel(
      'Desligamento que originou a reposição',
      el(
        'div',
        { class: 'detalhe-grade' },
        detail('Colaborador', el('a', { href: `#/posicoes/${t.originPositionId}` }, `${t.originEmployeeName} (matr. ${t.originEmployeeRegistration})`)),
        detail('Último dia trabalhado', date(t.lastWorkedDay)),
        detail('Tipo', label(LABELS.terminationType, t.terminationType)),
        detail('Origem da informação', label(LABELS.terminationSource, t.source)),
        t.notes ? detail('Observações', t.notes) : null,
      ),
    )
    : null;

  const exit = p.exitTermination;
  const exitPanel = exit
    ? panel(
      'Desligamento do colaborador',
      el(
        'div',
        { class: 'detalhe-grade' },
        detail('Último dia trabalhado', date(exit.lastWorkedDay)),
        detail('Tipo', label(LABELS.terminationType, exit.terminationType)),
        exit.replacementPositionId ? detail('Reposição', el('a', { href: `#/posicoes/${exit.replacementPositionId}` }, 'Abrir posição de reposição')) : null,
      ),
    )
    : null;

  const pauses = panelNoPadding(
    'Pausas',
    table(
      [
        { title: 'Motivo', field: 'reasonName' },
        { title: 'Início', cls: 'nowrap', render: (x) => date(x.startDate) },
        { title: 'Fim', cls: 'nowrap', render: (x) => (x.endDate ? date(x.endDate) : el('span', { class: 'etiqueta amarela' }, 'Em andamento')) },
        { title: 'Dias', cls: 'num', render: (x) => String(x.days) },
      ],
      p.pauses,
      { empty: 'Nenhuma pausa registrada.' },
    ),
  );

  const history = panelNoPadding(
    'Histórico',
    table(
      [
        { title: 'Quando', cls: 'nowrap', render: (h) => dateTime(h.timestamp) },
        { title: 'Usuário', render: (h) => h.userName ?? 'Sistema' },
        { title: 'Ação', render: (h) => AUDIT_ACTION[h.action] ?? h.action },
        {
          title: 'Alteração',
          render: (h) => (h.field
            ? `${FIELD_LABEL[h.field] ?? h.field}: ${auditValue(h.oldValue)} → ${auditValue(h.newValue)}`
            : el('span', { class: 'texto-fraco' }, 'Registro criado')),
        },
        { title: 'Justificativa', render: (h) => h.justification },
      ],
      p.history,
      { empty: 'Sem histórico.' },
    ),
  );

  return [
    header,
    el('div', { class: 'grade grade-2' }, data, metrics),
    candidatePanel,
    firstDayPanel,
    description,
    el('div', { class: 'grade grade-2' }, timeline, el('div', {}, terminationPanel, exitPanel, pauses)),
    history,
  ];
}

/** Candidato selecionado da posição; CPF e nascimento completos só para o RH do pedido, NACC e DP (LGPD). */
function buildCandidatePanel(p, reasons, reload) {
  const c = p.candidate;
  const canEdit = p.allowedActions.includes('CORRECT_CANDIDATE');
  if (!c && !p.previousCandidates.length && !canEdit) return null;
  const info = (x) => el('div', { class: 'detalhe-grade' },
    detail('Nome completo', x.fullName),
    detail('CPF', x.cpf),
    detail('Data de nascimento', x.restricted ? 'Restrito' : date(x.birthDate)),
    detail('Sexo', x.restricted ? 'Restrito' : label(LABELS.candidateSex, x.sex)),
    detail('Aprovado em', date(x.approvedAt)),
    detail('Cadastrado', `${x.recordedByName ? `${x.recordedByName} em ` : ''}${dateTime(x.recordedAt)}`),
    x.updatedAt && x.updatedByName ? detail('Última alteração', `${x.updatedByName} em ${dateTime(x.updatedAt)}`) : null,
    x.withdrawnAt ? detail('Saída', `${x.withdrawalReason} · ${dateTime(x.withdrawnAt)}`) : null);
  const body = el('div', {},
    c ? info(c) : el('p', { class: 'texto-fraco' }, 'Nenhum candidato selecionado no momento.'),
    c?.restricted
      ? el('p', { class: 'texto-fraco texto-pequeno mb-0' }, 'CPF, nascimento e sexo completos ficam restritos ao RH do pedido, ao NACC e ao DP.')
      : null,
    p.previousCandidates.length
      ? el('details', { class: 'mais-filtros' },
        el('summary', {}, `Candidatos anteriores (${p.previousCandidates.length})`),
        ...p.previousCandidates.map(info))
      : null);
  const action = canEdit
    ? button(c ? 'Corrigir dados' : 'Registrar candidato', () => openAction('CORRECT_CANDIDATE', p, reasons, reload),
      c ? 'secundario pequeno' : 'pequeno')
    : null;
  return panel('Candidato selecionado', body, action);
}

/** Confirmação do 1º dia: justificativa, quem confirmou e a evidência (download para RH do pedido, NACC, DP e Gestor). */
function buildFirstDayPanel(p) {
  const f = p.firstDay;
  if (!f) return null;
  const e = f.evidence;
  const size = (bytes) => (bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1).replace('.', ',')} MB` : `${Math.ceil(bytes / 1024)} KB`);
  return panel('Confirmação do 1º dia efetivo', el('div', { class: 'detalhe-grade' },
    detail('1º dia efetivo', date(f.date)),
    detail('Confirmado', f.confirmedAt ? `${f.confirmedByName ? `${f.confirmedByName} em ` : ''}${dateTime(f.confirmedAt)}` : '—'),
    detail('Justificativa', f.justification ?? '—'),
    detail('Evidência', e
      ? (e.canDownload
        ? el('a', { href: `/api/positions/${p.summary.id}/evidences/${e.id}`, download: e.fileName }, `${e.fileName} (${size(e.sizeBytes)})`)
        : el('span', { class: 'texto-fraco' }, `${e.fileName} · restrita ao RH do pedido, NACC, DP e Gestor`))
      : 'Nenhuma evidência anexada')));
}

/** Campos do candidato (aprovação e correção). */
function candidateFields(c) {
  return [
    field({ name: 'fullName', label: 'Nome completo', value: c?.fullName ?? '', required: true, attributes: { maxlength: '200' } }),
    el('div', { class: 'linha-campos' },
      field({ name: 'birthDate', label: 'Data de nascimento', type: 'date', value: c?.birthDate ?? '', required: true,
        attributes: { max: today() } }),
      field({ name: 'sex', label: 'Sexo', type: 'select', value: c?.sex ?? '', required: true,
        options: options(LABELS.candidateSex, 'Selecione') }),
      cpfField({ value: c?.cpf ?? '' })),
  ];
}

function candidateBody(d) {
  requireFields(d, { fullName: 'O nome completo', birthDate: 'A data de nascimento', sex: 'O sexo', cpf: 'O CPF' });
  if (d.birthDate > today()) throw validationError({ birthDate: 'A data de nascimento não pode ser uma data futura.' });
  if (!isValidCpf(d.cpf)) throw validationError({ cpf: 'CPF inválido: confira os dígitos.' });
  return { fullName: d.fullName, birthDate: d.birthDate, sex: d.sex, cpf: d.cpf };
}

function buildTimeline(p) {
  const t = p.termination;
  const items = t
    ? [
      ['Último dia do colaborador anterior', t.lastWorkedDay, t.originEmployeeName],
      ['Desligamento registrado', t.registeredAt],
      ['Decisão do cliente', t.clientDecisionAt, t.clientDecision ? LABELS.clientDecision[t.clientDecision] : 'Aguardando'],
    ]
    : [
      ['Solicitação do cliente', p.clientRequestDate],
      ['Registro do pedido', p.orderRegisteredAt],
      ['Aprovação do cliente', p.orderClientDecisionDate,
        p.summary.orderApprovalStatus === 'NOT_APPROVED' ? 'Cliente não aprovou' : null],
      ['Início desejado', p.desiredStartDate],
    ];
  items.push(
    ['Abertura da posição', p.summary.openedAt],
    ['Publicação no JobConvo (pedido)', p.jobconvoPublishedAt ?? (p.jobconvoPublished === false ? '' : null),
      p.jobconvoPublished === false ? `Sem publicação: ${p.jobconvoNotes}` : p.jobconvoCode],
    ['Candidato selecionado', p.candidateApprovedAt],
    ['Admissão', p.admissionAt, p.admissionRegistration ? `matrícula ${p.admissionRegistration}` : null],
    ['1º dia efetivo', p.firstDayAt, p.employeeName ? `${p.employeeName} (matr. ${p.employeeRegistration})` : null],
  );

  const list = el('ul', { class: 'linha-tempo' });
  for (const [text, when, note] of items) {
    const done = when !== null && when !== undefined;
    list.append(el('li', { class: done ? 'concluido' : 'pendente' },
      el('div', { class: 'quando' }, done && when ? date(when) : done ? 'informado' : 'pendente'),
      el('div', { class: 'quem' }, text),
      note ? el('div', { class: 'texto-suave texto-pequeno' }, note) : null));
  }
  if (p.closedAt) {
    list.append(el('li', { class: 'encerrado' },
      el('div', { class: 'quando' }, date(p.closedAt)),
      el('div', { class: 'quem' }, LABELS.positionStatus[p.summary.status]),
      p.cancellationReason ? el('div', { class: 'motivo' }, p.cancellationReason) : null));
  }
  return list;
}

// ---------------------------------------------------------------------
// Ações (seção 6)
// ---------------------------------------------------------------------

const justification = (required = false) =>
  field({
    name: 'justification',
    label: 'Justificativa',
    type: 'textarea',
    required,
    help: required ? null
      : state.user.initialLoadOpen ? 'Opcional durante a carga inicial.'
        : 'Obrigatória quando a data for anterior a hoje (RN-24).',
  });

const dateField = (name, text, value = today(), required = true) => field({ name, label: text, type: 'date', value, required });

const ACTIONS = {
  DECIDE: {
    title: 'Registrar decisão do cliente',
    path: 'decision',
    fields: () => [
      field({ name: 'decision', label: 'Decisão do cliente', type: 'select', required: true,
        options: [{ value: 'REPLACE', label: 'Repor o colaborador' }, { value: 'NOT_REPLACE', label: 'Não repor (encerra sem perda)' }] }),
      dateField('decisionAt', 'Data da decisão'),
      justification(),
    ],
    body: (d) => {
      requireFields(d, { decisionAt: 'A data da decisão' });
      return { decision: d.decision, decisionAt: d.decisionAt, justification: orNull(d.justification) };
    },
  },
  APPROVE_CANDIDATE: {
    title: 'Adicionar Candidato',
    path: 'candidate-approval',
    intro: 'Informe os dados do candidato selecionado para esta posição. Eles ficam na seção "Candidato selecionado".',
    fields: () => [dateField('date', 'Data da aprovação'), ...candidateFields(null), justification()],
    body: (d) => {
      requireFields(d, { date: 'A data' });
      return { date: d.date, ...candidateBody(d), justification: orNull(d.justification) };
    },
  },
  CORRECT_CANDIDATE: {
    title: (p) => (p.candidate ? 'Corrigir dados do candidato' : 'Registrar candidato'),
    path: 'candidate',
    method: 'put',
    intro: 'Os valores anteriores, quem alterou e quando ficam no histórico da posição.',
    fields: (p) => [...candidateFields(p.candidate),
      field({ name: 'justification', label: 'Motivo da correção (opcional)', type: 'textarea' })],
    body: (d) => ({ ...candidateBody(d), justification: orNull(d.justification) }),
  },
  REGISTER_ADMISSION: {
    title: 'Registrar admissão',
    path: 'admission',
    fields: () => [
      dateField('date', 'Data da admissão'),
      field({ name: 'registration', label: 'Matrícula (opcional)', attributes: { maxlength: '50' },
        help: 'Quando informada, já vem preenchida na confirmação do 1º dia.' }),
      justification(),
    ],
    body: (d) => {
      requireFields(d, { date: 'A data' });
      return { date: d.date, registration: orNull(d.registration), justification: orNull(d.justification) };
    },
  },
  CONFIRM_FIRST_DAY: {
    title: 'Confirmar 1º dia efetivo',
    path: 'first-day',
    intro: 'Nome e matrícula vêm do cadastro do candidato e da admissão e não podem ser alterados aqui. Confirme só depois '
      + 'de verificar que o profissional iniciou as atividades: a confirmação do comparecimento é do NACC.',
    fields: (p) => [
      ...missingFirstDayData(p).map((text) => el('div', { class: 'mensagem alerta' }, text)),
      dateField('date', '1º dia efetivo no posto'),
      field({ name: 'employeeName', label: 'Nome do colaborador', value: p.candidate?.fullName ?? '',
        attributes: { readonly: true, tabindex: '-1' }, help: 'Do cadastro do candidato. Correção: RH do pedido.' }),
      field({ name: 'employeeRegistration', label: 'Matrícula', value: p.admissionRegistration ?? '',
        attributes: { readonly: true, tabindex: '-1' }, help: 'Do registro da admissão. Correção: RH do pedido ou DP.' }),
      field({ name: 'justification', label: 'Justificativa', type: 'textarea', required: true,
        attributes: { maxlength: '2000' }, help: 'Como o comparecimento foi confirmado (ex.: e-mail do cliente, registro de presença).' }),
      field({ name: 'evidence', label: 'Anexar evidência (opcional)', type: 'file',
        attributes: { accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' },
        help: 'PDF, JPG ou PNG de até 10 MB: confirmação do cliente, registro de presença etc.' }),
    ],
    body: (d) => {
      if (!d.employeeName) throw validationError({ employeeName: 'A posição não tem candidato cadastrado: o RH do pedido deve registrá-lo antes.' });
      if (!d.employeeRegistration) throw validationError({ employeeRegistration: 'Matrícula não informada na admissão: o RH do pedido ou o DP deve informá-la antes.' });
      requireFields(d, { date: 'O 1º dia efetivo', justification: 'A justificativa' });
      // Nome e matrícula não são enviados: o servidor usa os dados da origem.
      const fields = { date: d.date, justification: d.justification };
      const file = d.evidence;
      if (!(typeof File !== 'undefined' && file instanceof File && file.size > 0)) return fields;
      if (file.size > 10 * 1024 * 1024) throw validationError({ evidence: 'A evidência deve ter no máximo 10 MB.' });
      if (!/\.(pdf|jpe?g|png)$/i.test(file.name)) throw validationError({ evidence: 'Anexe um arquivo PDF, JPG ou PNG.' });
      // Com arquivo, o envio vai em multipart/form-data com os mesmos nomes de campo.
      const form = new FormData();
      Object.entries(fields).forEach(([key, value]) => form.append(key, value));
      form.append('evidence', file, file.name);
      return form;
    },
  },
  CORRECT_REGISTRATION: {
    title: (p) => (p.admissionRegistration ? 'Corrigir matrícula' : 'Informar matrícula'),
    path: 'admission-registration',
    method: 'put',
    intro: 'A matrícula do registro de admissão é a usada na confirmação do 1º dia. O valor anterior fica no histórico.',
    fields: (p) => [
      field({ name: 'registration', label: 'Matrícula', value: p.admissionRegistration ?? '', required: true, attributes: { maxlength: '50' } }),
      field({ name: 'justification', label: 'Motivo (opcional)', type: 'textarea' }),
    ],
    body: (d) => {
      requireFields(d, { registration: 'A matrícula' });
      return { registration: d.registration, justification: orNull(d.justification) };
    },
  },
  CANDIDATE_WITHDREW: noteAction('Candidato desistiu', 'candidate-withdrawal',
    'A posição volta para "Em recrutamento" e a data de aprovação é limpa (o valor anterior fica no histórico).'),
  ADMISSION_NO_SHOW: noteAction('Admitido não compareceu', 'admission-no-show',
    'A posição volta para "Em recrutamento" e a data de admissão é limpa (o valor anterior fica no histórico).'),
  START_PAUSE: {
    title: 'Iniciar pausa',
    path: 'pause',
    fields: (_p, reasons) => [
      field({ name: 'reasonId', label: 'Motivo (responsabilidade do cliente)', type: 'select', required: true,
        options: [{ value: '', label: 'Selecione' }, ...reasons.filter((r) => r.active).map((r) => ({ value: r.id, label: r.name }))],
        help: reasons.some((r) => r.active) ? null : 'Nenhum motivo cadastrado. Peça ao administrador para cadastrar.' }),
      dateField('startDate', 'Início da pausa'),
      justification(),
    ],
    body: (d) => {
      requireFields(d, { reasonId: 'O motivo', startDate: 'O início da pausa' });
      return { reasonId: d.reasonId, startDate: d.startDate, justification: orNull(d.justification) };
    },
  },
  END_PAUSE: dateAction('Encerrar pausa', 'pause/end', 'Fim da pausa'),
  CANCEL: {
    title: 'Cancelar posição',
    path: 'cancellation',
    danger: true,
    intro: 'Encerra a posição como "Encerrada: cliente cancelou". Uma pausa ativa é encerrada na mesma data.',
    fields: () => [
      dateField('date', 'Data do cancelamento'),
      field({ name: 'reason', label: 'Motivo do cancelamento', type: 'textarea', required: true }),
    ],
    body: (d) => {
      requireFields(d, { date: 'A data', reason: 'O motivo' });
      return { date: d.date, reason: d.reason };
    },
  },
  ADJUST_TERM: {
    title: 'Ajustar vigência',
    path: 'term',
    fields: (p) => termFields(p.termType, p.termEndDate, p.termDurationDays).concat(justification(true)),
    body: (d) => {
      requireFields(d, { justification: 'A justificativa' });
      return {
        termType: d.termType,
        termEndDate: d.termType === 'FIXED_END' ? orNull(d.termEndDate) : null,
        termDurationDays: d.termType === 'PRESERVED_DURATION' ? intOrNull(d.termDurationDays) : null,
        justification: d.justification,
      };
    },
  },
  CORRECT_DATES: {
    title: 'Corrigir data',
    path: 'date-corrections',
    intro: 'Somente o autor do registro ou um administrador pode corrigir. O valor anterior fica no histórico (RN-25).',
    fields: (p) => [
      field({ name: 'target', label: 'Data a corrigir', type: 'select', required: true,
        options: [{ value: '', label: 'Selecione' }, ...correctableDates(p)] }),
      dateField('date', 'Data correta'),
      justification(true),
    ],
    body: (d) => {
      requireFields(d, { target: 'A data a corrigir', date: 'A data correta', justification: 'A justificativa' });
      const [fieldName, pauseId] = d.target.split(':');
      return { field: fieldName, pauseId: pauseId ?? null, date: d.date, justification: d.justification };
    },
  },
  REGISTER_TERMINATION: { title: 'Registrar desligamento' },
};

function dateAction(title, path, text) {
  return {
    title,
    path,
    fields: () => [dateField('date', text), justification()],
    body: (d) => {
      requireFields(d, { date: 'A data' });
      return { date: d.date, justification: orNull(d.justification) };
    },
  };
}

function noteAction(title, path, intro) {
  return {
    title,
    path,
    intro,
    fields: () => [field({ name: 'justification', label: 'Observação (opcional)', type: 'textarea' })],
    body: (d) => ({ justification: orNull(d.justification) }),
  };
}

/** Datas já registradas que podem ser corrigidas (RN-25). */
function correctableDates(p) {
  const t = p.termination;
  const items = [
    ['CANDIDATE_APPROVED_AT', 'Aprovação do candidato', p.candidateApprovedAt],
    ['ADMISSION_AT', 'Admissão', p.admissionAt],
    ['FIRST_DAY_AT', '1º dia efetivo', p.firstDayAt],
    ['CLOSED_AT', 'Data do cancelamento',
      p.summary.status === 'CLOSED_CLIENT_CANCELLED' && t?.clientDecision !== 'NOT_REPLACE' ? p.closedAt : null],
    ['CLIENT_DECISION_AT', 'Decisão do cliente', t?.clientDecisionAt],
    ['LAST_WORKED_DAY', 'Último dia trabalhado (origem)', t?.lastWorkedDay],
    ['TERMINATION_REGISTERED_AT', 'Registro do desligamento', t?.registeredAt],
    ...p.pauses.flatMap((pause, i) => [
      [`PAUSE_START:${pause.id}`, `Início da pausa ${i + 1}`, pause.startDate],
      [`PAUSE_END:${pause.id}`, `Fim da pausa ${i + 1}`, pause.endDate],
    ]),
  ];
  return items.filter(([, , current]) => current).map(([value, text, current]) => ({ value, label: `${text} (atual: ${date(current)})` }));
}

const actionTitle = (action, p) => (typeof ACTIONS[action].title === 'function' ? ACTIONS[action].title(p) : ACTIONS[action].title);

/** O que falta na origem para o NACC confirmar o 1º dia (nome do candidato e matrícula da admissão). */
function missingFirstDayData(p) {
  return [
    p.candidate ? null : 'A posição não tem candidato cadastrado: o RH do pedido deve registrá-lo em "Candidato selecionado".',
    p.admissionRegistration ? null : 'A matrícula não foi informada na admissão: o RH do pedido ou o DP deve informá-la ("Informar matrícula").',
  ].filter(Boolean);
}

function openAction(action, p, reasons, reload) {
  if (action === 'REGISTER_TERMINATION') {
    navigate(`/desligamentos/novo?positionId=${p.summary.id}`);
    return;
  }
  const config = ACTIONS[action];
  formModal({
    title: actionTitle(action, p),
    intro: config.intro ? el('div', { class: 'mensagem info' }, config.intro) : null,
    fields: config.fields(p, reasons),
    submitText: 'Confirmar',
    danger: config.danger,
    submit: async (data) => {
      const url = `/api/positions/${p.summary.id}/${config.path}`;
      const body = config.body(data);
      const updated = config.method === 'put' ? await api.put(url, body)
        : typeof FormData !== 'undefined' && body instanceof FormData ? await api.postForm(url, body)
          : await api.post(url, body);
      toast('Registro salvo.', 'sucesso');
      try {
        await reload(updated);
      } catch (error) {
        toast(errorMessage(error.message).textContent, 'erro');
      }
    },
  });
}

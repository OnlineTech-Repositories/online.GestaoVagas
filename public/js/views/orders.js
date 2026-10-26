import { api } from '../api.js';
import {
  el, clear, field, table, panel, panelNoPadding, loading, detail, date, label, LABELS, options, termFields, formData,
  applyErrors, requireFields, orNull, intOrNull, today, toast, button, formModal, positionColumns, positionRowClass,
  locationLabel, validationError, approvalTag, dateTime, rhTeam, rhFilterOptions, checkGroup, checkedValues,
  statusTag, cycleLabel, modal, errorMessage,
} from '../ui.js';
import { navigate, state, canCreateOrder } from '../app.js';

// ---------------------------------------------------------------------
// Lista de pedidos
// ---------------------------------------------------------------------

export async function ordersScreen(target, _params, query) {
  const filters = { clientId: '', status: '', approvalStatus: query?.get('aprovacao') ?? '', rh: query?.get('rh') ?? '' };
  const tableArea = el('div', {}, loading());

  async function reload() {
    clear(tableArea).append(loading());
    const orders = await api.get('/api/orders', filters);
    clear(tableArea).append(
      table(
        [
          { title: 'Pedido', field: 'number', cls: 'nowrap' },
          {
            title: 'Cliente / contrato',
            render: (o) => el('div', {}, el('div', {}, o.clientName), el('div', { class: 'texto-fraco texto-pequeno' }, o.contractName)),
          },
          {
            title: 'Cargo',
            render: (o) => el('div', {}, el('div', {}, o.jobRoleName),
              el('div', { class: 'texto-fraco texto-pequeno' }, `${LABELS.modalityShort[o.modality]} · ${o.workLocationName}`)),
          },
          { title: 'Qtd.', cls: 'num', render: (o) => String(o.currentQuantity ?? o.quantity) },
          {
            title: 'Preenchidas / vigentes',
            cls: 'num',
            render: (o) => el('div', {}, `${o.filledPositions} / ${o.currentQuantity ?? o.quantity}`,
              o.replacementCount ? el('div', { class: 'texto-fraco texto-pequeno' },
                `${o.replacementCount} reposição${o.replacementCount > 1 ? 'ões' : ''}`) : null),
          },
          { title: 'Solicitação → início', cls: 'nowrap', render: (o) => `${date(o.clientRequestDate)} → ${date(o.desiredStartDate)}` },
          { title: 'Analistas de RH', render: (o) => rhTeam(o.rhAnalystNames, o.awaitingRhAssignment) },
          { title: 'JobConvo', render: (o) => (o.jobconvoPublished === true ? o.jobconvoCode
            : o.jobconvoPublished === false ? el('span', { class: 'texto-fraco' }, 'Sem publicação') : '—') },
          { title: 'Aprovação', render: (o) => el('div', {}, approvalTag(o.approvalStatus),
            o.clientDecisionDate ? el('div', { class: 'texto-fraco texto-pequeno' }, date(o.clientDecisionDate)) : null) },
          { title: 'Status', render: (o) => label(LABELS.orderStatus, o.status) },
        ],
        orders,
        { onClick: (o) => navigate(`/pedidos/${o.id}`), empty: 'Nenhum pedido encontrado.' },
      ),
    );
  }

  const [clients, analysts] = await Promise.all([api.get('/api/clients'), api.get('/api/users/by-role/RH')]);
  const select = (name, text, items) => {
    const block = field({ name, label: text, type: 'select', options: items, value: filters[name] });
    block.querySelector('select').addEventListener('change', (e) => {
      filters[name] = e.target.value;
      reload();
    });
    return block;
  };

  clear(target).append(
    el(
      'section',
      { class: 'painel' },
      el(
        'div',
        { class: 'painel-cabecalho' },
        el('h2', {}, 'Pedidos'),
        canCreateOrder(state.user)
          ? el('div', { class: 'barra-botoes' }, button('+ Novo pedido', () => navigate('/pedidos/novo')))
          : null,
      ),
      el(
        'div',
        { class: 'filtros' },
        select('clientId', 'Cliente', [{ value: '', label: 'Todos' }, ...clients.map((c) => ({ value: c.id, label: c.legalName }))]),
        select('approvalStatus', 'Aprovação do cliente', options(LABELS.approvalStatus, 'Todas')),
        select('rh', 'Analistas de RH', rhFilterOptions(analysts, state.user)),
        select('status', 'Status', options(LABELS.orderStatus, 'Todos')),
      ),
      el('div', { class: 'painel-corpo sem-padding' }, tableArea),
    ),
  );

  await reload();
}

// ---------------------------------------------------------------------
// Novo pedido (RN-01 a RN-04)
// ---------------------------------------------------------------------

export async function newOrderScreen(target) {
  const [contracts, locations] = await Promise.all([
    api.get('/api/contracts', { onlyActive: true }),
    api.get('/api/catalogs/work-locations'),
  ]);

  const modalityArea = el('div', {});
  const jobRoleArea = el('div', {});
  const jobRoleNotice = el('div', {});
  let noJobRoles = false;
  let jobRolesRequest = 0;
  const locationArea = el('div', {});
  const preview = el('div', {});
  const messageArea = el('div', {});
  const justificationArea = el('div', { class: 'oculto' },
    field({ name: 'justification', label: 'Justificativa da data de registro retroativa', type: 'textarea', required: true }));

  const contractField = field({
    name: 'contractId',
    label: 'Contrato',
    type: 'select',
    required: true,
    options: [{ value: '', label: 'Selecione' }, ...contracts.map((c) => ({ value: c.id, label: `${c.clientName} — ${c.name}` }))],
    help: 'Somente contratos ativos.',
  });

  /** A modalidade e o local dependem do contrato escolhido (RN-01). */
  function syncContract() {
    const contract = contracts.find((c) => c.id === contractField.querySelector('select').value);
    const modalities = contract?.modalities ?? [];
    clear(modalityArea).append(field({
      name: 'modality',
      label: 'Modalidade',
      type: 'select',
      required: true,
      value: modalities.length === 1 ? modalities[0] : '',
      options: [{ value: '', label: contract ? 'Selecione' : 'Escolha o contrato' },
        ...modalities.map((m) => ({ value: m, label: LABELS.modality[m] }))],
    }));
    // Contrato com unidade contratante: o pedido usa essa unidade, sem escolha.
    const fixed = contract?.contractingUnitId ? locations.find((l) => l.id === contract.contractingUnitId) : null;
    const available = fixed
      ? [fixed]
      : locations.filter((l) => l.active && (!l.clientId || l.clientId === contract?.clientId));
    clear(locationArea).append(field({
      name: 'workLocationId',
      label: 'Local de trabalho / unidade',
      type: 'select',
      required: true,
      value: fixed?.id ?? '',
      options: [...(fixed ? [] : [{ value: '', label: 'Selecione' }]), ...available.map((l) => ({ value: l.id, label: locationLabel(l) }))],
      help: fixed ? 'Unidade contratante do contrato (fixa).' : contract?.clientId ? 'Unidades do cliente e locais gerais.' : null,
    }));
  }
  /** Cargo: desabilitado até escolher o contrato; depois, só os cargos com valor validado nesse contrato. */
  function renderJobRoles(roles, placeholder) {
    const disabled = !roles?.length;
    clear(jobRoleArea).append(field({
      name: 'jobRoleId',
      label: 'Cargo',
      type: 'select',
      required: true,
      disabled,
      options: [{ value: '', label: placeholder ?? 'Selecione' }, ...(roles ?? []).map((j) => ({ value: j.id, label: j.name }))],
      help: roles?.length ? 'Somente cargos com valor validado neste contrato (Valores por cargo).' : null,
    }));
  }

  function setNoJobRoles(value) {
    noJobRoles = value;
    clear(jobRoleNotice);
    if (value) {
      jobRoleNotice.append(el('div', { class: 'mensagem alerta' },
        el('strong', {}, 'Este contrato não tem cargos com valor validado.'),
        'Cadastre os valores em Valores por cargo e peça a validação da Controladoria antes de concluir o pedido.'));
    }
    const submit = form?.querySelector('button[type="submit"]');
    if (submit) submit.disabled = value;
  }

  async function loadJobRoles() {
    const contractId = contractField.querySelector('select').value;
    const request = ++jobRolesRequest;
    setNoJobRoles(false);
    if (!contractId) {
      renderJobRoles(null, 'Escolha o contrato');
      return;
    }
    renderJobRoles(null, 'Carregando cargos...');
    try {
      const roles = await api.get('/api/orders/job-roles', { contractId });
      if (request !== jobRolesRequest) return; // o contrato mudou enquanto carregava
      renderJobRoles(roles, roles.length ? 'Selecione' : 'Nenhum cargo disponível');
      setNoJobRoles(roles.length === 0);
    } catch (error) {
      if (request !== jobRolesRequest) return;
      renderJobRoles(null, 'Não foi possível carregar os cargos');
      clear(jobRoleNotice).append(el('div', { class: 'mensagem erro' }, error.message));
    }
  }

  // Trocar o contrato limpa o cargo escolhido e recarrega as opções.
  contractField.querySelector('select').addEventListener('change', () => {
    syncContract();
    loadJobRoles();
  });
  syncContract();
  let form;

  const registeredField = field({
    name: 'registeredAt',
    label: 'Data de registro',
    type: 'date',
    value: today(),
    required: true,
    help: state.user.initialLoadOpen
      ? 'Carga inicial aberta: informe a data original do pedido, se for o caso.'
      : 'Padrão: hoje. Data anterior exige justificativa (RN-24).',
  });

  form = el(
    'form',
    { novalidate: true },
    messageArea,
    contractField,
    el('div', { class: 'linha-campos' }, modalityArea,
      field({ name: 'quantity', label: 'Quantidade', type: 'number', value: '1', required: true, attributes: { min: '1', max: '1000' } })),
    jobRoleArea,
    jobRoleNotice,
    field({ name: 'jobDescription', label: 'Descrição da vaga', type: 'textarea',
      attributes: { maxlength: '4000', rows: '6' },
      help: 'Atividades, responsabilidades, requisitos e qualificações desejadas. Vale para todas as posições do pedido.' }),
    locationArea,
    el('div', { class: 'linha-campos' },
      field({ name: 'clientRequestDate', label: 'Data da solicitação do cliente', type: 'date', value: today(), required: true }),
      field({ name: 'desiredStartDate', label: 'Início desejado', type: 'date', value: today(), required: true })),
    el('div', { class: 'linha-campos' }, ...termFields()),
    field({ name: 'notes', label: 'Observações', type: 'textarea', attributes: { maxlength: '2000' } }),
    registeredField,
    justificationArea,
    el('div', { class: 'barra-botoes direita' },
      button('Cancelar', () => navigate('/pedidos'), 'secundario'),
      el('button', { class: 'btn', type: 'submit' }, 'Criar pedido')),
  );

  function updatePreview() {
    const data = formData(form);
    const quantity = Math.min(Math.max(Number(data.quantity) || 0, 0), 1000);
    const retroactive = !state.user.initialLoadOpen && data.registeredAt && data.registeredAt < today();
    justificationArea.classList.remove('oculto');
    if (!retroactive) justificationArea.classList.add('oculto');

    const items = [];
    for (let i = 1; i <= Math.min(quantity, 50); i++) {
      items.push(el('li', {}, `Posição ${i} · Vaga nova · início desejado ${date(data.desiredStartDate)} · ${label(LABELS.termType, data.termType)}`));
    }
    if (quantity > 50) items.push(el('li', { class: 'texto-fraco' }, `… e mais ${quantity - 50} posição(ões)`));
    clear(preview).append(
      el('div', { class: 'mensagem info' },
        el('strong', {}, 'O pedido nasce "Aguardando aprovação do cliente".'),
        'O Comercial ou a Controladoria registra a aprovação; o SLA das posições começa nessa data. Todos os usuários são notificados.'),
      el('p', { class: 'texto-suave' }, `${quantity} posição(ões) serão criadas com status "Aberta".`),
      el('ul', { class: 'lista-previa' }, items),
    );
  }
  form.addEventListener('input', updatePreview);
  form.addEventListener('change', updatePreview);
  updatePreview();
  await loadJobRoles();

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const submit = form.querySelector('button[type="submit"]');
    submit.disabled = true;
    clear(messageArea);
    const d = formData(form);
    try {
      if (noJobRoles) throw validationError({ jobRoleId: 'Este contrato não tem cargos com valor validado.' });
      requireFields(d, {
        contractId: 'O contrato', modality: 'A modalidade', quantity: 'A quantidade', jobRoleId: 'O cargo',
        workLocationId: 'O local', clientRequestDate: 'A data da solicitação', desiredStartDate: 'O início desejado',
        registeredAt: 'A data de registro',
      });
      const order = await api.post('/api/orders', {
        contractId: d.contractId,
        modality: d.modality,
        jobRoleId: d.jobRoleId,
        quantity: intOrNull(d.quantity),
        workLocationId: d.workLocationId,
        clientRequestDate: d.clientRequestDate,
        desiredStartDate: d.desiredStartDate,
        termType: d.termType,
        termEndDate: d.termType === 'FIXED_END' ? orNull(d.termEndDate) : null,
        termDurationDays: d.termType === 'PRESERVED_DURATION' ? intOrNull(d.termDurationDays) : null,
        notes: orNull(d.notes),
        jobDescription: orNull(d.jobDescription),
        registeredAt: d.registeredAt,
        justification: orNull(d.justification),
      });
      toast(`Pedido ${order.summary.number} criado com ${order.positions.length} posição(ões), aguardando a aprovação do cliente.`, 'sucesso');
      navigate(`/pedidos/${order.summary.id}`);
    } catch (error) {
      messageArea.append(applyErrors(form, error));
      submit.disabled = noJobRoles;
    }
  });

  clear(target).append(
    el('div', { class: 'grade grade-2' }, panel('Dados do pedido', form), panel('Prévia das posições', preview)),
  );
}

// ---------------------------------------------------------------------
// Detalhe do pedido
// ---------------------------------------------------------------------

export async function orderDetailScreen(target, id, query) {
  // Vindo do aviso de posições sem atualização: as paradas aparecem primeiro e destacadas.
  const highlightStale = query?.get('paradas') === '1';
  // Vindo de "Confirmações do 1º dia": a confirmação em lote já abre.
  const openBatch = query?.get('confirmar') === '1';
  // Vindo de "Admissões pendentes": a importação da planilha de admissões já abre.
  const openAdmissions = query?.get('admitir') === '1';
  let current = null;
  async function reload(data) {
    const o = data ?? (await api.get(`/api/orders/${id}`));
    current = o;
    const s = o.summary;

    const awaiting = s.approvalStatus === 'AWAITING_CLIENT_APPROVAL';
    const actions = [
      o.canDecideApproval && awaiting ? button('Registrar aprovação do cliente', () => openApprove(o, reload)) : null,
      o.canDecideApproval && awaiting ? button('Cliente não aprovou', () => openReject(o, reload), 'secundario') : null,
      o.canAddPositions ? button('Acrescentar posições', () => openAddPositions(o, reload)) : null,
      o.headcountReduction ? button('Reduzir posições', () => openReducePositions(o, reload), 'secundario') : null,
      o.canCorrectDates ? button('Corrigir datas', () => openCorrectDates(o, reload), 'secundario') : null,
    ];

    clear(target).append(
      panel(
        `Pedido ${s.number} · ${label(LABELS.orderStatus, s.status)}`,
        el(
          'div',
          {},
          el('div', { class: 'barra-botoes mb-16' }, approvalTag(s.approvalStatus),
            s.awaitingRhAssignment ? el('span', { class: 'etiqueta amarela' }, 'Aguardando atribuição do RH') : null),
          s.isLegacy ? el('div', { class: 'mensagem info' }, 'Pedido criado automaticamente por desligamento avulso (D1).') : null,
          awaiting
            ? el('div', { class: 'mensagem alerta' },
              el('strong', {}, 'Aguardando a aprovação do cliente.'),
              'O RH pode preparar as posições até "Em recrutamento"; adicionar candidato, registrar admissão e confirmar o 1º dia só depois da aprovação. '
              + 'O SLA começa na data da aprovação; os dias descobertos contam desde o início desejado.')
            : null,
          s.approvalStatus === 'NOT_APPROVED'
            ? el('div', { class: 'mensagem info' },
              el('strong', {}, 'O cliente não aprovou o pedido.'),
              `Todas as posições foram encerradas como "Encerrada: cliente cancelou", sem faturamento perdido. Motivo: ${o.notApprovedReason ?? '—'}`)
            : null,
          el(
            'div',
            { class: 'detalhe-grade' },
            detail('Cliente', s.clientName),
            detail('Contrato', s.contractName),
            o.contractingUnit ? detail('Unidade contratante', o.contractingUnit) : null,
            detail('Modalidade', label(LABELS.modality, s.modality)),
            detail('Cargo', s.jobRoleName),
            detail('Local', s.workLocationName),
            detail('Quantidade', quantityText(s)),
            detail('Situação das vagas', slotSummary(o)),
            detail('Solicitação do cliente', date(s.clientRequestDate)),
            detail('Registro', `${date(s.registeredAt)}${o.createdByName ? ` · por ${o.createdByName}` : ''}`),
            detail('Início desejado', date(s.desiredStartDate)),
            detail(s.approvalStatus === 'NOT_APPROVED' ? 'Recusa do cliente' : 'Aprovação do cliente',
              s.clientDecisionDate
                ? `${date(s.clientDecisionDate)}${o.approvalRecordedByName ? ` · registrada por ${o.approvalRecordedByName}` : ''}`
                  + (o.approvalRecordedAt ? ` em ${dateTime(o.approvalRecordedAt)}` : '')
                : 'Aguardando'),
            detail('Vigência', [label(LABELS.termType, o.termType), o.termEndDate ? ` até ${date(o.termEndDate)}` : '',
              o.termDurationDays ? ` · ${o.termDurationDays} dias` : ''].join('')),
            o.notes ? detail('Observações', o.notes) : null,
          ),
        ),
        actions.filter(Boolean).length ? actions : null,
      ),
      rhPanel(o, reload),
      jobconvoPanel(o, reload),
      o.candidateImport ? sheetImportPanel(o, reload, 'candidates') : null,
      o.admissionImport ? sheetImportPanel(o, reload, 'admissions') : null,
      o.firstDayBatch ? firstDayBatchPanel(o, reload) : null,
      panel('Descrição da vaga', o.jobDescription
        ? el('div', { class: 'texto-livre' }, o.jobDescription)
        : el('p', { class: 'texto-fraco mb-0' }, 'Nenhuma descrição informada.')),
      panelNoPadding('Posições', slotsTable(o, highlightStale)),
    );
  }

  clear(target).append(loading());
  await reload();
  if (openBatch && current.firstDayBatch?.items.length) openFirstDayBatch(current, reload);
  if (openAdmissions && current.admissionImport?.pending) openSheetImport(current, reload, SHEET_IMPORTS.admissions);
}

/** Quantidade vigente e a composição: solicitada no registro, acréscimos e reduções do quadro. */
function quantityText(s) {
  if (!s.addedQuantity && !s.reducedQuantity) return String(s.currentQuantity);
  const parts = [`${s.originalQuantity} no registro`];
  if (s.addedQuantity) parts.push(`+${s.addedQuantity} acrescentada(s)`);
  if (s.reducedQuantity) parts.push(`−${s.reducedQuantity} reduzida(s)`);
  return el('div', {}, el('div', {}, `${s.currentQuantity} vigentes`), el('div', { class: 'texto-fraco texto-pequeno' }, parts.join(' · ')));
}

/** Vigentes, preenchidas agora (ciclo atual), em reposição e reposições realizadas. */
function slotSummary(o) {
  const inReplacement = o.slots.filter((sl) => sl.current.demandType === 'REPLACEMENT'
    && !['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED', 'CLOSED_HEADCOUNT_REDUCED'].includes(sl.current.status)).length;
  const s = o.summary;
  return [`${s.currentQuantity} vigentes`, `${s.filledPositions} preenchidas agora`,
    inReplacement ? `${inReplacement} em reposição` : null,
    `${s.replacementCount} reposição(ões) realizada(s)`].filter(Boolean).join(' · ');
}

/**
 * Uma linha por vaga: o ciclo atual (colaborador ou candidato, status, reposição). Dias descobertos e valores somam
 * todos os ciclos da vaga; “Ver histórico de ocupantes” abre os ciclos anteriores logo abaixo da linha.
 */
function slotsTable(o, highlightStale = false) {
  const idle = new Map(highlightStale ? o.stale.positions.map((x) => [x.positionId, x.idleDays]) : []);
  const rows = o.slots.map((sl) => ({
    ...sl.current,
    uncoveredDays: sl.uncoveredDaysTotal,
    lost: sl.lostTotal ?? sl.current.lost,
    deferred: sl.deferredTotal ?? sl.current.deferred,
    slot: sl,
    idleDays: idle.get(sl.current.id) ?? null,
  }));
  // As paradas primeiro, das mais antigas para as mais recentes; as demais na ordem das vagas.
  if (idle.size) rows.sort((a, b) => (b.idleDays ?? -1) - (a.idleDays ?? -1));
  const columns = [
    ...(idle.size ? [{
      title: 'Sem atualização',
      cls: 'nowrap',
      render: (r) => (r.idleDays === null ? el('span', { class: 'texto-fraco' }, '—') : `${r.idleDays} dia${r.idleDays === 1 ? '' : 's'}`),
    }] : []),
    ...positionColumns({ money: state.user.canSeeDetailedValues, employee: true, client: false, rh: false }),
    {
      title: 'Ocupantes',
      render: (r) => (r.slot.occupants.length > 1
        ? button(`Ver histórico de ocupantes (${r.slot.occupants.length})`, (e) => toggleOccupants(e, r.slot, columns.length),
          'secundario pequeno')
        : el('span', { class: 'texto-fraco' }, '—')),
    },
  ];
  const n = o.stale.positions.length;
  const staleNotice = highlightStale ? el('div', { class: 'aviso-painel', role: 'status' }, n
    ? `${n} ${n === 1 ? 'posição está' : 'posições estão'} sem atualização há ${o.stale.days} dias ou mais: aparecem primeiro, destacadas. `
      + 'Se a etapa já aconteceu, registre-a na posição.'
    : 'Nenhuma posição deste pedido está sem atualização agora.') : null;
  return el('div', {},
    staleNotice,
    table(columns, rows, {
      onClick: (p) => navigate(`/posicoes/${p.id}`),
      rowClass: (r) => (r.idleDays !== null ? 'linha-alerta' : positionRowClass(r)),
      dense: true,
    }),
    el('div', { class: 'aviso-painel' }, 'Uma linha por vaga contratada. Dias descobertos e valores somam todos os ciclos da vaga (reposições incluídas).'));
}

function toggleOccupants(event, slot, span) {
  event.stopPropagation();
  const tr = event.target.closest('tr');
  if (tr.nextElementSibling?.classList.contains('linha-historico')) {
    tr.nextElementSibling.remove();
    return;
  }
  const cell = el('td', { colspan: String(span) }, occupantsTable(slot));
  tr.after(el('tr', { class: 'linha-historico' }, cell));
}

function occupantsTable(slot) {
  return table([
    { title: 'Ciclo', render: (x) => el('div', {}, cycleLabel(x.cycle),
      x.isCurrent ? el('div', { class: 'texto-fraco texto-pequeno' }, 'atual') : null) },
    { title: 'Ocupante', render: (x) => el('div', {}, `${x.name ?? '—'}${x.isCandidate ? ' (candidato)' : ''}`,
      x.registration ? el('div', { class: 'texto-fraco texto-pequeno' }, `matrícula ${x.registration}`) : null) },
    { title: 'Admissão', cls: 'nowrap', render: (x) => date(x.admissionAt) },
    { title: '1º dia efetivo', render: (x) => el('div', {}, date(x.firstDayAt),
      x.firstDayConfirmedByName ? el('div', { class: 'texto-fraco texto-pequeno' }, `confirmado por ${x.firstDayConfirmedByName}`) : null) },
    { title: 'Situação / desligamento', render: (x) => (x.leftAt
      ? el('div', {}, el('span', { class: 'etiqueta cinza' }, 'Desligado'), ` último dia ${date(x.leftAt)}`,
        el('div', { class: 'texto-fraco texto-pequeno' }, [label(LABELS.terminationType, x.exitType),
          x.exitRegisteredByName ? `registrado por ${x.exitRegisteredByName}` : null,
          x.exitRecordedAt ? `em ${dateTime(x.exitRecordedAt)}` : null].filter(Boolean).join(' · ')))
      : statusTag(x.status, x.notReplaced)) },
    { title: 'Substituído por', render: (x) => (x.replacedByPositionId ? (x.replacedByName ?? 'Reposição em andamento') : '—') },
  ], slot.occupants, { onClick: (x) => navigate(`/posicoes/${x.positionId}`), dense: true });
}

/** Analistas de RH responsáveis: o Gestor de RH distribui; as posições mostram a mesma equipe. */
function rhPanel(o, reload) {
  const s = o.summary;
  const body = el('div', {},
    o.rhAnalysts.length
      ? el('div', { class: 'barra-botoes' }, ...o.rhAnalysts.map((a) => el('span', { class: 'etiqueta azul' }, a.name)))
      : s.awaitingRhAssignment
        ? el('div', { class: 'mensagem alerta mb-0' },
          el('strong', {}, 'Aguardando atribuição do RH.'),
          'O Gestor de RH define os analistas responsáveis; até lá, só o Gestor de RH executa o recrutamento deste pedido.')
        : el('p', { class: 'texto-fraco mb-0' }, 'Nenhum analista responsável.'),
    o.rhAssignmentHistory.length
      ? el('details', { class: 'mais-filtros' },
        el('summary', {}, `Histórico de responsáveis (${o.rhAssignmentHistory.length})`),
        table([
          { title: 'Analista', render: (h) => h.userName },
          { title: 'Incluído', render: (h) => `${dateTime(h.assignedAt)}${h.assignedByName ? ` · por ${h.assignedByName}` : ''}` },
          { title: 'Removido', render: (h) => (h.removedAt
            ? `${dateTime(h.removedAt)}${h.removedByName ? ` · por ${h.removedByName}` : ''}` : 'Responsável atual') },
        ], o.rhAssignmentHistory, { dense: true }))
      : null);
  const action = o.canAssignRh
    ? button(o.rhAnalysts.length ? 'Alterar analistas' : 'Definir analistas', () => openRhAnalysts(o, reload),
      o.rhAnalysts.length ? 'secundario' : '')
    : null;
  return panel('Analistas de RH responsáveis', body, action);
}

async function openRhAnalysts(order, reload) {
  const analysts = await api.get('/api/users/by-role/RH');
  const current = order.rhAnalysts.map((a) => a.id);
  // Analista responsável que deixou de ser ativo continua listado até ser removido.
  const inactive = order.rhAnalysts.filter((a) => !analysts.some((x) => x.id === a.id));
  formModal({
    title: `Analistas de RH · pedido ${order.summary.number}`,
    intro: el('div', { class: 'mensagem info' },
      'Selecione um ou mais analistas de RH ativos. Quem entra ou sai da equipe recebe um aviso; as mudanças ficam no histórico.'),
    fields: [
      analysts.length || inactive.length
        ? checkGroup({ name: 'analystIds', label: 'Analistas de RH responsáveis', values: current,
          options: [...analysts.map((a) => ({ value: a.id, label: a.name })),
            ...inactive.map((a) => ({ value: a.id, label: `${a.name} (inativo)` }))] })
        : el('div', { class: 'mensagem alerta' }, 'Não há usuários ativos com o perfil Analista de RH.'),
    ],
    submitText: 'Salvar',
    submit: async (_d, form) => {
      const updated = await api.put(`/api/orders/${order.summary.id}/rh-analysts`, { analystIds: checkedValues(form, 'analystIds') });
      toast(updated.rhAnalysts.length ? 'Analistas de RH atualizados.' : 'Pedido aguardando atribuição do RH.', 'sucesso');
      await reload(updated);
    },
  });
}

/** RN-06 no pedido: uma publicação no JobConvo vale para todas as posições (inclusive as que entrarem depois). */
function jobconvoPanel(o, reload) {
  const j = o.jobconvo;
  const hasOpen = o.positions.some((p) => p.stageStatus === 'OPEN');
  const body = j
    ? el('div', {},
      el('div', { class: 'detalhe-grade' },
        detail('Publicado no JobConvo', j.published ? 'Sim' : 'Não'),
        j.published ? detail('Código da vaga', j.code) : null,
        j.published ? detail('Data da publicação', date(j.publishedAt)) : null,
        detail(j.published ? 'Observações' : 'Justificativa', j.notes ?? '—'),
        detail('Registrado por', `${j.recordedByName ?? '—'}${j.recordedAt ? ` em ${dateTime(j.recordedAt)}` : ''}`)),
      el('p', { class: 'texto-fraco texto-pequeno mb-0' },
        'Vale para todas as posições do pedido, inclusive as acrescentadas e as reposições confirmadas depois. '
        + 'Atualizações aparecem em todas elas; os valores anteriores ficam no histórico.'))
    : el('div', { class: `mensagem ${hasOpen ? 'alerta' : 'info'} mb-0` },
      el('strong', {}, 'Publicação ainda não informada.'),
      'As posições ficam "Aberta" até o RH informar a publicação no JobConvo (ou o recrutamento sem publicação, com justificativa).');
  const action = o.canRecordJobconvo
    ? button(j ? 'Atualizar publicação' : 'Informar publicação no JobConvo', () => openJobconvo(o, reload), j ? 'secundario' : '')
    : null;
  return panel('Publicação no JobConvo', body, action);
}

// ---------------------------------------------------------------------
// Candidatos em lote (planilha)
// ---------------------------------------------------------------------

/** Salva no computador um arquivo devolvido pela API (o DOM só se cria pelo ui.js). */
function saveFile({ name, blob }) {
  const url = URL.createObjectURL(blob);
  const link = el('a', { href: url, download: name, style: { display: 'none' } });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const situationList = (r, labels) => (r.errors.length
  ? el('ul', { class: 'lista-erros' }, ...r.errors.map((e) => el('li', {}, el('strong', {}, `${e.label}: `), e.message)))
  : el('div', {}, labels[r.status],
    r.warnings?.length ? el('ul', { class: 'lista-avisos-linha' }, ...r.warnings.map((w) => el('li', {}, w))) : null));

/**
 * Importações por planilha no pedido: o mesmo fluxo para candidatos e admissões — modelo com as posições pendentes,
 * conferência (erros por linha e avisos de data) e confirmação, que só grava sem nenhuma linha com erro.
 */
const SHEET_IMPORTS = {
  candidates: {
    panelTitle: 'Candidatos em lote',
    templatePath: 'candidates-template',
    importPath: 'candidates-import',
    downloadLabel: 'Baixar modelo de candidatos',
    importLabel: 'Importar candidatos',
    pendingText: (n) => `${n} posição(ões) em recrutamento aguardando candidato. Baixe o modelo (uma linha por posição pendente), `
      + 'preencha os candidatos selecionados e importe: o sistema mostra uma prévia com os erros antes de gravar.',
    emptyText: 'Nenhuma posição aguardando candidato: as posições "Em recrutamento" deste pedido já têm candidato selecionado.',
    modalTitle: 'Importar candidatos',
    intro: 'Selecione a planilha preenchida a partir do modelo deste pedido. A prévia confere cada linha com as mesmas regras do cadastro '
      + 'individual; a importação só é liberada quando todas as linhas preenchidas estiverem corretas.',
    readyText: (n) => `${n} candidato(s) prontos para importar.`,
    blankNote: 'as posições continuam aguardando candidato',
    columns: [
      { title: 'Linha', cls: 'num', field: 'line' },
      { title: 'Vaga', cls: 'nowrap', field: 'position' },
      { title: 'Nome', field: 'fullName' },
      { title: 'Telefone', cls: 'nowrap', render: (r) => r.phone || '—' },
      { title: 'Sexo', field: 'sexLabel' },
      { title: 'Aprovação', cls: 'nowrap', render: (r) => (r.approvedAt ? date(r.approvedAt) : '—') },
    ],
    emptyRows: 'A planilha não tem linhas de candidatos.',
    doneText: (r, order) => `${r.imported} candidato(s) cadastrado(s) no pedido ${order.summary.number}.`,
  },
  admissions: {
    panelTitle: 'Admissões em lote',
    templatePath: 'admissions-template',
    importPath: 'admissions-import',
    downloadLabel: 'Baixar modelo de admissões',
    importLabel: 'Importar admissões',
    pendingText: (n) => `${n} posição(ões) com candidato selecionado aguardando a admissão. Baixe o modelo (uma linha por posição), `
      + 'confira o telefone, preencha nascimento, CPF, data da admissão e matrícula e importe: o sistema mostra a conferência antes de gravar.',
    emptyText: 'Nenhuma posição aguardando admissão: não há posição "Candidato selecionado" neste pedido.',
    modalTitle: 'Importar admissões',
    intro: 'Selecione a planilha preenchida a partir do modelo de admissões deste pedido. A conferência aplica as mesmas regras do registro '
      + 'individual e mostra os avisos de data; a gravação só é liberada quando todas as linhas preenchidas estiverem corretas.',
    readyText: (n) => `${n} admissão(ões) prontas para registrar.`,
    blankNote: 'as posições continuam aguardando a admissão',
    columns: [
      { title: 'Linha', cls: 'num', field: 'line' },
      { title: 'Vaga', cls: 'nowrap', field: 'position' },
      { title: 'Candidato', field: 'candidate' },
      { title: 'Telefone', cls: 'nowrap', render: (r) => r.phone ?? '—' },
      { title: 'Nascimento', cls: 'nowrap', render: (r) => (r.birthDate ? date(r.birthDate) : '—') },
      { title: 'CPF', cls: 'nowrap', render: (r) => r.cpf ?? '—' },
      { title: 'Admissão', cls: 'nowrap', render: (r) => (r.admissionAt ? date(r.admissionAt) : '—') },
      { title: 'Matrícula', cls: 'nowrap', render: (r) => r.registration ?? '—' },
      { title: 'Justificativa', render: (r) => r.justification ?? '—' },
    ],
    emptyRows: 'A planilha não tem linhas de admissão.',
    doneText: (r, order) => `${r.imported} admissão(ões) registrada(s) no pedido ${order.summary.number}: `
      + `${r.awaitingFirstDay} aguardando o 1º dia${r.withoutRegistration ? `, ${r.withoutRegistration} sem matrícula` : ''}.`,
  },
};

/** Painel da importação no pedido: quantas posições aguardam, o modelo e o botão de importar. */
function sheetImportPanel(o, reload, kind) {
  const cfg = SHEET_IMPORTS[kind];
  const { pending } = kind === 'candidates' ? o.candidateImport : o.admissionImport;
  const download = button(cfg.downloadLabel, async () => {
    download.disabled = true;
    try {
      const file = await api.file(`/api/orders/${o.summary.id}/${cfg.templatePath}`);
      saveFile(file);
      toast(`Modelo gerado: ${file.name}`, 'sucesso');
    } catch (e) {
      toast(e.message, 'erro');
    } finally {
      download.disabled = false;
    }
  }, 'secundario');
  const importButton = button(cfg.importLabel, () => openSheetImport(o, reload, cfg));
  const body = pending
    ? el('p', { class: 'mb-0' }, cfg.pendingText(pending))
    : el('p', { class: 'texto-fraco mb-0' }, cfg.emptyText);
  return panel(cfg.panelTitle, body, pending ? [download, importButton] : null);
}

/** Conferência e confirmação da planilha: erros por linha, avisos de data e a gravação só sem erros. */
function openSheetImport(order, reload, cfg) {
  let file = null;
  const result = el('div');
  const input = el('input', {
    type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', name: 'file',
    onchange: (e) => {
      file = e.target.files?.[0] ?? null;
      confirmButton.disabled = true;
      clear(result);
      if (file) runPreview();
    },
  });
  const form = () => {
    const data = new FormData();
    data.append('file', file, file.name);
    return data;
  };

  async function runPreview() {
    clear(result).append(el('div', { class: 'vazio' }, el('div', { class: 'spinner', style: { margin: '0 auto' } })));
    try {
      const preview = await api.postForm(`/api/orders/${order.summary.id}/${cfg.importPath}/preview`, form());
      renderPreview(preview);
    } catch (e) {
      clear(result).append(errorMessage(e.message));
    }
  }

  function renderPreview(p) {
    const s = p.summary;
    const SITUATION = { ready: 'Pronto', blank: 'Em branco (ignorada)', error: 'Com erro' };
    clear(result).append(
      ...p.fileErrors.map((m) => errorMessage(m)),
      el('div', { class: `mensagem ${s.canConfirm ? 'sucesso' : s.errors || p.fileErrors.length ? 'erro' : 'alerta'}` },
        el('strong', {}, s.canConfirm
          ? cfg.readyText(s.ready)
          : s.errors ? `${s.errors} linha(s) com erro: corrija a planilha e selecione-a de novo. Nada será gravado até lá.`
            : p.fileErrors.length ? 'A planilha não pode ser importada.' : 'Nenhuma linha preenchida.'),
        `${s.total} linha(s) no arquivo · ${s.ready} pronta(s) · ${s.errors} com erro · ${s.blank} em branco (${cfg.blankNote}).`
        + (s.warnings ? ` ${s.warnings} linha(s) com aviso de data: confira; elas podem ser importadas.` : '')),
      table([...cfg.columns, { title: 'Situação', render: (r) => situationList(r, SITUATION) }], p.rows, {
        rowClass: (r) => (r.status === 'error' ? 'linha-erro' : r.status === 'blank' ? 'linha-apagada'
          : r.warnings?.length ? 'linha-alerta' : ''),
        empty: cfg.emptyRows,
        dense: true,
      }),
    );
    confirmButton.disabled = !s.canConfirm;
    confirmButton.textContent = s.canConfirm ? `Confirmar importação (${s.ready})` : 'Confirmar importação';
  }

  const confirmButton = button('Confirmar importação', async () => {
    confirmButton.disabled = true;
    try {
      const done = await api.postForm(`/api/orders/${order.summary.id}/${cfg.importPath}`, form());
      reference.close();
      toast(cfg.doneText(done, order), 'sucesso', 8000);
      await reload(done.order);
    } catch (e) {
      clear(result).append(errorMessage(e.message));
      toast(e.message, 'erro');
    }
  });
  confirmButton.disabled = true;

  const reference = modal({
    title: `${cfg.modalTitle} · pedido ${order.summary.number}`,
    wide: true,
    body: el('div', {},
      el('div', { class: 'mensagem info' }, cfg.intro),
      el('div', { class: 'campo' }, el('label', {}, 'Planilha (.xlsx)'), input),
      result),
    footer: [button('Cancelar', () => reference.close(), 'secundario'), confirmButton],
  });
}

// ---------------------------------------------------------------------
// 1º dia efetivo em lote (NACC)
// ---------------------------------------------------------------------

/** Painel do NACC no pedido: quantos admitidos aguardam o 1º dia e quantos ainda estão sem matrícula. */
function firstDayBatchPanel(o, reload) {
  const { items, withoutRegistration } = o.firstDayBatch;
  const note = withoutRegistration.length
    ? el('p', { class: 'texto-fraco texto-pequeno mb-0', style: { marginTop: '6px' } },
      `${withoutRegistration.length} admitido(s) sem matrícula (${withoutRegistration.map((w) => w.position).join(', ')}) `
      + 'ainda não podem ser confirmados: o RH do pedido ou o DP precisa informar a matrícula.')
    : null;
  const body = items.length
    ? el('div', {}, el('p', { class: 'mb-0' },
      `${items.length} admitido(s) aguardando a confirmação do 1º dia efetivo. Marque só quem comprovadamente começou: `
      + 'quem não for marcado continua pendente.'), note)
    : el('div', {}, el('p', { class: 'texto-fraco mb-0' }, 'Nenhum admitido aguardando a confirmação do 1º dia.'), note);
  return panel('1º dia efetivo em lote', body,
    items.length ? [button('Confirmar 1º dia efetivo em lote', () => openFirstDayBatch(o, reload))] : null);
}

/**
 * Duas etapas na mesma janela: (1) marcar quem compareceu e preencher data, justificativa e evidências, com "aplicar
 * às selecionadas"; (2) conferência com os avisos de data, e só então "Confirmar selecionados (N)".
 */
function openFirstDayBatch(order, reload) {
  const { items } = order.firstDayBatch;
  const sharedInput = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' });
  const bulkDate = el('input', { type: 'date', value: today(), 'aria-label': 'Data para as selecionadas' });
  const bulkJustification = el('input', { type: 'text', maxlength: '1000', placeholder: 'Ex.: cliente confirmou por e-mail',
    'aria-label': 'Justificativa para as selecionadas' });

  const rows = items.map((it) => {
    const check = el('input', { type: 'checkbox', 'aria-label': `Confirmar comparecimento de ${it.employeeName}` });
    const dateInput = el('input', { type: 'date', value: today(), 'aria-label': `1º dia de ${it.employeeName}` });
    const justification = el('input', { type: 'text', maxlength: '1000', placeholder: 'Justificativa',
      'aria-label': `Justificativa de ${it.employeeName}` });
    const shared = el('input', { type: 'checkbox', 'aria-label': `Usar a evidência compartilhada para ${it.employeeName}` });
    const own = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png',
      class: 'arquivo-linha', 'aria-label': `Evidência própria de ${it.employeeName}` });
    return { it, check, dateInput, justification, shared, own };
  });
  const selected = () => rows.filter((r) => r.check.checked);

  const counter = el('span', { class: 'texto-suave' });
  const reviewButton = button('Revisar selecionados', () => review());
  const syncCount = () => {
    const n = selected().length;
    counter.textContent = `${n} de ${rows.length} selecionado(s)`;
    reviewButton.disabled = n === 0;
    reviewButton.textContent = n ? `Revisar selecionados (${n})` : 'Revisar selecionados';
  };
  rows.forEach((r) => r.check.addEventListener('change', syncCount));

  const applyBulk = () => {
    const chosen = selected();
    if (!chosen.length) {
      toast('Marque primeiro os profissionais que compareceram.', 'alerta');
      return;
    }
    for (const r of chosen) {
      if (bulkDate.value) r.dateInput.value = bulkDate.value;
      if (bulkJustification.value.trim()) r.justification.value = bulkJustification.value.trim();
      if (sharedInput.files?.length) r.shared.checked = true;
    }
    toast(`Aplicado a ${chosen.length} posição(ões); ajuste linha a linha se precisar.`, 'sucesso');
  };

  const selectionStep = el('div', {},
    el('div', { class: 'mensagem info' },
      'Marque só os profissionais cujo comparecimento foi verificado. Os desmarcados continuam "Aguardando 1º dia" — a falta de marcação '
      + 'não registra "não compareceu", que é feito na própria posição.'),
    el('div', { class: 'lote-aplicar' },
      el('div', { class: 'campo' }, el('label', {}, '1º dia efetivo'), bulkDate),
      el('div', { class: 'campo cresce' }, el('label', {}, 'Justificativa'), bulkJustification),
      el('div', { class: 'campo' }, el('label', {}, 'Evidência compartilhada (opcional)'), sharedInput),
      el('div', { class: 'campo acoes-filtro' }, button('Aplicar às selecionadas', applyBulk, 'secundario'))),
    el('p', { class: 'texto-fraco texto-pequeno' },
      'A evidência compartilhada (PDF, JPG ou PNG até 10 MB) só é vinculada às linhas com "Compartilhada" marcada. Cada linha também aceita um arquivo próprio.'),
    table([
      { title: 'Confirmar comparecimento', cls: 'centro', render: (r) => r.check },
      { title: 'Vaga', cls: 'nowrap', render: (r) => r.it.position },
      { title: 'Colaborador', render: (r) => r.it.employeeName },
      { title: 'Matrícula', cls: 'nowrap', render: (r) => r.it.registration ?? '—' },
      { title: 'Admissão', cls: 'nowrap', render: (r) => date(r.it.admissionAt) },
      { title: '1º dia efetivo', render: (r) => r.dateInput },
      { title: 'Justificativa', render: (r) => r.justification },
      { title: 'Compartilhada', cls: 'centro', render: (r) => r.shared },
      { title: 'Evidência própria', render: (r) => r.own },
    ], rows, { dense: true }));

  const reviewStep = el('div', { class: 'oculto' });
  const confirmButton = button('Confirmar selecionados', () => save());
  const backButton = button('Voltar', () => showSelection(), 'secundario');
  const footerSelection = el('div', { class: 'barra-botoes' }, counter, button('Cancelar', () => reference.close(), 'secundario'), reviewButton);
  const footerReview = el('div', { class: 'barra-botoes oculto' }, backButton, confirmButton);

  const payload = () => selected().map((r) => ({
    positionId: r.it.positionId, date: r.dateInput.value, justification: r.justification.value.trim(),
    sharedEvidence: r.shared.checked, ownEvidence: Boolean(r.own.files?.length),
  }));

  function showSelection() {
    reviewStep.classList.add('oculto');
    footerReview.classList.add('oculto');
    selectionStep.classList.remove('oculto');
    footerSelection.classList.remove('oculto');
  }

  async function review() {
    const list = payload();
    if (list.some((i) => i.sharedEvidence) && !sharedInput.files?.length) {
      toast('Selecione o arquivo da evidência compartilhada ou desmarque "Compartilhada".', 'erro');
      return;
    }
    reviewButton.disabled = true;
    try {
      const preview = await api.post(`/api/orders/${order.summary.id}/first-day-batch/preview`, { items: list });
      renderReview(preview, list);
      selectionStep.classList.add('oculto');
      footerSelection.classList.add('oculto');
      reviewStep.classList.remove('oculto');
      footerReview.classList.remove('oculto');
    } catch (e) {
      toast(e.message, 'erro');
    } finally {
      reviewButton.disabled = false;
    }
  }

  function renderReview(p, list) {
    const s = p.summary;
    const evidence = (row) => {
      const parts = [];
      if (row.sharedEvidence) parts.push(`compartilhada (${sharedInput.files[0].name})`);
      const own = rows.find((r) => r.it.positionId === row.positionId)?.own.files?.[0];
      if (own) parts.push(own.name);
      return parts.join(' + ') || '—';
    };
    clear(reviewStep).append(
      el('div', { class: `mensagem ${s.canConfirm ? 'sucesso' : 'erro'}` },
        el('strong', {}, s.canConfirm
          ? `${s.ready} confirmação(ões) de 1º dia serão gravadas.`
          : `${s.errors} posição(ões) com erro: volte, corrija ou desmarque. Nada será gravado até lá.`),
        s.warnings ? `${s.warnings} posição(ões) com aviso de data: confira antes de confirmar.` : ''),
      table([
        { title: 'Vaga', cls: 'nowrap', field: 'position' },
        { title: 'Colaborador', field: 'employeeName' },
        { title: 'Matrícula', cls: 'nowrap', render: (r) => r.registration ?? '—' },
        { title: '1º dia efetivo', cls: 'nowrap', render: (r) => date(r.date) },
        { title: 'Justificativa', field: 'justification' },
        { title: 'Evidência', render: evidence },
        { title: 'Situação', render: (r) => situationList({ ...r, errors: r.errors.map((e) => ({ label: e.field === 'date' ? '1º dia' : e.field === 'justification' ? 'Justificativa' : 'Posição', message: e.message })) },
          { ready: 'Pronto', error: 'Com erro' }) },
      ], p.rows, {
        rowClass: (r) => (r.status === 'error' ? 'linha-erro' : r.warnings.length ? 'linha-alerta' : ''),
        dense: true,
      }));
    confirmButton.disabled = !s.canConfirm;
    confirmButton.textContent = s.canConfirm ? `Confirmar selecionados (${s.ready})` : 'Confirmar selecionados';
    confirmButton.dataset.items = JSON.stringify(list);
  }

  async function save() {
    const list = JSON.parse(confirmButton.dataset.items);
    const form = new FormData();
    form.append('items', JSON.stringify(list));
    if (list.some((i) => i.sharedEvidence)) form.append('shared', sharedInput.files[0], sharedInput.files[0].name);
    for (const i of list.filter((x) => x.ownEvidence)) {
      const file = rows.find((r) => r.it.positionId === i.positionId).own.files[0];
      form.append(`evidence_${i.positionId}`, file, file.name);
    }
    confirmButton.disabled = true;
    try {
      const done = await api.postForm(`/api/orders/${order.summary.id}/first-day-batch`, form);
      reference.close();
      toast(done.message, 'sucesso', 9000);
      await reload(done.order);
    } catch (e) {
      clear(reviewStep).prepend(errorMessage(e.message));
      toast(e.message, 'erro');
      confirmButton.disabled = false;
    }
  }

  syncCount();
  const reference = modal({
    title: `Confirmar 1º dia efetivo em lote · pedido ${order.summary.number}`,
    wide: true,
    body: el('div', {}, selectionStep, reviewStep),
    footer: [footerSelection, footerReview],
  });
  // A tabela tem campos por linha (data, justificativa, evidências): a janela usa a largura da tela.
  reference.box.classList.add('extra-largo');
}

// ---------------------------------------------------------------------
// Redução do quadro (ADMIN)
// ---------------------------------------------------------------------

/**
 * Reduz o quadro a pedido do cliente: escolhe as posições (só as sem candidato, admissão ou colaborador), informa a
 * data efetiva, a justificativa e a evidência; revisa o resumo e confirma.
 */
function openReducePositions(order, reload) {
  const s = order.summary;
  const { eligible } = order.headcountReduction;
  const statusText = (it) => `${LABELS.positionStatus[it.status]}${it.status === 'PAUSED' ? ` (${LABELS.positionStatus[it.stageStatus]})` : ''}`;
  const rows = eligible.map((it) => ({ it, check: el('input', { type: 'checkbox', 'aria-label': `Retirar a posição ${it.position}` }) }));
  const amount = el('input', { type: 'number', min: '0', max: String(eligible.length), value: '0', 'aria-label': 'Quantidade a reduzir' });
  const newQuantity = el('strong', {}, String(s.currentQuantity));
  const dateInput = el('input', { type: 'date', value: today(), 'aria-label': 'Data efetiva da redução' });
  const justification = el('textarea', { rows: '3', maxlength: '1000', 'aria-label': 'Justificativa da redução',
    placeholder: 'Ex.: cliente reduziu o quadro por e-mail em 21/10' });
  const evidence = el('input', { type: 'file', accept: '.pdf,.jpg,.jpeg,.png,application/pdf,image/jpeg,image/png' });
  const selected = () => rows.filter((r) => r.check.checked);

  const reviewButton = button('Revisar redução', () => review());
  const sync = () => {
    const n = selected().length;
    amount.value = String(n);
    newQuantity.textContent = String(s.currentQuantity - n);
    reviewButton.disabled = n === 0;
  };
  rows.forEach((r) => r.check.addEventListener('change', sync));
  // Digitar a quantidade marca as primeiras posições da lista; dá para trocar a seleção depois.
  amount.addEventListener('input', () => {
    const n = Math.max(0, Math.min(eligible.length, Number(amount.value) || 0));
    rows.forEach((r, i) => { r.check.checked = i < n; });
    sync();
  });

  const formStep = el('div', {},
    el('div', { class: 'mensagem info' },
      'Só entram posições sem candidato selecionado, admissão ou colaborador. As demais passam antes pela desistência, pelo não '
      + 'comparecimento ou pelo desligamento. As retiradas ficam no histórico como "Cancelada por redução do quadro".'),
    el('div', { class: 'detalhe-grade' },
      el('div', { class: 'detalhe-item' }, el('div', { class: 'rotulo' }, 'Quantidade atual'), el('div', { class: 'valor' }, String(s.currentQuantity))),
      el('div', { class: 'campo' }, el('label', {}, 'Posições a reduzir', el('span', { class: 'obrigatorio' }, '*')), amount),
      el('div', { class: 'detalhe-item' }, el('div', { class: 'rotulo' }, 'Nova quantidade'), el('div', { class: 'valor' }, newQuantity)),
      el('div', { class: 'campo' }, el('label', {}, 'Data efetiva da redução', el('span', { class: 'obrigatorio' }, '*')), dateInput)),
    eligible.length
      ? table([
        { title: 'Retirar', cls: 'centro', render: (r) => r.check },
        { title: 'Vaga', cls: 'nowrap', render: (r) => `${r.it.position}${r.it.cycle > 1 ? ` (reposição nº ${r.it.cycle - 1})` : ''}` },
        { title: 'Tipo', render: (r) => LABELS.demandType[r.it.demandType] },
        { title: 'Situação', render: (r) => statusTextEl(statusText(r.it)) },
      ], rows, { dense: true })
      : el('p', { class: 'texto-fraco' }, 'Nenhuma posição pode sair do quadro agora.'),
    el('div', { class: 'campo', style: { marginTop: '12px' } },
      el('label', {}, 'Justificativa (solicitação do cliente)', el('span', { class: 'obrigatorio' }, '*')), justification),
    el('div', { class: 'campo' }, el('label', {}, 'Evidência (opcional)'), evidence,
      el('div', { class: 'ajuda' }, 'PDF, JPG ou PNG até 10 MB: o documento ou a comunicação do cliente. Fica vinculada a cada posição retirada.')));

  const summaryStep = el('div', { class: 'oculto' });
  const confirmButton = button('Confirmar redução', () => save(), 'perigo');
  const footerForm = el('div', { class: 'barra-botoes' }, button('Cancelar', () => reference.close(), 'secundario'), reviewButton);
  const footerSummary = el('div', { class: 'barra-botoes oculto' }, button('Voltar', () => toggle(false), 'secundario'), confirmButton);
  const toggle = (summary) => {
    formStep.classList.toggle('oculto', summary);
    footerForm.classList.toggle('oculto', summary);
    summaryStep.classList.toggle('oculto', !summary);
    footerSummary.classList.toggle('oculto', !summary);
  };

  function review() {
    const chosen = selected();
    if (!justification.value.trim()) {
      toast('Informe a justificativa da redução.', 'erro');
      return;
    }
    if (!dateInput.value) {
      toast('Informe a data efetiva da redução.', 'erro');
      return;
    }
    clear(summaryStep).append(
      el('div', { class: 'mensagem alerta' },
        el('strong', {}, `O pedido ${s.number} passa de ${s.currentQuantity} para ${s.currentQuantity - chosen.length} posições vigentes.`),
        `${chosen.length} posição(ões) serão encerradas como "Cancelada por redução do quadro" em ${date(dateInput.value)}. `
        + 'Os dias descobertos até essa data contam no faturamento perdido, como no cancelamento.'),
      table([
        { title: 'Vaga', cls: 'nowrap', render: (r) => r.it.position },
        { title: 'Tipo', render: (r) => LABELS.demandType[r.it.demandType] },
        { title: 'Situação atual', render: (r) => statusText(r.it) },
        { title: 'Nova situação', render: () => 'Cancelada por redução do quadro' },
      ], chosen, { dense: true }),
      el('p', { class: 'texto-suave', style: { marginTop: '10px' } }, el('strong', {}, 'Justificativa: '), justification.value.trim()),
      el('p', { class: 'texto-suave' }, el('strong', {}, 'Evidência: '), evidence.files?.[0]?.name ?? 'nenhuma'));
    confirmButton.textContent = `Confirmar redução (${chosen.length})`;
    toggle(true);
  }

  async function save() {
    const chosen = selected();
    const body = new FormData();
    body.append('positionIds', JSON.stringify(chosen.map((r) => r.it.positionId)));
    body.append('date', dateInput.value);
    body.append('justification', justification.value.trim());
    if (evidence.files?.length) body.append('evidence', evidence.files[0], evidence.files[0].name);
    confirmButton.disabled = true;
    try {
      const updated = await api.postForm(`/api/orders/${s.id}/position-reductions`, body);
      reference.close();
      toast(`Quadro reduzido: o pedido ${s.number} tem agora ${updated.summary.currentQuantity} posições vigentes.`, 'sucesso', 8000);
      await reload(updated);
    } catch (e) {
      clear(summaryStep).prepend(errorMessage(e.message));
      toast(e.message, 'erro');
      confirmButton.disabled = false;
    }
  }

  sync();
  const reference = modal({
    title: `Reduzir posições · pedido ${s.number}`,
    wide: true,
    body: el('div', {}, formStep, summaryStep),
    footer: [footerForm, footerSummary],
  });
}

const statusTextEl = (text) => el('span', { class: 'texto-suave' }, text);

function openJobconvo(order, reload) {
  const j = order.jobconvo;
  const publishedField = field({ name: 'published', label: 'Publicado no JobConvo', type: 'select', required: true,
    value: j && !j.published ? 'false' : 'true',
    options: [{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não' }] });
  const publicationArea = el('div', { class: 'linha-campos' },
    field({ name: 'code', label: 'Código da vaga no JobConvo', value: j?.code ?? '', required: true, attributes: { maxlength: '100' } }),
    field({ name: 'publishedAt', label: 'Data da publicação', type: 'date', value: j?.publishedAt ?? today(), required: true }));
  const notesField = field({ name: 'justification', label: 'Justificativa / observações', type: 'textarea', value: j?.notes ?? '',
    attributes: { maxlength: '2000' },
    help: 'Obrigatória quando não houver publicação ou quando a data for anterior a hoje.' });
  const sync = () => publicationArea.classList.toggle('oculto', publishedField.querySelector('select').value !== 'true');
  publishedField.querySelector('select').addEventListener('change', sync);
  sync();

  formModal({
    title: `Publicação no JobConvo · pedido ${order.summary.number}`,
    intro: el('div', { class: 'mensagem info' },
      'Uma publicação atende todas as posições do pedido: as abertas passam para "Em recrutamento" e as que entrarem depois herdam.'),
    fields: [publishedField, publicationArea, notesField],
    submitText: j ? 'Atualizar' : 'Registrar',
    submit: async (d) => {
      const published = d.published === 'true';
      if (published) requireFields(d, { code: 'O código da vaga', publishedAt: 'A data da publicação' });
      else requireFields(d, { justification: 'A justificativa' });
      const updated = await api.post(`/api/orders/${order.summary.id}/jobconvo`, {
        published,
        code: published ? d.code : null,
        publishedAt: published ? d.publishedAt : null,
        justification: orNull(d.justification),
      });
      toast('Publicação no JobConvo registrada no pedido.', 'sucesso');
      await reload(updated);
    },
  });
}

function openAddPositions(order, reload) {
  formModal({
    title: 'Acrescentar posições',
    intro: el('div', { class: 'mensagem info' }, 'Para reduzir a quantidade, cancele posições individualmente (RN-05).'),
    fields: [
      field({ name: 'quantity', label: 'Novas posições', type: 'number', value: '1', required: true, attributes: { min: '1' } }),
      field({ name: 'desiredStartDate', label: 'Início desejado das novas posições', type: 'date', value: today(), required: true }),
      field({ name: 'justification', label: 'Observação (opcional)', type: 'textarea' }),
    ],
    submitText: 'Acrescentar',
    submit: async (d) => {
      requireFields(d, { quantity: 'A quantidade', desiredStartDate: 'O início desejado' });
      const updated = await api.post(`/api/orders/${order.summary.id}/positions`, {
        quantity: intOrNull(d.quantity),
        desiredStartDate: d.desiredStartDate,
        justification: orNull(d.justification),
      });
      toast('Posições acrescentadas.', 'sucesso');
      await reload(updated);
    },
  });
}

function openCorrectDates(order, reload) {
  formModal({
    title: 'Corrigir datas do pedido',
    intro: el('div', { class: 'mensagem info' }, 'O valor anterior fica registrado no histórico (RN-25).'),
    fields: [
      field({ name: 'field', label: 'Data', type: 'select', required: true, options: [
        { value: 'CLIENT_REQUEST_DATE', label: `Solicitação do cliente (atual: ${date(order.summary.clientRequestDate)})` },
        { value: 'DESIRED_START_DATE', label: `Início desejado (atual: ${date(order.summary.desiredStartDate)})` },
        { value: 'REGISTERED_AT', label: `Registro do pedido (atual: ${date(order.summary.registeredAt)})` },
        ...(order.summary.approvalStatus === 'APPROVED' && order.summary.clientDecisionDate
          ? [{ value: 'APPROVAL_DATE', label: `Aprovação do cliente (atual: ${date(order.summary.clientDecisionDate)})` }]
          : []),
      ] }),
      field({ name: 'date', label: 'Data correta', type: 'date', value: today(), required: true }),
      field({ name: 'justification', label: 'Justificativa', type: 'textarea', required: true }),
    ],
    submitText: 'Corrigir',
    submit: async (d) => {
      requireFields(d, { date: 'A data', justification: 'A justificativa' });
      const updated = await api.post(`/api/orders/${order.summary.id}/date-corrections`, d);
      toast('Data corrigida.', 'sucesso');
      await reload(updated);
    },
  });
}

function openApprove(order, reload) {
  const s = order.summary;
  formModal({
    title: `Aprovação do cliente · pedido ${s.number}`,
    intro: el('div', { class: 'mensagem info' },
      'O pedido passa para "Aprovado" e as posições abertas ganham a data de abertura e a meta de SLA a partir da data informada. '
      + 'Todos os usuários são notificados.'),
    fields: [
      field({ name: 'date', label: 'Data da aprovação pelo cliente', type: 'date', value: today(), required: true,
        help: `Entre ${date(s.clientRequestDate)} (solicitação) e hoje. Data anterior a hoje exige justificativa (RN-24).` }),
      field({ name: 'justification', label: 'Justificativa (se a data for anterior a hoje)', type: 'textarea' }),
    ],
    submitText: 'Registrar aprovação',
    submit: async (d) => {
      requireFields(d, { date: 'A data da aprovação' });
      const updated = await api.post(`/api/orders/${s.id}/approval`, { date: d.date, justification: orNull(d.justification) });
      toast(`Pedido ${s.number} aprovado.`, 'sucesso');
      await reload(updated);
    },
  });
}

function openReject(order, reload) {
  const s = order.summary;
  formModal({
    title: `Cliente não aprovou · pedido ${s.number}`,
    intro: el('div', { class: 'mensagem alerta' },
      el('strong', {}, 'Esta ação não pode ser desfeita.'),
      'Todas as posições abertas do pedido serão encerradas como "Encerrada: cliente cancelou", sem faturamento perdido. '
      + 'Todos os usuários são notificados.'),
    fields: [
      field({ name: 'date', label: 'Data da recusa pelo cliente', type: 'date', value: today(), required: true }),
      field({ name: 'reason', label: 'Motivo', type: 'textarea', required: true, attributes: { maxlength: '1000' } }),
    ],
    submitText: 'Confirmar recusa',
    submit: async (d) => {
      requireFields(d, { date: 'A data', reason: 'O motivo' });
      const updated = await api.post(`/api/orders/${s.id}/rejection`, { date: d.date, reason: d.reason });
      toast(`Pedido ${s.number} registrado como não aprovado.`, 'sucesso');
      await reload(updated);
    },
  });
}

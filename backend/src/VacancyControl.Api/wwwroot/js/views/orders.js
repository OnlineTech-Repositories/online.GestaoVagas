import { api } from '../api.js';
import {
  el, clear, field, table, panel, panelNoPadding, loading, detail, date, label, LABELS, options, termFields, formData,
  applyErrors, requireFields, orNull, intOrNull, today, toast, button, formModal, positionColumns, positionRowClass,
  locationLabel, validationError, approvalTag, dateTime, rhTeam, rhFilterOptions, checkGroup, checkedValues,
  statusTag, cycleLabel,
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
          { title: 'Qtd.', cls: 'num', render: (o) => String(o.quantity) },
          {
            title: 'Preenchidas / contratadas',
            cls: 'num',
            render: (o) => el('div', {}, `${o.filledPositions} / ${o.quantity}`,
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

export async function orderDetailScreen(target, id) {
  async function reload(data) {
    const o = data ?? (await api.get(`/api/orders/${id}`));
    const s = o.summary;

    const awaiting = s.approvalStatus === 'AWAITING_CLIENT_APPROVAL';
    const actions = [
      o.canDecideApproval && awaiting ? button('Registrar aprovação do cliente', () => openApprove(o, reload)) : null,
      o.canDecideApproval && awaiting ? button('Cliente não aprovou', () => openReject(o, reload), 'secundario') : null,
      o.canAddPositions ? button('Acrescentar posições', () => openAddPositions(o, reload)) : null,
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
            detail('Quantidade', String(s.quantity)),
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
      panel('Descrição da vaga', o.jobDescription
        ? el('div', { class: 'texto-livre' }, o.jobDescription)
        : el('p', { class: 'texto-fraco mb-0' }, 'Nenhuma descrição informada.')),
      panelNoPadding('Posições', slotsTable(o)),
    );
  }

  clear(target).append(loading());
  await reload();
}

/** Contratadas, preenchidas agora (ciclo atual), em reposição e reposições realizadas. */
function slotSummary(o) {
  const inReplacement = o.slots.filter((sl) => sl.current.demandType === 'REPLACEMENT'
    && !['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED'].includes(sl.current.status)).length;
  const s = o.summary;
  return [`${s.quantity} contratadas`, `${s.filledPositions} preenchidas agora`,
    inReplacement ? `${inReplacement} em reposição` : null,
    `${s.replacementCount} reposição(ões) realizada(s)`].filter(Boolean).join(' · ');
}

/**
 * Uma linha por vaga: o ciclo atual (colaborador ou candidato, status, reposição). Dias descobertos e valores somam
 * todos os ciclos da vaga; “Ver histórico de ocupantes” abre os ciclos anteriores logo abaixo da linha.
 */
function slotsTable(o) {
  const rows = o.slots.map((sl) => ({
    ...sl.current,
    uncoveredDays: sl.uncoveredDaysTotal,
    lost: sl.lostTotal ?? sl.current.lost,
    deferred: sl.deferredTotal ?? sl.current.deferred,
    slot: sl,
  }));
  const columns = [
    ...positionColumns({ money: state.user.canSeeDetailedValues, employee: true, client: false, rh: false }),
    {
      title: 'Ocupantes',
      render: (r) => (r.slot.occupants.length > 1
        ? button(`Ver histórico de ocupantes (${r.slot.occupants.length})`, (e) => toggleOccupants(e, r.slot, columns.length),
          'secundario pequeno')
        : el('span', { class: 'texto-fraco' }, '—')),
    },
  ];
  return el('div', {},
    table(columns, rows, { onClick: (p) => navigate(`/posicoes/${p.id}`), rowClass: positionRowClass, dense: true }),
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

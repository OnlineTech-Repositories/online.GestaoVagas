import { api } from '../api.js';
import {
  el, clear, field, table, panel, panelNoPadding, loading, date, LABELS, options, termFields, formData, applyErrors,
  requireFields, orNull, intOrNull, today, toast, button, debounce, infoMessage, errorMessage, locationLabel,
} from '../ui.js';
import { navigate, state, hasRole } from '../app.js';

/**
 * Registrar desligamento (DP, NACC). Dois modos: colaborador já cadastrado (busca por nome ou matrícula
 * entre as posições preenchidas) ou desligamento avulso (D1), quando a posição de origem não existe no sistema.
 */
export async function terminationScreen(target, _params, query) {
  let mode = 'existing';
  let selected = null;
  const preselect = query?.get('positionId');

  const [contracts, jobRoles, locations] = await Promise.all([
    api.get('/api/contracts', { onlyActive: true }),
    api.get('/api/catalogs/job-roles'),
    api.get('/api/catalogs/work-locations'),
  ]);

  const modeBar = el('div', { class: 'barra-botoes mb-16' });
  const body = el('div', {});

  function renderModeBar() {
    clear(modeBar).append(
      el('button', { class: `btn ${mode === 'existing' ? '' : 'secundario'}`, type: 'button', onclick: () => switchMode('existing') },
        'Colaborador cadastrado'),
      el('button', { class: `btn ${mode === 'legacy' ? '' : 'secundario'}`, type: 'button', onclick: () => switchMode('legacy') },
        'Desligamento avulso'),
    );
  }

  function switchMode(next) {
    mode = next;
    renderModeBar();
    clear(body).append(mode === 'existing' ? existingMode() : legacyMode());
  }

  // ------------------------------------------------------------ campos comuns do desligamento
  const commonFields = () => [
    el('div', { class: 'linha-campos' },
      field({ name: 'lastWorkedDay', label: 'Último dia trabalhado', type: 'date', value: today(), required: true,
        help: 'Pode ser uma data futura (RN-13).' }),
      field({ name: 'terminationType', label: 'Tipo de desligamento', type: 'select', required: true,
        options: options(LABELS.terminationType) })),
    el('div', { class: 'linha-campos' },
      field({ name: 'source', label: 'Origem da informação', type: 'select', required: true,
        value: hasRole(state.user, 'DP') ? 'DP' : 'NACC', options: options(LABELS.terminationSource) }),
      field({ name: 'registeredAt', label: 'Data de registro', type: 'date', value: today(), required: true })),
    field({ name: 'justification', label: 'Justificativa', type: 'textarea',
      help: state.user.initialLoadOpen ? 'Opcional durante a carga inicial.' : 'Obrigatória se a data de registro for anterior a hoje (RN-24).' }),
    field({ name: 'notes', label: 'Observações', type: 'textarea', attributes: { maxlength: '2000' } }),
  ];

  const commonBody = (d) => ({
    lastWorkedDay: d.lastWorkedDay,
    source: d.source,
    terminationType: d.terminationType,
    notes: orNull(d.notes),
    registeredAt: d.registeredAt,
    justification: orNull(d.justification),
  });

  /** Envia e leva para a posição de reposição criada (RN-14). */
  function submitHandler(form, messages, build) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      submit.disabled = true;
      clear(messages);
      try {
        const result = await build(formData(form));
        toast('Desligamento registrado. A reposição aguarda a decisão do cliente.', 'sucesso');
        navigate(`/posicoes/${result.replacementPositionId}`);
      } catch (error) {
        messages.append(applyErrors(form, error));
        submit.disabled = false;
      }
    });
  }

  // ------------------------------------------------------------ colaborador cadastrado
  function existingMode() {
    const resultArea = el('div', {}, loading());
    const chosen = el('div', {});
    const messages = el('div', {});
    let results = [];

    const search = field({ name: 'term', label: 'Nome ou matrícula', type: 'search' });
    search.classList.add('busca');

    function renderResults() {
      clear(resultArea).append(table(
        [
          { title: 'Colaborador', render: (r) => el('div', {}, el('div', {}, r.employeeName),
            el('div', { class: 'texto-fraco texto-pequeno' }, `matr. ${r.employeeRegistration}`)) },
          { title: 'Cliente / cargo', render: (r) => el('div', {}, el('div', {}, r.clientName),
            el('div', { class: 'texto-fraco texto-pequeno' }, `${r.jobRoleName} · ${r.workLocationName}`)) },
          { title: 'Desde', cls: 'nowrap', render: (r) => date(r.firstDayAt) },
          { title: 'Posição', cls: 'nowrap', render: (r) => `${r.orderNumber}-${r.slotNumber}` },
        ],
        results,
        {
          onClick: (r) => { selected = r; renderResults(); renderChosen(); },
          rowClass: (r) => (selected?.positionId === r.positionId ? 'selecionada' : ''),
          empty: 'Nenhum colaborador encontrado entre as posições preenchidas.',
        },
      ));
    }

    function renderChosen() {
      clear(chosen).append(selected
        ? infoMessage(`${selected.employeeName} (matr. ${selected.employeeRegistration}) — ${selected.clientName}, ${selected.jobRoleName}`)
        : el('div', { class: 'mensagem alerta' }, 'Selecione o colaborador na lista ao lado.'));
    }

    async function load(term = '') {
      clear(resultArea).append(loading());
      results = await api.get('/api/terminations/filled-positions', { term });
      if (preselect && !selected) selected = results.find((r) => r.positionId === preselect) ?? null;
      renderResults();
      renderChosen();
    }

    const runSearch = debounce((value) => load(value));
    search.querySelector('input').addEventListener('input', (e) => runSearch(e.target.value));

    const form = el('form', { novalidate: true }, messages, chosen, commonFields(),
      el('div', { class: 'barra-botoes direita' }, el('button', { class: 'btn', type: 'submit' }, 'Registrar desligamento')));
    submitHandler(form, messages, (d) => {
      if (!selected) throw Object.assign(new Error('Selecione o colaborador desligado.'), { fields: {} });
      requireFields(d, { lastWorkedDay: 'O último dia trabalhado', registeredAt: 'A data de registro' });
      return api.post('/api/terminations', { originPositionId: selected.positionId, ...commonBody(d) });
    });

    load().catch((error) => clear(resultArea).append(errorMessage(error.message)));
    return el('div', { class: 'grade grade-2' },
      panelNoPadding('1. Colaborador', el('div', {}, el('div', { class: 'filtros' }, search), resultArea)),
      panel('2. Desligamento', form));
  }

  // ------------------------------------------------------------ desligamento avulso (D1)
  function legacyMode() {
    const messages = el('div', {});
    const modalityArea = el('div', {});
    const locationArea = el('div', {});

    const contractField = field({ name: 'contractId', label: 'Contrato', type: 'select', required: true,
      options: [{ value: '', label: 'Selecione' }, ...contracts.map((c) => ({ value: c.id, label: `${c.clientName} — ${c.name}` }))] });

    function syncContract() {
      const contract = contracts.find((c) => c.id === contractField.querySelector('select').value);
      const modalities = contract?.modalities ?? [];
      clear(modalityArea).append(field({ name: 'modality', label: 'Modalidade', type: 'select', required: true,
        value: modalities.length === 1 ? modalities[0] : '',
        options: [{ value: '', label: 'Selecione' }, ...modalities.map((m) => ({ value: m, label: LABELS.modality[m] }))] }));
      // Contrato com unidade contratante: o desligamento avulso usa essa unidade, sem escolha.
      const fixed = contract?.contractingUnitId ? locations.find((l) => l.id === contract.contractingUnitId) : null;
      const available = fixed ? [fixed] : locations.filter((l) => l.active && (!l.clientId || l.clientId === contract?.clientId));
      clear(locationArea).append(field({ name: 'workLocationId', label: 'Local de trabalho / unidade', type: 'select', required: true,
        value: fixed?.id ?? '',
        options: [...(fixed ? [] : [{ value: '', label: 'Selecione' }]), ...available.map((l) => ({ value: l.id, label: locationLabel(l) }))],
        help: fixed ? 'Unidade contratante do contrato (fixa).' : null }));
    }
    contractField.querySelector('select').addEventListener('change', syncContract);
    syncContract();

    const form = el(
      'form',
      { novalidate: true },
      messages,
      infoMessage('Use quando o colaborador não tem posição no sistema: é criado um pedido avulso com a posição de origem e a reposição.'),
      contractField,
      el('div', { class: 'linha-campos' }, modalityArea,
        field({ name: 'jobRoleId', label: 'Cargo', type: 'select', required: true,
          options: [{ value: '', label: 'Selecione' }, ...jobRoles.filter((j) => j.active).map((j) => ({ value: j.id, label: j.name }))] })),
      locationArea,
      el('div', { class: 'linha-campos' },
        field({ name: 'employeeName', label: 'Nome do colaborador', required: true }),
        field({ name: 'employeeRegistration', label: 'Matrícula', required: true })),
      field({ name: 'firstDayAt', label: '1º dia do colaborador (opcional)', type: 'date' }),
      el('div', { class: 'linha-campos' }, ...termFields()),
      commonFields(),
      el('div', { class: 'barra-botoes direita' }, el('button', { class: 'btn', type: 'submit' }, 'Registrar desligamento avulso')),
    );

    submitHandler(form, messages, (d) => {
      requireFields(d, {
        contractId: 'O contrato', modality: 'A modalidade', jobRoleId: 'O cargo', workLocationId: 'O local',
        employeeName: 'O nome', employeeRegistration: 'A matrícula', lastWorkedDay: 'O último dia trabalhado',
      });
      return api.post('/api/terminations/legacy', {
        contractId: d.contractId,
        modality: d.modality,
        jobRoleId: d.jobRoleId,
        workLocationId: d.workLocationId,
        termType: d.termType,
        termEndDate: d.termType === 'FIXED_END' ? orNull(d.termEndDate) : null,
        termDurationDays: d.termType === 'PRESERVED_DURATION' ? intOrNull(d.termDurationDays) : null,
        employeeName: d.employeeName,
        employeeRegistration: d.employeeRegistration,
        firstDayAt: orNull(d.firstDayAt),
        ...commonBody(d),
      });
    });

    return panel('Desligamento avulso', form);
  }

  clear(target).append(modeBar, body);
  switchMode('existing');
}

import { api } from '../api.js';
import {
  el, clear, field, checkGroup, checkedValues, checkbox, cnpjField, table, panelNoPadding, loading, date, cnpj, label, LABELS,
  options, requireFields, orNull, intOrNull, toast, button, formModal, today, confirm, validationError,
} from '../ui.js';

/** Clientes e contratos (COMMERCIAL, ADMIN). Sem exclusão: inativação/encerramento. */
export async function clientsScreen(target) {
  const clientsArea = el('div', {}, loading());
  const contractsArea = el('div', {}, loading());
  let clients = [];
  let groups = [];
  let owners = [];

  async function reload() {
    [clients, groups, owners] = await Promise.all([
      api.get('/api/clients'),
      api.get('/api/catalogs/group-entities'),
      api.get('/api/users/by-role/COMMERCIAL'),
    ]);
    const contracts = await api.get('/api/contracts');

    clear(clientsArea).append(table(
      [
        { title: 'Razão social', field: 'legalName' },
        { title: 'CNPJ', cls: 'nowrap', render: (c) => cnpj(c.cnpj) },
        { title: 'Unidades', cls: 'num', render: (c) => (c.hasMultipleUnits ? String(c.units.length) : '—') },
        { title: 'Situação', render: (c) => el('span', { class: `etiqueta ${c.active ? 'verde' : 'cinza'}` }, c.active ? 'Ativo' : 'Inativo') },
      ],
      clients,
      { onClick: openClient, empty: 'Nenhum cliente cadastrado.' },
    ));

    clear(contractsArea).append(table(
      [
        { title: 'Contrato', cls: 'nowrap', render: (c) => el('strong', {}, c.name) },
        { title: 'Cliente / unidade contratante', render: (c) => el('div', {}, el('div', {}, c.clientName),
          el('div', { class: 'texto-fraco texto-pequeno' },
            c.contractingUnitId ? `${c.contractingUnitCode} — ${c.contractingUnitName}` : 'Cliente principal')) },
        { title: 'CNPJ do Grupo', field: 'groupEntityName' },
        { title: 'Modalidades', render: (c) => c.modalities.map((m) => LABELS.modalityShort[m]).join(', ') },
        { title: 'Vigência', cls: 'nowrap', render: (c) => `${date(c.startDate)} → ${c.endDate ? date(c.endDate) : 'indeterminado'}` },
        { title: 'SLA nova / reposição', cls: 'num', render: (c) => `${c.slaNewDays ?? '—'} / ${c.slaReplacementDays ?? '—'}` },
        { title: 'Comercial', field: 'commercialOwnerName' },
        { title: 'Status', render: (c) => el('span', { class: `etiqueta ${c.status === 'ACTIVE' ? 'verde' : 'cinza'}` },
          label(LABELS.contractStatus, c.status)) },
      ],
      contracts,
      { onClick: openContract, empty: 'Nenhum contrato cadastrado.' },
    ));
  }

  function openClient(client) {
    const units = unitsEditor(client?.units ?? []);
    const multiple = checkbox({ name: 'hasMultipleUnits', label: 'Cliente possui múltiplas unidades', checked: client?.hasMultipleUnits ?? false });
    const multipleInput = multiple.querySelector('input');

    const syncSection = () => {
      units.section.classList.remove('oculto');
      if (!multipleInput.checked) units.section.classList.add('oculto');
    };
    multipleInput.addEventListener('change', () => {
      // Com unidades na lista, desmarcar esconderia o que ainda vai ser gravado: exclua as unidades antes.
      if (!multipleInput.checked && units.count() > 0) {
        multipleInput.checked = true;
        toast('Exclua as unidades antes de desmarcar esta opção.', 'alerta');
      }
      syncSection();
    });
    syncSection();

    formModal({
      title: client ? 'Editar cliente' : 'Novo cliente',
      wide: true,
      fields: [
        el('div', { class: 'linha-campos' },
          field({ name: 'legalName', label: 'Razão social', value: client?.legalName ?? '', required: true, attributes: { maxlength: '200' } }),
          cnpjField({ value: client?.cnpj ?? '' })),
        checkbox({ name: 'active', label: 'Ativo', checked: client?.active ?? true }),
        multiple,
        el('p', { class: 'texto-fraco texto-pequeno', style: { marginTop: '-6px' } },
          'Para redes com várias lojas, filiais ou unidades. Cada unidade passa a ser um local de trabalho do cliente nos pedidos.'),
        units.section,
      ],
      submit: async (d) => {
        requireFields(d, { legalName: 'A razão social', cnpj: 'O CNPJ' });
        const body = {
          legalName: d.legalName,
          cnpj: d.cnpj,
          active: d.active,
          hasMultipleUnits: d.hasMultipleUnits,
          units: d.hasMultipleUnits ? units.values() : [],
        };
        await (client ? api.put(`/api/clients/${client.id}`, body) : api.post('/api/clients', body));
        toast('Cliente salvo.', 'sucesso');
        await reload();
      },
    });
  }

  function openContract(contract) {
    const editing = !!contract;
    const clientField = field({ name: 'clientId', label: 'Cliente', type: 'select', required: true, value: contract?.clientId ?? '',
      disabled: editing,
      options: [{ value: '', label: 'Selecione' },
        ...clients.filter((c) => c.active || c.id === contract?.clientId).map((c) => ({ value: c.id, label: c.legalName }))] });
    const unitArea = el('div', {});

    /** A unidade contratante lista só as unidades do cliente escolhido; sem unidades, o contrato é do cliente principal. */
    const syncUnits = () => {
      const client = clients.find((c) => c.id === clientField.querySelector('select').value);
      const units = client?.units ?? [];
      clear(unitArea).append(units.length
        ? field({ name: 'contractingUnitId', label: 'Unidade contratante', type: 'select', required: true,
          value: contract?.contractingUnitId ?? '', disabled: editing,
          options: [{ value: '', label: 'Selecione' }, ...units.map((u) => ({ value: u.id, label: `${u.code} — ${u.name}` }))],
          help: 'Loja, filial ou unidade a que o contrato se refere.' })
        : el('div', { class: 'campo', dataset: { campo: 'contractingUnitId' } },
          el('label', {}, 'Unidade contratante'),
          el('div', { class: 'texto-suave', style: { padding: '8px 0' } },
            client ? 'Cliente sem unidades: o contrato fica vinculado ao cliente principal.' : 'Escolha o cliente.')));
    };
    clientField.querySelector('select').addEventListener('change', syncUnits);
    syncUnits();

    formModal({
      title: editing ? 'Editar contrato' : 'Novo contrato',
      wide: true,
      intro: editing
        ? el('div', { class: 'mensagem info' }, 'O código, o cliente e a unidade contratante não mudam depois de criado o contrato.')
        : null,
      fields: [
        el('div', { class: 'linha-campos' }, clientField, unitArea),
        field({ name: 'code', label: 'Identificador do contrato', value: contract?.name ?? '', disabled: true,
          placeholder: 'Gerado automaticamente ao salvar',
          help: editing ? null : 'Padrão CT-AAAA-UNIDADE-SEQUENCIAL, com o código da unidade ou o nome do cliente principal.' }),
        el('div', { class: 'linha-campos' },
          field({ name: 'groupEntityId', label: 'CNPJ do Grupo responsável', type: 'select', required: true, value: contract?.groupEntityId ?? '',
            options: [{ value: '', label: 'Selecione' },
              ...groups.filter((g) => g.active || g.id === contract?.groupEntityId).map((g) => ({ value: g.id, label: g.name }))] }),
          field({ name: 'commercialOwnerId', label: 'Responsável comercial', type: 'select', required: true,
            value: contract?.commercialOwnerId ?? '',
            options: [{ value: '', label: 'Selecione' }, ...owners.map((u) => ({ value: u.id, label: u.name }))] })),
        checkGroup({ name: 'modalities', label: 'Modalidades', required: true, options: options(LABELS.modality),
          values: contract?.modalities ?? [] }),
        el('div', { class: 'linha-campos' },
          field({ name: 'startDate', label: 'Início', type: 'date', value: contract?.startDate ?? today(), required: true }),
          field({ name: 'endDate', label: 'Fim (opcional)', type: 'date', value: contract?.endDate ?? '' }),
          field({ name: 'status', label: 'Status', type: 'select', value: contract?.status ?? 'ACTIVE', options: options(LABELS.contractStatus) })),
        el('div', { class: 'linha-campos' },
          field({ name: 'slaNewDays', label: 'Meta SLA vaga nova (dias)', type: 'number', value: contract?.slaNewDays ?? '', attributes: { min: '1' } }),
          field({ name: 'slaReplacementDays', label: 'Meta SLA reposição (dias)', type: 'number', value: contract?.slaReplacementDays ?? '',
            attributes: { min: '1' }, help: 'Sem meta contratual, vale a meta padrão da modalidade.' })),
      ],
      submit: async (d, form) => {
        const body = {
          // Campos desabilitados não entram no formulário: na edição, cliente e unidade são os do contrato.
          clientId: editing ? contract.clientId : d.clientId,
          contractingUnitId: editing ? contract.contractingUnitId : orNull(d.contractingUnitId),
          groupEntityId: d.groupEntityId,
          commercialOwnerId: d.commercialOwnerId,
          modalities: checkedValues(form, 'modalities'),
          startDate: d.startDate,
          endDate: orNull(d.endDate),
          status: d.status,
          slaNewDays: intOrNull(d.slaNewDays),
          slaReplacementDays: intOrNull(d.slaReplacementDays),
        };
        requireFields(body, { clientId: 'O cliente', groupEntityId: 'O CNPJ do Grupo',
          commercialOwnerId: 'O responsável comercial', modalities: 'Ao menos uma modalidade', startDate: 'O início' });
        if (!editing && form.querySelector('select[name="contractingUnitId"]') && !body.contractingUnitId) {
          throw validationError({ contractingUnitId: 'Selecione a unidade contratante.' });
        }
        const saved = await (editing ? api.put(`/api/contracts/${contract.id}`, body) : api.post('/api/contracts', body));
        toast(editing ? 'Contrato salvo.' : `Contrato ${saved.name} criado.`, 'sucesso');
        await reload();
      },
    });
  }

  clear(target).append(
    panelNoPadding('Clientes', clientsArea, button('+ Novo cliente', () => openClient(null))),
    panelNoPadding('Contratos', contractsArea, button('+ Novo contrato', () => openContract(null))),
  );

  await reload();
}

/**
 * Unidades do cliente dentro do formulário: adicionar, editar e excluir. Nada é gravado até salvar o
 * cliente; excluir uma unidade já gravada é exclusão lógica (RN-26) — ela sai das listas e de novos pedidos,
 * mas os pedidos já registrados continuam com ela.
 */
function unitsEditor(initial) {
  const newRow = (unit = {}) => {
    const code = el('input', { type: 'text', value: unit.code ?? '', maxlength: '50', placeholder: 'Ex.: LJ-045', 'aria-label': 'Código da unidade' });
    const name = el('input', { type: 'text', value: unit.name ?? '', maxlength: '200', placeholder: 'Ex.: Loja Paulista', 'aria-label': 'Nome da unidade' });
    const doc = el('input', { type: 'text', value: cnpj(unit.cnpj ?? ''), maxlength: '18', placeholder: 'Opcional', inputmode: 'numeric',
      'aria-label': 'CNPJ da unidade' });
    doc.addEventListener('input', () => {
      doc.value = cnpj(doc.value);
    });
    return { id: unit.id ?? null, code, name, doc };
  };

  let rows = initial.map((u) => newRow(u));
  const list = el('div', {});

  async function remove(row) {
    if (row.id) {
      const label = row.code.value.trim() || row.name.value.trim() || 'sem código';
      const ok = await confirm({
        title: 'Excluir unidade',
        message: `A unidade "${label}" sai da lista e deixa de aparecer em novos pedidos. Pedidos já registrados continuam com ela. A exclusão vale ao salvar o cliente.`,
        confirmText: 'Excluir',
        danger: true,
      });
      if (!ok) return;
    }
    rows = rows.filter((r) => r !== row);
    render();
  }

  function add() {
    const row = newRow();
    rows.push(row);
    render();
    setTimeout(() => row.code.focus(), 40);
  }

  function render() {
    clear(list).append(table(
      [
        { title: 'Código', render: (r) => r.code },
        { title: 'Nome da unidade', render: (r) => r.name },
        { title: 'CNPJ da filial', render: (r) => r.doc },
        { title: '', cls: 'acoes', render: (r) => button('Excluir', () => remove(r), 'secundario pequeno') },
      ],
      rows,
      { empty: 'Nenhuma unidade cadastrada. Use "Adicionar unidade".' },
    ));
  }
  render();

  const section = el(
    'div',
    { class: 'campo', dataset: { campo: 'units' } },
    el('label', {}, 'Unidades do cliente'),
    list,
    el('div', { class: 'barra-botoes', style: { marginTop: '8px' } }, button('+ Adicionar unidade', add, 'secundario pequeno')),
    el('div', { class: 'ajuda' }, 'Código e nome são obrigatórios, e o código não se repete entre as unidades do cliente.'),
  );

  return {
    section,
    count: () => rows.length,
    values: () => {
      const values = rows.map((r) => ({
        id: r.id,
        code: r.code.value.trim(),
        name: r.name.value.trim(),
        cnpj: r.doc.value.trim() || null,
      }));
      if (values.some((v) => !v.code || !v.name)) throw validationError({ units: 'Informe o código e o nome de cada unidade.' });
      return values;
    },
  };
}

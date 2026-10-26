import { api } from '../api.js';
import {
  el, clear, field, moneyField, table, loading, date, money, LABELS, options, rateTag, requireFields, orNull,
  toast, button, formModal, confirm, today,
} from '../ui.js';
import { state, hasRole, navigate } from '../app.js';

/**
 * Valores por cargo, versionados por data de vigência. Segregação obrigatória:
 * COMMERCIAL cadastra; só a CONTROLLERSHIP valida ou rejeita (RN-21).
 */
export async function ratesScreen(target) {
  const canRegister = hasRole(state.user, 'COMMERCIAL');
  const canValidate = hasRole(state.user, 'CONTROLLERSHIP');
  const filters = { contractId: '', status: canValidate ? 'PENDING' : '' };
  const tableArea = el('div', {}, loading());

  const [contracts, jobRoles] = await Promise.all([api.get('/api/contracts'), api.get('/api/catalogs/job-roles')]);

  async function reload() {
    clear(tableArea).append(loading());
    const rates = await api.get('/api/contract-rates', filters);
    clear(tableArea).append(table(
      [
        { title: 'Cliente / contrato', render: (r) => el('div', {}, el('div', {}, r.clientName),
          el('div', { class: 'texto-fraco texto-pequeno' }, r.contractName)) },
        { title: 'Cargo', field: 'jobRoleName' },
        { title: 'Mensal', cls: 'num', render: (r) => money(r.monthlyValue) },
        { title: 'Diário (÷30)', cls: 'num', render: (r) => money(r.dailyValue) },
        { title: 'Fee R&S', cls: 'num', render: (r) => money(r.feeValue) },
        { title: 'Vigência', cls: 'nowrap', render: (r) => date(r.validFrom) },
        {
          title: 'Status',
          render: (r) => el('div', {}, rateTag(r.status),
            el('div', { class: 'texto-fraco texto-pequeno' }, `por ${r.createdByName ?? '—'}${r.validatedByName ? ` · ${r.validatedByName}` : ''}`),
            r.rejectionReason ? el('div', { class: 'texto-pequeno', style: { color: 'var(--erro)' } }, r.rejectionReason) : null,
            r.order ? el('div', { class: 'texto-pequeno' }, el('a', { href: `#/pedidos/${r.order.id}` },
              r.order.inReview ? `Pedido ${r.order.number} · em validação no pedido` : `Proposto no pedido ${r.order.number}`)) : null),
        },
        {
          title: '',
          cls: 'acoes',
          render: (r) => el('div', { class: 'barra-botoes direita' },
            // Valor proposto num pedido em validação: valida-se, devolve-se e ajusta-se no próprio pedido.
            r.order?.inReview ? button('Abrir pedido', () => navigate(`/pedidos/${r.order.id}`), 'secundario pequeno') : null,
            canValidate && r.status === 'PENDING' && !r.order?.inReview ? button('Validar', () => validate(r), 'sucesso pequeno') : null,
            canValidate && r.status === 'PENDING' && !r.order?.inReview ? button('Rejeitar', () => reject(r), 'perigo pequeno') : null,
            canRegister && r.status !== 'VALIDATED' && !r.order?.inReview ? button('Corrigir', () => openRate(r), 'secundario pequeno') : null),
        },
      ],
      rates,
      { empty: 'Nenhum valor encontrado.' },
    ));
  }

  function openRate(rate) {
    formModal({
      title: rate ? 'Corrigir valor (volta para validação)' : 'Cadastrar valor por cargo',
      fields: [
        field({ name: 'contractId', label: 'Contrato', type: 'select', required: true, value: rate?.contractId ?? '', disabled: !!rate,
          options: [{ value: '', label: 'Selecione' }, ...contracts.map((c) => ({ value: c.id, label: `${c.clientName} — ${c.name}` }))] }),
        field({ name: 'jobRoleId', label: 'Cargo', type: 'select', required: true, value: rate?.jobRoleId ?? '', disabled: !!rate,
          options: [{ value: '', label: 'Selecione' }, ...jobRoles.map((j) => ({ value: j.id, label: j.name }))] }),
        el('div', { class: 'linha-campos' },
          moneyField({ name: 'monthlyValue', label: 'Valor mensal', value: rate?.monthlyValue ?? '',
            help: 'Base do valor diário (÷30). Dispensado em contrato só de R&S.' }),
          moneyField({ name: 'feeValue', label: 'Fee R&S (informativo)', value: rate?.feeValue ?? '' })),
        field({ name: 'validFrom', label: 'Vigente a partir de', type: 'date', value: rate?.validFrom ?? today(), required: true }),
      ],
      submit: async (d) => {
        const body = {
          contractId: rate?.contractId ?? d.contractId,
          jobRoleId: rate?.jobRoleId ?? d.jobRoleId,
          monthlyValue: orNull(d.monthlyValue) === null ? null : Number(d.monthlyValue),
          feeValue: orNull(d.feeValue) === null ? null : Number(d.feeValue),
          validFrom: d.validFrom,
        };
        requireFields(body, { contractId: 'O contrato', jobRoleId: 'O cargo', validFrom: 'A vigência' });
        await (rate ? api.put(`/api/contract-rates/${rate.id}`, body) : api.post('/api/contract-rates', body));
        toast('Valor enviado para validação da Controladoria.', 'sucesso');
        await reload();
      },
    });
  }

  async function validate(rate) {
    const ok = await confirm({
      title: 'Validar valor',
      message: `Validar ${rate.jobRoleName} em ${rate.contractName}: ${money(rate.monthlyValue)} a partir de ${date(rate.validFrom)}?`,
      confirmText: 'Validar',
    });
    if (!ok) return;
    try {
      await api.post(`/api/contract-rates/${rate.id}/validate`);
      toast('Valor validado.', 'sucesso');
      await reload();
    } catch (error) {
      toast(error.message, 'erro');
    }
  }

  function reject(rate) {
    formModal({
      title: 'Rejeitar valor',
      danger: true,
      submitText: 'Rejeitar',
      intro: el('p', {}, `Rejeitar o valor de ${rate.jobRoleName} em ${rate.contractName}? O autor será notificado.`),
      fields: [field({ name: 'reason', label: 'Motivo da rejeição', type: 'textarea', required: true })],
      submit: async (d) => {
        requireFields(d, { reason: 'O motivo' });
        await api.post(`/api/contract-rates/${rate.id}/reject`, { reason: d.reason });
        toast('Valor rejeitado.', 'sucesso');
        await reload();
      },
    });
  }

  const select = (name, text, items) => {
    const block = field({ name, label: text, type: 'select', value: filters[name], options: items });
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
      el('div', { class: 'painel-cabecalho' }, el('h2', {}, 'Valores por cargo'),
        canRegister ? el('div', { class: 'barra-botoes' }, button('+ Cadastrar valor', () => openRate(null))) : null),
      el('div', { class: 'aviso-painel' },
        'Valor mensal de venda, versionado por vigência. Só entra nos totais oficiais depois de validado pela Controladoria. '
        + 'Valores informados na criação do pedido também aparecem aqui e são validados no próprio pedido.'),
      el('div', { class: 'filtros' },
        select('contractId', 'Contrato', [{ value: '', label: 'Todos' }, ...contracts.map((c) => ({ value: c.id, label: `${c.clientName} — ${c.name}` }))]),
        select('status', 'Status', options(LABELS.rateStatus, 'Todos'))),
      el('div', { class: 'painel-corpo sem-padding' }, tableArea),
    ),
  );

  await reload();
}

import { api } from '../api.js';
import {
  el, clear, field, table, panelNoPadding, loading, date, days, LABELS, options, requireFields, intOrNull, toast, button,
  formModal, today,
} from '../ui.js';
import { refreshSession } from '../app.js';

const BOOLEAN_KEYS = ['INITIAL_LOAD_OPEN', 'ALLOW_LEGACY_TERMINATION', 'LOSS_ON_CANCEL_AFTER_OPEN', 'REQUEST_EVIDENCE_REQUIRED'];
/** Metas dos KPIs (seção 11): vazias = "sem meta". */
const isKpiTarget = (key) => key.startsWith('KPI_TARGET_');
const showValue = (p) => (BOOLEAN_KEYS.includes(p.key) ? (p.value === 'true' ? 'Sim' : 'Não')
  : isKpiTarget(p.key) && !p.value ? 'Sem meta' : p.value);

/** Parâmetros do sistema (D5) e metas padrão de SLA (D7), mantidos pelo ADMIN. */
export async function parametersScreen(target) {
  const parametersArea = el('div', {}, loading());
  const targetsArea = el('div', {}, loading());

  async function reload() {
    const [parameters, targets] = await Promise.all([api.get('/api/parameters'), api.get('/api/catalogs/sla-targets')]);

    clear(parametersArea).append(table(
      [
        { title: 'Parâmetro', render: (p) => el('div', {}, el('div', {}, p.description ?? p.key), el('div', { class: 'mono texto-fraco' }, p.key)) },
        { title: 'Valor', cls: 'nowrap', render: (p) => el('strong', {}, showValue(p)) },
      ],
      parameters,
      { onClick: openParameter },
    ));

    clear(targetsArea).append(table(
      [
        { title: 'Modalidade', render: (t) => LABELS.modality[t.modality] },
        { title: 'Tipo de demanda', render: (t) => LABELS.demandType[t.demandType] },
        { title: 'Meta', cls: 'num', render: (t) => days(t.days) },
        { title: 'Vigente desde', cls: 'nowrap', render: (t) => date(t.validFrom) },
      ],
      targets,
      { empty: 'Nenhuma meta cadastrada: posições sem meta contratual ficam "Sem meta" (D7).' },
    ));
  }

  function openParameter(p) {
    const isBoolean = BOOLEAN_KEYS.includes(p.key);
    formModal({
      title: p.description ?? p.key,
      intro: p.key === 'INITIAL_LOAD_OPEN'
        ? el('div', { class: 'mensagem alerta' },
          'Ao encerrar a carga inicial, datas de marcos anteriores à data de registro passam a exigir justificativa (RN-24).')
        : null,
      fields: [
        isBoolean
          ? field({ name: 'value', label: 'Valor', type: 'select', value: p.value, options: [{ value: 'true', label: 'Sim' }, { value: 'false', label: 'Não' }] })
          : field({
            name: 'value', label: 'Valor', value: p.value, required: !isKpiTarget(p.key),
            help: p.key === 'DAILY_DIGEST_TIME' ? 'Formato HH:mm.' : isKpiTarget(p.key) ? 'Deixe vazio para "sem meta".' : null,
          }),
      ],
      submit: async (d) => {
        if (!isKpiTarget(p.key)) requireFields(d, { value: 'O valor' });
        await api.put(`/api/parameters/${p.key}`, { value: d.value });
        toast('Parâmetro atualizado.', 'sucesso');
        if (p.key === 'INITIAL_LOAD_OPEN') await refreshSession();
        await reload();
      },
    });
  }

  function openTarget() {
    formModal({
      title: 'Nova meta de SLA',
      intro: el('div', { class: 'mensagem info' },
        'A meta do contrato tem precedência. Uma nova meta vale só para posições abertas a partir da vigência (RN-19).'),
      fields: [
        el('div', { class: 'linha-campos' },
          field({ name: 'modality', label: 'Modalidade', type: 'select', options: options(LABELS.modality), required: true }),
          field({ name: 'demandType', label: 'Tipo de demanda', type: 'select', options: options(LABELS.demandType), required: true })),
        el('div', { class: 'linha-campos' },
          field({ name: 'days', label: 'Meta (dias)', type: 'number', value: '10', required: true, attributes: { min: '1' } }),
          field({ name: 'validFrom', label: 'Vigente a partir de', type: 'date', value: today(), required: true })),
      ],
      submit: async (d) => {
        requireFields(d, { days: 'A meta', validFrom: 'A vigência' });
        await api.post('/api/catalogs/sla-targets', { modality: d.modality, demandType: d.demandType, days: intOrNull(d.days), validFrom: d.validFrom });
        toast('Meta cadastrada.', 'sucesso');
        await reload();
      },
    });
  }

  clear(target).append(
    panelNoPadding('Parâmetros', el('div', {},
      el('div', { class: 'aviso-painel' }, 'Clique em um parâmetro para alterá-lo. Toda alteração fica no log de auditoria.'),
      parametersArea)),
    panelNoPadding('Metas padrão de SLA', targetsArea, button('+ Nova meta', openTarget)),
  );

  await reload();
}

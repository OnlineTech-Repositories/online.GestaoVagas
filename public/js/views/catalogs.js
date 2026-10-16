import { api } from '../api.js';
import { el, clear, field, checkbox, cnpjField, table, panelNoPadding, loading, cnpj, requireFields, toast, button, formModal } from '../ui.js';

const activeTag = (active) => el('span', { class: `etiqueta ${active ? 'verde' : 'cinza'}` }, active ? 'Ativo' : 'Inativo');

/** Cadastros auxiliares do ADMIN: cargos, locais de trabalho, CNPJs do Grupo e motivos de pausa (D6). */
export async function catalogsScreen(target) {
  const areas = {
    jobRoles: el('div', {}, loading()),
    locations: el('div', {}, loading()),
    groups: el('div', {}, loading()),
    reasons: el('div', {}, loading()),
  };
  async function reload() {
    const [jobRoles, allLocations, groups, reasons] = await Promise.all([
      api.get('/api/catalogs/job-roles'),
      api.get('/api/catalogs/work-locations'),
      api.get('/api/catalogs/group-entities'),
      api.get('/api/catalogs/pause-reasons'),
    ]);
    // Unidades de cliente (lojas, filiais) são mantidas no cadastro do cliente; aqui ficam só os locais gerais.
    const locations = allLocations.filter((l) => !l.clientId);

    const named = [{ title: 'Nome', field: 'name' }, { title: 'Situação', render: (i) => activeTag(i.active) }];
    clear(areas.jobRoles).append(table(named, jobRoles, { onClick: (i) => openNamed('job-roles', 'cargo', i), empty: 'Nenhum cargo cadastrado.' }));
    clear(areas.reasons).append(table(named, reasons, {
      onClick: (i) => openNamed('pause-reasons', 'motivo de pausa', i),
      empty: 'Nenhum motivo cadastrado. Sem motivos, o NACC não consegue pausar posições.',
    }));
    clear(areas.locations).append(
      el('div', { class: 'aviso-painel' }, 'Locais gerais, válidos para qualquer cliente. Unidades de um cliente (lojas, filiais) são cadastradas em Clientes e contratos.'),
      table(
        [{ title: 'Local', field: 'name' }, { title: 'Situação', render: (l) => activeTag(l.active) }],
        locations,
        { onClick: openLocation, empty: 'Nenhum local geral cadastrado.' },
      ),
    );
    clear(areas.groups).append(table(
      [{ title: 'Nome', field: 'name' }, { title: 'CNPJ', cls: 'nowrap', render: (g) => cnpj(g.cnpj) },
        { title: 'Situação', render: (g) => activeTag(g.active) }],
      groups,
      { onClick: openGroup, empty: 'Nenhum CNPJ do Grupo cadastrado.' },
    ));
  }

  const save = async (catalog, item, body) => {
    await (item ? api.put(`/api/catalogs/${catalog}/${item.id}`, body) : api.post(`/api/catalogs/${catalog}`, body));
    toast('Cadastro salvo.', 'sucesso');
    await reload();
  };

  function openNamed(catalog, noun, item) {
    formModal({
      title: item ? `Editar ${noun}` : `Novo ${noun}`,
      fields: [
        field({ name: 'name', label: 'Nome', value: item?.name ?? '', required: true, attributes: { maxlength: '150' } }),
        checkbox({ name: 'active', label: 'Ativo', checked: item?.active ?? true }),
      ],
      submit: async (d) => {
        requireFields(d, { name: 'O nome' });
        await save(catalog, item, d);
      },
    });
  }

  function openLocation(item) {
    formModal({
      title: item ? 'Editar local geral' : 'Novo local geral',
      fields: [
        field({ name: 'name', label: 'Nome', value: item?.name ?? '', required: true, attributes: { maxlength: '200' } }),
        checkbox({ name: 'active', label: 'Ativo', checked: item?.active ?? true }),
      ],
      submit: async (d) => {
        requireFields(d, { name: 'O nome' });
        await save('work-locations', item, { name: d.name, active: d.active });
      },
    });
  }

  function openGroup(item) {
    formModal({
      title: item ? 'Editar CNPJ do Grupo' : 'Novo CNPJ do Grupo',
      fields: [
        field({ name: 'name', label: 'Nome', value: item?.name ?? '', required: true, attributes: { maxlength: '150' } }),
        cnpjField({ value: item?.cnpj ?? '' }),
        checkbox({ name: 'active', label: 'Ativo', checked: item?.active ?? true }),
      ],
      submit: async (d) => {
        requireFields(d, { name: 'O nome', cnpj: 'O CNPJ' });
        await save('group-entities', item, d);
      },
    });
  }

  clear(target).append(
    el('div', { class: 'grade grade-2' },
      panelNoPadding('Cargos', areas.jobRoles, button('+ Novo', () => openNamed('job-roles', 'cargo', null), 'pequeno')),
      panelNoPadding('Motivos de pausa', areas.reasons, button('+ Novo', () => openNamed('pause-reasons', 'motivo de pausa', null), 'pequeno'))),
    el('div', { class: 'grade grade-2' },
      panelNoPadding('Locais gerais de trabalho', areas.locations, button('+ Novo', () => openLocation(null), 'pequeno')),
      panelNoPadding('CNPJs do Grupo', areas.groups, button('+ Novo', () => openGroup(null), 'pequeno'))),
  );

  await reload();
}

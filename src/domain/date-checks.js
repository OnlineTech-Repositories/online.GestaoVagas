import { formatBr } from './dates.js';
import { DemandType, PositionStatus as S } from './enums.js';

/**
 * Datas fora do esperado: futuras (evento que ainda não aconteceu) e fora de sequência (etapa antes da precedente).
 *
 * Decisão do usuário em 19/10/2026: datas retroativas, futuras e fora de ordem NÃO bloqueiam — viram aviso antes de
 * salvar, e a posição fica sinalizada enquanto a situação durar. Bloqueiam só o impossível dentro do próprio registro
 * (fim antes do início: pausa, vigência, contrato e o início desejado antes da solicitação, que o banco também
 * confere; pausas sobrepostas; nascimento futuro), o formato e o obrigatório.
 *
 * Fonte única: as mesmas regras dão o aviso na hora de salvar (o que a operação acrescentou) e os selos "Data futura"
 * e "Fora de sequência" nas telas e no Painel de RH. Calculadas a cada leitura, não gravadas: o selo de data futura some
 * sozinho quando a data chega.
 */

export const DateIssue = Object.freeze({ RETROACTIVE: 'RETROACTIVE', FUTURE: 'FUTURE', SEQUENCE: 'SEQUENCE' });

const br = (d) => formatBr(d);

export const retroactiveMessage = (label, date) =>
  `${label} (${br(date)}) é anterior à data atual. O evento será registrado com essa data e poderá atualizar os indicadores do período correspondente.`;

const futureMessage = (label, date) =>
  `${label} (${br(date)}) é uma data futura. O registro será salvo e identificado como futuro para fins de acompanhamento.`;

/** `after`: a referência já vem com a preposição ("ao 1º dia efetivo"). */
const sequenceMessage = (label, date, refLabel, refDate, after) => (after
  ? `${label} (${br(date)}) é posterior ${refLabel} (${br(refDate)}). Confira as informações antes de concluir.`
  : `${label} (${br(date)}) é anterior à etapa precedente: ${refLabel} (${br(refDate)}). Confira as informações antes de concluir.`);

/**
 * Coletor: `future` e `sequence` acrescentam o aviso só quando a condição vale. `message` é o aviso antes de salvar;
 * `summary`, a frase curta do selo no detalhe da posição (depois de salvo).
 */
function collector(today) {
  const issues = [];
  return {
    issues,
    future(key, label, date) {
      if (date && date > today) {
        issues.push({ kind: DateIssue.FUTURE, key, message: futureMessage(label, date), summary: `${label} (${br(date)}) é uma data futura.` });
      }
    },
    /** `after` = a data não pode passar da referência (ex.: fim da pausa depois do 1º dia). */
    sequence(key, label, date, refLabel, refDate, after = false) {
      if (date && refDate && (after ? date > refDate : date < refDate)) {
        const message = sequenceMessage(label, date, refLabel, refDate, after);
        issues.push({ kind: DateIssue.SEQUENCE, key, message, summary: message.replace(' Confira as informações antes de concluir.', '') });
      }
    },
  };
}

/** Datas do pedido: solicitação, registro, decisão do cliente, JobConvo e o período do contrato. */
export function orderDateIssues(order, today) {
  const c = collector(today);
  const contract = order.contract;
  c.future('order:request', 'A data da solicitação do cliente', order.clientRequestDate);
  c.future('order:registered', 'A data de registro do pedido', order.registeredAt);
  c.future('order:decision', 'A data da decisão do cliente', order.clientDecisionDate);
  c.future('order:jobconvo', 'A data da publicação no JobConvo', order.jobconvoPublishedAt);
  c.sequence('order:registered<request', 'A data de registro do pedido', order.registeredAt, 'a solicitação do cliente', order.clientRequestDate);
  c.sequence('order:decision<request', 'A data da decisão do cliente', order.clientDecisionDate, 'a solicitação do cliente', order.clientRequestDate);
  c.sequence('order:jobconvo<request', 'A data da publicação no JobConvo', order.jobconvoPublishedAt, 'a solicitação do cliente', order.clientRequestDate);
  if (contract && !order.isLegacy) {
    c.sequence('order:request<contract', 'A data da solicitação do cliente', order.clientRequestDate, 'o início do contrato', contract.startDate);
    c.sequence('order:request>contract', 'A data da solicitação do cliente', order.clientRequestDate, 'ao fim do contrato', contract.endDate, true);
  }
  return c.issues;
}

/** Datas da posição: os marcos do recrutamento, as pausas e, na reposição, o desligamento. */
export function positionDateIssues(p, today) {
  const c = collector(today);
  const order = p.order ?? {};
  const t = p.termination;
  const isNew = p.demandType === DemandType.NEW;
  // Legado (D1): a posição de origem do desligamento avulso não tem histórico de recrutamento.
  if (order.isLegacy && isNew) return c.issues;

  c.future('p:opened', 'A abertura da posição', p.openedAt);
  c.future('p:candidate', 'A aprovação do candidato', p.candidateApprovedAt);
  c.future('p:admission', 'A data de admissão', p.admissionAt);
  c.future('p:firstDay', 'O 1º dia efetivo', p.firstDayAt);
  if (p.status === S.CLOSED_CLIENT_CANCELLED) c.future('p:closed', 'A data de cancelamento', p.closedAt);
  for (const x of p.pauses ?? []) {
    c.future(`pause:${x.id}:start`, 'O início da pausa', x.startDate);
    c.future(`pause:${x.id}:end`, 'O fim da pausa', x.endDate);
  }
  if (t) {
    c.future('t:decision', 'A data da decisão do cliente sobre a reposição', t.clientDecisionAt);
    c.future('t:lastWorked', 'O último dia trabalhado', t.lastWorkedDay);
  }

  if (isNew) {
    c.sequence('p:opened<request', 'A abertura da posição', p.openedAt, 'a solicitação do cliente', order.clientRequestDate);
    if (p.status === S.CLOSED_CLIENT_CANCELLED) {
      c.sequence('p:closed<request', 'A data de cancelamento', p.closedAt, 'a solicitação do cliente', order.clientRequestDate);
    }
  }
  c.sequence('p:candidate<opened', 'A aprovação do candidato', p.candidateApprovedAt, 'a abertura da posição', p.openedAt);
  c.sequence('p:admission<candidate', 'A data de admissão', p.admissionAt, 'a aprovação do candidato', p.candidateApprovedAt);
  c.sequence('p:firstDay<admission', 'O 1º dia efetivo', p.firstDayAt, 'a admissão', p.admissionAt);
  c.sequence('p:firstDay<opened', 'O 1º dia efetivo', p.firstDayAt, 'a abertura da posição', p.openedAt);
  for (const x of p.pauses ?? []) {
    c.sequence(`pause:${x.id}<opened`, 'O início da pausa', x.startDate, 'a abertura da posição', p.openedAt);
    c.sequence(`pause:${x.id}>firstDay`, 'O fim da pausa', x.endDate, 'ao 1º dia efetivo', p.firstDayAt, true);
  }
  if (t) {
    c.sequence('t:decision<registered', 'A data da decisão do cliente sobre a reposição', t.clientDecisionAt,
      'o registro do desligamento', t.registeredAt);
    c.sequence('t:lastWorked<firstDay', 'O último dia trabalhado', t.lastWorkedDay, 'o 1º dia do colaborador',
      t.originPosition?.firstDayAt);
  }
  return c.issues;
}

/** Selos da posição para listas e painéis. */
export function dateFlags(p, today) {
  const issues = positionDateIssues(p, today);
  return {
    future: issues.some((i) => i.kind === DateIssue.FUTURE),
    sequence: issues.some((i) => i.kind === DateIssue.SEQUENCE),
  };
}

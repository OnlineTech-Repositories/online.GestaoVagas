import { formatBr } from '../domain/dates.js';
import { DemandType, Labels } from '../domain/enums.js';

/**
 * Campos do quadro de informações dos e-mails, por assunto: cada aviso usa os blocos que lhe dizem respeito e
 * acrescenta os dados do próprio evento. [rótulo, valor, { strong?, tone? }]; valor vazio sai do quadro.
 */

const moneyFormat = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (value) => (value === null || value === undefined ? null : moneyFormat.format(Number(value)));
export const date = (value) => (value ? formatBr(value) : null);

/** Unidade contratante do contrato, ou o cliente principal quando o contrato não tem unidade. */
export const unitLabel = (contract) => {
  const unit = contract?.contractingUnit;
  return unit ? `${unit.code} — ${unit.name}` : 'Cliente principal';
};

/** Cliente e unidade numa linha: "Rede X · LJ-16 — Loja Centro". */
export const clientUnit = (contract) => [contract?.client?.legalName, unitLabel(contract)].filter(Boolean).join(' · ');

/** Pedido: número, cliente/unidade, contrato, cargo e vagas novas. */
export function orderFields(order) {
  const quantity = (order.positions ?? []).filter((p) => p.demandType === DemandType.NEW).length;
  return [
    ['Pedido', `Nº ${order.number}`, { strong: true }],
    ['Cliente / unidade', clientUnit(order.contract)],
    ['Contrato', order.contract?.name],
    ['Cargo', order.jobRole?.name],
    ['Vagas', quantity ? String(quantity) : null],
  ];
}

/** Posição: vaga (pedido-posição e ciclo), tipo de demanda, cliente/unidade, local e cargo. */
export function positionFields(p) {
  const order = p.order ?? {};
  return [
    ['Vaga', `Pedido ${order.number} · posição ${p.slotNumber}${p.cycle > 1 ? ` (reposição nº ${p.cycle - 1})` : ''}`, { strong: true }],
    ['Tipo', Labels.demandType[p.demandType]],
    ['Cliente / unidade', clientUnit(order.contract)],
    ['Local de trabalho', order.workLocation?.name],
    ['Cargo', order.jobRole?.name],
  ];
}

/** Valor por cargo: cliente/unidade, contrato, cargo, valores e início da vigência. */
export function rateFields(rate) {
  return [
    ['Cliente / unidade', clientUnit(rate.contract)],
    ['Contrato', rate.contract?.name],
    ['Cargo', rate.jobRole?.name],
    ['Valor mensal', money(rate.monthlyValue), { strong: true }],
    ['Fee', money(rate.feeValue)],
    ['Início da vigência', date(rate.validFrom), { strong: true }],
  ];
}

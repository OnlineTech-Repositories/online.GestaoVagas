import { queryOne } from '../db/index.js';
import { findEffectiveRate } from '../db/repository.js';
import { DemandType, SlaTargetSource } from '../domain/enums.js';

/** Valores gravados na abertura da posição: valor por cargo e meta de SLA (RN-19). */

export const rateAt = (uow, contractId, jobRoleId, date) => findEffectiveRate(uow, contractId, jobRoleId, date, false);

/** Valor do pedido: a versão VALIDADA vigente na data (combinação contrato + cargo). */
export const validatedRateAt = (uow, contractId, jobRoleId, date) => findEffectiveRate(uow, contractId, jobRoleId, date, true);

/** Precedência: meta do contrato pelo tipo de demanda → meta padrão vigente na abertura → sem meta. */
export async function slaFor(contract, modality, demandType, openedAt) {
  const contractDays = demandType === DemandType.NEW ? contract.slaNewDays : contract.slaReplacementDays;
  if (contractDays !== null && contractDays !== undefined) return { days: contractDays, source: SlaTargetSource.CONTRACT };
  const target = await queryOne(
    `SELECT days FROM sla_targets WHERE modality = ? AND demand_type = ? AND valid_from <= ?
      ORDER BY valid_from DESC LIMIT 1`, modality, demandType, openedAt);
  return target ? { days: Number(target.days), source: SlaTargetSource.DEFAULT } : { days: null, source: SlaTargetSource.NONE };
}

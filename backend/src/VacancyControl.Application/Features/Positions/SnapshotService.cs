using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Positions;

/// <summary>Valores gravados na abertura da posição: valor por cargo e meta de SLA (RN-19).</summary>
public class SnapshotService(IContractRateRepository rates, ISlaTargetRepository slaTargets)
{
    public Task<ContractRate?> RateAsync(Guid contractId, Guid jobRoleId, DateOnly openedAt, CancellationToken ct = default) =>
        rates.FindEffectiveAsync(contractId, jobRoleId, openedAt, ct);

    /// <summary>Valor do pedido: a versão validada vigente na abertura (combinação contrato + cargo).</summary>
    public Task<ContractRate?> ValidatedRateAsync(Guid contractId, Guid jobRoleId, DateOnly openedAt, CancellationToken ct = default) =>
        rates.FindEffectiveValidatedAsync(contractId, jobRoleId, openedAt, ct);

    /// <summary>Precedência: meta do contrato pelo tipo de demanda → SlaTarget vigente em opened_at → sem meta.</summary>
    public async Task<(int? Days, SlaTargetSource Source)> SlaAsync(Contract contract, Modality modality,
        DemandType demandType, DateOnly openedAt, CancellationToken ct = default)
    {
        var contractDays = demandType == DemandType.NEW ? contract.SlaNewDays : contract.SlaReplacementDays;
        if (contractDays is not null) return (contractDays, SlaTargetSource.CONTRACT);

        var target = await slaTargets.FindEffectiveAsync(modality, demandType, openedAt, ct);
        return target is null ? (null, SlaTargetSource.NONE) : (target.Days, SlaTargetSource.DEFAULT);
    }
}

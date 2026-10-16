using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Notifications;

namespace VacancyControl.Application.Features.Rates;

public sealed record ContractRateDto(
    Guid Id, Guid ContractId, string ContractName, string ClientName, Guid JobRoleId, string JobRoleName,
    decimal? MonthlyValue, decimal? DailyValue, decimal? FeeValue, DateOnly ValidFrom, RateStatus Status,
    string? CreatedByName, DateTimeOffset CreatedAt, string? ValidatedByName, DateTimeOffset? ValidatedAt, string? RejectionReason);

public sealed record SaveContractRateRequest(Guid ContractId, Guid JobRoleId, decimal? MonthlyValue, decimal? FeeValue, DateOnly ValidFrom);
public sealed record RejectRateRequest(string Reason);

/// <summary>
/// Valores por cargo, versionados. Segregação obrigatória: COMMERCIAL cadastra, só CONTROLLERSHIP valida.
/// </summary>
public class ContractRateService(
    IContractRateRepository rates,
    IRepository<ContractRate> ratesRepository,
    IContractRepository contracts,
    IRepository<JobRole> jobRoles,
    IPositionRepository positions,
    IUserDirectory users,
    NotificationService notifications,
    IAppLinks links,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    public async Task<List<ContractRateDto>> ListAsync(Guid? contractId, RateStatus? status, CancellationToken ct = default)
    {
        if (!Permissions.CanSeeDetailedValues(user)) throw new ForbiddenException();
        var list = await rates.ListAsync(contractId, status, ct);
        return await ToDtosAsync(list, ct);
    }

    public async Task<ContractRateDto> CreateAsync(SaveContractRateRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial);
        var rate = new ContractRate();
        await ApplyAsync(rate, request, null, ct);
        ratesRepository.Add(rate);
        await AttachToPositionsWithoutRateAsync(rate, ct);
        await NotifyPendingAsync(rate, ct);
        audit.Set("CREATE_RATE");
        await uow.SaveChangesAsync(ct);
        return (await ToDtosAsync([await rates.GetAsync(rate.Id, ct) ?? rate], ct)).Single();
    }

    /// <summary>Correção de valor pendente ou rejeitado: volta para PENDING e reentra na fila de validação.</summary>
    public async Task<ContractRateDto> UpdateAsync(Guid id, SaveContractRateRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial);
        var rate = await rates.GetAsync(id, ct) ?? throw new NotFoundException("Valor não encontrado.");
        if (rate.Status == RateStatus.VALIDATED)
            throw new BusinessRuleException("Valor já validado não pode ser alterado. Cadastre uma nova versão com outra data de vigência.");
        if (request.ContractId != rate.ContractId || request.JobRoleId != rate.JobRoleId)
            throw new BusinessRuleException("Não é possível trocar o contrato ou o cargo de um valor já cadastrado.");

        await ApplyAsync(rate, request, rate.Id, ct);
        rate.Status = RateStatus.PENDING;
        rate.RejectionReason = null;
        rate.ValidatedBy = null;
        rate.ValidatedAt = null;
        await NotifyPendingAsync(rate, ct);
        audit.Set("UPDATE_RATE");
        await uow.SaveChangesAsync(ct);
        return (await ToDtosAsync([rate], ct)).Single();
    }

    public async Task<ContractRateDto> ValidateAsync(Guid id, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Controllership);
        var rate = await GetPendingAsync(id, ct);
        rate.Status = RateStatus.VALIDATED;
        rate.ValidatedBy = user.UserId;
        rate.ValidatedAt = clock.UtcNow;
        audit.Set("VALIDATE_RATE");
        await uow.SaveChangesAsync(ct);
        return (await ToDtosAsync([rate], ct)).Single();
    }

    public async Task<ContractRateDto> RejectAsync(Guid id, RejectRateRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Controllership);
        var reason = DateGuard.RequireText(request.Reason, "Informe o motivo da rejeição.", "reason");
        var rate = await GetPendingAsync(id, ct);
        rate.Status = RateStatus.REJECTED;
        rate.RejectionReason = reason;
        rate.ValidatedBy = user.UserId;
        rate.ValidatedAt = clock.UtcNow;

        if (rate.CreatedBy is { } author)
            await notifications.NotifyAsync(new EventMessage(NotificationTypes.RateRejected, rate.Id,
                "Valor por cargo rejeitado",
                $"O valor de {rate.JobRole?.Name} no contrato {rate.Contract?.Name} (vigência a partir de {rate.ValidFrom:dd/MM/yyyy}) foi rejeitado pela Controladoria. Motivo: {reason}",
                links.ContractRates()), userIds: [author], ct: ct);

        audit.Set("REJECT_RATE", reason);
        await uow.SaveChangesAsync(ct);
        return (await ToDtosAsync([rate], ct)).Single();
    }

    private async Task<ContractRate> GetPendingAsync(Guid id, CancellationToken ct)
    {
        var rate = await rates.GetAsync(id, ct) ?? throw new NotFoundException("Valor não encontrado.");
        if (rate.Status != RateStatus.PENDING) throw new BusinessRuleException("Somente valores pendentes podem ser validados ou rejeitados.");
        if (rate.CreatedBy == user.UserId) throw new ForbiddenException("Quem cadastrou o valor não pode validá-lo.");
        return rate;
    }

    private async Task ApplyAsync(ContractRate rate, SaveContractRateRequest request, Guid? exceptId, CancellationToken ct)
    {
        var contract = await contracts.GetAsync(request.ContractId, ct) ?? throw new BusinessRuleException("Contrato não encontrado.", "contractId");
        var jobRole = await jobRoles.GetByIdAsync(request.JobRoleId, ct) ?? throw new BusinessRuleException("Cargo não encontrado.", "jobRoleId");
        var onlyRs = contract.Modalities.All(m => m == Modality.RS);
        if (!onlyRs && request.MonthlyValue is null)
            throw new BusinessRuleException("Informe o valor mensal.", "monthlyValue");
        if (request.MonthlyValue is <= 0 || request.FeeValue is < 0)
            throw new BusinessRuleException("Os valores devem ser positivos.", "monthlyValue");
        if (await rates.ExistsAsync(request.ContractId, request.JobRoleId, request.ValidFrom, exceptId, ct))
            throw new BusinessRuleException("Já existe valor para este cargo no contrato com a mesma data de vigência.", "validFrom");

        rate.ContractId = contract.Id;
        rate.Contract = contract;
        rate.JobRoleId = jobRole.Id;
        rate.JobRole = jobRole;
        rate.MonthlyValue = request.MonthlyValue is { } m ? Math.Round(m, 2) : null;
        rate.FeeValue = request.FeeValue is { } f ? Math.Round(f, 2) : null;
        rate.ValidFrom = request.ValidFrom;
    }

    /// <summary>
    /// Posições abertas sem valor (cadastradas antes de existir valor vigente) recebem a nova versão,
    /// desde que ela já vigorasse na abertura. Posições que já têm snapshot não são alteradas.
    /// </summary>
    private async Task AttachToPositionsWithoutRateAsync(ContractRate rate, CancellationToken ct)
    {
        foreach (var p in await positions.ListWithoutRateAsync(rate.ContractId, rate.JobRoleId, rate.ValidFrom, ct))
        {
            p.RateId = rate.Id;
            p.Rate = rate;
        }
    }

    private Task NotifyPendingAsync(ContractRate rate, CancellationToken ct) =>
        notifications.NotifyAsync(new EventMessage(NotificationTypes.RatePending, rate.Id,
            "Valor por cargo pendente de validação",
            $"Novo valor de {rate.JobRole?.Name} no contrato {rate.Contract?.Name} aguarda validação da Controladoria.",
            links.ContractRates()), roles: [Roles.Controllership], ct: ct);

    private async Task<List<ContractRateDto>> ToDtosAsync(IReadOnlyCollection<ContractRate> list, CancellationToken ct)
    {
        var userIds = list.SelectMany(r => new[] { r.CreatedBy, r.ValidatedBy }).OfType<Guid>().Distinct();
        var names = (await users.ListByIdsAsync(userIds, ct)).ToDictionary(u => u.Id, u => u.Name);
        return list.Select(r => new ContractRateDto(
                r.Id, r.ContractId, r.Contract?.Name ?? "", r.Contract?.Client?.LegalName ?? "", r.JobRoleId, r.JobRole?.Name ?? "",
                r.MonthlyValue, r.DailyValue is { } d ? Math.Round(d, 2) : null, r.FeeValue, r.ValidFrom, r.Status,
                r.CreatedBy is { } c ? names.GetValueOrDefault(c) : null, r.CreatedAt,
                r.ValidatedBy is { } v ? names.GetValueOrDefault(v) : null, r.ValidatedAt, r.RejectionReason))
            .ToList();
    }
}

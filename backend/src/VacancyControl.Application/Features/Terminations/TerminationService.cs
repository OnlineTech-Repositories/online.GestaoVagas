using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Positions;

namespace VacancyControl.Application.Features.Terminations;

public sealed record FilledPositionDto(
    Guid PositionId, string EmployeeName, string EmployeeRegistration, string ClientName, string ContractName,
    string JobRoleName, string WorkLocationName, DateOnly? FirstDayAt, long OrderNumber, int SlotNumber);

public sealed record RegisterTerminationRequest(
    Guid OriginPositionId, DateOnly LastWorkedDay, TerminationSource Source, TerminationType TerminationType, string? Notes,
    DateOnly? RegisteredAt, string? Justification);

/// <summary>D1: desligamento de colaborador sem posição de origem no sistema.</summary>
public sealed record LegacyTerminationRequest(
    Guid ContractId, Modality Modality, Guid JobRoleId, Guid WorkLocationId, TermType TermType, DateOnly? TermEndDate,
    int? TermDurationDays, string EmployeeName, string EmployeeRegistration, DateOnly? FirstDayAt, DateOnly LastWorkedDay,
    TerminationSource Source, TerminationType TerminationType, string? Notes, DateOnly? RegisteredAt, string? Justification);

public sealed record TerminationResultDto(Guid TerminationId, Guid ReplacementPositionId);

public class TerminationService(
    IPositionRepository positions,
    IOrderRepository orders,
    IContractRepository contracts,
    IRepository<JobRole> jobRoles,
    IRepository<WorkLocation> workLocations,
    SnapshotService snapshots,
    ParameterService parameters,
    NotificationService notifications,
    IAppLinks links,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    /// <summary>Busca do colaborador por nome ou matrícula entre as posições FILLED sem desligamento.</summary>
    public async Task<List<FilledPositionDto>> SearchFilledAsync(string? term, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Dp, Roles.Nacc);
        var list = await positions.SearchFilledAsync(term, 50, ct);
        return list.Select(p => new FilledPositionDto(p.Id, p.EmployeeName ?? "", p.EmployeeRegistration ?? "",
                p.Order!.Contract!.Client?.LegalName ?? "", p.Order.Contract.Name, p.Order.JobRole?.Name ?? "",
                p.Order.WorkLocation?.Name ?? "", p.FirstDayAt, p.Order.Number, p.SlotNumber))
            .ToList();
    }

    /// <summary>RN-11 a RN-14: registra o desligamento e cria a reposição AWAITING_CONFIRMATION.</summary>
    public async Task<TerminationResultDto> RegisterAsync(RegisterTerminationRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Dp, Roles.Nacc);
        var origin = await positions.GetDetailedAsync(r.OriginPositionId, ct) ?? throw new NotFoundException("Posição não encontrada.");
        var result = await RegisterCoreAsync(origin, r.LastWorkedDay, r.Source, r.TerminationType, r.Notes, r.RegisteredAt, r.Justification, ct);
        audit.Set("REGISTER_TERMINATION", DateGuard.Clean(r.Justification));
        await uow.SaveChangesAsync(ct);
        return result;
    }

    /// <summary>D1: cria pedido avulso (is_legacy) com a posição de origem FILLED e segue a RN-14.</summary>
    public async Task<TerminationResultDto> RegisterLegacyAsync(LegacyTerminationRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Dp, Roles.Nacc);
        if (!await parameters.GetBoolAsync(ParameterKeys.AllowLegacyTermination, ct))
            throw new BusinessRuleException("O desligamento avulso está desabilitado pelo administrador.");

        var contract = await contracts.GetAsync(r.ContractId, ct) ?? throw new BusinessRuleException("Contrato não encontrado.", "contractId");
        if (contract.Status != ContractStatus.ACTIVE) throw new BusinessRuleException("Selecione um contrato ativo.", "contractId");
        if (!contract.Modalities.Contains(r.Modality)) throw new BusinessRuleException("A modalidade selecionada não pertence ao contrato.", "modality");
        var jobRole = await jobRoles.GetByIdAsync(r.JobRoleId, ct) ?? throw new BusinessRuleException("Cargo não encontrado.", "jobRoleId");
        var location = await workLocations.GetByIdAsync(r.WorkLocationId, ct);
        if (location is not { Active: true }) throw new BusinessRuleException("Selecione um local de trabalho ativo.", "workLocationId");
        if (location.ClientId is { } locationClient && locationClient != contract.ClientId)
            throw new BusinessRuleException("O local de trabalho selecionado pertence a outro cliente.", "workLocationId");
        if (contract.ContractingUnitId is { } contractUnit && location.Id != contractUnit)
            throw new BusinessRuleException("O pedido deste contrato usa a unidade contratante do contrato.", "workLocationId");
        if (r.FirstDayAt is { } first)
        {
            DateGuard.NotFuture(first, clock.Today, "O 1º dia do colaborador", "firstDayAt");
            if (first > r.LastWorkedDay) throw new BusinessRuleException("O último dia trabalhado não pode ser anterior ao 1º dia.", "lastWorkedDay");
        }

        var startDate = r.FirstDayAt ?? r.LastWorkedDay;
        TermRules.Validate(r.TermType, r.TermEndDate, r.TermDurationDays, startDate);
        var (termEnd, termDuration) = TermRules.Normalize(r.TermType, r.TermEndDate, r.TermDurationDays);

        var order = new Order
        {
            ContractId = contract.Id,
            Contract = contract,
            Modality = r.Modality,
            JobRoleId = jobRole.Id,
            JobRole = jobRole,
            Quantity = 1,
            WorkLocationId = location.Id,
            WorkLocation = location,
            ClientRequestDate = startDate,
            DesiredStartDate = startDate,
            TermType = r.TermType,
            TermEndDate = termEnd,
            TermDurationDays = termDuration,
            IsLegacy = true,
            // Colaborador já trabalhava: não há aprovação do cliente a aguardar.
            ApprovalStatus = OrderApprovalStatus.APPROVED,
            ClientDecisionDate = startDate,
            ApprovalRecordedAt = clock.UtcNow,
            ApprovalRecordedBy = user.UserId,
            RegisteredAt = clock.Today,
            Notes = "Pedido criado automaticamente por desligamento avulso.",
        };
        // RN-14: a reposição herda o valor da origem; usa a versão vigente no dia seguinte à saída.
        var rate = await snapshots.RateAsync(contract.Id, jobRole.Id, r.LastWorkedDay.AddDays(1), ct);
        var origin = Position.CreateLegacyFilled(order, r.FirstDayAt, r.EmployeeName, r.EmployeeRegistration, rate);
        order.Positions.Add(origin);
        orders.Add(order);

        var result = await RegisterCoreAsync(origin, r.LastWorkedDay, r.Source, r.TerminationType, r.Notes, r.RegisteredAt,
            r.Justification, ct, isNewOrigin: true);
        audit.Set("REGISTER_LEGACY_TERMINATION", DateGuard.Clean(r.Justification));
        await uow.SaveChangesAsync(ct);
        return result;
    }

    private async Task<TerminationResultDto> RegisterCoreAsync(Position origin, DateOnly lastWorkedDay, TerminationSource source,
        TerminationType type, string? notes, DateOnly? registeredAtInput, string? justification, CancellationToken ct,
        bool isNewOrigin = false)
    {
        var today = clock.Today;
        var registeredAt = registeredAtInput ?? today;
        DateGuard.NotFuture(registeredAt, today, "A data de registro", "registeredAt");
        if (origin.FirstDayAt is { } first && lastWorkedDay < first)
            throw new BusinessRuleException("O último dia trabalhado não pode ser anterior ao 1º dia do colaborador.", "lastWorkedDay");
        var retroactive = DateGuard.CheckRetroactive(registeredAt, today, await parameters.IsInitialLoadOpenAsync(ct),
            justification, "A data de registro do desligamento");

        var alreadyTerminated = !isNewOrigin && await positions.HasTerminationAsync(origin.Id, ct);
        var termination = Termination.Register(origin, alreadyTerminated, lastWorkedDay, source, type, notes, registeredAt);
        var sequence = isNewOrigin ? 2 : await positions.NextSequenceAsync(origin.OrderId, ct);
        var replacement = Position.CreateReplacement(origin, termination, sequence);
        if (retroactive) replacement.MarkRetroactive();

        positions.Add(termination);
        positions.Add(replacement);

        await notifications.NotifyAsync(new EventMessage(NotificationTypes.TerminationRegistered, replacement.Id,
            $"Desligamento registrado — {origin.EmployeeName}",
            $"Desligamento de {origin.EmployeeName} (matrícula {origin.EmployeeRegistration}), {origin.Order!.JobRole?.Name} — " +
            $"{origin.Order.Contract?.Client?.LegalName}. Último dia trabalhado: {lastWorkedDay:dd/MM/yyyy}. " +
            "Registre a decisão do cliente sobre a reposição.",
            links.Position(replacement.Id)), roles: [Roles.Nacc], ct: ct);

        return new TerminationResultDto(termination.Id, replacement.Id);
    }
}

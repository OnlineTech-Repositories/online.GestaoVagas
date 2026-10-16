using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Positions;

namespace VacancyControl.Application.Features.Orders;

public sealed record CreateOrderRequest(
    Guid ContractId, Modality Modality, Guid JobRoleId, int Quantity, Guid WorkLocationId, DateOnly ClientRequestDate,
    DateOnly DesiredStartDate, TermType TermType, DateOnly? TermEndDate, int? TermDurationDays, string? Notes,
    DateOnly? RegisteredAt, string? Justification, string? JobDescription = null);

/// <summary>Cargo disponível para o pedido do contrato: tem valor validado; <c>ValidFrom</c> = vigência da 1ª versão validada.</summary>
public sealed record OrderJobRoleDto(Guid Id, string Name, DateOnly ValidFrom);

public sealed record AddPositionsRequest(int Quantity, DateOnly DesiredStartDate, string? Justification);

public enum OrderDate { CLIENT_REQUEST_DATE, DESIRED_START_DATE, REGISTERED_AT, APPROVAL_DATE }

/// <summary>Aprovação formal do cliente: data em que o cliente aprovou (padrão hoje).</summary>
public sealed record ApproveOrderRequest(DateOnly Date, string? Justification);
public sealed record RejectOrderRequest(DateOnly Date, string Reason);

/// <summary>Publicação no JobConvo do pedido: publicado exige código e data; não publicado exige justificativa.</summary>
public sealed record RecordJobconvoRequest(bool Published, string? Code, DateOnly? PublishedAt, string? Justification);

/// <summary>Analistas de RH responsáveis: a lista completa desejada (inclui, substitui ou remove).</summary>
public sealed record SetRhAnalystsRequest(IReadOnlyList<Guid> AnalystIds);

/// <summary>Histórico de responsáveis: quem entrou e saiu, por quem e quando.</summary>
public sealed record RhAssignmentDto(
    Guid UserId, string UserName, DateTimeOffset AssignedAt, string? AssignedByName, DateTimeOffset? RemovedAt, string? RemovedByName);

public sealed record JobconvoDto(
    bool Published, string? Code, DateOnly? PublishedAt, string? Notes, DateTimeOffset? RecordedAt, string? RecordedByName);
public sealed record CorrectOrderDateRequest(OrderDate Field, DateOnly Date, string Justification);

public sealed record OrderSummaryDto(
    Guid Id, long Number, string ClientName, string ContractName, Modality Modality, string JobRoleName, string WorkLocationName,
    int Quantity, DateOnly ClientRequestDate, DateOnly DesiredStartDate, DateOnly RegisteredAt, OrderStatus Status,
    int OpenPositions, int FilledPositions, bool IsLegacy, OrderApprovalStatus ApprovalStatus, DateOnly? ClientDecisionDate,
    bool? JobconvoPublished, string? JobconvoCode, IReadOnlyList<string> RhAnalystNames, bool AwaitingRhAssignment,
    int ReplacementCount);

/// <summary>Um ocupante (ciclo) de uma vaga: o colaborador ou candidato daquele ciclo e como ele saiu.</summary>
public sealed record OccupantDto(
    Guid PositionId, int Cycle, DemandType DemandType, PositionStatus Status, bool IsCurrent, bool NotReplaced,
    string? Name, string? Registration, bool IsCandidate, DateOnly? OpenedAt, DateOnly? AdmissionAt, DateOnly? FirstDayAt,
    string? FirstDayConfirmedByName, DateOnly? LeftAt, TerminationType? ExitType, string? ExitNotes,
    DateOnly? ExitRegisteredAt, string? ExitRegisteredByName, DateTimeOffset? ExitRecordedAt, Guid? ReplacedByPositionId,
    string? ReplacedByName, bool IsLegacyOrigin);

/// <summary>
/// Vaga do pedido: o ciclo atual (uma linha por vaga) e o histórico de ocupantes. Dias descobertos e valores somam
/// todos os ciclos da vaga.
/// </summary>
public sealed record SlotDto(
    int Number, PositionSummaryDto Current, int UncoveredDaysTotal, decimal? LostTotal, decimal? DeferredTotal,
    int ReplacementCount, IReadOnlyList<OccupantDto> Occupants);

public sealed record OrderDetailDto(
    OrderSummaryDto Summary, Guid ContractId, Guid JobRoleId, Guid WorkLocationId, TermType TermType, DateOnly? TermEndDate,
    int? TermDurationDays, string? Notes, string? JobDescription, string? CreatedByName, bool CanAddPositions, bool CanCorrectDates,
    IReadOnlyList<PositionSummaryDto> Positions, string? ContractingUnit, DateTimeOffset? ApprovalRecordedAt,
    string? ApprovalRecordedByName, string? NotApprovedReason, bool CanDecideApproval, JobconvoDto? Jobconvo,
    bool CanRecordJobconvo, IReadOnlyList<RhAnalystDto> RhAnalysts, IReadOnlyList<RhAssignmentDto> RhAssignmentHistory,
    bool CanAssignRh, IReadOnlyList<SlotDto> Slots);

public class OrderService(
    IOrderRepository orders,
    IContractRepository contracts,
    IRepository<JobRole> jobRoles,
    IRepository<WorkLocation> workLocations,
    IPositionRepository positions,
    IContractRateRepository rates,
    SnapshotService snapshots,
    ParameterService parameters,
    NotificationService notifications,
    IUserDirectory users,
    IAppLinks links,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    /// <summary>RN-01 a RN-04: cria o pedido e suas N posições NEW/OPEN.</summary>
    public async Task<OrderDetailDto> CreateAsync(CreateOrderRequest r, CancellationToken ct = default)
    {
        var initialLoadOpen = await parameters.IsInitialLoadOpenAsync(ct);
        // Matriz 4.1: só COMMERCIAL cria pedido. Na carga inicial (seção 13) o NACC também cadastra pedidos em aberto.
        if (!user.IsInRole(Roles.Commercial) && !(initialLoadOpen && user.IsInRole(Roles.Nacc)))
            throw new ForbiddenException();

        var today = clock.Today;
        var contract = await contracts.GetAsync(r.ContractId, ct) ?? throw new BusinessRuleException("Contrato não encontrado.", "contractId");
        if (contract.Status != ContractStatus.ACTIVE)
            throw new BusinessRuleException("O pedido só pode ser registrado em contrato ativo.", "contractId");
        if (!contract.Modalities.Contains(r.Modality))
            throw new BusinessRuleException("A modalidade selecionada não pertence ao contrato.", "modality");
        var jobRole = await jobRoles.GetByIdAsync(r.JobRoleId, ct);
        if (jobRole is not { Active: true }) throw new BusinessRuleException("Selecione um cargo ativo.", "jobRoleId");
        var location = await workLocations.GetByIdAsync(r.WorkLocationId, ct);
        if (location is not { Active: true }) throw new BusinessRuleException("Selecione um local de trabalho ativo.", "workLocationId");
        if (location.ClientId is { } locationClient && locationClient != contract.ClientId)
            throw new BusinessRuleException("O local de trabalho selecionado pertence a outro cliente.", "workLocationId");
        if (contract.ContractingUnitId is { } contractUnit && location.Id != contractUnit)
            throw new BusinessRuleException("O pedido deste contrato usa a unidade contratante do contrato.", "workLocationId");
        if (r.Quantity is < 1 or > 1000)
            throw new BusinessRuleException("A quantidade deve estar entre 1 e 1000.", "quantity");
        if (r.DesiredStartDate < r.ClientRequestDate)
            throw new BusinessRuleException("A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.", "desiredStartDate");
        TermRules.Validate(r.TermType, r.TermEndDate, r.TermDurationDays, r.DesiredStartDate);
        var jobDescription = OrderTexts.CleanMultiline(r.JobDescription);
        if (jobDescription is { Length: > OrderTexts.JobDescriptionMaxLength })
            throw new BusinessRuleException(
                $"A descrição da vaga deve ter no máximo {OrderTexts.JobDescriptionMaxLength} caracteres.", "jobDescription");

        var registeredAt = r.RegisteredAt ?? today;
        DateGuard.NotFuture(r.ClientRequestDate, today, "A data da solicitação do cliente", "clientRequestDate");
        DateGuard.NotFuture(registeredAt, today, "A data de registro", "registeredAt");
        if (registeredAt < r.ClientRequestDate)
            throw new BusinessRuleException("A data de registro não pode ser anterior à data da solicitação do cliente.", "registeredAt");
        var retroactive = DateGuard.CheckRetroactive(registeredAt, today, initialLoadOpen, r.Justification, "A data de registro");

        // Valores por cargo são do contrato: o pedido só aceita cargo com valor validado vigente na data de registro.
        if (await snapshots.ValidatedRateAsync(contract.Id, jobRole.Id, registeredAt, ct) is null)
            throw new BusinessRuleException(
                $"O cargo {jobRole.Name} não tem valor validado neste contrato vigente em {registeredAt:dd/MM/yyyy}. "
                + "Cadastre e valide o valor em Valores por cargo antes de concluir o pedido.", "jobRoleId");

        var (termEnd, termDuration) = TermRules.Normalize(r.TermType, r.TermEndDate, r.TermDurationDays);
        var order = new Order
        {
            ContractId = contract.Id,
            Contract = contract,
            Modality = r.Modality,
            JobRoleId = jobRole.Id,
            JobRole = jobRole,
            Quantity = r.Quantity,
            WorkLocationId = location.Id,
            WorkLocation = location,
            ClientRequestDate = r.ClientRequestDate,
            DesiredStartDate = r.DesiredStartDate,
            TermType = r.TermType,
            TermEndDate = termEnd,
            TermDurationDays = termDuration,
            Notes = DateGuard.Clean(r.Notes),
            JobDescription = jobDescription,
            RegisteredAt = registeredAt,
        };

        // Todo pedido nasce aguardando a aprovação do cliente: as posições abrem (e o SLA começa) na aprovação.
        await AddPositionsAsync(order, r.Quantity, r.DesiredStartDate, null, registeredAt, retroactive, 1, ct);
        orders.Add(order);
        audit.Set("CREATE_ORDER", DateGuard.Clean(r.Justification));
        await uow.SaveChangesAsync(ct);

        // Depois de gravar: o número do pedido (gerado pelo banco) entra na notificação.
        await NotifyEveryoneAsync(order, NotificationTypes.OrderCreated, "Novo pedido aguardando aprovação do cliente",
            "Nova demanda registrada, aguardando a aprovação formal do cliente. O RH já pode preparar o recrutamento.", ct);
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>RN-05: aumentar a quantidade gera novas posições, com a própria data de início desejada.</summary>
    public async Task<OrderDetailDto> AddPositionsAsync(Guid id, AddPositionsRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial);
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        if (order.IsLegacy) throw new BusinessRuleException("Não é possível acrescentar posições a um pedido de desligamento avulso.");
        if (order.Contract!.Status != ContractStatus.ACTIVE)
            throw new BusinessRuleException("O contrato do pedido não está ativo.");
        if (r.Quantity is < 1 or > 1000) throw new BusinessRuleException("A quantidade deve estar entre 1 e 1000.", "quantity");
        if (r.DesiredStartDate < order.ClientRequestDate)
            throw new BusinessRuleException("A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.", "desiredStartDate");

        if (order.ApprovalStatus == OrderApprovalStatus.NOT_APPROVED)
            throw new BusinessRuleException("O cliente não aprovou este pedido: não é possível acrescentar posições.");

        var sequence = await positions.NextSequenceAsync(order.Id, ct);
        var today = clock.Today;
        // Pedido aprovado: as novas posições abrem hoje; aguardando aprovação: abrem quando o cliente aprovar.
        var created = await AddPositionsAsync(order, r.Quantity, r.DesiredStartDate, order.IsApproved ? today : null, today, false,
            sequence, ct);
        foreach (var p in created) positions.Add(p);
        order.Quantity += r.Quantity;

        await notifications.NotifyAsync(new EventMessage(NotificationTypes.OrderCreated, order.Id,
            $"Pedido {order.Number}: +{r.Quantity} posição(ões)",
            $"O pedido {order.Number} ({order.JobRole?.Name}, {order.Contract.Client?.LegalName}) recebeu {r.Quantity} nova(s) posição(ões), " +
            $"início desejado em {r.DesiredStartDate:dd/MM/yyyy}.",
            links.Order(order.Id)), roles: [Roles.RhManager, Roles.Nacc], userIds: order.ActiveRhAnalysts.Select(a => a.UserId), ct: ct);

        audit.Set("ADD_POSITIONS", DateGuard.Clean(r.Justification));
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>RN-25: correção de datas do pedido pelo autor (ou ADMIN), com justificativa.</summary>
    public async Task<OrderDetailDto> CorrectDateAsync(Guid id, CorrectOrderDateRequest r, CancellationToken ct = default)
    {
        var justification = DateGuard.RequireText(r.Justification, "Informe a justificativa da correção.", "justification");
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        if (!user.IsInRole(Roles.Admin) && order.CreatedBy != user.UserId)
            throw new ForbiddenException("Somente o autor do pedido ou um administrador pode corrigir estas datas.");
        DateGuard.NotFuture(r.Field == OrderDate.DESIRED_START_DATE ? clock.Today : r.Date, clock.Today, "A data corrigida", "date");

        switch (r.Field)
        {
            case OrderDate.CLIENT_REQUEST_DATE:
                if (r.Date > order.DesiredStartDate || r.Date > order.RegisteredAt)
                    throw new BusinessRuleException("A solicitação do cliente não pode ser posterior ao início desejado nem ao registro.", "date");
                order.ClientRequestDate = r.Date;
                break;
            case OrderDate.DESIRED_START_DATE:
                if (r.Date < order.ClientRequestDate)
                    throw new BusinessRuleException("A data de início desejada deve ser igual ou posterior à data da solicitação do cliente.", "desiredStartDate");
                // Posições criadas com a data original acompanham a correção; acréscimos posteriores mantêm a própria data.
                foreach (var p in order.Positions.Where(p => p.DemandType == DemandType.NEW && p.DesiredStartDate == order.DesiredStartDate))
                    p.DesiredStartDate = r.Date;
                order.DesiredStartDate = r.Date;
                break;
            case OrderDate.REGISTERED_AT:
                if (r.Date < order.ClientRequestDate)
                    throw new BusinessRuleException("A data de registro não pode ser anterior à data da solicitação do cliente.", "registeredAt");
                order.RegisteredAt = r.Date;
                break;
            case OrderDate.APPROVAL_DATE:
                if (!order.IsApproved || order.ClientDecisionDate is not { } current)
                    throw new BusinessRuleException("O pedido não está aprovado: não há data de aprovação a corrigir.", "date");
                if (r.Date < order.ClientRequestDate)
                    throw new BusinessRuleException("A aprovação não pode ser anterior à solicitação do cliente.", "date");
                // A abertura das vagas novas é a data da aprovação: elas acompanham a correção.
                foreach (var p in order.Positions.Where(p => p.DemandType == DemandType.NEW && p.OpenedAt == current))
                {
                    if (p.FirstDayAt is { } first && first < r.Date)
                        throw new BusinessRuleException($"A posição {p.SlotNumber} tem 1º dia efetivo anterior à nova data de aprovação.");
                    p.OpenedAt = r.Date;
                }
                order.ClientDecisionDate = r.Date;
                break;
        }

        audit.Set("CORRECT_DATE", justification);
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>Cargos que o pedido do contrato pode usar: ativos e com valor validado no contrato.</summary>
    public async Task<List<OrderJobRoleDto>> ListJobRolesForContractAsync(Guid contractId, CancellationToken ct = default) =>
        (await rates.ListValidatedAsync(contractId, ct))
            .Where(r => r.JobRole is { Active: true })
            .GroupBy(r => r.JobRole!)
            .Select(g => new OrderJobRoleDto(g.Key.Id, g.Key.Name, g.Min(r => r.ValidFrom)))
            .OrderBy(j => j.Name)
            .ToList();

    public async Task<List<OrderSummaryDto>> ListAsync(Guid? clientId, Guid? contractId, OrderStatus? status,
        OrderApprovalStatus? approvalStatus = null, string? rh = null, CancellationToken ct = default)
    {
        Func<Order, bool> rhFilter = rh switch
        {
            null or "" => _ => true,
            "UNASSIGNED" => o => o.AwaitingRhAssignment,
            "MINE" => o => user.UserId is { } me && o.IsRhAnalyst(me),
            var id when Guid.TryParse(id, out var analyst) => o => o.IsRhAnalyst(analyst),
            _ => throw new BusinessRuleException("Filtro de analista de RH inválido.", "rh"),
        };
        var list = await orders.ListAsync(clientId, contractId, ct);
        // Pedidos avulsos (D1) só aparecem no filtro do RH: as reposições deles também precisam de responsável.
        return list.Where(o => !o.IsLegacy || !string.IsNullOrEmpty(rh))
            .Where(rhFilter)
            .Where(o => approvalStatus is null || o.ApprovalStatus == approvalStatus)
            .Select(ToSummary)
            .Where(o => status is null || o.Status == status)
            .OrderByDescending(o => o.Number)
            .ToList();
    }

    public async Task<OrderDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        var settings = await parameters.GetCalcSettingsAsync(ct);
        var today = clock.Today;
        var showMoney = Permissions.CanSeeDetailedValues(user);
        var names = (await users.ListByIdsAsync(new[] { order.CreatedBy, order.ApprovalRecordedBy, order.JobconvoRecordedBy }
            .Concat(order.RhAnalysts.SelectMany(a => new[] { a.AssignedBy, a.RemovedBy }))
            .Concat(order.Positions.SelectMany(p => new[] { p.FirstDayConfirmedBy, p.ExitTermination?.CreatedBy }))
            .OfType<Guid>().Distinct(), ct))
            .ToDictionary(u => u.Id, u => u.Name);
        var createdBy = order.CreatedBy is { } c ? names.GetValueOrDefault(c) : null;

        var metrics = order.Positions.ToDictionary(p => p.Id, p => PositionCalculator.Calculate(p, today, settings));
        var positionDtos = order.Positions
            .Where(p => !PositionCalculator.IsLegacyOrigin(p))
            .OrderBy(p => p.SlotNumber).ThenBy(p => p.Cycle)
            .Select(p => PositionMapper.ToSummary(p, metrics[p.Id], showMoney))
            .ToList();
        var slots = BuildSlots(order, metrics, names, showMoney);

        return new OrderDetailDto(ToSummary(order), order.ContractId, order.JobRoleId, order.WorkLocationId, order.TermType,
            order.TermEndDate, order.TermDurationDays, order.Notes, order.JobDescription, createdBy,
            CanAddPositions: user.IsInRole(Roles.Commercial) && !order.IsLegacy,
            CanCorrectDates: user.IsInRole(Roles.Admin) || order.CreatedBy == user.UserId,
            positionDtos,
            ContractingUnitLabel(order),
            order.ApprovalRecordedAt,
            order.ApprovalRecordedBy is { } a ? names.GetValueOrDefault(a) : null,
            order.NotApprovedReason,
            CanDecideApproval: order.ApprovalStatus == OrderApprovalStatus.AWAITING_CLIENT_APPROVAL
                               && user.IsInAnyRole([Roles.Commercial, Roles.Controllership]),
            order.JobconvoPublished is { } published
                ? new JobconvoDto(published, order.JobconvoCode, order.JobconvoPublishedAt, order.JobconvoNotes,
                    order.JobconvoRecordedAt, order.JobconvoRecordedBy is { } j ? names.GetValueOrDefault(j) : null)
                : null,
            CanRecordJobconvo: RhAccess.CanAct(user, order) && order.ApprovalStatus != OrderApprovalStatus.NOT_APPROVED,
            order.ActiveRhAnalysts.Select(a => new RhAnalystDto(a.UserId, a.UserName)).ToList(),
            order.RhAnalysts.OrderByDescending(a => a.RemovedAt ?? a.AssignedAt).ThenBy(a => a.UserName)
                .Select(a => new RhAssignmentDto(a.UserId, a.UserName, a.AssignedAt,
                    a.AssignedBy is { } by ? names.GetValueOrDefault(by) : null, a.RemovedAt,
                    a.RemovedBy is { } rb ? names.GetValueOrDefault(rb) : null))
                .ToList(),
            CanAssignRh: user.IsInRole(Roles.RhManager) && order.ApprovalStatus != OrderApprovalStatus.NOT_APPROVED,
            slots);
    }

    /// <summary>Agrupa os ciclos por vaga: a linha mostra o ciclo atual; os anteriores formam o histórico de ocupantes.</summary>
    private static List<SlotDto> BuildSlots(Order order, IReadOnlyDictionary<Guid, PositionMetrics> metrics,
        IReadOnlyDictionary<Guid, string> names, bool showMoney)
    {
        string? Name(Guid? id) => id is { } u ? names.GetValueOrDefault(u) : null;
        string? OccupantName(Position p) => p.EmployeeName ?? p.ActiveCandidate?.FullName;

        return order.Positions
            .GroupBy(p => p.SlotNumber)
            .OrderBy(g => g.Key)
            .Select(g =>
            {
                var cycles = g.OrderBy(p => p.Cycle).ToList();
                var current = cycles.LastOrDefault(p => p.IsCurrentCycle) ?? cycles.Last();
                var counted = cycles.Where(p => !PositionCalculator.IsLegacyOrigin(p)).ToList();
                var occupants = cycles.Select(p =>
                {
                    var exit = p.ExitTermination;
                    var next = exit?.ReplacementPosition;
                    return new OccupantDto(
                        p.Id, p.Cycle, p.DemandType, p.Status, p.IsCurrentCycle, p.NotReplaced, OccupantName(p),
                        p.EmployeeRegistration ?? p.AdmissionRegistration, p.EmployeeName is null && p.ActiveCandidate is not null,
                        p.OpenedAt, p.AdmissionAt, p.FirstDayAt, Name(p.FirstDayConfirmedBy), exit?.LastWorkedDay,
                        exit?.TerminationType, exit?.Notes, exit?.RegisteredAt, Name(exit?.CreatedBy), exit?.CreatedAt,
                        next?.Id, next is null ? null : OccupantName(next), PositionCalculator.IsLegacyOrigin(p));
                }).ToList();
                return new SlotDto(
                    g.Key,
                    PositionMapper.ToSummary(current, metrics[current.Id], showMoney),
                    counted.Sum(p => metrics[p.Id].UncoveredDays),
                    showMoney ? counted.Sum(p => metrics[p.Id].Lost ?? 0m) : null,
                    showMoney ? counted.Sum(p => metrics[p.Id].Deferred ?? 0m) : null,
                    cycles.Count(p => p.DemandType == DemandType.REPLACEMENT),
                    occupants);
            })
            .ToList();
    }

    /// <summary>
    /// Gestor de RH distribui o pedido entre analistas de RH ativos (inclui, substitui ou remove). Quem entra e quem sai
    /// é avisado; as remoções são lógicas e formam o histórico.
    /// </summary>
    public async Task<OrderDetailDto> SetRhAnalystsAsync(Guid id, SetRhAnalystsRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.RhManager);
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        var requested = (r.AnalystIds ?? []).Distinct().ToList();
        var analysts = (await users.ListActiveByRolesAsync([Roles.Rh], ct)).ToDictionary(u => u.Id);
        if (requested.Any(a => !analysts.ContainsKey(a)))
            throw new BusinessRuleException("Selecione apenas usuários ativos com o perfil Analista de RH.", "analystIds");

        var (added, removed) = order.SetRhAnalysts(requested.Select(a => (a, analysts[a].Name)).ToList(), user.UserId, clock.UtcNow);
        if (added.Count == 0 && removed.Count == 0) return await GetAsync(order.Id, ct);

        var team = order.ActiveRhAnalysts.Any() ? string.Join(", ", order.ActiveRhAnalysts.Select(a => a.UserName)) : "nenhum";
        if (added.Count > 0)
            await NotifyTeamChangeAsync(order, NotificationTypes.RhAssigned, "Você é responsável por um pedido",
                $"Você passou a ser responsável pelo atendimento deste pedido. Equipe atual: {team}.", added, ct);
        if (removed.Count > 0)
            await NotifyTeamChangeAsync(order, NotificationTypes.RhUnassigned, "Você não é mais responsável por um pedido",
                $"Você não é mais responsável pelo atendimento deste pedido. Equipe atual: {team}.", removed, ct);

        audit.Set("ASSIGN_RH", null);
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    private Task NotifyTeamChangeAsync(Order order, string type, string subject, string intro,
        IEnumerable<OrderRhAnalyst> analysts, CancellationToken ct)
    {
        var quantity = order.Positions.Count(p => p.DemandType == DemandType.NEW);
        var message =
            $"Pedido {order.Number} — {intro} "
            + $"Cliente: {order.Contract?.Client?.LegalName}. Unidade contratante: {ContractingUnitLabel(order)}. "
            + $"Cargo: {order.JobRole?.Name}. Vagas: {quantity}.";
        return notifications.NotifyAsync(new EventMessage(type, order.Id, $"{subject} — Pedido {order.Number}", message,
            links.Order(order.Id)), userIds: analysts.Select(a => a.UserId), ct: ct);
    }

    /// <summary>
    /// RN-06 no pedido (RH): uma publicação no JobConvo atende todas as posições. As abertas entram em recrutamento;
    /// as acrescentadas e as reposições confirmadas depois herdam. Atualizar a publicação reflete em todas.
    /// </summary>
    public async Task<OrderDetailDto> RecordJobconvoAsync(Guid id, RecordJobconvoRequest r, CancellationToken ct = default)
    {
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        RhAccess.Require(user, order);
        var retroactive = false;
        if (r.Published && r.PublishedAt is { } date)
        {
            DateGuard.NotFuture(date, clock.Today, "A data da publicação", "publishedAt");
            retroactive = DateGuard.CheckRetroactive(date, clock.Today, await parameters.IsInitialLoadOpenAsync(ct),
                r.Justification, "A data da publicação");
        }

        var started = order.RecordJobconvo(r.Published, r.Code, r.PublishedAt, r.Justification, user.UserId, clock.UtcNow);
        if (retroactive)
            foreach (var p in started) p.MarkRetroactive();

        audit.Set("RECORD_JOBCONVO", order.JobconvoNotes);
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>Aprovação formal do cliente (Comercial ou Controladoria): as vagas novas abrem e o SLA começa.</summary>
    public async Task<OrderDetailDto> ApproveAsync(Guid id, ApproveOrderRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial, Roles.Controllership);
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        var today = clock.Today;
        DateGuard.NotFuture(r.Date, today, "A data da aprovação", "date");
        var retroactive = DateGuard.CheckRetroactive(r.Date, today, await parameters.IsInitialLoadOpenAsync(ct), r.Justification,
            "A data da aprovação");

        foreach (var position in order.Approve(r.Date, user.UserId, clock.UtcNow))
        {
            var (days, source) = await snapshots.SlaAsync(order.Contract!, order.Modality, DemandType.NEW, r.Date, ct);
            position.OpenOnApproval(r.Date, days, source);
            if (retroactive) position.MarkRetroactive();
        }

        await NotifyEveryoneAsync(order, NotificationTypes.OrderApproved, "Pedido aprovado pelo cliente",
            $"A demanda foi aprovada formalmente pelo cliente em {r.Date:dd/MM/yyyy}; as posições estão abertas.", ct);
        audit.Set("APPROVE_ORDER", DateGuard.Clean(r.Justification));
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>O cliente não aprovou: as posições são encerradas como "cliente cancelou", sem perda em R$.</summary>
    public async Task<OrderDetailDto> RejectAsync(Guid id, RejectOrderRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial, Roles.Controllership);
        var order = await orders.GetAsync(id, ct) ?? throw new NotFoundException("Pedido não encontrado.");
        DateGuard.NotFuture(r.Date, clock.Today, "A data da decisão", "date");
        order.Reject(r.Date, r.Reason, user.UserId, clock.UtcNow);

        await NotifyEveryoneAsync(order, NotificationTypes.OrderNotApproved, "Pedido não aprovado pelo cliente",
            $"O cliente não aprovou a demanda ({order.NotApprovedReason}); as posições foram encerradas.", ct);
        audit.Set("NOT_APPROVE_ORDER", order.NotApprovedReason);
        await uow.SaveChangesAsync(ct);
        return await GetAsync(order.Id, ct);
    }

    /// <summary>Unidade contratante do contrato, ou o cliente principal quando o contrato não tem unidade.</summary>
    private static string ContractingUnitLabel(Order order) =>
        order.Contract?.ContractingUnit is { } unit ? $"{unit.Code} — {unit.Name}" : "Cliente principal";

    /// <summary>Notificação a todos os usuários ativos, identificando pedido, cliente, unidade, cargo, vagas e status.</summary>
    private Task NotifyEveryoneAsync(Order order, string type, string subject, string intro, CancellationToken ct)
    {
        var quantity = order.Positions.Count(p => p.DemandType == DemandType.NEW);
        var message =
            $"Pedido {order.Number} — {intro} "
            + $"Cliente: {order.Contract?.Client?.LegalName}. Unidade contratante: {ContractingUnitLabel(order)}. "
            + $"Cargo: {order.JobRole?.Name}. Vagas: {quantity}. Status: {Labels.Of(order.ApprovalStatus)}.";
        return notifications.NotifyAsync(new EventMessage(type, order.Id, $"{subject} — {order.JobRole?.Name}", message,
            links.Order(order.Id)), roles: Roles.All, ct: ct);
    }

    /// <summary>
    /// Cria as vagas novas. <paramref name="openedAt"/> nulo = aguardando a aprovação (sem abertura nem meta, gravadas
    /// na aprovação); o valor é a versão validada vigente em <paramref name="rateDate"/>.
    /// </summary>
    private async Task<List<Position>> AddPositionsAsync(Order order, int quantity, DateOnly desiredStartDate, DateOnly? openedAt,
        DateOnly rateDate, bool retroactive, int firstSequence, CancellationToken ct)
    {
        var rate = await snapshots.ValidatedRateAsync(order.ContractId, order.JobRoleId, rateDate, ct);
        // Vagas novas continuam a numeração das vagas do pedido (as reposições não consomem números de vaga).
        var firstSlot = order.Positions.Select(p => p.SlotNumber).DefaultIfEmpty(0).Max() + 1;
        var (slaDays, slaSource) = openedAt is { } opened
            ? await snapshots.SlaAsync(order.Contract!, order.Modality, DemandType.NEW, opened, ct)
            : (null, SlaTargetSource.NONE);
        var created = new List<Position>();
        for (var i = 0; i < quantity; i++)
        {
            var p = Position.CreateNew(order, firstSequence + i, desiredStartDate, openedAt, rate, slaDays, slaSource, firstSlot + i);
            if (retroactive) p.MarkRetroactive();
            order.Positions.Add(p);
            created.Add(p);
        }
        return created;
    }

    private static OrderSummaryDto ToSummary(Order o) => new(
        o.Id, o.Number, o.Contract?.Client?.LegalName ?? "", o.Contract?.Name ?? "", o.Modality, o.JobRole?.Name ?? "",
        o.WorkLocation?.Name ?? "", o.Quantity, o.ClientRequestDate, o.DesiredStartDate, o.RegisteredAt, o.Status,
        o.CurrentPositions.Count(p => p.IsOpen), o.CurrentPositions.Count(p => p.Status == PositionStatus.FILLED), o.IsLegacy,
        o.ApprovalStatus, o.ClientDecisionDate, o.JobconvoPublished, o.JobconvoCode,
        o.ActiveRhAnalysts.Select(a => a.UserName).ToList(), o.AwaitingRhAssignment,
        o.Positions.Count(p => p.DemandType == DemandType.REPLACEMENT));
}

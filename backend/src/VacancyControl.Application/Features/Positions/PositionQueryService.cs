using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Parameters;

namespace VacancyControl.Application.Features.Positions;

public sealed record PositionListRequest
{
    public PositionFilter Filter { get; init; } = new();
    public IReadOnlyCollection<SlaSituation>? SlaSituations { get; init; }
    /// <summary>"uncovered" = mais dias descobertos primeiro; padrão = pedidos mais recentes primeiro.</summary>
    public string? Sort { get; init; }
    public int Page { get; init; } = 1;
    public int PageSize { get; init; } = 50;
    /// <summary>Analistas de RH: "MINE" (do usuário), "UNASSIGNED" (sem responsável) ou o id do analista.</summary>
    public string? Rh { get; init; }
    /// <summary>Inclui os ciclos anteriores das vagas (ocupantes desligados); o padrão é só o ciclo atual.</summary>
    public bool AllCycles { get; init; }
}

public class PositionQueryService(
    IPositionRepository positions,
    IAuditLogRepository auditLogs,
    IUserDirectory users,
    ParameterService parameters,
    IClock clock,
    ICurrentUser user)
{
    public async Task<PagedResult<PositionSummaryDto>> ListAsync(PositionListRequest request, CancellationToken ct = default)
    {
        var settings = await parameters.GetCalcSettingsAsync(ct);
        var today = clock.Today;
        var showMoney = Permissions.CanSeeDetailedValues(user);

        var baseFilter = request.Filter with { CurrentCycleOnly = !request.AllCycles };
        var filter = request.Rh switch
        {
            null or "" => baseFilter,
            "UNASSIGNED" => baseFilter with { RhUnassigned = true },
            "MINE" => baseFilter with { RhAnalystId = user.UserId ?? Guid.Empty },
            var id when Guid.TryParse(id, out var analyst) => baseFilter with { RhAnalystId = analyst },
            _ => throw new BusinessRuleException("Filtro de analista de RH inválido.", "rh"),
        };
        var rows = (await positions.ListDetailedAsync(filter, ct))
            .Where(p => !PositionCalculator.IsLegacyOrigin(p))
            .Select(p => PositionMapper.ToSummary(p, PositionCalculator.Calculate(p, today, settings), showMoney));

        if (request.SlaSituations is { Count: > 0 } situations)
            rows = rows.Where(r => r.SlaSituation is { } s && situations.Contains(s));

        rows = request.Sort == "uncovered"
            ? rows.OrderByDescending(r => r.UncoveredDays).ThenBy(r => r.OrderNumber)
            : rows.OrderByDescending(r => r.OrderNumber).ThenBy(r => r.SlotNumber).ThenBy(r => r.Cycle);

        var all = rows.ToList();
        var pageSize = Math.Clamp(request.PageSize, 1, 500);
        var page = Math.Max(1, request.Page);
        return new PagedResult<PositionSummaryDto>(all.Skip((page - 1) * pageSize).Take(pageSize).ToList(), all.Count);
    }

    public async Task<PositionDetailDto> GetAsync(Guid id, CancellationToken ct = default)
    {
        var p = await positions.GetDetailedAsync(id, ct) ?? throw new NotFoundException("Posição não encontrada.");
        var settings = await parameters.GetCalcSettingsAsync(ct);
        var metrics = PositionCalculator.Calculate(p, clock.Today, settings);
        var showMoney = Permissions.CanSeeDetailedValues(user);
        var order = p.Order!;
        var fullCandidate = CandidatePrivacy.CanSeeFullData(user, order);
        var candidateNames = (await users.ListByIdsAsync(
                p.Candidates.SelectMany(c => new[] { c.CreatedBy, c.UpdatedBy })
                    .Concat(p.Evidences.Select(e => e.CreatedBy)).Append(p.FirstDayConfirmedBy)
                    .OfType<Guid>().Distinct(), ct))
            .ToDictionary(u => u.Id, u => u.Name);
        var canDownload = EvidenceAccess.CanDownload(user, order);
        var firstDayEvidence = p.Evidences.Where(e => e.Kind == EvidenceKind.FIRST_DAY).MaxBy(e => e.CreatedAt);

        return new PositionDetailDto(
            PositionMapper.ToSummary(p, metrics, showMoney),
            order.ClientRequestDate, order.RegisteredAt, p.DesiredStartDate, order.Notes, order.JobDescription, order.IsLegacy, order.ClientDecisionDate,
            order.JobconvoPublished, order.JobconvoCode, order.JobconvoPublishedAt, order.JobconvoNotes, p.CandidateApprovedAt, p.AdmissionAt, p.FirstDayAt,
            p.EmployeeName, p.EmployeeRegistration, p.ClosedAt, p.CancellationReason,
            p.TermType, p.TermEndDate, p.TermDurationDays, p.TermAdjustJustification,
            p.Termination is null ? null : PositionMapper.ToDto(p.Termination),
            p.ExitTermination is null ? null : PositionMapper.ToDto(p.ExitTermination),
            p.Pauses.OrderBy(x => x.StartDate)
                .Select(x => new PauseDto(x.Id, x.ReasonId, x.Reason?.Name ?? "", x.StartDate, x.EndDate, x.DaysUntil(clock.Today)))
                .ToList(),
            PositionMapper.ToMetrics(p, metrics, showMoney),
            PositionActions.For(p, user),
            await HistoryAsync(p, fullCandidate, ct),
            order.ActiveRhAnalysts.Select(a => new RhAnalystDto(a.UserId, a.UserName)).ToList(),
            RhAccess.CanAct(user, order),
            p.ActiveCandidate is { } active ? CandidatePrivacy.ToDto(active, fullCandidate, candidateNames) : null,
            p.Candidates.Where(c => !c.IsActive).OrderByDescending(c => c.WithdrawnAt)
                .Select(c => CandidatePrivacy.ToDto(c, fullCandidate, candidateNames)).ToList(),
            p.AdmissionRegistration,
            p.FirstDayAt is { } firstDay
                ? new FirstDayConfirmationDto(firstDay, p.FirstDayJustification, p.FirstDayConfirmedAt,
                    p.FirstDayConfirmedBy is { } fb ? candidateNames.GetValueOrDefault(fb) : null,
                    firstDayEvidence is null ? null : new EvidenceDto(firstDayEvidence.Id, firstDayEvidence.FileName,
                        firstDayEvidence.ContentType, firstDayEvidence.SizeBytes, firstDayEvidence.CreatedAt,
                        firstDayEvidence.CreatedBy is { } eb ? candidateNames.GetValueOrDefault(eb) : null, canDownload))
                : null);
    }

    private async Task<List<HistoryEntryDto>> HistoryAsync(Position p, bool fullCandidate, CancellationToken ct)
    {
        var ids = new List<Guid> { p.Id };
        ids.AddRange(p.Pauses.Select(x => x.Id));
        ids.AddRange(p.Candidates.Select(x => x.Id));
        ids.AddRange(p.Evidences.Select(x => x.Id));
        if (p.TerminationId is { } t) ids.Add(t);
        if (p.ExitTermination is { } exit) ids.Add(exit.Id);

        var logs = await auditLogs.ListForEntitiesAsync(ids, ct);
        var names = (await users.ListByIdsAsync(logs.Select(l => l.UserId).OfType<Guid>().Distinct(), ct))
            .ToDictionary(u => u.Id, u => u.Name);

        return logs.OrderByDescending(l => l.Timestamp).ThenByDescending(l => l.Id)
            .Where(l => !IsNoise(l))
            .Select(l => new HistoryEntryDto(l.Timestamp, l.UserId is { } u ? names.GetValueOrDefault(u) : "Sistema",
                l.Entity, l.Action, l.Field, Protect(l, l.OldValue, fullCandidate), Protect(l, l.NewValue, fullCandidate),
                l.Justification))
            .ToList();
    }

    /// <summary>Dados pessoais do candidato no histórico: mascarados para quem não vê os dados completos (LGPD).</summary>
    private static string? Protect(AuditLog l, string? value, bool fullCandidate)
    {
        if (fullCandidate || value is null || l.Entity != nameof(Candidate)) return value;
        return l.Field switch
        {
            nameof(Candidate.Cpf) => Cpf.Mask(value),
            nameof(Candidate.BirthDate) or nameof(Candidate.Sex) => "(restrito)",
            null => "(dados do candidato restritos)",
            _ => value,
        };
    }

    /// <summary>Campos técnicos que não interessam no histórico da tela.</summary>
    private static bool IsNoise(AuditLog l) =>
        l.Field is "UpdatedAt" or "UpdatedBy" or "FirstDayConfirmedAt" or "FirstDayConfirmedBy" or "StorageKey";
}

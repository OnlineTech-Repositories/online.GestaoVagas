using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Positions;

public sealed record PositionSummaryDto(
    Guid Id, Guid OrderId, long OrderNumber, int Sequence, string ClientName, string ContractName, string GroupEntityName,
    Modality Modality, string JobRoleName, string WorkLocationName, DemandType DemandType, PositionStatus Status,
    PositionStatus StageStatus, DateOnly? OpenedAt, DateOnly UncoveredStart, int UncoveredDays, int PausedDays, int? FillTime,
    int? SlaTargetDays, DateOnly? SlaDeadline, SlaSituation? SlaSituation, decimal? Lost, decimal? Deferred,
    MoneyStatus? MoneyStatus, string? EmployeeName, string? JobconvoCode, bool HasRetroactiveDates, DateTimeOffset LastUpdate,
    OrderApprovalStatus OrderApprovalStatus, IReadOnlyList<string> RhAnalystNames, string? CandidateName,
    int SlotNumber, int Cycle, bool IsCurrentCycle, bool NotReplaced);

/// <summary>
/// Candidato selecionado. Para quem não vê os dados completos (LGPD), <see cref="Cpf"/> vem mascarado e
/// <see cref="BirthDate"/>/<see cref="Sex"/> vêm nulos (<see cref="Restricted"/> = true).
/// </summary>
public sealed record CandidateDto(
    Guid Id, string FullName, DateOnly? BirthDate, CandidateSex? Sex, string Cpf, bool Restricted, DateOnly ApprovedAt,
    DateTimeOffset RecordedAt, string? RecordedByName, DateTimeOffset? UpdatedAt, string? UpdatedByName,
    DateTimeOffset? WithdrawnAt, string? WithdrawalReason);

/// <summary>Analista de RH responsável pelo pedido.</summary>
public sealed record RhAnalystDto(Guid Id, string Name);

public sealed record PauseDto(Guid Id, Guid ReasonId, string ReasonName, DateOnly StartDate, DateOnly? EndDate, int Days);

public sealed record TerminationDto(
    Guid Id, Guid OriginPositionId, string? OriginEmployeeName, string? OriginEmployeeRegistration, DateOnly LastWorkedDay,
    TerminationSource Source, TerminationType TerminationType, string? Notes, ClientDecision? ClientDecision,
    DateOnly? ClientDecisionAt, DateOnly RegisteredAt, Guid? ReplacementPositionId);

public sealed record MetricsDto(
    int UncoveredDays, DateOnly UncoveredStart, DateOnly UncoveredEndExclusive, int PausedDays, int? RegistrationTime,
    int? CommunicationTime, int? ConfirmationTime, int? FillTime, int? SlaTargetDays, SlaTargetSource SlaTargetSource,
    DateOnly? SlaDeadline, SlaSituation? SlaSituation, decimal? DailyValue, decimal? Lost, decimal? Deferred, MoneyStatus? MoneyStatus,
    int? ApprovalWaitTime);

public sealed record HistoryEntryDto(
    DateTimeOffset Timestamp, string? UserName, string Entity, string Action, string? Field, string? OldValue,
    string? NewValue, string? Justification);

public sealed record PositionDetailDto(
    PositionSummaryDto Summary,
    DateOnly ClientRequestDate, DateOnly OrderRegisteredAt, DateOnly DesiredStartDate, string? OrderNotes, string? JobDescription,
    bool IsLegacyOrder, DateOnly? OrderClientDecisionDate,
    bool? JobconvoPublished, string? JobconvoCode, DateOnly? JobconvoPublishedAt, string? JobconvoNotes, DateOnly? CandidateApprovedAt, DateOnly? AdmissionAt, DateOnly? FirstDayAt,
    string? EmployeeName, string? EmployeeRegistration, DateOnly? ClosedAt, string? CancellationReason,
    TermType TermType, DateOnly? TermEndDate, int? TermDurationDays, string? TermAdjustJustification,
    TerminationDto? Termination, TerminationDto? ExitTermination, IReadOnlyList<PauseDto> Pauses, MetricsDto Metrics,
    IReadOnlyList<string> AllowedActions, IReadOnlyList<HistoryEntryDto> History, IReadOnlyList<RhAnalystDto> RhAnalysts,
    bool CanActAsRh, CandidateDto? Candidate, IReadOnlyList<CandidateDto> PreviousCandidates, string? AdmissionRegistration,
    FirstDayConfirmationDto? FirstDay);

/// <summary>Arquivo de evidência: <see cref="CanDownload"/> = o usuário pode baixar (RH do pedido, NACC, DP e Gestor).</summary>
public sealed record EvidenceDto(
    Guid Id, string FileName, string ContentType, long SizeBytes, DateTimeOffset UploadedAt, string? UploadedByName, bool CanDownload);

/// <summary>Confirmação do 1º dia efetivo: justificativa, quem confirmou, quando e a evidência anexada.</summary>
public sealed record FirstDayConfirmationDto(
    DateOnly Date, string? Justification, DateTimeOffset? ConfirmedAt, string? ConfirmedByName, EvidenceDto? Evidence);

/// <summary>Ações da tela de detalhe: perfil autorizado (matriz 4.1) + status atual (seção 6).</summary>
public static class PositionActions
{
    public const string Decide = "DECIDE";
    public const string ApproveCandidate = "APPROVE_CANDIDATE";
    public const string RegisterAdmission = "REGISTER_ADMISSION";
    public const string ConfirmFirstDay = "CONFIRM_FIRST_DAY";
    public const string CandidateWithdrew = "CANDIDATE_WITHDREW";
    public const string AdmissionNoShow = "ADMISSION_NO_SHOW";
    public const string StartPause = "START_PAUSE";
    public const string EndPause = "END_PAUSE";
    public const string Cancel = "CANCEL";
    public const string AdjustTerm = "ADJUST_TERM";
    public const string RegisterTermination = "REGISTER_TERMINATION";
    public const string CorrectDates = "CORRECT_DATES";
    public const string CorrectCandidate = "CORRECT_CANDIDATE";
    public const string CorrectRegistration = "CORRECT_REGISTRATION";

    private static readonly Dictionary<string, string[]> AllowedRoles = new()
    {
        [Decide] = [Roles.Nacc],
        [ApproveCandidate] = [Roles.Rh, Roles.RhManager],
        [RegisterAdmission] = [Roles.Rh, Roles.RhManager],
        [ConfirmFirstDay] = [Roles.Nacc],
        [CandidateWithdrew] = [Roles.Rh, Roles.RhManager],
        [CorrectCandidate] = [Roles.Rh, Roles.RhManager],
        // A matrícula vem da admissão (RH do pedido) e costuma ser gerada pelo DP.
        [CorrectRegistration] = [Roles.Rh, Roles.RhManager, Roles.Dp],
        [AdmissionNoShow] = [Roles.Rh, Roles.RhManager, Roles.Nacc],
        [StartPause] = [Roles.Nacc],
        [EndPause] = [Roles.Nacc],
        [Cancel] = [Roles.Commercial, Roles.Nacc],
        [AdjustTerm] = [Roles.Nacc],
        [RegisterTermination] = [Roles.Dp, Roles.Nacc],
        // A autoria de cada marco é verificada na correção; ADMIN corrige qualquer data.
        [CorrectDates] = [Roles.Commercial, Roles.Nacc, Roles.Dp, Roles.Rh, Roles.RhManager, Roles.Admin],
    };

    /// <summary>Execução do recrutamento: o Analista de RH age só nos pedidos atribuídos a ele.</summary>
    private static readonly HashSet<string> RhExecution =
        [ApproveCandidate, RegisterAdmission, CandidateWithdrew, AdmissionNoShow, CorrectCandidate, CorrectRegistration];

    public static IReadOnlyList<string> For(Position p, ICurrentUser user) =>
        AllowedRoles.Keys.Where(action => RoleAllows(p, user, action) && StatusAllows(p, action)).ToList();

    /// <summary>Verificação no backend do perfil exigido pela ação (o status é validado pelo domínio).</summary>
    public static void EnsureRole(Position p, ICurrentUser user, string action)
    {
        if (RoleAllows(p, user, action)) return;
        if (RhExecution.Contains(action) && user.IsInRole(Roles.Rh)) RhAccess.Require(user, p.Order!);
        throw new ForbiddenException();
    }

    private static bool RoleAllows(Position p, ICurrentUser user, string action)
    {
        var roles = AllowedRoles[action];
        if (!RhExecution.Contains(action)) return user.IsInAnyRole(roles);
        // Outros perfis da ação (Gestor de RH, NACC) valem sempre; o Analista de RH, só se for responsável pelo pedido.
        return user.IsInAnyRole(roles.Where(r => r != Roles.Rh))
               || (user.IsInRole(Roles.Rh) && p.Order is { } order && RhAccess.CanAct(user, order));
    }

    private static bool StatusAllows(Position p, string action) => action switch
    {
        Decide => p.Status == PositionStatus.AWAITING_CONFIRMATION,
        // Antes da aprovação do cliente, a posição avança só até "Em recrutamento".
        ApproveCandidate => p.Status == PositionStatus.RECRUITING && p.Order?.IsApproved != false,
        RegisterAdmission => p.Status == PositionStatus.CANDIDATE_APPROVED && p.Order?.IsApproved != false,
        CandidateWithdrew => p.Status == PositionStatus.CANDIDATE_APPROVED,
        CorrectCandidate => p.ActiveCandidate is not null || p.CanRegisterMissingCandidate,
        CorrectRegistration => p.IsAdmitted,
        ConfirmFirstDay => p.Status == PositionStatus.AWAITING_FIRST_DAY && p.Order?.IsApproved != false,
        AdmissionNoShow => p.IsAdmitted,
        StartPause => p.IsOpen && p.Status != PositionStatus.PAUSED,
        EndPause => p.Status == PositionStatus.PAUSED,
        Cancel or AdjustTerm => p.IsOpen,
        RegisterTermination => p.Status == PositionStatus.FILLED && p.ExitTermination is null,
        CorrectDates => true,
        _ => false
    };
}

public static class PositionMapper
{
    public static PositionSummaryDto ToSummary(Position p, PositionMetrics m, bool showMoney)
    {
        var order = p.Order!;
        var contract = order.Contract!;
        return new PositionSummaryDto(
            p.Id, p.OrderId, order.Number, p.Sequence, contract.Client?.LegalName ?? "", contract.Name,
            contract.GroupEntity?.Name ?? "", order.Modality, order.JobRole?.Name ?? "", order.WorkLocation?.Name ?? "",
            p.DemandType, p.Status, p.StageStatus, p.OpenedAt, m.UncoveredStart, m.UncoveredDays, m.PausedDays, m.FillTime,
            p.SlaTargetDays, m.SlaDeadline, m.SlaSituation,
            showMoney ? m.Lost : null, showMoney ? m.Deferred : null, showMoney ? m.MoneyStatus : null,
            p.EmployeeName, order.JobconvoCode, p.HasRetroactiveDates, p.UpdatedAt ?? p.CreatedAt, order.ApprovalStatus,
            order.ActiveRhAnalysts.Select(a => a.UserName).ToList(), p.ActiveCandidate?.FullName,
            p.SlotNumber, p.Cycle, p.IsCurrentCycle, p.NotReplaced);
    }

    public static MetricsDto ToMetrics(Position p, PositionMetrics m, bool showMoney) => new(
        m.UncoveredDays, m.UncoveredStart, m.UncoveredEndExclusive, m.PausedDays, m.RegistrationTime, m.CommunicationTime,
        m.ConfirmationTime, m.FillTime, p.SlaTargetDays, p.SlaTargetSource, m.SlaDeadline, m.SlaSituation,
        showMoney ? m.DailyValue : null, showMoney ? m.Lost : null, showMoney ? m.Deferred : null,
        showMoney ? m.MoneyStatus : null, m.ApprovalWaitTime);

    public static TerminationDto ToDto(Termination t) => new(
        t.Id, t.OriginPositionId, t.OriginPosition?.EmployeeName, t.OriginPosition?.EmployeeRegistration, t.LastWorkedDay,
        t.Source, t.TerminationType, t.Notes, t.ClientDecision, t.ClientDecisionAt, t.RegisteredAt, t.ReplacementPosition?.Id);
}

/// <summary>Quem vê os dados completos do candidato (LGPD): RH do pedido (analistas responsáveis e Gestor de RH), NACC e DP.</summary>
public static class CandidatePrivacy
{
    public static bool CanSeeFullData(ICurrentUser user, Order order) =>
        RhAccess.CanAct(user, order) || user.IsInAnyRole([Roles.Nacc, Roles.Dp]);

    public static CandidateDto ToDto(Candidate c, bool full, IReadOnlyDictionary<Guid, string> names) => new(
        c.Id, c.FullName, full ? c.BirthDate : null, full ? c.Sex : null, full ? Cpf.Format(c.Cpf) : Cpf.Mask(c.Cpf), !full,
        c.ApprovedAt, c.CreatedAt, c.CreatedBy is { } by ? names.GetValueOrDefault(by) : null,
        c.UpdatedAt, c.UpdatedBy is { } up ? names.GetValueOrDefault(up) : null, c.WithdrawnAt, c.WithdrawalReason);
}

/// <summary>Quem baixa as evidências da posição: RH do pedido, NACC, DP e Gestor.</summary>
public static class EvidenceAccess
{
    public static bool CanDownload(ICurrentUser user, Order order) =>
        CandidatePrivacy.CanSeeFullData(user, order) || user.IsInRole(Roles.Manager);
}

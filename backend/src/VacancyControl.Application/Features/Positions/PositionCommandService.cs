using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Parameters;

namespace VacancyControl.Application.Features.Positions;

public sealed record DateRequest(DateOnly Date, string? Justification);
public sealed record NoteRequest(string? Justification);
public sealed record DecisionRequest(ClientDecision Decision, DateOnly DecisionAt, string? Justification);
/// <summary>Aprovação do candidato com os dados dele (nome, nascimento, sexo e CPF).</summary>
public sealed record ApproveCandidateRequest(
    DateOnly Date, string? FullName, DateOnly? BirthDate, CandidateSex? Sex, string? Cpf, string? Justification);
public sealed record CandidateRequest(string? FullName, DateOnly? BirthDate, CandidateSex? Sex, string? Cpf, string? Justification);
public sealed record AdmissionRequest(DateOnly Date, string? Registration, string? Justification);
/// <summary>1º dia: só a data e a justificativa. Nome e matrícula vêm do candidato e da admissão (não são alteráveis aqui).</summary>
public sealed record FirstDayRequest(DateOnly Date, string? Justification);
public sealed record RegistrationRequest(string? Registration, string? Justification);
public sealed record StartPauseRequest(Guid ReasonId, DateOnly StartDate, string? Justification);
public sealed record CancelRequest(DateOnly Date, string Reason);
public sealed record AdjustTermRequest(TermType TermType, DateOnly? TermEndDate, int? TermDurationDays, string Justification);

public enum CorrectableDate
{
    CANDIDATE_APPROVED_AT,
    ADMISSION_AT,
    FIRST_DAY_AT,
    CLOSED_AT,
    CLIENT_DECISION_AT,
    LAST_WORKED_DAY,
    TERMINATION_REGISTERED_AT,
    PAUSE_START,
    PAUSE_END
}

public sealed record CorrectDateRequest(CorrectableDate Field, Guid? PauseId, DateOnly Date, string Justification);

/// <summary>Ações sobre a posição: transições da seção 6, pausas, vigência e correção de datas.</summary>
public class PositionCommandService(
    IPositionRepository positions,
    IRepository<PauseReason> pauseReasons,
    IAuditLogRepository auditLogs,
    SnapshotService snapshots,
    ParameterService parameters,
    NotificationService notifications,
    PositionQueryService queries,
    IAppLinks links,
    IEvidenceStorage evidenceStorage,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    public Task<PositionDetailDto> DecideAsync(Guid id, DecisionRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.Decide, r.Justification, async p =>
        {
            var termination = p.Termination!;
            if (r.DecisionAt < termination.RegisteredAt)
                throw new BusinessRuleException("A decisão do cliente não pode ser anterior ao registro do desligamento.", "decisionAt");
            await CheckDateAsync(p, r.DecisionAt, "A data da decisão", r.Justification, "decisionAt", ct);

            if (r.Decision == ClientDecision.REPLACE)
            {
                var order = p.Order!;
                var (days, source) = await snapshots.SlaAsync(order.Contract!, order.Modality, DemandType.REPLACEMENT, r.DecisionAt, ct);
                p.ConfirmReplacement(r.DecisionAt, days, source);
                await NotifyAsync(p, NotificationTypes.ReplacementConfirmed, "Reposição confirmada pelo cliente",
                    order.HasJobconvoRecord
                        ? "O cliente confirmou a reposição. Ela entrou em recrutamento com a publicação no JobConvo do pedido."
                        : "O cliente confirmou a reposição. Informe a publicação no JobConvo no pedido para iniciar o recrutamento.",
                    [Roles.Rh], ct);
                return "CLIENT_DECISION_REPLACE";
            }

            p.DeclineReplacement(r.DecisionAt);
            return "CLIENT_DECISION_NOT_REPLACE";
        }, ct);

    public Task<PositionDetailDto> ApproveCandidateAsync(Guid id, ApproveCandidateRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.ApproveCandidate, r.Justification, async p =>
        {
            await CheckDateAsync(p, r.Date, "A data de aprovação", r.Justification, "date", ct);
            var candidate = p.ApproveCandidate(r.Date, new CandidateData(r.FullName, r.BirthDate, r.Sex, r.Cpf), clock.Today);
            await EnsureCpfFreeAsync(p, candidate.Cpf, ct);
            return "APPROVE_CANDIDATE";
        }, ct);

    /// <summary>Correção dos dados do candidato pelo RH do pedido; quem e quando ficam no cadastro e no histórico.</summary>
    public Task<PositionDetailDto> CorrectCandidateAsync(Guid id, CandidateRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.CorrectCandidate, r.Justification, async p =>
        {
            var candidate = p.CorrectCandidate(new CandidateData(r.FullName, r.BirthDate, r.Sex, r.Cpf), clock.Today);
            await EnsureCpfFreeAsync(p, candidate.Cpf, ct);
            return "CORRECT_CANDIDATE";
        }, ct);

    /// <summary>O mesmo CPF não pode ser o candidato selecionado de duas posições abertas.</summary>
    private async Task EnsureCpfFreeAsync(Position p, string cpf, CancellationToken ct)
    {
        if (await positions.FindOpenWithCandidateCpfAsync(cpf, p.Id, ct) is { } other)
            throw new BusinessRuleException(
                $"Este CPF já é o candidato selecionado da posição {other.Order?.Number}-{other.SlotNumber}, ainda aberta.", "cpf");
    }

    public Task<PositionDetailDto> RegisterAdmissionAsync(Guid id, AdmissionRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.RegisterAdmission, r.Justification, async p =>
        {
            await CheckDateAsync(p, r.Date, "A data de admissão", r.Justification, "date", ct);
            p.RegisterAdmission(r.Date, r.Registration);
            await NotifyAsync(p, NotificationTypes.AdmissionRegistered, "Admissão registrada",
                p.Status == PositionStatus.AWAITING_FIRST_DAY
                    ? $"Admissão registrada em {r.Date:dd/MM/yyyy}, com matrícula. Confirme o 1º dia efetivo do colaborador."
                    : $"Admissão registrada em {r.Date:dd/MM/yyyy}, sem matrícula. A confirmação do 1º dia fica liberada quando o RH ou o DP informar a matrícula.",
                [Roles.Nacc], ct);
            return "REGISTER_ADMISSION";
        }, ct);

    /// <summary>
    /// NACC confirma o 1º dia: justificativa obrigatória e evidência opcional (PDF, JPG ou PNG até 10 MB), gravadas
    /// na mesma transação; quem confirmou e quando ficam na posição e no histórico.
    /// </summary>
    public Task<PositionDetailDto> ConfirmFirstDayAsync(Guid id, FirstDayRequest r, EvidenceUpload? evidence = null,
        CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.ConfirmFirstDay, r.Justification, async p =>
        {
            var file = evidence is null ? ((string, string)?)null : EvidenceFiles.Validate(evidence);
            await CheckDateAsync(p, r.Date, "O 1º dia efetivo", r.Justification, "date", ct);
            p.ConfirmFirstDay(r.Date, r.Justification, user.UserId, clock.UtcNow);
            if (file is var (name, type) && evidence is not null)
                p.AttachEvidence(EvidenceKind.FIRST_DAY, name, type, evidence.Content.Length, evidenceStorage.Add(evidence.Content));
            return "CONFIRM_FIRST_DAY";
        }, ct);

    /// <summary>Informa ou corrige a matrícula da admissão (RH do pedido ou DP), antes da confirmação do 1º dia.</summary>
    public Task<PositionDetailDto> CorrectRegistrationAsync(Guid id, RegistrationRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.CorrectRegistration, r.Justification, async p =>
        {
            if (p.SetAdmissionRegistration(r.Registration))
                await NotifyAsync(p, NotificationTypes.AdmissionRegistered, "Admissão concluída",
                    "A matrícula foi informada e a admissão está concluída. Confirme o 1º dia efetivo do colaborador.", [Roles.Nacc], ct);
            return "CORRECT_REGISTRATION";
        }, ct);

    /// <summary>Download da evidência: RH do pedido, NACC, DP e Gestor.</summary>
    public async Task<(byte[] Content, string ContentType, string FileName)> DownloadEvidenceAsync(Guid positionId, Guid evidenceId,
        CancellationToken ct = default)
    {
        var p = await positions.GetDetailedAsync(positionId, ct) ?? throw new NotFoundException("Posição não encontrada.");
        var evidence = p.Evidences.FirstOrDefault(e => e.Id == evidenceId) ?? throw new NotFoundException("Evidência não encontrada.");
        if (!EvidenceAccess.CanDownload(user, p.Order!))
            throw new ForbiddenException("A evidência fica restrita ao RH do pedido, ao NACC, ao DP e ao Gestor.");
        var content = await evidenceStorage.ReadAsync(evidence.StorageKey, ct)
                      ?? throw new NotFoundException("O arquivo da evidência não foi encontrado.");
        return (content, evidence.ContentType, evidence.FileName);
    }

    public Task<PositionDetailDto> CandidateWithdrewAsync(Guid id, NoteRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.CandidateWithdrew, r.Justification, p =>
        {
            p.CandidateWithdrew(clock.UtcNow);
            return Task.FromResult("CANDIDATE_WITHDREW");
        }, ct);

    public Task<PositionDetailDto> AdmissionNoShowAsync(Guid id, NoteRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.AdmissionNoShow, r.Justification, p =>
        {
            p.AdmissionNoShow(clock.UtcNow);
            return Task.FromResult("ADMISSION_NO_SHOW");
        }, ct);

    public Task<PositionDetailDto> StartPauseAsync(Guid id, StartPauseRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.StartPause, r.Justification, async p =>
        {
            var reason = await pauseReasons.GetByIdAsync(r.ReasonId, ct);
            if (reason is not { Active: true }) throw new BusinessRuleException("Selecione um motivo de pausa cadastrado e ativo.", "reasonId");
            await CheckDateAsync(p, r.StartDate, "A data de início da pausa", r.Justification, "startDate", ct);
            var pause = p.StartPause(reason.Id, r.StartDate);
            pause.Reason = reason;
            positions.Add(pause);
            await NotifyAsync(p, NotificationTypes.PauseStarted, "Posição pausada",
                $"Posição pausada a partir de {r.StartDate:dd/MM/yyyy}. Motivo: {reason.Name}.", [Roles.Rh], ct);
            return "START_PAUSE";
        }, ct);

    public Task<PositionDetailDto> EndPauseAsync(Guid id, DateRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.EndPause, r.Justification, async p =>
        {
            await CheckDateAsync(p, r.Date, "A data de fim da pausa", r.Justification, "date", ct);
            p.EndPause(r.Date);
            await NotifyAsync(p, NotificationTypes.PauseEnded, "Pausa encerrada",
                $"A pausa da posição foi encerrada em {r.Date:dd/MM/yyyy}. Status atual: {Labels.Of(p.Status)}.", [Roles.Rh], ct);
            return "END_PAUSE";
        }, ct);

    public Task<PositionDetailDto> CancelAsync(Guid id, CancelRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.Cancel, r.Reason, p =>
        {
            DateGuard.NotFuture(r.Date, clock.Today, "A data de cancelamento", "date");
            p.Cancel(r.Date, r.Reason);
            return Task.FromResult("CANCEL");
        }, ct);

    public Task<PositionDetailDto> AdjustTermAsync(Guid id, AdjustTermRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.AdjustTerm, r.Justification, p =>
        {
            p.AdjustTerm(r.TermType, r.TermEndDate, r.TermDurationDays, r.Justification);
            return Task.FromResult("ADJUST_TERM");
        }, ct);

    /// <summary>RN-25: correção de data já registrada, pelo autor do marco ou ADMIN, com justificativa.</summary>
    public Task<PositionDetailDto> CorrectDateAsync(Guid id, CorrectDateRequest r, CancellationToken ct = default) =>
        ExecuteAsync(id, PositionActions.CorrectDates, r.Justification, async p =>
        {
            DateGuard.RequireText(r.Justification, "Informe a justificativa da correção.", "justification");
            var today = clock.Today;
            if (r.Field != CorrectableDate.LAST_WORKED_DAY) DateGuard.NotFuture(r.Date, today, "A data corrigida", "date");

            var (entity, entityId, property, current, createdBy) = Target(p, r);
            if (current is null) throw new BusinessRuleException("Esta data ainda não foi registrada; não há o que corrigir.");
            await EnsureAuthorAsync(entity, entityId, property, createdBy, ct);

            Apply(p, r);
            return "CORRECT_DATE";
        }, ct);

    // ---------------------------------------------------------------- auxiliares

    private async Task<PositionDetailDto> ExecuteAsync(Guid id, string action, string? justification,
        Func<Position, Task<string>> operation, CancellationToken ct)
    {
        var position = await positions.GetDetailedAsync(id, ct) ?? throw new NotFoundException("Posição não encontrada.");
        PositionActions.EnsureRole(position, user, action);
        var auditAction = await operation(position);
        audit.Set(auditAction, DateGuard.Clean(justification));
        await uow.SaveChangesAsync(ct);
        return await queries.GetAsync(id, ct);
    }

    /// <summary>Bloqueia datas futuras e aplica a RN-24 (data retroativa exige justificativa e sinaliza a posição).</summary>
    private async Task CheckDateAsync(Position p, DateOnly date, string label, string? justification, string field,
        CancellationToken ct)
    {
        var today = clock.Today;
        DateGuard.NotFuture(date, today, label, field);
        if (DateGuard.CheckRetroactive(date, today, await parameters.IsInitialLoadOpenAsync(ct), justification, label))
            p.MarkRetroactive();
    }

    /// <summary>
    /// Avisos ao RH vão para os analistas responsáveis pelo pedido e para os gestores de RH (que redistribuem as
    /// demandas); os demais perfis recebem por perfil.
    /// </summary>
    private Task NotifyAsync(Position p, string type, string subject, string detail, string[] roles, CancellationToken ct)
    {
        var order = p.Order!;
        var message = $"{Describe(p)}: {detail}";
        var rh = roles.Contains(Roles.Rh);
        return notifications.NotifyAsync(new EventMessage(type, p.Id, $"{subject} — Pedido {order.Number}", message,
                links.Position(p.Id)),
            roles: rh ? roles.Where(r => r != Roles.Rh).Append(Roles.RhManager) : roles,
            userIds: rh ? order.ActiveRhAnalysts.Select(a => a.UserId) : null, ct: ct);
    }

    public static string Describe(Position p)
    {
        var order = p.Order!;
        return $"{Labels.Of(p.DemandType)} — {order.JobRole?.Name} — {order.Contract?.Client?.LegalName} " +
               $"(pedido {order.Number}, posição {p.SlotNumber}{(p.Cycle > 1 ? $", reposição nº {p.Cycle - 1}" : "")})";
    }

    private async Task EnsureAuthorAsync(string entity, Guid entityId, string property, Guid? createdBy, CancellationToken ct)
    {
        if (user.IsInRole(Roles.Admin)) return;
        var author = await auditLogs.FindFieldAuthorAsync(entity, entityId, property, ct) ?? createdBy;
        if (author is null || author != user.UserId)
            throw new ForbiddenException("Somente o autor do registro ou um administrador pode corrigir esta data.");
    }

    private static (string Entity, Guid Id, string Property, DateOnly? Current, Guid? CreatedBy) Target(Position p, CorrectDateRequest r)
    {
        Termination T() => p.Termination ?? throw new BusinessRuleException("Esta posição não é uma reposição.");
        Pause P() => p.Pauses.FirstOrDefault(x => x.Id == r.PauseId) ?? throw new BusinessRuleException("Pausa não encontrada.");

        return r.Field switch
        {
            CorrectableDate.CANDIDATE_APPROVED_AT => (nameof(Position), p.Id, nameof(p.CandidateApprovedAt), p.CandidateApprovedAt, p.CreatedBy),
            CorrectableDate.ADMISSION_AT => (nameof(Position), p.Id, nameof(p.AdmissionAt), p.AdmissionAt, p.CreatedBy),
            CorrectableDate.FIRST_DAY_AT => (nameof(Position), p.Id, nameof(p.FirstDayAt), p.FirstDayAt, p.CreatedBy),
            CorrectableDate.CLOSED_AT => (nameof(Position), p.Id, nameof(p.ClosedAt),
                p.Status == PositionStatus.CLOSED_CLIENT_CANCELLED && p.Termination?.ClientDecision != ClientDecision.NOT_REPLACE
                    ? p.ClosedAt
                    : throw new BusinessRuleException("Apenas a data de cancelamento pode ser corrigida aqui."), p.CreatedBy),
            CorrectableDate.CLIENT_DECISION_AT => (nameof(Termination), T().Id, nameof(Termination.ClientDecisionAt), T().ClientDecisionAt, T().CreatedBy),
            CorrectableDate.LAST_WORKED_DAY => (nameof(Termination), T().Id, nameof(Termination.LastWorkedDay), T().LastWorkedDay, T().CreatedBy),
            CorrectableDate.TERMINATION_REGISTERED_AT => (nameof(Termination), T().Id, nameof(Termination.RegisteredAt), T().RegisteredAt, T().CreatedBy),
            CorrectableDate.PAUSE_START => (nameof(Pause), P().Id, nameof(Pause.StartDate), P().StartDate, P().CreatedBy),
            CorrectableDate.PAUSE_END => (nameof(Pause), P().Id, nameof(Pause.EndDate), P().EndDate, P().CreatedBy),
            _ => throw new BusinessRuleException("Campo de data inválido.")
        };
    }

    private static void Apply(Position p, CorrectDateRequest r)
    {
        var date = r.Date;
        switch (r.Field)
        {
            case CorrectableDate.CANDIDATE_APPROVED_AT:
                p.CandidateApprovedAt = date;
                break;
            case CorrectableDate.ADMISSION_AT:
                p.AdmissionAt = date;
                break;
            case CorrectableDate.FIRST_DAY_AT:
                if (p.OpenedAt is { } opened && date < opened)
                    throw new BusinessRuleException("O 1º dia efetivo não pode ser anterior à data de abertura da posição.", "date");
                p.FirstDayAt = date;
                break;
            case CorrectableDate.CLOSED_AT:
                p.ClosedAt = date;
                break;
            case CorrectableDate.CLIENT_DECISION_AT:
            {
                var t = p.Termination!;
                if (date < t.RegisteredAt)
                    throw new BusinessRuleException("A decisão do cliente não pode ser anterior ao registro do desligamento.", "date");
                if (p.FirstDayAt is { } first && date > first)
                    throw new BusinessRuleException("A decisão do cliente não pode ser posterior ao 1º dia efetivo.", "date");
                t.ClientDecisionAt = date;
                if (t.ClientDecision == ClientDecision.REPLACE) p.OpenedAt = date;
                else p.ClosedAt = date;
                break;
            }
            case CorrectableDate.LAST_WORKED_DAY:
                p.Termination!.LastWorkedDay = date;
                p.DesiredStartDate = date.AddDays(1);
                break;
            case CorrectableDate.TERMINATION_REGISTERED_AT:
                if (p.Termination!.ClientDecisionAt is { } decision && date > decision)
                    throw new BusinessRuleException("O registro do desligamento não pode ser posterior à decisão do cliente.", "date");
                p.Termination.RegisteredAt = date;
                break;
            case CorrectableDate.PAUSE_START:
            case CorrectableDate.PAUSE_END:
            {
                var pause = p.Pauses.First(x => x.Id == r.PauseId);
                var start = r.Field == CorrectableDate.PAUSE_START ? date : pause.StartDate;
                var end = r.Field == CorrectableDate.PAUSE_END ? date : pause.EndDate;
                if (end < start)
                    throw new BusinessRuleException("A data de fim da pausa deve ser igual ou posterior à data de início.", "date");
                var overlaps = p.Pauses.Where(x => x.Id != pause.Id)
                    .Any(x => start < (x.EndDate ?? DateOnly.MaxValue) && x.StartDate < (end ?? DateOnly.MaxValue));
                if (overlaps) throw new BusinessRuleException("A pausa não pode se sobrepor a outra pausa da posição.", "date");
                pause.StartDate = start;
                pause.EndDate = end;
                break;
            }
        }
    }
}

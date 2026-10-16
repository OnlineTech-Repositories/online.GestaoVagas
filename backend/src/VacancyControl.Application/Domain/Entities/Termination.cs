using VacancyControl.Application.Common;

namespace VacancyControl.Application.Domain.Entities;

/// <summary>Desligamento de colaborador de uma posição preenchida.</summary>
public class Termination : BaseEntity
{
    public Guid OriginPositionId { get; internal set; }
    public Position? OriginPosition { get; internal set; }
    /// <summary>Último dia trabalhado; pode ser futuro (RN-13).</summary>
    public DateOnly LastWorkedDay { get; internal set; }
    public TerminationSource Source { get; internal set; }
    public TerminationType TerminationType { get; internal set; }
    public string? Notes { get; internal set; }
    public ClientDecision? ClientDecision { get; internal set; }
    public DateOnly? ClientDecisionAt { get; internal set; }
    /// <summary>Data de registro do desligamento (base do tempo de comunicação).</summary>
    public DateOnly RegisteredAt { get; internal set; }
    /// <summary>Posição de reposição criada por este desligamento (RN-14).</summary>
    public Position? ReplacementPosition { get; internal set; }

    private Termination() { }

    /// <summary>
    /// RN-11/RN-12: só de posição FILLED e no máximo um desligamento por posição de origem.
    /// <paramref name="originAlreadyTerminated"/> vem da consulta ao banco (há também constraint única).
    /// </summary>
    public static Termination Register(Position origin, bool originAlreadyTerminated, DateOnly lastWorkedDay,
        TerminationSource source, TerminationType type, string? notes, DateOnly registeredAt)
    {
        if (originAlreadyTerminated || origin.ExitTermination is not null)
            throw new BusinessRuleException("Já existe um desligamento registrado para esta posição.");
        if (origin.Status != PositionStatus.FILLED)
            throw new BusinessRuleException("O desligamento só pode ser registrado para uma posição preenchida.");

        var termination = new Termination
        {
            OriginPositionId = origin.Id,
            OriginPosition = origin,
            LastWorkedDay = lastWorkedDay,
            Source = source,
            TerminationType = type,
            Notes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim(),
            RegisteredAt = registeredAt,
        };
        origin.ExitTermination = termination;
        return termination;
    }
}

/// <summary>Pausa: espera por responsabilidade do cliente.</summary>
public class Pause : BaseEntity
{
    public Guid PositionId { get; internal set; }
    public Guid ReasonId { get; internal set; }
    public PauseReason? Reason { get; internal set; }
    public DateOnly StartDate { get; internal set; }
    public DateOnly? EndDate { get; internal set; }

    internal Pause() { }

    internal Pause(Guid positionId, Guid reasonId, DateOnly startDate)
    {
        PositionId = positionId;
        ReasonId = reasonId;
        StartDate = startDate;
    }

    public bool IsActive => EndDate is null;

    /// <summary>Seção 8.2: coalesce(end_date, today) - start_date.</summary>
    public int DaysUntil(DateOnly today) => Math.Max(0, (EndDate ?? today).DayNumber - StartDate.DayNumber);
}

using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Calculations;

/// <summary>Parâmetros que influenciam os cálculos (SystemParameter).</summary>
public sealed record CalcSettings(int AtRiskDays, bool LossOnCancelAfterOpen)
{
    public static readonly CalcSettings Default = new(2, true);
}

/// <summary>Situação do valor em R$ da posição (RN-21/RN-22).</summary>
public enum MoneyStatus
{
    /// <summary>Modalidade R&amp;S: não há cálculo em R$.</summary>
    NOT_APPLICABLE,
    /// <summary>Não há valor por cargo vigente na abertura.</summary>
    NO_RATE,
    /// <summary>Valor pendente de validação: exibido, mas fora dos totais.</summary>
    PENDING,
    VALIDATED,
    REJECTED
}

public sealed record PositionMetrics(
    DateOnly UncoveredStart,
    DateOnly UncoveredEndExclusive,
    int UncoveredDays,
    int PausedDays,
    int? RegistrationTime,
    int? CommunicationTime,
    int? ConfirmationTime,
    int? FillTime,
    DateOnly? SlaDeadline,
    SlaSituation? SlaSituation,
    decimal? DailyValue,
    decimal? Lost,
    decimal? Deferred,
    MoneyStatus MoneyStatus,
    int? ApprovalWaitTime = null)
{
    /// <summary>RN-21: só valores VALIDATED entram nos totais oficiais.</summary>
    public bool CountsInTotals => MoneyStatus == MoneyStatus.VALIDATED;
}

/// <summary>
/// Funções puras da seção 8. Recebem a posição (com Order, Termination, Pauses e Rate carregados)
/// e a data de hoje. Toda conta de dias é diferença simples entre datas, em dias corridos.
/// </summary>
public static class PositionCalculator
{
    public static PositionMetrics Calculate(Position p, DateOnly today, CalcSettings settings)
    {
        var start = UncoveredStart(p);
        var end = UncoveredEndExclusive(p, today);
        var uncovered = Days(start, end);
        var paused = PausedDays(p, today);
        var fill = FillTime(p, today, paused);
        var (deadline, situation) = Sla(p, today, settings, paused, fill);
        var (daily, lost, deferred, moneyStatus) = Money(p, uncovered, settings);

        return new PositionMetrics(start, end, uncovered, paused,
            RegistrationTime(p), CommunicationTime(p), ConfirmationTime(p), fill,
            deadline, situation, daily, lost, deferred, moneyStatus, ApprovalWaitTime(p, today));
    }

    /// <summary>8.1 — início da janela descoberta.</summary>
    public static DateOnly UncoveredStart(Position p) => p.DemandType == DemandType.REPLACEMENT
        ? Termination(p).LastWorkedDay.AddDays(1)
        : p.DesiredStartDate;

    /// <summary>8.1 — fim (exclusivo) da janela descoberta.</summary>
    public static DateOnly UncoveredEndExclusive(Position p, DateOnly today)
    {
        if (IsLegacyOrigin(p)) return UncoveredStart(p);

        return p.Status switch
        {
            PositionStatus.FILLED => p.FirstDayAt ?? UncoveredStart(p),
            PositionStatus.CLOSED_CONTRACT_ENDED => p.TermEndDate?.AddDays(1) ?? p.ClosedAt ?? today,
            PositionStatus.CLOSED_CLIENT_CANCELLED => p.ClosedAt ?? today,
            _ when p.TermType == TermType.FIXED_END && p.TermEndDate is { } termEnd => Min(today, termEnd.AddDays(1)),
            _ => today
        };
    }

    /// <summary>8.2 — Σ (coalesce(end_date, today) - start_date).</summary>
    public static int PausedDays(Position p, DateOnly today) => p.Pauses.Sum(x => x.DaysUntil(today));

    /// <summary>8.3 — tempo de cadastro (vaga nova).</summary>
    public static int? RegistrationTime(Position p) =>
        p.DemandType == DemandType.NEW && p.Order is { IsLegacy: false } order
            ? Diff(order.ClientRequestDate, order.RegisteredAt)
            : null;

    /// <summary>Espera pela aprovação formal do cliente (vaga nova): do registro do pedido à decisão, ou até hoje.</summary>
    public static int? ApprovalWaitTime(Position p, DateOnly today)
    {
        if (p.DemandType != DemandType.NEW || p.Order is not { IsLegacy: false } order) return null;
        var end = order.ClientDecisionDate ?? (order.ApprovalStatus == OrderApprovalStatus.AWAITING_CLIENT_APPROVAL ? today : (DateOnly?)null);
        return end is { } e ? Math.Max(0, Diff(order.RegisteredAt, e)) : null;
    }

    /// <summary>8.3 — tempo de comunicação interna (reposição).</summary>
    public static int? CommunicationTime(Position p) =>
        p.DemandType == DemandType.REPLACEMENT
            ? Math.Max(0, Diff(Termination(p).LastWorkedDay, Termination(p).RegisteredAt))
            : null;

    /// <summary>8.3 — tempo de espera pela decisão do cliente (reposição).</summary>
    public static int? ConfirmationTime(Position p) =>
        p.DemandType == DemandType.REPLACEMENT && Termination(p).ClientDecisionAt is { } decision
            ? Diff(Termination(p).RegisteredAt, decision)
            : null;

    /// <summary>
    /// 8.3 — tempo de preenchimento (SLA do RH), descontadas as pausas (RN-18).
    /// Calculado para posições abertas a partir de OPEN e para as preenchidas.
    /// </summary>
    public static int? FillTime(Position p, DateOnly today, int pausedDays)
    {
        if (p.OpenedAt is not { } opened || p.IsClosed || IsLegacyOrigin(p)) return null;
        return Diff(opened, p.FirstDayAt ?? today) - pausedDays;
    }

    /// <summary>8.4 — prazo e situação do SLA.</summary>
    public static (DateOnly? Deadline, SlaSituation? Situation) Sla(
        Position p, DateOnly today, CalcSettings settings, int pausedDays, int? fillTime)
    {
        // AWAITING_CONFIRMATION não tem SLA do RH; posições encerradas sem preenchimento não têm situação.
        if (p.OpenedAt is not { } opened || p.IsClosed || IsLegacyOrigin(p)) return (null, null);
        if (p.SlaTargetDays is not { } target) return (null, SlaSituation.NO_TARGET);

        var deadline = opened.AddDays(target + pausedDays);
        if (p.Status == PositionStatus.FILLED)
            return (deadline, fillTime <= target ? SlaSituation.ON_TIME : SlaSituation.OVERDUE);
        if (today > deadline) return (deadline, SlaSituation.OVERDUE);
        if (today >= deadline.AddDays(-settings.AtRiskDays)) return (deadline, SlaSituation.AT_RISK);
        return (deadline, SlaSituation.ON_TIME);
    }

    /// <summary>8.5 — valor diário, faturamento perdido e postergado para uma quantidade de dias descobertos.</summary>
    public static (decimal? Daily, decimal? Lost, decimal? Deferred, MoneyStatus Status) Money(
        Position p, int uncoveredDays, CalcSettings settings)
    {
        if (Modality(p) == Domain.Modality.RS) return (null, 0m, 0m, MoneyStatus.NOT_APPLICABLE);
        if (p.Rate?.MonthlyValue is not { } monthly) return (null, null, null, MoneyStatus.NO_RATE);

        var status = p.Rate.Status switch
        {
            RateStatus.VALIDATED => MoneyStatus.VALIDATED,
            RateStatus.REJECTED => MoneyStatus.REJECTED,
            _ => MoneyStatus.PENDING
        };
        var daily = Math.Round(monthly / 30m, 2);
        // Multiplica antes de dividir para não acumular arredondamento do valor diário.
        var amount = Math.Round(uncoveredDays * monthly / 30m, 2);

        if (IsLegacyOrigin(p)) return (daily, 0m, 0m, status);
        // Pedido que o cliente não aprovou: o posto nunca foi contratado, não há perda.
        if (p.Order?.ApprovalStatus == OrderApprovalStatus.NOT_APPROVED) return (daily, 0m, 0m, status);
        if (p.DemandType == DemandType.REPLACEMENT && p.Termination?.ClientDecision == ClientDecision.NOT_REPLACE)
            return (daily, 0m, 0m, status);
        if (p.Status == PositionStatus.CLOSED_CLIENT_CANCELLED && !settings.LossOnCancelAfterOpen)
            return (daily, 0m, 0m, status);
        if (p.TermType == TermType.PRESERVED_DURATION)
            return (daily, 0m, amount, status);
        return (daily, amount, 0m, status);
    }

    /// <summary>Dias descobertos de uma janela que caem dentro do período [from, toExclusive).</summary>
    public static int OverlapDays(DateOnly start, DateOnly endExclusive, DateOnly from, DateOnly toExclusive) =>
        Math.Max(0, Min(endExclusive, toExclusive).DayNumber - Max(start, from).DayNumber);

    // ---------------------------------------------------------------- auxiliares

    /// <summary>Posição FILLED criada pelo desligamento avulso (D1): não tem histórico de preenchimento.</summary>
    public static bool IsLegacyOrigin(Position p) => p.Order?.IsLegacy == true && p.DemandType == DemandType.NEW;

    private static Modality Modality(Position p) =>
        p.Order?.Modality ?? throw new InvalidOperationException("Pedido da posição não carregado.");

    private static Termination Termination(Position p) =>
        p.Termination ?? throw new InvalidOperationException("Desligamento da reposição não carregado.");

    private static int Diff(DateOnly from, DateOnly to) => to.DayNumber - from.DayNumber;

    private static int Days(DateOnly start, DateOnly endExclusive) => Math.Max(0, Diff(start, endExclusive));

    private static DateOnly Min(DateOnly a, DateOnly b) => a < b ? a : b;
    private static DateOnly Max(DateOnly a, DateOnly b) => a > b ? a : b;
}

/// <summary>Totais oficiais em R$ (RN-21): valores não validados ficam de fora e são contados à parte.</summary>
public sealed record MoneyTotals(decimal Lost, decimal Deferred, decimal PendingLost, decimal PendingDeferred, int PendingCount)
{
    public static MoneyTotals Sum(IEnumerable<(decimal? Lost, decimal? Deferred, MoneyStatus Status)> items)
    {
        decimal lost = 0, deferred = 0, pendingLost = 0, pendingDeferred = 0;
        var pendingCount = 0;
        foreach (var (l, d, s) in items)
        {
            if (s == MoneyStatus.VALIDATED)
            {
                lost += l ?? 0;
                deferred += d ?? 0;
            }
            else if (s is MoneyStatus.PENDING or MoneyStatus.REJECTED)
            {
                pendingLost += l ?? 0;
                pendingDeferred += d ?? 0;
                pendingCount++;
            }
        }
        return new MoneyTotals(lost, deferred, pendingLost, pendingDeferred, pendingCount);
    }
}

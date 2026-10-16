using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Tests;

/// <summary>Monta cenários dos casos de teste da seção 8.7 (valor mensal R$ 3.000,00 → diário R$ 100,00).</summary>
internal static class Builders
{
    public static DateOnly D(string iso) => DateOnly.Parse(iso);

    /// <summary>Candidato válido (CPF 529.982.247-25, exemplo clássico de CPF válido).</summary>
    public static CandidateData Candidate(string cpf = "52998224725") =>
        new("Maria da Silva", D("1995-04-10"), CandidateSex.FEMALE, cpf);

    public static ContractRate Rate(RateStatus status = RateStatus.VALIDATED) =>
        new() { MonthlyValue = 3000m, ValidFrom = D("2026-01-01"), Status = status };

    public static Order Order(Modality modality = Modality.MOT, TermType term = TermType.INDEFINITE,
        string desired = "2026-12-01", string? termEnd = null, int? duration = null) =>
        new()
        {
            Modality = modality,
            Quantity = 1,
            ClientRequestDate = D(desired),
            DesiredStartDate = D(desired),
            RegisteredAt = D(desired),
            TermType = term,
            TermEndDate = termEnd is null ? null : D(termEnd),
            TermDurationDays = duration,
            ApprovalStatus = OrderApprovalStatus.APPROVED,
            ClientDecisionDate = D(desired),
        };

    public static Position NewPosition(Order order, ContractRate? rate = null, int? slaDays = null, string? openedAt = null)
    {
        var p = Position.CreateNew(order, 1, order.DesiredStartDate, openedAt is null ? order.RegisteredAt : D(openedAt),
            rate ?? Rate(), slaDays, slaDays is null ? SlaTargetSource.NONE : SlaTargetSource.CONTRACT);
        order.Positions.Add(p);
        return p;
    }

    /// <summary>RN-06: a publicação no JobConvo é do pedido; as posições abertas dele entram em recrutamento.</summary>
    public static void Recruit(Position p) =>
        p.Order!.RecordJobconvo(true, "JC-1", p.Order.ClientRequestDate, null, null, DateTimeOffset.UtcNow);

    /// <summary>Leva a posição de OPEN até FILLED pelo fluxo completo.</summary>
    public static void Fill(Position p, string firstDay)
    {
        Recruit(p);
        p.ApproveCandidate(D(firstDay), Candidate(), D(firstDay));
        p.RegisterAdmission(D(firstDay), "M-1");
        p.ConfirmFirstDay(D(firstDay), "Confirmado pelo cliente", null, DateTimeOffset.UtcNow);
    }

    /// <summary>Posição FILLED de origem + desligamento + reposição AWAITING_CONFIRMATION.</summary>
    public static (Position Origin, Termination Termination, Position Replacement) Replacement(
        string lastWorkedDay, string registeredAt, TermType term = TermType.INDEFINITE, ContractRate? rate = null)
    {
        var order = Order(term: term, desired: "2026-01-05");
        var origin = NewPosition(order, rate);
        Fill(origin, "2026-01-05");
        var termination = Termination.Register(origin, false, D(lastWorkedDay), TerminationSource.DP,
            TerminationType.RESIGNATION, null, D(registeredAt));
        var replacement = Position.CreateReplacement(origin, termination, 2);
        order.Positions.Add(replacement);
        return (origin, termination, replacement);
    }
}

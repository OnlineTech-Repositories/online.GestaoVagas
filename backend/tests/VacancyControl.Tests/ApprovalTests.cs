using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Pedido aguardando a aprovação do cliente: SLA só a partir da aprovação; dias descobertos desde o início desejado.</summary>
public class ApprovalTests
{
    private static readonly CalcSettings Settings = CalcSettings.Default;

    private static (Order Order, Position Position) AwaitingOrder()
    {
        var order = Order(desired: "2026-11-10");
        order.ApprovalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
        order.ClientDecisionDate = null;
        order.ClientRequestDate = D("2026-11-01");
        order.RegisteredAt = D("2026-11-03");
        var position = Position.CreateNew(order, 1, order.DesiredStartDate, null, Rate(), null, SlaTargetSource.NONE);
        order.Positions.Add(position);
        return (order, position);
    }

    [Fact]
    public void Awaiting_NoOpening_NoSla_ButUncoveredDaysCount()
    {
        var (_, p) = AwaitingOrder();

        var m = PositionCalculator.Calculate(p, D("2026-11-20"), Settings);

        Assert.Null(p.OpenedAt);
        Assert.Null(m.SlaSituation);
        Assert.Null(m.FillTime);
        Assert.Equal(10, m.UncoveredDays); // desde o início desejado (10/11), como na pausa (RN-18)
        Assert.Equal(17, m.ApprovalWaitTime); // registro 03/11 → hoje 20/11
        Assert.Equal(1000m, m.Lost);
    }

    [Fact]
    public void Awaiting_RhPreparesUpToRecruiting_ButCannotApproveCandidate()
    {
        var (_, p) = AwaitingOrder();

        Recruit(p);
        var ex = Assert.Throws<BusinessRuleException>(() => p.ApproveCandidate(D("2026-11-05"), Candidate(), D("2026-11-05")));
        Assert.Contains("aguarda a aprovação do cliente", ex.Message);
    }

    [Fact]
    public void Approve_OpensPositionsOnApprovalDate_AndSlaStartsThere()
    {
        var (order, p) = AwaitingOrder();
        Recruit(p);

        foreach (var position in order.Approve(D("2026-11-12"), Guid.NewGuid(), DateTimeOffset.UtcNow))
            position.OpenOnApproval(D("2026-11-12"), 10, SlaTargetSource.CONTRACT);
        var m = PositionCalculator.Calculate(p, D("2026-11-20"), Settings);

        Assert.True(order.IsApproved);
        Assert.Equal(D("2026-11-12"), p.OpenedAt);
        Assert.Equal(D("2026-11-22"), m.SlaDeadline);
        Assert.Equal(8, m.FillTime);
        Assert.Equal(9, m.ApprovalWaitTime); // registro 03/11 → aprovação 12/11
        p.ApproveCandidate(D("2026-11-20"), Candidate(), D("2026-11-20")); // liberado depois da aprovação
    }

    [Fact]
    public void Approve_CannotHappenTwice_NorBeforeTheRequest()
    {
        var (order, _) = AwaitingOrder();

        Assert.Throws<BusinessRuleException>(() => order.Approve(D("2026-10-30"), null, DateTimeOffset.UtcNow));
        order.Approve(D("2026-11-05"), null, DateTimeOffset.UtcNow);
        Assert.Throws<BusinessRuleException>(() => order.Approve(D("2026-11-06"), null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void Reject_ClosesAllPositions_WithoutLoss()
    {
        var (order, p) = AwaitingOrder();

        order.Reject(D("2026-11-15"), "Cliente desistiu da contratação", null, DateTimeOffset.UtcNow);
        var m = PositionCalculator.Calculate(p, D("2026-11-20"), Settings);

        Assert.Equal(OrderApprovalStatus.NOT_APPROVED, order.ApprovalStatus);
        Assert.Equal(PositionStatus.CLOSED_CLIENT_CANCELLED, p.Status);
        Assert.Equal(0m, m.Lost);
        Assert.Equal(0m, m.Deferred);
        Assert.Throws<BusinessRuleException>(() => order.Reject(D("2026-11-16"), "", null, DateTimeOffset.UtcNow));
    }
}

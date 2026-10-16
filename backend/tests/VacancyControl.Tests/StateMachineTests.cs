using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Regras da máquina de estados da posição (seção 6) e regras de negócio relacionadas.</summary>
public class StateMachineTests
{
    [Fact]
    public void Recruiting_RequiresJobconvoCode()
    {
        var p = NewPosition(Order());
        Assert.Throws<BusinessRuleException>(() =>
            p.Order!.RecordJobconvo(true, " ", D("2026-12-01"), null, null, DateTimeOffset.UtcNow));
        Assert.Equal(PositionStatus.OPEN, p.Status);
    }

    [Fact]
    public void FirstDay_CannotBeBeforeOpenedAt()
    {
        var p = NewPosition(Order(desired: "2026-12-01"));
        Recruit(p);
        p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02"));
        p.RegisterAdmission(D("2026-12-03"), "M1");

        var ex = Assert.Throws<BusinessRuleException>(() => p.ConfirmFirstDay(D("2026-11-30"), "Ok", null, DateTimeOffset.UtcNow));
        Assert.Equal("date", ex.Field);
    }

    [Fact]
    public void Transitions_OutOfOrder_AreBlocked()
    {
        var p = NewPosition(Order());
        Assert.Throws<BusinessRuleException>(() => p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02")));
        Assert.Throws<BusinessRuleException>(() => p.ConfirmFirstDay(D("2026-12-02"), "Ok", null, DateTimeOffset.UtcNow));
    }

    [Fact]
    public void CandidateWithdrew_ReturnsToRecruiting_AndClearsDate()
    {
        var p = NewPosition(Order());
        Recruit(p);
        p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02"));

        p.CandidateWithdrew(DateTimeOffset.UtcNow);

        Assert.Equal(PositionStatus.RECRUITING, p.Status);
        Assert.Null(p.CandidateApprovedAt);
    }

    [Fact]
    public void AdmissionNoShow_ReturnsToRecruiting_AndClearsDate()
    {
        var p = NewPosition(Order());
        Recruit(p);
        p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02"));
        p.RegisterAdmission(D("2026-12-03"));

        p.AdmissionNoShow(DateTimeOffset.UtcNow);

        Assert.Equal(PositionStatus.RECRUITING, p.Status);
        Assert.Null(p.AdmissionAt);
    }

    [Fact]
    public void Pause_ReturnsToPreviousStatus()
    {
        var p = NewPosition(Order());
        Recruit(p);

        p.StartPause(Guid.NewGuid(), D("2026-12-05"));
        Assert.Equal(PositionStatus.PAUSED, p.Status);
        Assert.Equal(PositionStatus.RECRUITING, p.PreviousStatus);

        p.EndPause(D("2026-12-07"));
        Assert.Equal(PositionStatus.RECRUITING, p.Status);
        Assert.Null(p.PreviousStatus);
    }

    [Fact]
    public void Pause_OnlyOneActive_AndNoOverlap()
    {
        var p = NewPosition(Order());
        p.StartPause(Guid.NewGuid(), D("2026-12-05"));
        Assert.Throws<BusinessRuleException>(() => p.StartPause(Guid.NewGuid(), D("2026-12-06")));

        p.EndPause(D("2026-12-10"));
        Assert.Throws<BusinessRuleException>(() => p.StartPause(Guid.NewGuid(), D("2026-12-08")));
        p.StartPause(Guid.NewGuid(), D("2026-12-10"));
    }

    [Fact]
    public void Cancel_ClosesActivePause_AndRequiresReason()
    {
        var p = NewPosition(Order());
        p.StartPause(Guid.NewGuid(), D("2026-12-05"));
        Assert.Throws<BusinessRuleException>(() => p.Cancel(D("2026-12-08"), ""));

        p.Cancel(D("2026-12-08"), "Cliente desistiu");

        Assert.Equal(PositionStatus.CLOSED_CLIENT_CANCELLED, p.Status);
        Assert.Equal(D("2026-12-08"), p.Pauses.Single().EndDate);
    }

    [Fact]
    public void Termination_OnlyFromFilledPosition()
    {
        var p = NewPosition(Order());
        Assert.Throws<BusinessRuleException>(() => Termination.Register(p, false, D("2026-12-01"),
            TerminationSource.DP, TerminationType.RESIGNATION, null, D("2026-12-01")));
    }

    [Fact]
    public void Replacement_InheritsTermAndRate()
    {
        var rate = Rate();
        var (origin, _, replacement) = Replacement("2026-11-10", "2026-11-12", TermType.FIXED_END, rate);

        Assert.Equal(PositionStatus.AWAITING_CONFIRMATION, replacement.Status);
        Assert.Equal(DemandType.REPLACEMENT, replacement.DemandType);
        Assert.Equal(origin.TermType, replacement.TermType);
        Assert.Equal(origin.RateId, replacement.RateId);
        Assert.Null(replacement.OpenedAt);
    }

    [Fact]
    public void AdjustTerm_RequiresJustification_AndOpenPosition()
    {
        var p = NewPosition(Order(desired: "2026-12-01"));
        Assert.Throws<BusinessRuleException>(() => p.AdjustTerm(TermType.FIXED_END, D("2026-12-31"), null, ""));

        p.AdjustTerm(TermType.FIXED_END, D("2026-12-31"), null, "Cliente estendeu");
        Assert.Equal(D("2026-12-31"), p.TermEndDate);

        Fill(p, "2026-12-03");
        Assert.Throws<BusinessRuleException>(() => p.AdjustTerm(TermType.INDEFINITE, null, null, "x"));
    }

    [Fact]
    public void OrderStatus_IsCalculated()
    {
        var order = Order();
        var a = NewPosition(order);
        var b = NewPosition(order);
        Assert.Equal(OrderStatus.IN_PROGRESS, order.Status);

        Fill(a, "2026-12-01");
        b.Cancel(D("2026-12-02"), "Redução");
        Assert.Equal(OrderStatus.FULFILLED, order.Status);

        var other = Order();
        NewPosition(other).Cancel(D("2026-12-02"), "Cancelado");
        Assert.Equal(OrderStatus.CANCELLED, other.Status);
    }
}

using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Casos de teste da seção 8.7 da SPEC.</summary>
public class CalculationTests
{
    private static readonly CalcSettings Settings = new(AtRiskDays: 2, LossOnCancelAfterOpen: true);

    [Fact]
    public void T1_Replacement_Indefinite()
    {
        var (_, _, p) = Replacement("2026-11-10", "2026-11-12");
        p.ConfirmReplacement(D("2026-11-14"), null, SlaTargetSource.NONE);
        p.StartPause(Guid.NewGuid(), D("2026-11-18"));
        p.EndPause(D("2026-11-20"));
        Fill(p, "2026-11-24");

        var m = PositionCalculator.Calculate(p, D("2026-11-30"), Settings);

        Assert.Equal(2, m.CommunicationTime);
        Assert.Equal(2, m.ConfirmationTime);
        Assert.Equal(8, m.FillTime);
        Assert.Equal(13, m.UncoveredDays);
        Assert.Equal(1300.00m, m.Lost);
        Assert.Equal(0m, m.Deferred);
    }

    [Fact]
    public void T2_New_PreservedDuration()
    {
        var p = NewPosition(Order(term: TermType.PRESERVED_DURATION, desired: "2026-12-01", duration: 30));
        Fill(p, "2026-12-05");

        var m = PositionCalculator.Calculate(p, D("2026-12-10"), Settings);

        Assert.Equal(4, m.UncoveredDays);
        Assert.Equal(0m, m.Lost);
        Assert.Equal(400.00m, m.Deferred);
    }

    [Fact]
    public void T3_New_FixedEnd()
    {
        var p = NewPosition(Order(term: TermType.FIXED_END, desired: "2026-12-01", termEnd: "2026-12-31"));
        Fill(p, "2026-12-05");

        var m = PositionCalculator.Calculate(p, D("2026-12-10"), Settings);

        Assert.Equal(4, m.UncoveredDays);
        Assert.Equal(400.00m, m.Lost);
    }

    [Fact]
    public void T4_New_FixedEnd_NotFilled_ClosedByDailyJob()
    {
        var p = NewPosition(Order(term: TermType.FIXED_END, desired: "2026-12-01", termEnd: "2026-12-31"));
        var jobDate = D("2027-01-01");

        Assert.False(p.CloseByContractEnd(D("2026-12-31")));
        Assert.True(p.CloseByContractEnd(jobDate));
        var m = PositionCalculator.Calculate(p, jobDate, Settings);

        Assert.Equal(PositionStatus.CLOSED_CONTRACT_ENDED, p.Status);
        Assert.Equal(D("2027-01-01"), p.ClosedAt);
        Assert.Equal(31, m.UncoveredDays);
        Assert.Equal(3100.00m, m.Lost);
    }

    [Fact]
    public void T4_ClosedAt_DoesNotDependOnJobRunDate()
    {
        var p = NewPosition(Order(term: TermType.FIXED_END, desired: "2026-12-01", termEnd: "2026-12-31"));

        p.CloseByContractEnd(D("2027-01-04")); // job só rodou na segunda-feira seguinte
        var m = PositionCalculator.Calculate(p, D("2027-01-04"), Settings);

        Assert.Equal(D("2027-01-01"), p.ClosedAt);
        Assert.Equal(31, m.UncoveredDays);
    }

    [Fact]
    public void T5_Replacement_NotReplace()
    {
        var (_, _, p) = Replacement("2026-11-10", "2026-11-11");
        p.DeclineReplacement(D("2026-11-12"));

        var m = PositionCalculator.Calculate(p, D("2026-11-30"), Settings);

        Assert.Equal(PositionStatus.CLOSED_CLIENT_CANCELLED, p.Status);
        Assert.Equal(0m, m.Lost);
        Assert.Equal(0m, m.Deferred);
    }

    [Fact]
    public void T6_RsModality_NoMoney_SlaNormal()
    {
        var p = NewPosition(Order(modality: Modality.RS, desired: "2026-12-01"), slaDays: 10);

        var m = PositionCalculator.Calculate(p, D("2026-12-05"), Settings);

        Assert.Equal(0m, m.Lost);
        Assert.Equal(0m, m.Deferred);
        Assert.Equal(MoneyStatus.NOT_APPLICABLE, m.MoneyStatus);
        Assert.Null(m.DailyValue);
        Assert.Equal(SlaSituation.ON_TIME, m.SlaSituation);
        Assert.Equal(D("2026-12-11"), m.SlaDeadline);
    }

    [Fact]
    public void T7_EarlyReplacement_LastDayInFuture()
    {
        var (_, _, p) = Replacement("2026-11-30", "2026-11-20");
        p.ConfirmReplacement(D("2026-11-21"), null, SlaTargetSource.NONE);
        Fill(p, "2026-12-01");

        var m = PositionCalculator.Calculate(p, D("2026-12-02"), Settings);

        Assert.Equal(0, m.UncoveredDays);
        Assert.Equal(0m, m.Lost);
    }

    [Fact]
    public void T8_SubstituteStartsBeforeExit()
    {
        var (_, _, p) = Replacement("2026-11-30", "2026-11-20");
        p.ConfirmReplacement(D("2026-11-21"), null, SlaTargetSource.NONE);
        Fill(p, "2026-11-28");

        var m = PositionCalculator.Calculate(p, D("2026-12-02"), Settings);

        Assert.Equal(0, m.UncoveredDays);
    }

    [Fact]
    public void T9_CancelledAfterOpen_Indefinite()
    {
        var (_, _, p) = Replacement("2026-11-10", "2026-11-11");
        p.ConfirmReplacement(D("2026-11-12"), null, SlaTargetSource.NONE);
        p.Cancel(D("2026-11-20"), "Cliente cancelou a vaga");

        var m = PositionCalculator.Calculate(p, D("2026-11-30"), Settings);

        Assert.Equal(9, m.UncoveredDays);
        Assert.Equal(900.00m, m.Lost);
    }

    [Fact]
    public void T9_CancelledAfterOpen_WithoutLossParameter()
    {
        var (_, _, p) = Replacement("2026-11-10", "2026-11-11");
        p.ConfirmReplacement(D("2026-11-12"), null, SlaTargetSource.NONE);
        p.Cancel(D("2026-11-20"), "Cliente cancelou a vaga");

        var m = PositionCalculator.Calculate(p, D("2026-11-30"), Settings with { LossOnCancelAfterOpen = false });

        Assert.Equal(0m, m.Lost);
    }

    [Fact]
    public void T10_Sla_AtRisk()
    {
        var (_, _, p) = Replacement("2026-11-10", "2026-11-12");
        p.ConfirmReplacement(D("2026-11-14"), 10, SlaTargetSource.CONTRACT);
        p.StartPause(Guid.NewGuid(), D("2026-11-16"));
        p.EndPause(D("2026-11-18"));

        var m = PositionCalculator.Calculate(p, D("2026-11-24"), Settings);

        Assert.Equal(2, m.PausedDays);
        Assert.Equal(D("2026-11-26"), m.SlaDeadline);
        Assert.Equal(SlaSituation.AT_RISK, m.SlaSituation);
    }

    [Theory]
    [InlineData("2026-11-23", SlaSituation.ON_TIME)]
    [InlineData("2026-11-26", SlaSituation.AT_RISK)]
    [InlineData("2026-11-27", SlaSituation.OVERDUE)]
    public void T10_Sla_Boundaries(string today, SlaSituation expected)
    {
        var p = NewPosition(Order(desired: "2026-11-14"), slaDays: 12);

        var m = PositionCalculator.Calculate(p, D(today), Settings);

        Assert.Equal(expected, m.SlaSituation);
    }

    [Fact]
    public void T10_Sla_NoTarget()
    {
        var p = NewPosition(Order(desired: "2026-11-14"));

        Assert.Equal(SlaSituation.NO_TARGET, PositionCalculator.Calculate(p, D("2026-11-20"), Settings).SlaSituation);
    }

    [Fact]
    public void T11_PendingRate_CalculatedButOutOfTotals()
    {
        var pending = NewPosition(Order(desired: "2026-12-01"), Rate(RateStatus.PENDING));
        var validated = NewPosition(Order(desired: "2026-12-01"), Rate(RateStatus.VALIDATED));
        var today = D("2026-12-05");

        var mp = PositionCalculator.Calculate(pending, today, Settings);
        var mv = PositionCalculator.Calculate(validated, today, Settings);
        var totals = MoneyTotals.Sum([(mp.Lost, mp.Deferred, mp.MoneyStatus), (mv.Lost, mv.Deferred, mv.MoneyStatus)]);

        Assert.Equal(400.00m, mp.Lost);
        Assert.Equal(MoneyStatus.PENDING, mp.MoneyStatus);
        Assert.False(mp.CountsInTotals);
        Assert.Equal(400.00m, totals.Lost);
        Assert.Equal(400.00m, totals.PendingLost);
        Assert.Equal(1, totals.PendingCount);
    }

    [Fact]
    public void T12_DuplicateTermination_IsBlocked()
    {
        var (origin, _, _) = Replacement("2026-11-10", "2026-11-12");

        var ex = Assert.Throws<BusinessRuleException>(() => Termination.Register(origin, false, D("2026-11-15"),
            TerminationSource.NACC, TerminationType.DISMISSAL, null, D("2026-11-16")));
        Assert.Equal("Já existe um desligamento registrado para esta posição.", ex.Message);
    }

    [Fact]
    public void T12_DuplicateTermination_DetectedFromDatabase()
    {
        var p = NewPosition(Order(desired: "2026-01-05"));
        Fill(p, "2026-01-05");

        Assert.Throws<BusinessRuleException>(() => Termination.Register(p, originAlreadyTerminated: true,
            D("2026-11-15"), TerminationSource.DP, TerminationType.RESIGNATION, null, D("2026-11-16")));
    }
}

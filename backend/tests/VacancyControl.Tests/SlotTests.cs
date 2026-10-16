using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Reposição = novo ciclo da mesma vaga: o pedido continua com uma linha por vaga contratada.</summary>
public class SlotTests
{
    [Fact]
    public void Replacement_KeepsTheSlot_AndOpensTheNextCycle()
    {
        var (origin, _, replacement) = Replacement("2026-02-10", "2026-02-11");

        Assert.Equal(origin.SlotNumber, replacement.SlotNumber);
        Assert.Equal(1, origin.Cycle);
        Assert.Equal(2, replacement.Cycle);
        Assert.False(origin.IsCurrentCycle, "o colaborador desligado sai do ciclo atual");
        Assert.True(replacement.IsCurrentCycle);
        Assert.Equal([replacement], origin.Order!.CurrentPositions);
    }

    [Fact]
    public void SecondReplacement_IsTheThirdCycleOfTheSameSlot()
    {
        var (_, _, first) = Replacement("2026-02-10", "2026-02-11");
        first.ConfirmReplacement(D("2026-02-12"), 5, SlaTargetSource.CONTRACT);
        Fill(first, "2026-02-20");
        var termination = Termination.Register(first, false, D("2026-03-10"), TerminationSource.DP,
            TerminationType.DISMISSAL, null, D("2026-03-11"));
        var second = Position.CreateReplacement(first, termination, 3);
        first.Order!.Positions.Add(second);

        Assert.Equal((1, 3), (second.SlotNumber, second.Cycle));
        Assert.Single(first.Order.CurrentPositions);
    }

    [Fact]
    public void OrderStatus_LooksOnlyAtTheCurrentCycle()
    {
        var (origin, _, replacement) = Replacement("2026-02-10", "2026-02-11");
        var order = origin.Order!;

        // O colaborador desligado continua "Preenchida" no seu ciclo, mas o pedido está em reposição.
        Assert.Equal(PositionStatus.FILLED, origin.Status);
        Assert.Equal(OrderStatus.IN_PROGRESS, order.Status);

        replacement.DeclineReplacement(D("2026-02-12"));
        Assert.True(replacement.NotReplaced);
        Assert.Equal(OrderStatus.CANCELLED, order.Status);
    }

    [Fact]
    public void NewPositions_UseTheirOwnSlotNumbers()
    {
        var order = Order();
        var p = Position.CreateNew(order, 12, order.DesiredStartDate, null, Rate(), null, SlaTargetSource.NONE, slotNumber: 11);

        Assert.Equal((12, 11, 1), (p.Sequence, p.SlotNumber, p.Cycle));
    }
}

using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>RN-06 no pedido: uma publicação no JobConvo atende todas as posições do pedido.</summary>
public class JobconvoTests
{
    private static Order OrderWith(int quantity, out List<Position> positions)
    {
        var order = Order(desired: "2026-11-10");
        order.ClientRequestDate = D("2026-11-01");
        positions = Enumerable.Range(1, quantity).Select(_ => NewPosition(order)).ToList();
        return order;
    }

    [Fact]
    public void Published_MovesEveryOpenPosition_ToRecruiting()
    {
        var order = OrderWith(3, out var positions);
        positions[2].Cancel(D("2026-11-05"), "Cliente reduziu o quadro.");

        var started = order.RecordJobconvo(true, " JC-10 ", D("2026-11-03"), "Publicação única.", null, DateTimeOffset.UtcNow);

        Assert.Equal(2, started.Count);
        Assert.All(positions.Take(2), p => Assert.Equal(PositionStatus.RECRUITING, p.Status));
        Assert.Equal(PositionStatus.CLOSED_CLIENT_CANCELLED, positions[2].Status);
        Assert.Equal("JC-10", order.JobconvoCode);
        Assert.True(order.JobconvoPublished);
    }

    [Fact]
    public void Published_RequiresCodeAndDate_NotBeforeTheRequest()
    {
        var order = OrderWith(1, out var positions);

        Assert.Equal("code", Assert.Throws<BusinessRuleException>(() =>
            order.RecordJobconvo(true, "", D("2026-11-03"), null, null, DateTimeOffset.UtcNow)).Field);
        Assert.Equal("publishedAt", Assert.Throws<BusinessRuleException>(() =>
            order.RecordJobconvo(true, "JC", null, null, null, DateTimeOffset.UtcNow)).Field);
        Assert.Equal("publishedAt", Assert.Throws<BusinessRuleException>(() =>
            order.RecordJobconvo(true, "JC", D("2026-10-30"), null, null, DateTimeOffset.UtcNow)).Field);
        Assert.Equal(PositionStatus.OPEN, positions[0].Status);
    }

    [Fact]
    public void NotPublished_RequiresJustification_AndStillStartsRecruiting()
    {
        var order = OrderWith(2, out var positions);

        Assert.Equal("justification", Assert.Throws<BusinessRuleException>(() =>
            order.RecordJobconvo(false, null, null, " ", null, DateTimeOffset.UtcNow)).Field);
        order.RecordJobconvo(false, "JC-ignorado", D("2026-11-03"), "Indicação do cliente.", null, DateTimeOffset.UtcNow);

        Assert.False(order.JobconvoPublished);
        Assert.Null(order.JobconvoCode);
        Assert.Null(order.JobconvoPublishedAt);
        Assert.All(positions, p => Assert.Equal(PositionStatus.RECRUITING, p.Status));
    }

    [Fact]
    public void Update_IsReflected_AndLaterPositionsInherit()
    {
        var order = OrderWith(1, out _);
        order.RecordJobconvo(true, "JC-1", D("2026-11-03"), null, null, DateTimeOffset.UtcNow);
        order.RecordJobconvo(true, "JC-2", D("2026-11-04"), "Vaga republicada.", null, DateTimeOffset.UtcNow);

        var added = NewPosition(order);

        Assert.Equal("JC-2", order.JobconvoCode);
        Assert.Equal(PositionStatus.RECRUITING, added.Status);
    }

    [Fact]
    public void PausedOpenPosition_ResumesInRecruiting()
    {
        var order = OrderWith(1, out var positions);
        var p = positions[0];
        p.StartPause(Guid.NewGuid(), D("2026-11-02"));

        order.RecordJobconvo(true, "JC-1", D("2026-11-03"), null, null, DateTimeOffset.UtcNow);
        Assert.Equal(PositionStatus.PAUSED, p.Status);
        p.EndPause(D("2026-11-04"));

        Assert.Equal(PositionStatus.RECRUITING, p.Status);
    }

    [Fact]
    public void ConfirmedReplacement_InheritsThePublication()
    {
        var (origin, _, replacement) = Replacement("2026-02-10", "2026-02-11");
        Assert.True(origin.Order!.HasJobconvoRecord); // a origem foi preenchida com a publicação do pedido

        replacement.ConfirmReplacement(D("2026-02-12"), 5, SlaTargetSource.CONTRACT);

        Assert.Equal(PositionStatus.RECRUITING, replacement.Status);
    }

    [Fact]
    public void ReplacementWithoutPublication_StaysOpen()
    {
        var order = OrderWith(1, out var positions);
        var origin = positions[0];
        Fill(origin, "2026-11-10");
        order.JobconvoPublished = null; // pedido sem publicação (ex.: preenchido na carga inicial)
        var termination = Termination.Register(origin, false, D("2026-11-20"), TerminationSource.DP,
            TerminationType.RESIGNATION, null, D("2026-11-21"));
        var replacement = Position.CreateReplacement(origin, termination, 2);
        order.Positions.Add(replacement);

        replacement.ConfirmReplacement(D("2026-11-22"), 5, SlaTargetSource.CONTRACT);

        Assert.Equal(PositionStatus.OPEN, replacement.Status);
    }

    [Fact]
    public void NotApprovedOrder_RejectsThePublication()
    {
        var order = OrderWith(1, out _);
        order.ApprovalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
        order.Reject(D("2026-11-02"), "Desistiu", null, DateTimeOffset.UtcNow);

        Assert.Throws<BusinessRuleException>(() =>
            order.RecordJobconvo(true, "JC-1", D("2026-11-03"), null, null, DateTimeOffset.UtcNow));
    }
}

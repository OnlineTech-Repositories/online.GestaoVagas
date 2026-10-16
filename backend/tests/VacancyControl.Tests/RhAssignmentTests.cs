using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Positions;
using static VacancyControl.Tests.Builders;

namespace VacancyControl.Tests;

/// <summary>Analistas de RH responsáveis pelo pedido: distribuição pelo Gestor de RH e execução restrita aos atribuídos.</summary>
public class RhAssignmentTests
{
    private sealed class FakeUser(Guid id, params string[] roles) : ICurrentUser
    {
        public Guid? UserId => id;
        public string? IpAddress => null;
        public IReadOnlyCollection<string> Roles => roles;
        public bool IsInRole(string role) => roles.Contains(role);
    }

    private static readonly Guid Rita = Guid.NewGuid();
    private static readonly Guid Renato = Guid.NewGuid();
    private static readonly Guid Manager = Guid.NewGuid();
    private static readonly DateTimeOffset T1 = new(2026, 11, 3, 9, 0, 0, TimeSpan.FromHours(-3));
    private static readonly DateTimeOffset T2 = T1.AddHours(5);

    [Fact]
    public void NewOrder_IsAwaitingRhAssignment_UntilSomeoneIsAssigned()
    {
        var order = Order();
        NewPosition(order);
        Assert.True(order.AwaitingRhAssignment);

        order.SetRhAnalysts([(Rita, "Rita")], Manager, T1);

        Assert.False(order.AwaitingRhAssignment);
        Assert.True(order.IsRhAnalyst(Rita));
    }

    [Fact]
    public void Replace_KeepsHistory_WithWhoAndWhen()
    {
        var order = Order();
        NewPosition(order);
        order.SetRhAnalysts([(Rita, "Rita")], Manager, T1);

        var (added, removed) = order.SetRhAnalysts([(Renato, "Renato")], Manager, T2);

        Assert.Equal([Renato], added.Select(a => a.UserId));
        Assert.Equal([Rita], removed.Select(a => a.UserId));
        Assert.Equal(["Renato"], order.ActiveRhAnalysts.Select(a => a.UserName));
        var old = order.RhAnalysts.Single(a => a.UserId == Rita);
        Assert.Equal((T1, Manager, T2, Manager), (old.AssignedAt, old.AssignedBy, old.RemovedAt!.Value, old.RemovedBy));
        Assert.Equal(2, order.RhAnalysts.Count);
    }

    [Fact]
    public void SameTeamAgain_ChangesNothing_AndRemovingAllReturnsToAwaiting()
    {
        var order = Order();
        NewPosition(order);
        order.SetRhAnalysts([(Rita, "Rita"), (Renato, "Renato")], Manager, T1);

        var (added, removed) = order.SetRhAnalysts([(Renato, "Renato"), (Rita, "Rita"), (Rita, "Rita")], Manager, T2);
        Assert.Empty(added);
        Assert.Empty(removed);

        order.SetRhAnalysts([], Manager, T2);
        Assert.True(order.AwaitingRhAssignment);
    }

    [Fact]
    public void NotApprovedOrder_HasNothingToAssign()
    {
        var order = Order();
        order.ApprovalStatus = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
        NewPosition(order);
        order.Reject(order.ClientRequestDate, "Desistiu", null, T1);

        Assert.False(order.AwaitingRhAssignment);
        Assert.Throws<BusinessRuleException>(() => order.SetRhAnalysts([(Rita, "Rita")], Manager, T1));
    }

    [Fact]
    public void Analyst_ActsOnlyOnAssignedOrders_ManagerActsOnAny()
    {
        var order = Order();
        var p = NewPosition(order);
        Recruit(p);
        var rita = new FakeUser(Rita, Roles.Rh);
        var manager = new FakeUser(Manager, Roles.RhManager);

        Assert.DoesNotContain(PositionActions.ApproveCandidate, PositionActions.For(p, rita));
        Assert.Contains(PositionActions.ApproveCandidate, PositionActions.For(p, manager));
        var denied = Assert.Throws<ForbiddenException>(() => PositionActions.EnsureRole(p, rita, PositionActions.ApproveCandidate));
        Assert.Contains("analistas de RH responsáveis", denied.Message);

        order.SetRhAnalysts([(Rita, "Rita")], Manager, T1);

        Assert.Contains(PositionActions.ApproveCandidate, PositionActions.For(p, rita));
        PositionActions.EnsureRole(p, rita, PositionActions.ApproveCandidate);
        Assert.True(RhAccess.CanAct(rita, order));
        Assert.False(RhAccess.CanAct(new FakeUser(Renato, Roles.Rh), order));
    }

    [Fact]
    public void Nacc_KeepsAdmissionNoShow_WithoutAssignment()
    {
        var order = Order();
        var p = NewPosition(order);
        Recruit(p);
        p.ApproveCandidate(D("2026-12-02"), Candidate(), D("2026-12-02"));
        p.RegisterAdmission(D("2026-12-03"));

        Assert.Contains(PositionActions.AdmissionNoShow, PositionActions.For(p, new FakeUser(Guid.NewGuid(), Roles.Nacc)));
    }
}

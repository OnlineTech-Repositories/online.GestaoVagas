using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Positions;

namespace VacancyControl.Application.Features.Dashboard;

public sealed record DashboardDto(
    DateOnly Today, DateOnly MonthStart, int OpenPositions, int Overdue, int AtRisk, int AwaitingClient, int AwaitingApproval, int AwaitingRhAssignment, int Paused,
    int UncoveredDaysInMonth, decimal? LostInMonth, decimal? DeferredInMonth, decimal? PendingValidationInMonth,
    int PendingValidationCount, IReadOnlyList<PositionSummaryDto> Critical);

/// <summary>Painel (seção 9): cards e lista de posições vencidas/em risco.</summary>
public class DashboardService(IPositionRepository positions, ParameterService parameters, IClock clock, ICurrentUser user)
{
    public async Task<DashboardDto> GetAsync(CancellationToken ct = default)
    {
        var today = clock.Today;
        var monthStart = new DateOnly(today.Year, today.Month, 1);
        var nextMonth = monthStart.AddMonths(1);
        var settings = await parameters.GetCalcSettingsAsync(ct);
        var showAggregated = Permissions.CanSeeAggregatedValues(user);
        var showDetailed = Permissions.CanSeeDetailedValues(user);

        var rows = (await positions.ListDetailedAsync(new PositionFilter(), ct))
            .Where(p => !PositionCalculator.IsLegacyOrigin(p))
            .Select(p => (Position: p, Metrics: PositionCalculator.Calculate(p, today, settings)))
            .ToList();

        var open = rows.Where(r => r.Position.IsOpen).ToList();
        var monthItems = rows
            .Select(r => (r.Position, Days: PositionCalculator.OverlapDays(r.Metrics.UncoveredStart, r.Metrics.UncoveredEndExclusive, monthStart, nextMonth)))
            .Where(x => x.Days > 0)
            .ToList();
        var totals = MoneyTotals.Sum(monthItems.Select(x =>
        {
            var money = PositionCalculator.Money(x.Position, x.Days, settings);
            return (money.Lost, money.Deferred, money.Status);
        }));

        var critical = open
            .Where(r => r.Metrics.SlaSituation is SlaSituation.OVERDUE or SlaSituation.AT_RISK)
            .OrderByDescending(r => r.Metrics.UncoveredDays)
            .Take(100)
            .Select(r => PositionMapper.ToSummary(r.Position, r.Metrics, showDetailed))
            .ToList();

        return new DashboardDto(
            today, monthStart,
            OpenPositions: open.Count(r => r.Position.Status != PositionStatus.AWAITING_CONFIRMATION),
            Overdue: open.Count(r => r.Metrics.SlaSituation == SlaSituation.OVERDUE),
            AtRisk: open.Count(r => r.Metrics.SlaSituation == SlaSituation.AT_RISK),
            AwaitingClient: open.Count(r => r.Position.StageStatus == PositionStatus.AWAITING_CONFIRMATION),
            AwaitingApproval: open.Count(r => r.Position.Order?.ApprovalStatus == OrderApprovalStatus.AWAITING_CLIENT_APPROVAL),
            AwaitingRhAssignment: open.Where(r => r.Position.Order is { AwaitingRhAssignment: true })
                .Select(r => r.Position.OrderId).Distinct().Count(),
            Paused: open.Count(r => r.Position.Status == PositionStatus.PAUSED),
            UncoveredDaysInMonth: monthItems.Sum(x => x.Days),
            LostInMonth: showAggregated ? totals.Lost : null,
            DeferredInMonth: showAggregated ? totals.Deferred : null,
            PendingValidationInMonth: showAggregated ? totals.PendingLost + totals.PendingDeferred : null,
            PendingValidationCount: showAggregated ? totals.PendingCount : 0,
            critical);
    }
}

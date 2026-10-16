using Microsoft.AspNetCore.Mvc;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Features.Dashboard;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Orders;
using VacancyControl.Application.Features.Terminations;

namespace VacancyControl.Api.Controllers;

[ApiController]
[Route("api/orders")]
public class OrdersController(OrderService orders) : ControllerBase
{
    [HttpGet]
    public Task<List<OrderSummaryDto>> List([FromQuery] Guid? clientId, [FromQuery] Guid? contractId,
        [FromQuery] OrderStatus? status, [FromQuery] OrderApprovalStatus? approvalStatus, [FromQuery] string? rh,
        CancellationToken ct) =>
        orders.ListAsync(clientId, contractId, status, approvalStatus, rh, ct);

    [HttpPut("{id:guid}/rh-analysts")]
    public Task<OrderDetailDto> SetRhAnalysts(Guid id, SetRhAnalystsRequest r, CancellationToken ct) =>
        orders.SetRhAnalystsAsync(id, r, ct);

    [HttpPost("{id:guid}/approval")]
    public Task<OrderDetailDto> Approve(Guid id, ApproveOrderRequest r, CancellationToken ct) => orders.ApproveAsync(id, r, ct);

    [HttpPost("{id:guid}/jobconvo")]
    public Task<OrderDetailDto> RecordJobconvo(Guid id, RecordJobconvoRequest r, CancellationToken ct) =>
        orders.RecordJobconvoAsync(id, r, ct);

    [HttpPost("{id:guid}/rejection")]
    public Task<OrderDetailDto> Reject(Guid id, RejectOrderRequest r, CancellationToken ct) => orders.RejectAsync(id, r, ct);

    [HttpGet("{id:guid}")]
    public Task<OrderDetailDto> Get(Guid id, CancellationToken ct) => orders.GetAsync(id, ct);

    /// <summary>Cargos com valor validado no contrato (sem valores em R$: serve a todos os perfis que criam pedido).</summary>
    [HttpGet("job-roles")]
    public Task<List<OrderJobRoleDto>> JobRoles([FromQuery] Guid contractId, CancellationToken ct) =>
        orders.ListJobRolesForContractAsync(contractId, ct);

    [HttpPost]
    public async Task<ActionResult<OrderDetailDto>> Create(CreateOrderRequest r, CancellationToken ct)
    {
        var order = await orders.CreateAsync(r, ct);
        return CreatedAtAction(nameof(Get), new { id = order.Summary.Id }, order);
    }

    [HttpPost("{id:guid}/positions")]
    public Task<OrderDetailDto> AddPositions(Guid id, AddPositionsRequest r, CancellationToken ct) => orders.AddPositionsAsync(id, r, ct);

    [HttpPost("{id:guid}/date-corrections")]
    public Task<OrderDetailDto> CorrectDate(Guid id, CorrectOrderDateRequest r, CancellationToken ct) => orders.CorrectDateAsync(id, r, ct);
}

[ApiController]
[Route("api/terminations")]
public class TerminationsController(TerminationService terminations) : ControllerBase
{
    [HttpGet("filled-positions")]
    public Task<List<FilledPositionDto>> SearchFilled([FromQuery] string? term, CancellationToken ct) =>
        terminations.SearchFilledAsync(term, ct);

    [HttpPost]
    public Task<TerminationResultDto> Register(RegisterTerminationRequest r, CancellationToken ct) => terminations.RegisterAsync(r, ct);

    [HttpPost("legacy")]
    public Task<TerminationResultDto> RegisterLegacy(LegacyTerminationRequest r, CancellationToken ct) =>
        terminations.RegisterLegacyAsync(r, ct);
}

[ApiController]
[Route("api/dashboard")]
public class DashboardController(DashboardService dashboard) : ControllerBase
{
    [HttpGet]
    public Task<DashboardDto> Get(CancellationToken ct) => dashboard.GetAsync(ct);
}

[ApiController]
[Route("api/notifications")]
public class NotificationsController(NotificationService notifications, IClock clock) : ControllerBase
{
    [HttpGet]
    public Task<List<NotificationDto>> List([FromQuery] bool unreadOnly, CancellationToken ct) =>
        notifications.ListMineAsync(unreadOnly, ct);

    [HttpGet("unread-count")]
    public Task<int> UnreadCount(CancellationToken ct) => notifications.CountUnreadAsync(ct);

    [HttpPost("{id:guid}/read")]
    public async Task<IActionResult> MarkRead(Guid id, CancellationToken ct)
    {
        await notifications.MarkReadAsync(id, clock.UtcNow, ct);
        return NoContent();
    }

    [HttpPost("read-all")]
    public async Task<IActionResult> MarkAllRead(CancellationToken ct)
    {
        await notifications.MarkAllReadAsync(clock.UtcNow, ct);
        return NoContent();
    }
}

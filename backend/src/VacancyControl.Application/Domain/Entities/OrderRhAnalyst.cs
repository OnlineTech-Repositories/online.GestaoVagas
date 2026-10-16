namespace VacancyControl.Application.Domain.Entities;

/// <summary>
/// Analista de RH responsável pelo atendimento do pedido. A remoção é lógica (<see cref="RemovedAt"/>): as linhas
/// formam o histórico de quem foi incluído ou removido, por quem e quando.
/// </summary>
public class OrderRhAnalyst : BaseEntity
{
    public Guid OrderId { get; internal set; }
    public Order? Order { get; internal set; }
    public Guid UserId { get; internal set; }
    /// <summary>Nome do analista na data da inclusão (exibido nas listas sem consultar o cadastro de usuários).</summary>
    public string UserName { get; internal set; } = "";
    public DateTimeOffset AssignedAt { get; internal set; }
    public Guid? AssignedBy { get; internal set; }
    public DateTimeOffset? RemovedAt { get; internal set; }
    public Guid? RemovedBy { get; internal set; }

    public bool IsActive => RemovedAt is null;

    internal OrderRhAnalyst() { }

    internal OrderRhAnalyst(Order order, Guid userId, string userName, Guid? assignedBy, DateTimeOffset assignedAt)
    {
        OrderId = order.Id;
        Order = order;
        UserId = userId;
        UserName = userName;
        AssignedBy = assignedBy;
        AssignedAt = assignedAt;
    }
}

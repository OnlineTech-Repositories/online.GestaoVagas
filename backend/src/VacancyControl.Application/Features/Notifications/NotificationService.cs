using System.Net;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Notifications;

public static class NotificationTypes
{
    public const string OrderCreated = "ORDER_CREATED";
    public const string OrderApproved = "ORDER_APPROVED";
    public const string OrderNotApproved = "ORDER_NOT_APPROVED";
    public const string RhAssigned = "RH_ASSIGNED";
    public const string RhUnassigned = "RH_UNASSIGNED";
    public const string TerminationRegistered = "TERMINATION_REGISTERED";
    public const string ReplacementConfirmed = "REPLACEMENT_CONFIRMED";
    public const string AdmissionRegistered = "ADMISSION_REGISTERED";
    public const string PauseStarted = "PAUSE_STARTED";
    public const string PauseEnded = "PAUSE_ENDED";
    public const string RatePending = "RATE_PENDING";
    public const string RateRejected = "RATE_REJECTED";
    public const string ContractEnded = "CONTRACT_ENDED";
}

public sealed record NotificationDto(Guid Id, string Type, Guid? EntityId, string Message, DateTimeOffset CreatedAt, DateTimeOffset? ReadAt);

/// <summary>Mensagem de um evento (seção 10.1): notificação interna + e-mail.</summary>
public sealed record EventMessage(string Type, Guid? EntityId, string Subject, string Message, string? Link);

/// <summary>
/// Notificações internas e e-mails. Os e-mails vão para a caixa de saída na mesma transação da operação
/// e são enviados em segundo plano pelo serviço de e-mail (SendGrid), desacoplado da regra de negócio.
/// </summary>
public class NotificationService(INotificationRepository repository, IUserDirectory users, ICurrentUser user, IUnitOfWork uow)
{
    /// <summary>Registra o evento para os usuários ativos dos perfis e/ou usuários informados. Não salva.</summary>
    public async Task NotifyAsync(EventMessage message, IEnumerable<string>? roles = null, IEnumerable<Guid>? userIds = null,
        CancellationToken ct = default)
    {
        var recipients = new Dictionary<Guid, UserRef>();
        if (roles is not null)
            foreach (var u in await users.ListActiveByRolesAsync(roles, ct)) recipients[u.Id] = u;
        if (userIds is not null)
            foreach (var u in await users.ListByIdsAsync(userIds, ct)) recipients[u.Id] = u;

        foreach (var recipient in recipients.Values)
        {
            repository.Add(new Notification
            {
                UserId = recipient.Id,
                Type = message.Type,
                EntityId = message.EntityId,
                Message = message.Message,
            });
            repository.Add(new EmailMessage
            {
                To = recipient.Email,
                Subject = $"[Controle de Vagas] {message.Subject}",
                HtmlBody = RenderEmail(recipient.Name, message),
            });
        }
    }

    public async Task<List<NotificationDto>> ListMineAsync(bool unreadOnly, CancellationToken ct = default)
    {
        var items = await repository.ListForUserAsync(RequireUser(), unreadOnly, 50, ct);
        return items.Select(n => new NotificationDto(n.Id, n.Type, n.EntityId, n.Message, n.CreatedAt, n.ReadAt)).ToList();
    }

    public Task<int> CountUnreadAsync(CancellationToken ct = default) => repository.CountUnreadAsync(RequireUser(), ct);

    public async Task MarkReadAsync(Guid id, DateTimeOffset now, CancellationToken ct = default)
    {
        var notification = await repository.GetAsync(id, ct);
        if (notification is null || notification.UserId != RequireUser()) throw new NotFoundException("Notificação não encontrada.");
        notification.ReadAt ??= now;
        await uow.SaveChangesAsync(ct);
    }

    public async Task MarkAllReadAsync(DateTimeOffset now, CancellationToken ct = default)
    {
        foreach (var n in await repository.ListUnreadAsync(RequireUser(), ct)) n.ReadAt = now;
        await uow.SaveChangesAsync(ct);
    }

    private Guid RequireUser() => user.UserId ?? throw new ForbiddenException();

    private static string RenderEmail(string recipientName, EventMessage message)
    {
        var name = WebUtility.HtmlEncode(recipientName);
        var body = WebUtility.HtmlEncode(message.Message);
        var link = message.Link is null
            ? ""
            : $"""<p><a href="{WebUtility.HtmlEncode(message.Link)}" style="color:#1565c0">Abrir no sistema</a></p>""";
        return $"""
            <div style="font-family:Segoe UI,Arial,sans-serif;font-size:14px;color:#222">
              <p>Olá, {name}.</p>
              <p>{body}</p>
              {link}
              <p style="color:#777;font-size:12px">Mensagem automática do Sistema de Controle de Vagas — Grupo ON LINE.</p>
            </div>
            """;
    }
}

using Microsoft.AspNetCore.Identity;

namespace VacancyControl.Application.Domain.Entities;

public class AppUser : IdentityUser<Guid>
{
    public AppUser() => Id = Guid.CreateVersion7();

    public string Name { get; set; } = "";
    public bool Active { get; set; } = true;
    /// <summary>Senha definida pelo ADMIN: o usuário deve trocá-la no primeiro acesso.</summary>
    public bool MustChangePassword { get; set; } = true;
    public DateTimeOffset CreatedAt { get; set; }
}

public class AppRole : IdentityRole<Guid>
{
    public AppRole() => Id = Guid.CreateVersion7();
    public AppRole(string name) : this() => Name = name;
}

/// <summary>Log de auditoria append-only: sem UPDATE/DELETE (garantido também por trigger no banco).</summary>
public class AuditLog
{
    public long Id { get; set; }
    public Guid? UserId { get; set; }
    public DateTimeOffset Timestamp { get; set; }
    public string? Ip { get; set; }
    public string Entity { get; set; } = "";
    public Guid EntityId { get; set; }
    public string Action { get; set; } = "";
    public string? Field { get; set; }
    public string? OldValue { get; set; }
    public string? NewValue { get; set; }
    public string? Justification { get; set; }
}

/// <summary>Notificação interna exibida no painel.</summary>
public class Notification : BaseEntity
{
    public Guid UserId { get; set; }
    public string Type { get; set; } = "";
    public Guid? EntityId { get; set; }
    public string Message { get; set; } = "";
    public DateTimeOffset? ReadAt { get; set; }
}

/// <summary>Caixa de saída de e-mails, processada em segundo plano (falha no envio não desfaz a operação).</summary>
public class EmailMessage : BaseEntity
{
    public string To { get; set; } = "";
    public string Subject { get; set; } = "";
    public string HtmlBody { get; set; } = "";
    public EmailStatus Status { get; set; } = EmailStatus.PENDING;
    public int Attempts { get; set; }
    public string? LastError { get; set; }
    public DateTimeOffset? SentAt { get; set; }
}

/// <summary>Registro de execução da rotina diária (evita reprocessar o mesmo dia).</summary>
public class JobRun : BaseEntity
{
    public string JobName { get; set; } = "";
    public DateOnly RunDate { get; set; }
    public DateTimeOffset StartedAt { get; set; }
    public DateTimeOffset? FinishedAt { get; set; }
    public string? Summary { get; set; }
}

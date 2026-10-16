namespace VacancyControl.Application.Common;

/// <summary>Relógio do sistema. "Hoje" é sempre a data em America/Sao_Paulo.</summary>
public interface IClock
{
    DateTimeOffset UtcNow { get; }
    DateOnly Today { get; }
}

/// <summary>Usuário da requisição atual (ou o sistema, quando executado pelo job).</summary>
public interface ICurrentUser
{
    Guid? UserId { get; }
    string? IpAddress { get; }
    IReadOnlyCollection<string> Roles { get; }
    bool IsInRole(string role);
    bool IsInAnyRole(IEnumerable<string> roles) => roles.Any(IsInRole);
}

/// <summary>
/// Contexto de auditoria da operação em andamento. Os serviços informam a ação e a justificativa
/// antes de salvar; a camada de dados grava o AuditLog com esses dados.
/// </summary>
public interface IAuditContext
{
    string? Action { get; }
    string? Justification { get; }
    void Set(string action, string? justification = null);
}

public interface IUnitOfWork
{
    Task SaveChangesAsync(CancellationToken ct = default);
}

public sealed record PagedResult<T>(IReadOnlyList<T> Items, int Total);

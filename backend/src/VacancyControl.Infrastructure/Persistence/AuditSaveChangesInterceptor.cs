using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using System.Globalization;
using System.Text.Json;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.ChangeTracking;
using Microsoft.EntityFrameworkCore.Diagnostics;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

/// <summary>
/// Preenche os campos de auditoria das entidades e grava o AuditLog (seção 12) na mesma transação:
/// uma linha por criação e uma linha por campo alterado, com valor anterior, novo e justificativa.
/// Também impede exclusão física (RN-26) e alteração do próprio log.
/// </summary>
public sealed class AuditSaveChangesInterceptor(ICurrentUser currentUser, IAuditContext auditContext, IClock clock)
    : SaveChangesInterceptor
{
    private static readonly HashSet<string> IgnoredProperties =
    [
        nameof(BaseEntity.CreatedAt), nameof(BaseEntity.CreatedBy), nameof(BaseEntity.UpdatedAt), nameof(BaseEntity.UpdatedBy),
        nameof(AppUser.PasswordHash), nameof(AppUser.SecurityStamp), nameof(AppUser.ConcurrencyStamp),
        nameof(AppUser.NormalizedEmail), nameof(AppUser.NormalizedUserName), nameof(AppUser.AccessFailedCount),
    ];

    /// <summary>Tabelas técnicas que não entram no AuditLog.</summary>
    private static readonly HashSet<Type> NotAudited =
        [typeof(Notification), typeof(EmailMessage), typeof(JobRun), typeof(EvidenceFile), typeof(DataProtectionKey)];

    public override InterceptionResult<int> SavingChanges(DbContextEventData eventData, InterceptionResult<int> result)
    {
        Process(eventData.Context);
        return base.SavingChanges(eventData, result);
    }

    public override ValueTask<InterceptionResult<int>> SavingChangesAsync(DbContextEventData eventData,
        InterceptionResult<int> result, CancellationToken cancellationToken = default)
    {
        Process(eventData.Context);
        return base.SavingChangesAsync(eventData, result, cancellationToken);
    }

    private void Process(DbContext? context)
    {
        if (context is null) return;
        context.ChangeTracker.DetectChanges();

        AssignOrderNumbersWhenNotRelational(context);

        var now = clock.UtcNow;
        var userId = currentUser.UserId;
        var logs = new List<AuditLog>();

        foreach (var entry in context.ChangeTracker.Entries().ToList())
        {
            if (entry.State is EntityState.Unchanged or EntityState.Detached) continue;

            if (entry.Entity is AuditLog)
            {
                if (entry.State != EntityState.Added)
                    throw new InvalidOperationException("O log de auditoria não pode ser alterado nem excluído.");
                continue;
            }

            if (entry.Entity is BaseEntity entity)
            {
                if (entry.State == EntityState.Deleted && !NotAudited.Contains(entry.Metadata.ClrType))
                    throw new InvalidOperationException("Exclusão física não é permitida (RN-26).");
                if (entry.State == EntityState.Added)
                {
                    entity.CreatedAt = now;
                    entity.CreatedBy ??= userId;
                }
                else if (entry.State == EntityState.Modified)
                {
                    entity.UpdatedAt = now;
                    entity.UpdatedBy = userId;
                }
            }

            if (NotAudited.Contains(entry.Metadata.ClrType)) continue;
            var target = Describe(context, entry);
            if (target is null) continue;
            var (entityName, entityId, extra) = target.Value;

            switch (entry.State)
            {
                case EntityState.Added:
                    logs.Add(NewLog(now, userId, entityName, entityId, auditContext.Action ?? "CREATE", null, null,
                        extra ?? Snapshot(entry)));
                    break;
                case EntityState.Deleted:
                    logs.Add(NewLog(now, userId, entityName, entityId, auditContext.Action ?? "DELETE", null,
                        extra ?? Snapshot(entry), null));
                    break;
                case EntityState.Modified:
                    foreach (var property in entry.Properties)
                    {
                        if (!property.IsModified || IgnoredProperties.Contains(property.Metadata.Name)) continue;
                        var oldValue = Format(property.OriginalValue);
                        var newValue = Format(property.CurrentValue);
                        if (oldValue == newValue) continue;
                        logs.Add(NewLog(now, userId, entityName, entityId, auditContext.Action ?? "UPDATE",
                            property.Metadata.Name, oldValue, newValue));
                    }
                    break;
            }
        }

        if (logs.Count > 0) context.Set<AuditLog>().AddRange(logs);
    }

    /// <summary>
    /// No PostgreSQL o número do pedido é uma coluna identity. O banco em memória (avaliação local) não gera
    /// valores para colunas que não são chave, então o número é atribuído aqui.
    /// </summary>
    private static void AssignOrderNumbersWhenNotRelational(DbContext context)
    {
        if (context.Database.IsRelational()) return;
        var pending = context.ChangeTracker.Entries<Order>()
            .Where(e => e.State == EntityState.Added && e.Entity.Number == 0).Select(e => e.Entity).ToList();
        if (pending.Count == 0) return;
        var next = context.Set<Order>().AsNoTracking().Select(o => o.Number).AsEnumerable().DefaultIfEmpty(0).Max();
        foreach (var order in pending) order.Number = ++next;
    }

    private AuditLog NewLog(DateTimeOffset now, Guid? userId, string entity, Guid entityId, string action, string? field,
        string? oldValue, string? newValue) => new()
    {
        UserId = userId,
        Timestamp = now,
        Ip = currentUser.IpAddress,
        Entity = entity,
        EntityId = entityId,
        Action = action,
        Field = field,
        OldValue = Truncate(oldValue),
        NewValue = Truncate(newValue),
        Justification = auditContext.Justification,
    };

    private static (string Entity, Guid Id, string? Extra)? Describe(DbContext context, EntityEntry entry) => entry.Entity switch
    {
        BaseEntity e => (entry.Metadata.ClrType.Name, e.Id, null),
        AppUser u => ("User", u.Id, null),
        IdentityUserRole<Guid> ur => ("UserRole", ur.UserId, context.Set<AppRole>().Find(ur.RoleId)?.Name),
        _ => null
    };

    private static string Snapshot(EntityEntry entry)
    {
        var values = entry.Properties
            .Where(p => !IgnoredProperties.Contains(p.Metadata.Name))
            .ToDictionary(p => p.Metadata.Name, p => Format(p.CurrentValue));
        return JsonSerializer.Serialize(values);
    }

    private static string? Format(object? value) => value switch
    {
        null => null,
        DateOnly d => d.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture),
        DateTimeOffset dt => dt.ToString("O", CultureInfo.InvariantCulture),
        IFormattable f => f.ToString(null, CultureInfo.InvariantCulture),
        System.Collections.IEnumerable list and not string => string.Join(",", list.Cast<object>()),
        _ => value.ToString()
    };

    private static string? Truncate(string? value) => value is { Length: > 4000 } ? value[..4000] : value;
}

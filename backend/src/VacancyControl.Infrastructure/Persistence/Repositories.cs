using System.Linq.Expressions;
using Microsoft.EntityFrameworkCore;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

internal sealed class Repository<T>(AppDbContext db) : IRepository<T> where T : BaseEntity
{
    public Task<T?> GetByIdAsync(Guid id, CancellationToken ct = default) =>
        db.Set<T>().FirstOrDefaultAsync(e => e.Id == id, ct);

    public Task<List<T>> ListAsync(Expression<Func<T, bool>>? predicate = null, CancellationToken ct = default) =>
        (predicate is null ? db.Set<T>() : db.Set<T>().Where(predicate)).ToListAsync(ct);

    public Task<bool> AnyAsync(Expression<Func<T, bool>> predicate, CancellationToken ct = default) =>
        db.Set<T>().AnyAsync(predicate, ct);

    public void Add(T entity) => db.Set<T>().Add(entity);
}

internal sealed class UnitOfWork(AppDbContext db) : IUnitOfWork
{
    public async Task SaveChangesAsync(CancellationToken ct = default)
    {
        try
        {
            await db.SaveChangesAsync(ct);
        }
        catch (DbUpdateException ex) when (ex.InnerException is Npgsql.PostgresException { SqlState: "23505" } pg)
        {
            // Violação de unicidade que escapou da validação (ex.: duas requisições simultâneas).
            throw new BusinessRuleException(pg.ConstraintName switch
            {
                "ix_terminations_origin_position_id" => "Já existe um desligamento registrado para esta posição.",
                "ux_pauses_one_active" => "A posição já possui uma pausa ativa.",
                "ix_contracts_name" => "Outro contrato foi gravado ao mesmo tempo com este código. Salve novamente.",
                _ => "Registro duplicado: já existe um cadastro com estes dados."
            });
        }
    }
}

internal sealed class ContractRepository(AppDbContext db) : IContractRepository
{
    public Task<Contract?> GetAsync(Guid id, CancellationToken ct = default) =>
        db.Contracts.Include(c => c.Client).Include(c => c.GroupEntity).Include(c => c.ContractingUnit)
            .FirstOrDefaultAsync(c => c.Id == id, ct);

    public Task<List<Contract>> ListAsync(Guid? clientId, bool onlyActive, CancellationToken ct = default) =>
        db.Contracts.Include(c => c.Client).Include(c => c.GroupEntity).Include(c => c.ContractingUnit)
            .Where(c => clientId == null || c.ClientId == clientId)
            .Where(c => !onlyActive || c.Status == ContractStatus.ACTIVE)
            .OrderBy(c => c.Client!.LegalName).ThenBy(c => c.Name)
            .ToListAsync(ct);
}

internal sealed class ContractRateRepository(AppDbContext db) : IContractRateRepository
{
    private IQueryable<ContractRate> Query => db.ContractRates
        .Include(r => r.Contract).ThenInclude(c => c!.Client)
        .Include(r => r.JobRole);

    public Task<ContractRate?> GetAsync(Guid id, CancellationToken ct = default) => Query.FirstOrDefaultAsync(r => r.Id == id, ct);

    public Task<List<ContractRate>> ListAsync(Guid? contractId, RateStatus? status, CancellationToken ct = default) =>
        Query.Where(r => contractId == null || r.ContractId == contractId)
            .Where(r => status == null || r.Status == status)
            .OrderBy(r => r.Contract!.Client!.LegalName).ThenBy(r => r.Contract!.Name)
            .ThenBy(r => r.JobRole!.Name).ThenByDescending(r => r.ValidFrom)
            .ToListAsync(ct);

    public Task<ContractRate?> FindEffectiveAsync(Guid contractId, Guid jobRoleId, DateOnly date, CancellationToken ct = default) =>
        db.ContractRates.Where(r => r.ContractId == contractId && r.JobRoleId == jobRoleId && r.ValidFrom <= date)
            .OrderByDescending(r => r.ValidFrom).FirstOrDefaultAsync(ct);

    public Task<ContractRate?> FindEffectiveValidatedAsync(Guid contractId, Guid jobRoleId, DateOnly date, CancellationToken ct = default) =>
        db.ContractRates.Where(r => r.ContractId == contractId && r.JobRoleId == jobRoleId && r.ValidFrom <= date
                                    && r.Status == RateStatus.VALIDATED)
            .OrderByDescending(r => r.ValidFrom).FirstOrDefaultAsync(ct);

    public Task<List<ContractRate>> ListValidatedAsync(Guid contractId, CancellationToken ct = default) =>
        db.ContractRates.Include(r => r.JobRole)
            .Where(r => r.ContractId == contractId && r.Status == RateStatus.VALIDATED)
            .ToListAsync(ct);

    public Task<bool> ExistsAsync(Guid contractId, Guid jobRoleId, DateOnly validFrom, Guid? exceptId, CancellationToken ct = default) =>
        db.ContractRates.AnyAsync(r => r.ContractId == contractId && r.JobRoleId == jobRoleId && r.ValidFrom == validFrom
                                       && r.Id != exceptId, ct);
}

internal sealed class SlaTargetRepository(AppDbContext db) : ISlaTargetRepository
{
    public Task<SlaTarget?> FindEffectiveAsync(Modality modality, DemandType demandType, DateOnly date, CancellationToken ct = default) =>
        db.SlaTargets.Where(t => t.Modality == modality && t.DemandType == demandType && t.ValidFrom <= date)
            .OrderByDescending(t => t.ValidFrom).FirstOrDefaultAsync(ct);
}

internal sealed class OrderRepository(AppDbContext db) : IOrderRepository
{
    private IQueryable<Order> Query => db.Orders
        .Include(o => o.Contract).ThenInclude(c => c!.Client)
        .Include(o => o.Contract).ThenInclude(c => c!.ContractingUnit)
        .Include(o => o.Contract).ThenInclude(c => c!.GroupEntity)
        .Include(o => o.JobRole)
        .Include(o => o.WorkLocation)
        .Include(o => o.Positions).ThenInclude(p => p.Termination)
        .Include(o => o.Positions).ThenInclude(p => p.Pauses)
        .Include(o => o.Positions).ThenInclude(p => p.Rate)
        .Include(o => o.Positions).ThenInclude(p => p.Candidates)
        .Include(o => o.Positions).ThenInclude(p => p.ExitTermination)
        .Include(o => o.RhAnalysts)
        .AsSplitQuery();

    public Task<Order?> GetAsync(Guid id, CancellationToken ct = default) => Query.FirstOrDefaultAsync(o => o.Id == id, ct);

    public Task<List<Order>> ListAsync(Guid? clientId, Guid? contractId, CancellationToken ct = default) =>
        Query.AsNoTracking()
            .Where(o => clientId == null || o.Contract!.ClientId == clientId)
            .Where(o => contractId == null || o.ContractId == contractId)
            .ToListAsync(ct);

    public void Add(Order order) => db.Orders.Add(order);
}

internal sealed class PositionRepository(AppDbContext db) : IPositionRepository
{
    private IQueryable<Position> Detailed => db.Positions
        .Include(p => p.Order).ThenInclude(o => o!.Contract).ThenInclude(c => c!.Client)
        .Include(p => p.Order).ThenInclude(o => o!.Contract).ThenInclude(c => c!.GroupEntity)
        .Include(p => p.Order).ThenInclude(o => o!.JobRole)
        .Include(p => p.Order).ThenInclude(o => o!.WorkLocation)
        .Include(p => p.Order).ThenInclude(o => o!.RhAnalysts)
        .Include(p => p.Termination).ThenInclude(t => t!.OriginPosition)
        .Include(p => p.ExitTermination).ThenInclude(t => t!.ReplacementPosition)
        .Include(p => p.Pauses).ThenInclude(x => x.Reason)
        .Include(p => p.Rate)
        .Include(p => p.Candidates)
        .Include(p => p.Evidences)
        .AsSplitQuery();

    private static readonly PositionStatus[] ClosedStatuses =
        [PositionStatus.FILLED, PositionStatus.CLOSED_CLIENT_CANCELLED, PositionStatus.CLOSED_CONTRACT_ENDED];

    public Task<Position?> GetDetailedAsync(Guid id, CancellationToken ct = default) =>
        Detailed.FirstOrDefaultAsync(p => p.Id == id, ct);

    public Task<List<Position>> ListDetailedAsync(PositionFilter f, CancellationToken ct = default)
    {
        var q = Detailed.AsNoTracking();
        if (f.OpenedFrom is { } from) q = q.Where(p => p.OpenedAt >= from);
        if (f.OpenedTo is { } to) q = q.Where(p => p.OpenedAt <= to);
        if (f.ClientId is { } client) q = q.Where(p => p.Order!.Contract!.ClientId == client);
        if (f.ContractId is { } contract) q = q.Where(p => p.Order!.ContractId == contract);
        if (f.OrderId is { } order) q = q.Where(p => p.OrderId == order);
        if (f.Modality is { } modality) q = q.Where(p => p.Order!.Modality == modality);
        if (f.JobRoleId is { } jobRole) q = q.Where(p => p.Order!.JobRoleId == jobRole);
        if (f.DemandType is { } demand) q = q.Where(p => p.DemandType == demand);
        if (f.GroupEntityId is { } group) q = q.Where(p => p.Order!.Contract!.GroupEntityId == group);
        if (f.WorkLocationId is { } location) q = q.Where(p => p.Order!.WorkLocationId == location);
        if (f.Statuses is { Count: > 0 } statuses) q = q.Where(p => statuses.Contains(p.Status));
        if (f.OnlyOpen) q = q.Where(p => !ClosedStatuses.Contains(p.Status));
        if (f.RhAnalystId is { } analyst)
            q = q.Where(p => p.Order!.RhAnalysts.Any(a => a.UserId == analyst && a.RemovedAt == null));
        if (f.RhUnassigned) q = q.Where(p => !p.Order!.RhAnalysts.Any(a => a.RemovedAt == null));
        if (f.CurrentCycleOnly) q = q.Where(p => p.ExitTermination == null);
        if (!string.IsNullOrWhiteSpace(f.Search))
        {
            // lower() + LIKE: funciona em qualquer provedor (PostgreSQL ou banco em memória).
            var term = f.Search.Trim().ToLower();
            q = q.Where(p => (p.EmployeeName ?? "").ToLower().Contains(term)
                             || (p.EmployeeRegistration ?? "").ToLower().Contains(term)
                             || (p.Order!.JobconvoCode ?? "").ToLower().Contains(term)
                             || p.Order!.Contract!.Client!.LegalName.ToLower().Contains(term)
                             || p.Order!.JobRole!.Name.ToLower().Contains(term));
        }
        return q.ToListAsync(ct);
    }

    public Task<List<Position>> ListExpiredFixedEndAsync(DateOnly today, CancellationToken ct = default) =>
        Detailed.Where(p => !ClosedStatuses.Contains(p.Status) && p.TermType == TermType.FIXED_END && p.TermEndDate < today)
            .ToListAsync(ct);

    public Task<List<Position>> SearchFilledAsync(string? term, int take, CancellationToken ct = default)
    {
        var q = db.Positions.AsNoTracking()
            .Include(p => p.Order).ThenInclude(o => o!.Contract).ThenInclude(c => c!.Client)
            .Include(p => p.Order).ThenInclude(o => o!.JobRole)
            .Include(p => p.Order).ThenInclude(o => o!.WorkLocation)
            .Where(p => p.Status == PositionStatus.FILLED && p.ExitTermination == null);
        if (!string.IsNullOrWhiteSpace(term))
        {
            var like = term.Trim().ToLower();
            q = q.Where(p => (p.EmployeeName ?? "").ToLower().Contains(like) || (p.EmployeeRegistration ?? "").ToLower().Contains(like));
        }
        return q.OrderBy(p => p.EmployeeName).Take(take).ToListAsync(ct);
    }

    public Task<List<Position>> ListWithoutRateAsync(Guid contractId, Guid jobRoleId, DateOnly openedFrom, CancellationToken ct = default) =>
        db.Positions.Where(p => p.RateId == null && p.Order!.ContractId == contractId && p.Order.JobRoleId == jobRoleId
                                && p.OpenedAt >= openedFrom && !ClosedStatuses.Contains(p.Status))
            .ToListAsync(ct);

    public Task<Position?> FindOpenWithCandidateCpfAsync(string cpf, Guid exceptPositionId, CancellationToken ct = default) =>
        db.Positions.AsNoTracking()
            .Include(p => p.Order)
            .Where(p => p.Id != exceptPositionId && !ClosedStatuses.Contains(p.Status)
                        && p.Candidates.Any(c => c.Cpf == cpf && c.WithdrawnAt == null))
            .FirstOrDefaultAsync(ct);

    public async Task<int> NextSequenceAsync(Guid orderId, CancellationToken ct = default)
    {
        var persisted = await db.Positions.Where(p => p.OrderId == orderId).MaxAsync(p => (int?)p.Sequence, ct) ?? 0;
        var pending = db.ChangeTracker.Entries<Position>()
            .Where(e => e.State == EntityState.Added && e.Entity.OrderId == orderId)
            .Select(e => e.Entity.Sequence).DefaultIfEmpty(0).Max();
        return Math.Max(persisted, pending) + 1;
    }

    public Task<bool> HasTerminationAsync(Guid originPositionId, CancellationToken ct = default) =>
        db.Terminations.AnyAsync(t => t.OriginPositionId == originPositionId, ct);

    public void Add(Position position)
    {
        if (db.Entry(position).State == EntityState.Detached) db.Positions.Add(position);
    }

    public void Add(Termination termination)
    {
        if (db.Entry(termination).State == EntityState.Detached) db.Terminations.Add(termination);
    }

    public void Add(Pause pause)
    {
        if (db.Entry(pause).State == EntityState.Detached) db.Pauses.Add(pause);
    }
}

internal sealed class AuditLogRepository(AppDbContext db) : IAuditLogRepository
{
    public async Task<Guid?> FindFieldAuthorAsync(string entity, Guid entityId, string field, CancellationToken ct = default) =>
        await db.AuditLogs.Where(l => l.Entity == entity && l.EntityId == entityId && l.Field == field && l.NewValue != null)
            .OrderByDescending(l => l.Id).Select(l => l.UserId).FirstOrDefaultAsync(ct);

    public Task<List<AuditLog>> ListForEntitiesAsync(IReadOnlyCollection<Guid> entityIds, CancellationToken ct = default) =>
        db.AuditLogs.AsNoTracking().Where(l => entityIds.Contains(l.EntityId)).ToListAsync(ct);
}

internal sealed class NotificationRepository(AppDbContext db) : INotificationRepository
{
    public Task<List<Notification>> ListForUserAsync(Guid userId, bool unreadOnly, int take, CancellationToken ct = default) =>
        db.Notifications.AsNoTracking().Where(n => n.UserId == userId && (!unreadOnly || n.ReadAt == null))
            .OrderByDescending(n => n.CreatedAt).Take(take).ToListAsync(ct);

    public Task<int> CountUnreadAsync(Guid userId, CancellationToken ct = default) =>
        db.Notifications.CountAsync(n => n.UserId == userId && n.ReadAt == null, ct);

    public Task<Notification?> GetAsync(Guid id, CancellationToken ct = default) =>
        db.Notifications.FirstOrDefaultAsync(n => n.Id == id, ct);

    public Task<List<Notification>> ListUnreadAsync(Guid userId, CancellationToken ct = default) =>
        db.Notifications.Where(n => n.UserId == userId && n.ReadAt == null).ToListAsync(ct);

    public void Add(Notification notification) => db.Notifications.Add(notification);
    public void Add(EmailMessage email) => db.EmailMessages.Add(email);
}

internal sealed class JobRunRepository(AppDbContext db) : IJobRunRepository
{
    public Task<JobRun?> FindAsync(string jobName, DateOnly runDate, CancellationToken ct = default) =>
        db.JobRuns.FirstOrDefaultAsync(r => r.JobName == jobName && r.RunDate == runDate, ct);

    public void Add(JobRun run) => db.JobRuns.Add(run);
}

internal sealed class UserDirectory(AppDbContext db) : IUserDirectory
{
    public Task<List<UserRef>> ListActiveByRolesAsync(IEnumerable<string> roles, CancellationToken ct = default)
    {
        var names = roles.ToList();
        return (from u in db.Users
                join ur in db.UserRoles on u.Id equals ur.UserId
                join r in db.Roles on ur.RoleId equals r.Id
                where u.Active && names.Contains(r.Name!)
                select new UserRef(u.Id, u.Name, u.Email!))
            .Distinct().ToListAsync(ct);
    }

    public Task<List<UserRef>> ListByIdsAsync(IEnumerable<Guid> ids, CancellationToken ct = default)
    {
        var list = ids.ToList();
        return db.Users.Where(u => list.Contains(u.Id)).Select(u => new UserRef(u.Id, u.Name, u.Email!)).ToListAsync(ct);
    }

    public Task<bool> HasRoleAsync(Guid userId, string role, CancellationToken ct = default) =>
        (from u in db.Users
         join ur in db.UserRoles on u.Id equals ur.UserId
         join r in db.Roles on ur.RoleId equals r.Id
         where u.Id == userId && u.Active && r.Name == role
         select u.Id).AnyAsync(ct);
}

/// <summary>Conteúdo das evidências no banco, na mesma transação da operação (troca futura: SharePoint, D4).</summary>
internal sealed class DbEvidenceStorage(AppDbContext db) : IEvidenceStorage
{
    public string Add(byte[] content)
    {
        var file = new EvidenceFile { Content = content };
        db.EvidenceFiles.Add(file);
        return file.Id.ToString();
    }

    public async Task<byte[]?> ReadAsync(string key, CancellationToken ct = default) =>
        Guid.TryParse(key, out var id)
            ? await db.EvidenceFiles.AsNoTracking().Where(f => f.Id == id).Select(f => f.Content).FirstOrDefaultAsync(ct)
            : null;
}

/// <summary>Conteúdo binário de uma evidência (fora do log de auditoria).</summary>
public sealed class EvidenceFile
{
    public Guid Id { get; init; } = Guid.CreateVersion7();
    public byte[] Content { get; init; } = [];
}

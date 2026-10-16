using System.Linq.Expressions;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Common;

/// <summary>Acesso a dados genérico. Implementado na camada Infrastructure (EF Core).</summary>
public interface IRepository<T> where T : BaseEntity
{
    Task<T?> GetByIdAsync(Guid id, CancellationToken ct = default);
    Task<List<T>> ListAsync(Expression<Func<T, bool>>? predicate = null, CancellationToken ct = default);
    Task<bool> AnyAsync(Expression<Func<T, bool>> predicate, CancellationToken ct = default);
    void Add(T entity);
}

public interface IContractRepository
{
    Task<Contract?> GetAsync(Guid id, CancellationToken ct = default);
    Task<List<Contract>> ListAsync(Guid? clientId, bool onlyActive, CancellationToken ct = default);
}

public interface IContractRateRepository
{
    Task<ContractRate?> GetAsync(Guid id, CancellationToken ct = default);
    Task<List<ContractRate>> ListAsync(Guid? contractId, RateStatus? status, CancellationToken ct = default);
    /// <summary>Versão com maior valid_from ≤ data (a versão vigente na data).</summary>
    Task<ContractRate?> FindEffectiveAsync(Guid contractId, Guid jobRoleId, DateOnly date, CancellationToken ct = default);
    /// <summary>Versão VALIDADA com maior valid_from ≤ data (versões pendentes ou rejeitadas são ignoradas).</summary>
    Task<ContractRate?> FindEffectiveValidatedAsync(Guid contractId, Guid jobRoleId, DateOnly date, CancellationToken ct = default);
    /// <summary>Valores validados do contrato (todas as versões), com o cargo carregado.</summary>
    Task<List<ContractRate>> ListValidatedAsync(Guid contractId, CancellationToken ct = default);
    Task<bool> ExistsAsync(Guid contractId, Guid jobRoleId, DateOnly validFrom, Guid? exceptId, CancellationToken ct = default);
}

public interface ISlaTargetRepository
{
    Task<SlaTarget?> FindEffectiveAsync(Modality modality, DemandType demandType, DateOnly date, CancellationToken ct = default);
}

public sealed record OrderFilter(Guid? ClientId, Guid? ContractId, OrderStatus? Status, int Page = 1, int PageSize = 50);

public interface IOrderRepository
{
    /// <summary>Pedido com contrato, cargo, local e posições (com desligamentos, pausas e valor).</summary>
    Task<Order?> GetAsync(Guid id, CancellationToken ct = default);
    Task<List<Order>> ListAsync(Guid? clientId, Guid? contractId, CancellationToken ct = default);
    void Add(Order order);
}

public sealed record PositionFilter
{
    public DateOnly? OpenedFrom { get; init; }
    public DateOnly? OpenedTo { get; init; }
    public Guid? ClientId { get; init; }
    public Guid? ContractId { get; init; }
    public Guid? OrderId { get; init; }
    public Modality? Modality { get; init; }
    public Guid? JobRoleId { get; init; }
    public DemandType? DemandType { get; init; }
    public Guid? GroupEntityId { get; init; }
    public Guid? WorkLocationId { get; init; }
    public IReadOnlyCollection<PositionStatus>? Statuses { get; init; }
    /// <summary>Posições dos pedidos em que o analista de RH é responsável.</summary>
    public Guid? RhAnalystId { get; init; }
    /// <summary>Posições de pedidos sem analista de RH responsável.</summary>
    public bool RhUnassigned { get; init; }
    /// <summary>Só o ciclo atual de cada vaga (exclui ocupantes já desligados).</summary>
    public bool CurrentCycleOnly { get; init; }
    public bool OnlyOpen { get; init; }
    public string? Search { get; init; }
}

public interface IPositionRepository
{
    /// <summary>Posição com tudo o que os cálculos e a tela de detalhe precisam.</summary>
    Task<Position?> GetDetailedAsync(Guid id, CancellationToken ct = default);
    Task<List<Position>> ListDetailedAsync(PositionFilter filter, CancellationToken ct = default);
    /// <summary>Posições abertas FIXED_END com data fim anterior a hoje (encerramento pelo job).</summary>
    Task<List<Position>> ListExpiredFixedEndAsync(DateOnly today, CancellationToken ct = default);
    /// <summary>Posições FILLED sem desligamento, para a busca do colaborador.</summary>
    Task<List<Position>> SearchFilledAsync(string? term, int take, CancellationToken ct = default);
    Task<List<Position>> ListWithoutRateAsync(Guid contractId, Guid jobRoleId, DateOnly openedFrom, CancellationToken ct = default);
    Task<int> NextSequenceAsync(Guid orderId, CancellationToken ct = default);
    /// <summary>Outra posição aberta em que o CPF é o candidato selecionado (o mesmo candidato não ocupa duas).</summary>
    Task<Position?> FindOpenWithCandidateCpfAsync(string cpf, Guid exceptPositionId, CancellationToken ct = default);
    Task<bool> HasTerminationAsync(Guid originPositionId, CancellationToken ct = default);
    void Add(Position position);
    void Add(Termination termination);
    void Add(Pause pause);
}

public interface IAuditLogRepository
{
    /// <summary>Usuário que gravou o valor atual do campo (último registro no log), se houver.</summary>
    Task<Guid?> FindFieldAuthorAsync(string entity, Guid entityId, string field, CancellationToken ct = default);
    Task<List<AuditLog>> ListForEntitiesAsync(IReadOnlyCollection<Guid> entityIds, CancellationToken ct = default);
}

public interface INotificationRepository
{
    Task<List<Notification>> ListForUserAsync(Guid userId, bool unreadOnly, int take, CancellationToken ct = default);
    Task<int> CountUnreadAsync(Guid userId, CancellationToken ct = default);
    Task<Notification?> GetAsync(Guid id, CancellationToken ct = default);
    Task<List<Notification>> ListUnreadAsync(Guid userId, CancellationToken ct = default);
    void Add(Notification notification);
    void Add(EmailMessage email);
}

public sealed record UserRef(Guid Id, string Name, string Email);

/// <summary>Consulta de usuários (Identity) para notificações e exibição de nomes.</summary>
public interface IUserDirectory
{
    Task<List<UserRef>> ListActiveByRolesAsync(IEnumerable<string> roles, CancellationToken ct = default);
    Task<List<UserRef>> ListByIdsAsync(IEnumerable<Guid> ids, CancellationToken ct = default);
    Task<bool> HasRoleAsync(Guid userId, string role, CancellationToken ct = default);
}

/// <summary>Links da aplicação usados em e-mails.</summary>
public interface IAppLinks
{
    string Position(Guid id);
    string Order(Guid id);
    string ContractRates();
}

public interface IJobRunRepository
{
    Task<JobRun?> FindAsync(string jobName, DateOnly runDate, CancellationToken ct = default);
    void Add(JobRun run);
}

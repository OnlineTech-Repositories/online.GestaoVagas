using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Catalogs;

public sealed record NamedItemDto(Guid Id, string Name, bool Active);
public sealed record SaveNamedItemRequest(string Name, bool Active = true);

public sealed record GroupEntityDto(Guid Id, string Name, string Cnpj, bool Active);
public sealed record SaveGroupEntityRequest(string Name, string Cnpj, bool Active = true);

public sealed record WorkLocationDto(Guid Id, string Name, string? Code, string? Cnpj, Guid? ClientId, string? ClientName, bool Active);
/// <summary>Local geral (sem cliente). Unidades de cliente são mantidas no cadastro do cliente.</summary>
public sealed record SaveWorkLocationRequest(string Name, bool Active = true);

public sealed record SlaTargetDto(Guid Id, Modality Modality, DemandType DemandType, int Days, DateOnly ValidFrom);
public sealed record CreateSlaTargetRequest(Modality Modality, DemandType DemandType, int Days, DateOnly ValidFrom);

/// <summary>Cadastros auxiliares mantidos pelo ADMIN (cargos, locais, CNPJs do Grupo, motivos de pausa, metas de SLA).</summary>
public class CatalogService(
    IRepository<JobRole> jobRoles,
    IRepository<WorkLocation> workLocations,
    IRepository<GroupEntity> groupEntities,
    IRepository<PauseReason> pauseReasons,
    IRepository<SlaTarget> slaTargets,
    IRepository<Client> clients,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    // ---------------------------------------------------------------- cargos

    public async Task<List<NamedItemDto>> ListJobRolesAsync(CancellationToken ct = default) =>
        (await jobRoles.ListAsync(ct: ct)).OrderBy(x => x.Name).Select(x => new NamedItemDto(x.Id, x.Name, x.Active)).ToList();

    public async Task<NamedItemDto> SaveJobRoleAsync(Guid? id, SaveNamedItemRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var name = DateGuard.RequireText(request.Name, "Informe o nome do cargo.", "name");
        if (await jobRoles.AnyAsync(x => x.Name.ToLower() == name.ToLower() && x.Id != id, ct))
            throw new BusinessRuleException("Já existe um cargo com este nome.", "name");

        var entity = id is null ? Add(jobRoles, new JobRole()) : await Get(jobRoles, id.Value, ct);
        entity.Name = name;
        entity.Active = request.Active;
        await SaveAsync(id, ct);
        return new NamedItemDto(entity.Id, entity.Name, entity.Active);
    }

    // ---------------------------------------------------------------- motivos de pausa

    public async Task<List<NamedItemDto>> ListPauseReasonsAsync(CancellationToken ct = default) =>
        (await pauseReasons.ListAsync(ct: ct)).OrderBy(x => x.Name).Select(x => new NamedItemDto(x.Id, x.Name, x.Active)).ToList();

    public async Task<NamedItemDto> SavePauseReasonAsync(Guid? id, SaveNamedItemRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var name = DateGuard.RequireText(request.Name, "Informe o motivo.", "name");
        if (await pauseReasons.AnyAsync(x => x.Name.ToLower() == name.ToLower() && x.Id != id, ct))
            throw new BusinessRuleException("Já existe um motivo de pausa com este nome.", "name");

        var entity = id is null ? Add(pauseReasons, new PauseReason()) : await Get(pauseReasons, id.Value, ct);
        entity.Name = name;
        entity.Active = request.Active;
        await SaveAsync(id, ct);
        return new NamedItemDto(entity.Id, entity.Name, entity.Active);
    }

    // ---------------------------------------------------------------- CNPJs do Grupo

    public async Task<List<GroupEntityDto>> ListGroupEntitiesAsync(CancellationToken ct = default) =>
        (await groupEntities.ListAsync(ct: ct)).OrderBy(x => x.Name).Select(ToDto).ToList();

    public async Task<GroupEntityDto> SaveGroupEntityAsync(Guid? id, SaveGroupEntityRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var name = DateGuard.RequireText(request.Name, "Informe o nome.", "name");
        var cnpj = Cnpj.Require(request.Cnpj, "cnpj");
        if (await groupEntities.AnyAsync(x => x.Cnpj == cnpj && x.Id != id, ct))
            throw new BusinessRuleException("Já existe um CNPJ do Grupo cadastrado com este número.", "cnpj");

        var entity = id is null ? Add(groupEntities, new GroupEntity()) : await Get(groupEntities, id.Value, ct);
        entity.Name = name;
        entity.Cnpj = cnpj;
        entity.Active = request.Active;
        await SaveAsync(id, ct);
        return ToDto(entity);
    }

    // ---------------------------------------------------------------- locais de trabalho

    /// <summary>Locais gerais e unidades de clientes (as excluídas logicamente ficam de fora).</summary>
    public async Task<List<WorkLocationDto>> ListWorkLocationsAsync(CancellationToken ct = default)
    {
        var items = await workLocations.ListAsync(l => l.RemovedAt == null, ct);
        var clientNames = (await clients.ListAsync(ct: ct)).ToDictionary(c => c.Id, c => c.LegalName);
        return items.OrderBy(x => x.ClientId is { } cid ? clientNames.GetValueOrDefault(cid) ?? "" : "")
            .ThenBy(x => x.Code).ThenBy(x => x.Name)
            .Select(x => new WorkLocationDto(x.Id, x.Name, x.Code, x.Cnpj, x.ClientId,
                x.ClientId is { } cid ? clientNames.GetValueOrDefault(cid) : null, x.Active))
            .ToList();
    }

    public async Task<WorkLocationDto> SaveWorkLocationAsync(Guid? id, SaveWorkLocationRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var name = DateGuard.RequireText(request.Name, "Informe o nome do local.", "name");

        var entity = id is null ? Add(workLocations, new WorkLocation()) : await Get(workLocations, id.Value, ct);
        if (entity.IsUnit)
            throw new BusinessRuleException("Esta é uma unidade de cliente: altere-a no cadastro do cliente.", "name");
        entity.Name = name;
        entity.Active = request.Active;
        await SaveAsync(id, ct);
        return new WorkLocationDto(entity.Id, entity.Name, entity.Code, entity.Cnpj, null, null, entity.Active);
    }

    // ---------------------------------------------------------------- metas de SLA

    public async Task<List<SlaTargetDto>> ListSlaTargetsAsync(CancellationToken ct = default) =>
        (await slaTargets.ListAsync(ct: ct))
            .OrderBy(x => x.Modality).ThenBy(x => x.DemandType).ThenByDescending(x => x.ValidFrom)
            .Select(x => new SlaTargetDto(x.Id, x.Modality, x.DemandType, x.Days, x.ValidFrom))
            .ToList();

    /// <summary>Metas são versionadas: uma nova meta vale para posições abertas a partir de <c>ValidFrom</c> (RN-19).</summary>
    public async Task<SlaTargetDto> CreateSlaTargetAsync(CreateSlaTargetRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        if (request.Days < 1) throw new BusinessRuleException("A meta deve ser de pelo menos 1 dia.", "days");
        if (await slaTargets.AnyAsync(x => x.Modality == request.Modality && x.DemandType == request.DemandType
                                           && x.ValidFrom == request.ValidFrom, ct))
            throw new BusinessRuleException("Já existe meta para esta modalidade e tipo de demanda com a mesma data de vigência.", "validFrom");

        var entity = Add(slaTargets, new SlaTarget
        {
            Modality = request.Modality,
            DemandType = request.DemandType,
            Days = request.Days,
            ValidFrom = request.ValidFrom,
        });
        await SaveAsync(null, ct);
        return new SlaTargetDto(entity.Id, entity.Modality, entity.DemandType, entity.Days, entity.ValidFrom);
    }

    // ---------------------------------------------------------------- auxiliares

    private static GroupEntityDto ToDto(GroupEntity x) => new(x.Id, x.Name, x.Cnpj, x.Active);

    private static T Add<T>(IRepository<T> repository, T entity) where T : BaseEntity
    {
        repository.Add(entity);
        return entity;
    }

    private static async Task<T> Get<T>(IRepository<T> repository, Guid id, CancellationToken ct) where T : BaseEntity =>
        await repository.GetByIdAsync(id, ct) ?? throw new NotFoundException("Registro não encontrado.");

    private async Task SaveAsync(Guid? id, CancellationToken ct)
    {
        audit.Set(id is null ? "CREATE" : "UPDATE");
        await uow.SaveChangesAsync(ct);
    }
}

using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Clients;

public sealed record UnitDto(Guid Id, string? Code, string Name, string? Cnpj);
public sealed record ClientDto(Guid Id, string LegalName, string Cnpj, bool Active, bool HasMultipleUnits, IReadOnlyList<UnitDto> Units);

/// <summary>Unidade enviada com o cliente: sem <c>Id</c> = nova; unidade atual ausente da lista = excluída (logicamente).</summary>
public sealed record SaveUnitRequest(Guid? Id, string? Code, string? Name, string? Cnpj);

/// <summary><c>Units</c> = a lista completa de unidades do cliente; nula = mantém as unidades como estão.</summary>
public sealed record SaveClientRequest(string LegalName, string Cnpj, bool Active = true, bool HasMultipleUnits = false,
    List<SaveUnitRequest>? Units = null);

/// <summary><c>Name</c> = identificador do contrato, o código interno gerado (CT-AAAA-UNIDADE-SEQUENCIAL).</summary>
public sealed record ContractDto(
    Guid Id, Guid ClientId, string ClientName, string Name, Guid? ContractingUnitId, string? ContractingUnitCode,
    string? ContractingUnitName, Guid GroupEntityId, string GroupEntityName,
    IReadOnlyList<Modality> Modalities, DateOnly StartDate, DateOnly? EndDate, Guid CommercialOwnerId,
    string? CommercialOwnerName, int? SlaNewDays, int? SlaReplacementDays, ContractStatus Status);

/// <summary>O identificador não é informado: o sistema gera o código ao criar o contrato.</summary>
public sealed record SaveContractRequest(
    Guid ClientId, Guid? ContractingUnitId, Guid GroupEntityId, List<Modality> Modalities, DateOnly StartDate, DateOnly? EndDate,
    Guid CommercialOwnerId, int? SlaNewDays, int? SlaReplacementDays, ContractStatus Status = ContractStatus.ACTIVE);

/// <summary>Clientes e contratos: COMMERCIAL e ADMIN (matriz 4.1). Sem exclusão, apenas inativação.</summary>
public class ClientService(
    IRepository<Client> clients,
    IRepository<GroupEntity> groupEntities,
    IContractRepository contracts,
    IRepository<Contract> contractsRepository,
    IRepository<WorkLocation> workLocations,
    IUserDirectory users,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ICurrentUser user)
{
    public async Task<List<ClientDto>> ListAsync(CancellationToken ct = default)
    {
        var units = (await workLocations.ListAsync(l => l.ClientId != null && l.RemovedAt == null, ct))
            .ToLookup(l => l.ClientId!.Value);
        return (await clients.ListAsync(ct: ct)).OrderBy(c => c.LegalName).Select(c => ToDto(c, units[c.Id])).ToList();
    }

    public async Task<ClientDto> SaveAsync(Guid? id, SaveClientRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial, Roles.Admin);
        var name = DateGuard.RequireText(request.LegalName, "Informe a razão social.", "legalName");
        var cnpj = Cnpj.Require(request.Cnpj, "cnpj");
        if (await clients.AnyAsync(c => c.Cnpj == cnpj && c.Id != id, ct))
            throw new BusinessRuleException("Já existe um cliente cadastrado com este CNPJ.", "cnpj");

        Client client;
        if (id is null)
        {
            client = new Client();
            clients.Add(client);
        }
        else
        {
            client = await clients.GetByIdAsync(id.Value, ct) ?? throw new NotFoundException("Cliente não encontrado.");
        }

        client.LegalName = name;
        client.Cnpj = cnpj;
        client.Active = request.Active;
        var units = await SaveUnitsAsync(client, id is null, request, ct);
        client.HasMultipleUnits = request.HasMultipleUnits;
        audit.Set(id is null ? "CREATE" : "UPDATE");
        await uow.SaveChangesAsync(ct);
        return ToDto(client, units);
    }

    /// <summary>
    /// Sincroniza as unidades (locais de trabalho do cliente) com a lista enviada: cria as novas, atualiza as
    /// existentes e exclui logicamente as que saíram da lista (RN-26). Tudo na mesma gravação do cliente.
    /// </summary>
    private async Task<List<WorkLocation>> SaveUnitsAsync(Client client, bool isNew, SaveClientRequest request, CancellationToken ct)
    {
        var current = isNew ? [] : await workLocations.ListAsync(l => l.ClientId == client.Id && l.RemovedAt == null, ct);
        var desired = request.Units
            ?? current.Select(u => new SaveUnitRequest(u.Id, u.Code, u.Name, u.Cnpj)).ToList();

        if (!request.HasMultipleUnits && desired.Count > 0)
            throw new BusinessRuleException(
                "Exclua as unidades antes de desmarcar \"Cliente possui múltiplas unidades\".", "hasMultipleUnits");

        var codes = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        foreach (var unit in desired)
        {
            if (string.IsNullOrWhiteSpace(unit.Code) || string.IsNullOrWhiteSpace(unit.Name))
                throw new BusinessRuleException("Informe o código e o nome de cada unidade.", "units");
            if (!codes.Add(unit.Code.Trim()))
                throw new BusinessRuleException($"O código de unidade \"{unit.Code.Trim()}\" está repetido.", "units");
            if (!string.IsNullOrWhiteSpace(unit.Cnpj) && !Cnpj.IsValid(unit.Cnpj))
                throw new BusinessRuleException($"CNPJ inválido na unidade \"{unit.Code.Trim()}\".", "units");
            if (unit.Id is { } unitId && current.All(c => c.Id != unitId))
                throw new BusinessRuleException("Unidade não encontrada para este cliente.", "units");
        }

        var removing = current.Where(c => desired.All(d => d.Id != c.Id)).ToList();
        if (removing.Count > 0)
        {
            var removingIds = removing.Select(r => r.Id).ToList();
            var inUse = await contractsRepository.ListAsync(
                c => c.ContractingUnitId != null && removingIds.Contains(c.ContractingUnitId.Value) && c.Status == ContractStatus.ACTIVE, ct);
            if (inUse.Count > 0)
            {
                var unit = removing.First(r => r.Id == inUse[0].ContractingUnitId);
                throw new BusinessRuleException(
                    $"A unidade \"{unit.Code}\" é a unidade contratante do contrato {inUse[0].Name}. Encerre o contrato antes de excluir a unidade.",
                    "units");
            }
        }

        var now = clock.UtcNow;
        foreach (var removed in removing)
        {
            removed.RemovedAt = now;
            removed.Active = false;
        }

        var result = new List<WorkLocation>();
        foreach (var unit in desired)
        {
            var entity = unit.Id is { } unitId ? current.First(c => c.Id == unitId) : null;
            if (entity is null)
            {
                entity = new WorkLocation { ClientId = client.Id, Active = true };
                workLocations.Add(entity);
            }
            entity.Code = unit.Code!.Trim();
            entity.Name = unit.Name!.Trim();
            entity.Cnpj = string.IsNullOrWhiteSpace(unit.Cnpj) ? null : Cnpj.Normalize(unit.Cnpj);
            result.Add(entity);
        }
        return result;
    }

    public async Task<List<ContractDto>> ListContractsAsync(Guid? clientId, bool onlyActive, CancellationToken ct = default)
    {
        var list = await contracts.ListAsync(clientId, onlyActive, ct);
        var owners = await OwnerNamesAsync(list.Select(c => c.CommercialOwnerId), ct);
        return list.Select(c => ToDto(c, owners)).ToList();
    }

    public async Task<ContractDto> GetContractAsync(Guid id, CancellationToken ct = default)
    {
        var contract = await contracts.GetAsync(id, ct) ?? throw new NotFoundException("Contrato não encontrado.");
        return ToDto(contract, await OwnerNamesAsync([contract.CommercialOwnerId], ct));
    }

    public async Task<ContractDto> SaveContractAsync(Guid? id, SaveContractRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Commercial, Roles.Admin);
        if (request.Modalities is not { Count: > 0 })
            throw new BusinessRuleException("Selecione ao menos uma modalidade.", "modalities");
        if (request.EndDate is { } end && end < request.StartDate)
            throw new BusinessRuleException("A data fim do contrato deve ser igual ou posterior à data de início.", "endDate");
        if (request.SlaNewDays is < 1 || request.SlaReplacementDays is < 1)
            throw new BusinessRuleException("As metas contratuais de SLA devem ser de pelo menos 1 dia.", "slaNewDays");
        var client = await clients.GetByIdAsync(request.ClientId, ct) ?? throw new BusinessRuleException("Cliente não encontrado.", "clientId");
        var unit = await ValidateContractingUnitAsync(client, request.ContractingUnitId, ct);
        if (await groupEntities.GetByIdAsync(request.GroupEntityId, ct) is null)
            throw new BusinessRuleException("CNPJ do Grupo não encontrado.", "groupEntityId");
        if (!await users.HasRoleAsync(request.CommercialOwnerId, Roles.Commercial, ct))
            throw new BusinessRuleException("O responsável comercial deve ser um usuário com perfil Comercial.", "commercialOwnerId");

        Contract contract;
        if (id is null)
        {
            contract = new Contract
            {
                ClientId = client.Id,
                ContractingUnitId = unit?.Id,
                Name = await NextContractCodeAsync(unit?.Code ?? client.LegalName, ct),
            };
            contractsRepository.Add(contract);
        }
        else
        {
            contract = await contractsRepository.GetByIdAsync(id.Value, ct) ?? throw new NotFoundException("Contrato não encontrado.");
            // O código foi gerado a partir do cliente e da unidade: os dois ficam fixos depois de criado o contrato.
            if (contract.ClientId != request.ClientId || contract.ContractingUnitId != request.ContractingUnitId)
                throw new BusinessRuleException(
                    "O cliente e a unidade contratante não mudam depois de criado o contrato. Encerre este contrato e crie outro.",
                    "contractingUnitId");
        }

        contract.GroupEntityId = request.GroupEntityId;
        contract.Modalities = request.Modalities.Distinct().Order().ToList();
        contract.StartDate = request.StartDate;
        contract.EndDate = request.EndDate;
        contract.CommercialOwnerId = request.CommercialOwnerId;
        contract.SlaNewDays = request.SlaNewDays;
        contract.SlaReplacementDays = request.SlaReplacementDays;
        contract.Status = request.Status;
        audit.Set(id is null ? "CREATE" : "UPDATE");
        await uow.SaveChangesAsync(ct);
        return await GetContractAsync(contract.Id, ct);
    }

    /// <summary>
    /// Cliente com unidades exige a unidade contratante, que precisa ser dele e estar ativa;
    /// cliente sem unidades fica vinculado ao cliente principal (sem unidade).
    /// </summary>
    private async Task<WorkLocation?> ValidateContractingUnitAsync(Client client, Guid? unitId, CancellationToken ct)
    {
        var units = await workLocations.ListAsync(l => l.ClientId == client.Id && l.RemovedAt == null, ct);
        if (units.Count == 0)
        {
            if (unitId is not null)
                throw new BusinessRuleException("Este cliente não tem unidades: o contrato fica vinculado ao cliente principal.", "contractingUnitId");
            return null;
        }
        if (unitId is null)
            throw new BusinessRuleException("Selecione a unidade contratante.", "contractingUnitId");
        return units.FirstOrDefault(u => u.Id == unitId)
               ?? throw new BusinessRuleException("A unidade contratante não pertence a este cliente.", "contractingUnitId");
    }

    /// <summary>CT-AAAA-UNIDADE-SEQUENCIAL, com o ano do registro e o sequencial por ano e unidade.</summary>
    private async Task<string> NextContractCodeAsync(string segmentSource, CancellationToken ct)
    {
        var prefix = ContractCode.Prefix(clock.Today.Year, ContractCode.Segment(segmentSource));
        var existing = await contractsRepository.ListAsync(c => c.Name.StartsWith(prefix), ct);
        return prefix + ContractCode.NextSequence(prefix, existing.Select(c => c.Name)).ToString("D4");
    }

    private async Task<Dictionary<Guid, string>> OwnerNamesAsync(IEnumerable<Guid> ids, CancellationToken ct) =>
        (await users.ListByIdsAsync(ids.Distinct(), ct)).ToDictionary(u => u.Id, u => u.Name);

    private static ClientDto ToDto(Client c, IEnumerable<WorkLocation> units) => new(
        c.Id, c.LegalName, c.Cnpj, c.Active, c.HasMultipleUnits,
        units.OrderBy(u => u.Code).Select(u => new UnitDto(u.Id, u.Code, u.Name, u.Cnpj)).ToList());

    private static ContractDto ToDto(Contract c, IReadOnlyDictionary<Guid, string> owners) => new(
        c.Id, c.ClientId, c.Client?.LegalName ?? "", c.Name, c.ContractingUnitId, c.ContractingUnit?.Code,
        c.ContractingUnit?.Name, c.GroupEntityId, c.GroupEntity?.Name ?? "",
        c.Modalities, c.StartDate, c.EndDate, c.CommercialOwnerId, owners.GetValueOrDefault(c.CommercialOwnerId),
        c.SlaNewDays, c.SlaReplacementDays, c.Status);
}

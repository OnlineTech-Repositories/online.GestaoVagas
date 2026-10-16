using Microsoft.AspNetCore.Mvc;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Features.Catalogs;
using VacancyControl.Application.Features.Clients;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Rates;
using VacancyControl.Application.Features.Users;

namespace VacancyControl.Api.Controllers;

[ApiController]
[Route("api/clients")]
public class ClientsController(ClientService clients) : ControllerBase
{
    [HttpGet]
    public Task<List<ClientDto>> List(CancellationToken ct) => clients.ListAsync(ct);

    [HttpPost]
    public Task<ClientDto> Create(SaveClientRequest r, CancellationToken ct) => clients.SaveAsync(null, r, ct);

    [HttpPut("{id:guid}")]
    public Task<ClientDto> Update(Guid id, SaveClientRequest r, CancellationToken ct) => clients.SaveAsync(id, r, ct);
}

[ApiController]
[Route("api/contracts")]
public class ContractsController(ClientService clients) : ControllerBase
{
    [HttpGet]
    public Task<List<ContractDto>> List([FromQuery] Guid? clientId, [FromQuery] bool onlyActive, CancellationToken ct) =>
        clients.ListContractsAsync(clientId, onlyActive, ct);

    [HttpGet("{id:guid}")]
    public Task<ContractDto> Get(Guid id, CancellationToken ct) => clients.GetContractAsync(id, ct);

    [HttpPost]
    public Task<ContractDto> Create(SaveContractRequest r, CancellationToken ct) => clients.SaveContractAsync(null, r, ct);

    [HttpPut("{id:guid}")]
    public Task<ContractDto> Update(Guid id, SaveContractRequest r, CancellationToken ct) => clients.SaveContractAsync(id, r, ct);
}

[ApiController]
[Route("api/contract-rates")]
public class ContractRatesController(ContractRateService rates) : ControllerBase
{
    [HttpGet]
    public Task<List<ContractRateDto>> List([FromQuery] Guid? contractId, [FromQuery] RateStatus? status, CancellationToken ct) =>
        rates.ListAsync(contractId, status, ct);

    [HttpPost]
    public Task<ContractRateDto> Create(SaveContractRateRequest r, CancellationToken ct) => rates.CreateAsync(r, ct);

    [HttpPut("{id:guid}")]
    public Task<ContractRateDto> Update(Guid id, SaveContractRateRequest r, CancellationToken ct) => rates.UpdateAsync(id, r, ct);

    [HttpPost("{id:guid}/validate")]
    public Task<ContractRateDto> Validate(Guid id, CancellationToken ct) => rates.ValidateAsync(id, ct);

    [HttpPost("{id:guid}/reject")]
    public Task<ContractRateDto> Reject(Guid id, RejectRateRequest r, CancellationToken ct) => rates.RejectAsync(id, r, ct);
}

[ApiController]
[Route("api/catalogs")]
public class CatalogsController(CatalogService catalogs) : ControllerBase
{
    [HttpGet("job-roles")]
    public Task<List<NamedItemDto>> JobRoles(CancellationToken ct) => catalogs.ListJobRolesAsync(ct);

    [HttpPost("job-roles")]
    public Task<NamedItemDto> CreateJobRole(SaveNamedItemRequest r, CancellationToken ct) => catalogs.SaveJobRoleAsync(null, r, ct);

    [HttpPut("job-roles/{id:guid}")]
    public Task<NamedItemDto> UpdateJobRole(Guid id, SaveNamedItemRequest r, CancellationToken ct) => catalogs.SaveJobRoleAsync(id, r, ct);

    [HttpGet("pause-reasons")]
    public Task<List<NamedItemDto>> PauseReasons(CancellationToken ct) => catalogs.ListPauseReasonsAsync(ct);

    [HttpPost("pause-reasons")]
    public Task<NamedItemDto> CreatePauseReason(SaveNamedItemRequest r, CancellationToken ct) => catalogs.SavePauseReasonAsync(null, r, ct);

    [HttpPut("pause-reasons/{id:guid}")]
    public Task<NamedItemDto> UpdatePauseReason(Guid id, SaveNamedItemRequest r, CancellationToken ct) =>
        catalogs.SavePauseReasonAsync(id, r, ct);

    [HttpGet("group-entities")]
    public Task<List<GroupEntityDto>> GroupEntities(CancellationToken ct) => catalogs.ListGroupEntitiesAsync(ct);

    [HttpPost("group-entities")]
    public Task<GroupEntityDto> CreateGroupEntity(SaveGroupEntityRequest r, CancellationToken ct) =>
        catalogs.SaveGroupEntityAsync(null, r, ct);

    [HttpPut("group-entities/{id:guid}")]
    public Task<GroupEntityDto> UpdateGroupEntity(Guid id, SaveGroupEntityRequest r, CancellationToken ct) =>
        catalogs.SaveGroupEntityAsync(id, r, ct);

    [HttpGet("work-locations")]
    public Task<List<WorkLocationDto>> WorkLocations(CancellationToken ct) => catalogs.ListWorkLocationsAsync(ct);

    [HttpPost("work-locations")]
    public Task<WorkLocationDto> CreateWorkLocation(SaveWorkLocationRequest r, CancellationToken ct) =>
        catalogs.SaveWorkLocationAsync(null, r, ct);

    [HttpPut("work-locations/{id:guid}")]
    public Task<WorkLocationDto> UpdateWorkLocation(Guid id, SaveWorkLocationRequest r, CancellationToken ct) =>
        catalogs.SaveWorkLocationAsync(id, r, ct);

    [HttpGet("sla-targets")]
    public Task<List<SlaTargetDto>> SlaTargets(CancellationToken ct) => catalogs.ListSlaTargetsAsync(ct);

    [HttpPost("sla-targets")]
    public Task<SlaTargetDto> CreateSlaTarget(CreateSlaTargetRequest r, CancellationToken ct) => catalogs.CreateSlaTargetAsync(r, ct);
}

[ApiController]
[Route("api/parameters")]
public class ParametersController(ParameterService parameters) : ControllerBase
{
    [HttpGet]
    public Task<List<ParameterDto>> List(CancellationToken ct) => parameters.ListAsync(ct);

    [HttpPut("{key}")]
    public Task<ParameterDto> Update(string key, UpdateParameterRequest r, CancellationToken ct) => parameters.UpdateAsync(key, r, ct);
}

[ApiController]
[Route("api/users")]
public class UsersController(UserService users) : ControllerBase
{
    [HttpGet]
    public Task<List<UserDto>> List(CancellationToken ct) => users.ListAsync(ct);

    [HttpGet("by-role/{role}")]
    public Task<List<UserOptionDto>> ByRole(string role, CancellationToken ct) => users.ListByRoleAsync(role, ct);

    [HttpPost]
    public Task<UserDto> Create(CreateUserRequest r, CancellationToken ct) => users.CreateAsync(r, ct);

    [HttpPut("{id:guid}")]
    public Task<UserDto> Update(Guid id, UpdateUserRequest r, CancellationToken ct) => users.UpdateAsync(id, r, ct);

    [HttpPost("{id:guid}/reset-password")]
    public async Task<IActionResult> ResetPassword(Guid id, ResetPasswordRequest r, CancellationToken ct)
    {
        await users.ResetPasswordAsync(id, r, ct);
        return NoContent();
    }
}

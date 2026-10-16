using Microsoft.AspNetCore.Mvc;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Features.Positions;

namespace VacancyControl.Api.Controllers;

[ApiController]
[Route("api/positions")]
public class PositionsController(PositionQueryService queries, PositionCommandService commands) : ControllerBase
{
    [HttpGet]
    public Task<PagedResult<PositionSummaryDto>> List(
        [FromQuery] DateOnly? openedFrom, [FromQuery] DateOnly? openedTo, [FromQuery] Guid? clientId,
        [FromQuery] Guid? contractId, [FromQuery] Guid? orderId, [FromQuery] Modality? modality, [FromQuery] Guid? jobRoleId,
        [FromQuery] DemandType? demandType, [FromQuery] Guid? groupEntityId, [FromQuery] Guid? workLocationId,
        [FromQuery] PositionStatus[]? status, [FromQuery] SlaSituation[]? slaSituation, [FromQuery] bool onlyOpen = false,
        [FromQuery] string? search = null, [FromQuery] string? sort = null, [FromQuery] string? rh = null, [FromQuery] bool allCycles = false, [FromQuery] int page = 1,
        [FromQuery] int pageSize = 50, CancellationToken ct = default) =>
        queries.ListAsync(new PositionListRequest
        {
            Filter = new PositionFilter
            {
                OpenedFrom = openedFrom, OpenedTo = openedTo, ClientId = clientId, ContractId = contractId, OrderId = orderId,
                Modality = modality, JobRoleId = jobRoleId, DemandType = demandType, GroupEntityId = groupEntityId,
                WorkLocationId = workLocationId, Statuses = status, OnlyOpen = onlyOpen, Search = search,
            },
            Rh = rh,
            AllCycles = allCycles,
            SlaSituations = slaSituation,
            Sort = sort,
            Page = page,
            PageSize = pageSize,
        }, ct);

    [HttpGet("{id:guid}")]
    public Task<PositionDetailDto> Get(Guid id, CancellationToken ct) => queries.GetAsync(id, ct);

    [HttpPost("{id:guid}/decision")]
    public Task<PositionDetailDto> Decide(Guid id, DecisionRequest r, CancellationToken ct) => commands.DecideAsync(id, r, ct);


    [HttpPost("{id:guid}/candidate-approval")]
    public Task<PositionDetailDto> ApproveCandidate(Guid id, ApproveCandidateRequest r, CancellationToken ct) =>
        commands.ApproveCandidateAsync(id, r, ct);

    [HttpPut("{id:guid}/candidate")]
    public Task<PositionDetailDto> CorrectCandidate(Guid id, CandidateRequest r, CancellationToken ct) =>
        commands.CorrectCandidateAsync(id, r, ct);

    [HttpPost("{id:guid}/admission")]
    public Task<PositionDetailDto> RegisterAdmission(Guid id, AdmissionRequest r, CancellationToken ct) =>
        commands.RegisterAdmissionAsync(id, r, ct);

    [HttpPost("{id:guid}/first-day")]
    [Consumes("application/json")]
    public Task<PositionDetailDto> ConfirmFirstDay(Guid id, FirstDayRequest r, CancellationToken ct) =>
        commands.ConfirmFirstDayAsync(id, r, null, ct);

    /// <summary>Confirmação do 1º dia com a evidência anexada (multipart/form-data, até 10 MB).</summary>
    [HttpPost("{id:guid}/first-day")]
    [Consumes("multipart/form-data")]
    [RequestSizeLimit(EvidenceFiles.MaxBytes + 1024 * 1024)]
    [RequestFormLimits(MultipartBodyLengthLimit = EvidenceFiles.MaxBytes + 1024 * 1024)]
    public async Task<PositionDetailDto> ConfirmFirstDayWithEvidence(Guid id, [FromForm] FirstDayForm form, CancellationToken ct)
    {
        EvidenceUpload? evidence = null;
        if (form.Evidence is { Length: > 0 } file)
        {
            if (file.Length > EvidenceFiles.MaxBytes)
                throw new BusinessRuleException("A evidência deve ter no máximo 10 MB.", "evidence");
            using var buffer = new MemoryStream();
            await file.CopyToAsync(buffer, ct);
            evidence = new EvidenceUpload(file.FileName, file.ContentType, buffer.ToArray());
        }
        var request = new FirstDayRequest(form.Date, form.Justification);
        return await commands.ConfirmFirstDayAsync(id, request, evidence, ct);
    }

    [HttpPut("{id:guid}/admission-registration")]
    public Task<PositionDetailDto> CorrectRegistration(Guid id, RegistrationRequest r, CancellationToken ct) =>
        commands.CorrectRegistrationAsync(id, r, ct);

    [HttpGet("{id:guid}/evidences/{evidenceId:guid}")]
    public async Task<IActionResult> DownloadEvidence(Guid id, Guid evidenceId, CancellationToken ct)
    {
        var (content, contentType, fileName) = await commands.DownloadEvidenceAsync(id, evidenceId, ct);
        Response.Headers.XContentTypeOptions = "nosniff";
        return File(content, contentType, fileName);
    }

    [HttpPost("{id:guid}/candidate-withdrawal")]
    public Task<PositionDetailDto> CandidateWithdrew(Guid id, NoteRequest r, CancellationToken ct) =>
        commands.CandidateWithdrewAsync(id, r, ct);

    [HttpPost("{id:guid}/admission-no-show")]
    public Task<PositionDetailDto> AdmissionNoShow(Guid id, NoteRequest r, CancellationToken ct) =>
        commands.AdmissionNoShowAsync(id, r, ct);

    [HttpPost("{id:guid}/pause")]
    public Task<PositionDetailDto> StartPause(Guid id, StartPauseRequest r, CancellationToken ct) =>
        commands.StartPauseAsync(id, r, ct);

    [HttpPost("{id:guid}/pause/end")]
    public Task<PositionDetailDto> EndPause(Guid id, DateRequest r, CancellationToken ct) => commands.EndPauseAsync(id, r, ct);

    [HttpPost("{id:guid}/cancellation")]
    public Task<PositionDetailDto> Cancel(Guid id, CancelRequest r, CancellationToken ct) => commands.CancelAsync(id, r, ct);

    [HttpPost("{id:guid}/term")]
    public Task<PositionDetailDto> AdjustTerm(Guid id, AdjustTermRequest r, CancellationToken ct) => commands.AdjustTermAsync(id, r, ct);

    [HttpPost("{id:guid}/date-corrections")]
    public Task<PositionDetailDto> CorrectDate(Guid id, CorrectDateRequest r, CancellationToken ct) =>
        commands.CorrectDateAsync(id, r, ct);
}

/// <summary>Formulário do 1º dia com evidência (campos com os mesmos nomes do JSON; nome e matrícula vêm da origem).</summary>
public sealed class FirstDayForm
{
    public DateOnly Date { get; set; }
    public string? Justification { get; set; }
    public IFormFile? Evidence { get; set; }
}

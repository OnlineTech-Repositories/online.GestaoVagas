using System.Globalization;
using VacancyControl.Application.Calculations;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Parameters;

public sealed record ParameterDto(string Key, string Value, string? Description);
public sealed record UpdateParameterRequest(string Value);

public class ParameterService(IRepository<SystemParameter> repository, IUnitOfWork uow, IAuditContext audit, ICurrentUser user)
{
    public async Task<List<ParameterDto>> ListAsync(CancellationToken ct = default)
    {
        var items = await repository.ListAsync(ct: ct);
        return items.OrderBy(p => p.Key).Select(p => new ParameterDto(p.Key, p.Value, p.Description)).ToList();
    }

    public async Task<ParameterDto> UpdateAsync(string key, UpdateParameterRequest request, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var parameter = (await repository.ListAsync(p => p.Key == key, ct)).SingleOrDefault()
            ?? throw new NotFoundException("Parâmetro não encontrado.");

        parameter.Value = Validate(key, request.Value);
        audit.Set("UPDATE_PARAMETER");
        await uow.SaveChangesAsync(ct);
        return new ParameterDto(parameter.Key, parameter.Value, parameter.Description);
    }

    public async Task<int> GetIntAsync(string key, CancellationToken ct = default) =>
        int.Parse(await GetValueAsync(key, ct), CultureInfo.InvariantCulture);

    public async Task<bool> GetBoolAsync(string key, CancellationToken ct = default) =>
        bool.Parse(await GetValueAsync(key, ct));

    public async Task<TimeOnly> GetTimeAsync(string key, CancellationToken ct = default) =>
        TimeOnly.ParseExact(await GetValueAsync(key, ct), "HH:mm", CultureInfo.InvariantCulture);

    public async Task<CalcSettings> GetCalcSettingsAsync(CancellationToken ct = default) =>
        new(await GetIntAsync(ParameterKeys.AtRiskDays, ct), await GetBoolAsync(ParameterKeys.LossOnCancelAfterOpen, ct));

    public Task<bool> IsInitialLoadOpenAsync(CancellationToken ct = default) => GetBoolAsync(ParameterKeys.InitialLoadOpen, ct);

    private async Task<string> GetValueAsync(string key, CancellationToken ct)
    {
        var parameter = (await repository.ListAsync(p => p.Key == key, ct)).SingleOrDefault();
        return parameter?.Value ?? ParameterKeys.Defaults[key].Value;
    }

    private static string Validate(string key, string? value)
    {
        value = value?.Trim() ?? "";
        switch (key)
        {
            case ParameterKeys.AtRiskDays or ParameterKeys.StaleDays or ParameterKeys.EarlyReplacementWindowDays:
                if (!int.TryParse(value, NumberStyles.None, CultureInfo.InvariantCulture, out var n) || n < 0)
                    throw new BusinessRuleException("Informe um número inteiro maior ou igual a zero.", "value");
                return n.ToString(CultureInfo.InvariantCulture);
            case ParameterKeys.DailyDigestTime:
                if (!TimeOnly.TryParseExact(value, "HH:mm", CultureInfo.InvariantCulture, DateTimeStyles.None, out _))
                    throw new BusinessRuleException("Informe o horário no formato HH:mm.", "value");
                return value;
            default:
                if (!bool.TryParse(value, out var b))
                    throw new BusinessRuleException("Informe true ou false.", "value");
                return b ? "true" : "false";
        }
    }
}

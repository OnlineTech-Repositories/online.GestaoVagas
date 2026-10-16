using VacancyControl.Application.Common;

namespace VacancyControl.Infrastructure.Services;

/// <summary>Relógio com "hoje" no fuso America/Sao_Paulo (SPEC, seção 0).</summary>
public sealed class SaoPauloClock(TimeProvider timeProvider) : IClock
{
    private static readonly TimeZoneInfo Zone = TimeZoneInfo.FindSystemTimeZoneById("America/Sao_Paulo");

    public DateTimeOffset UtcNow => timeProvider.GetUtcNow();

    public DateTimeOffset LocalNow => TimeZoneInfo.ConvertTime(UtcNow, Zone);

    public DateOnly Today => DateOnly.FromDateTime(LocalNow.DateTime);
}

public sealed class AuditContext : IAuditContext
{
    public string? Action { get; private set; }
    public string? Justification { get; private set; }

    public void Set(string action, string? justification = null)
    {
        Action = action;
        Justification = string.IsNullOrWhiteSpace(justification) ? null : justification.Trim();
    }
}

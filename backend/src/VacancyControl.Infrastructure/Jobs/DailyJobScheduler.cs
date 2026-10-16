using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Features.Jobs;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Infrastructure.Persistence;
using VacancyControl.Infrastructure.Services;

namespace VacancyControl.Infrastructure.Jobs;

/// <summary>
/// Agenda a rotina diária em dias úteis (segunda a sexta), a partir do horário DAILY_DIGEST_TIME
/// (America/Sao_Paulo). Verifica a cada minuto; se o servidor estava fora do ar no horário, executa ao subir.
/// </summary>
public sealed class DailyJobScheduler(IServiceScopeFactory scopeFactory, SaoPauloClock clock, DatabaseReadiness database,
    ILogger<DailyJobScheduler> logger) : BackgroundService
{
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await database.WaitAsync(stoppingToken);
        using var timer = new PeriodicTimer(TimeSpan.FromMinutes(1));
        do
        {
            try
            {
                await TickAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Falha na rotina diária.");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task TickAsync(CancellationToken ct)
    {
        var now = clock.LocalNow;
        if (now.DayOfWeek is DayOfWeek.Saturday or DayOfWeek.Sunday) return;

        using var scope = scopeFactory.CreateScope();
        var parameters = scope.ServiceProvider.GetRequiredService<ParameterService>();
        var runAt = await parameters.GetTimeAsync(ParameterKeys.DailyDigestTime, ct);
        if (TimeOnly.FromDateTime(now.DateTime) < runAt) return;

        var job = scope.ServiceProvider.GetRequiredService<DailyJobService>();
        if (await job.HasRunAsync(clock.Today, ct)) return;
        await job.RunAsync(ct);
    }
}

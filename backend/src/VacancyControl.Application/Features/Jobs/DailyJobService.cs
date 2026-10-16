using Microsoft.Extensions.Logging;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Notifications;
using VacancyControl.Application.Features.Positions;

namespace VacancyControl.Application.Features.Jobs;

/// <summary>
/// Rotina diária (seção 10.2). Fase 1: encerra posições FIXED_END com vigência vencida.
/// Idempotente: pode rodar mais de uma vez no mesmo dia sem duplicar encerramentos nem notificações.
/// </summary>
public class DailyJobService(
    IPositionRepository positions,
    IJobRunRepository jobRuns,
    NotificationService notifications,
    IAppLinks links,
    IClock clock,
    IUnitOfWork uow,
    IAuditContext audit,
    ILogger<DailyJobService> logger)
{
    public const string JobName = "DAILY";

    public async Task<bool> HasRunAsync(DateOnly date, CancellationToken ct = default) =>
        await jobRuns.FindAsync(JobName, date, ct) is { FinishedAt: not null };

    public async Task RunAsync(CancellationToken ct = default)
    {
        var today = clock.Today;
        var run = await jobRuns.FindAsync(JobName, today, ct);
        if (run is null)
        {
            run = new JobRun { JobName = JobName, RunDate = today, StartedAt = clock.UtcNow };
            jobRuns.Add(run);
        }

        var closed = await CloseExpiredPositionsAsync(today, ct);

        run.FinishedAt = clock.UtcNow;
        run.Summary = $"Posições encerradas por fim de vigência: {closed}.";
        audit.Set("DAILY_JOB");
        await uow.SaveChangesAsync(ct);
        logger.LogInformation("Rotina diária de {Date} concluída. {Summary}", today, run.Summary);
    }

    private async Task<int> CloseExpiredPositionsAsync(DateOnly today, CancellationToken ct)
    {
        var count = 0;
        foreach (var p in await positions.ListExpiredFixedEndAsync(today, ct))
        {
            if (!p.CloseByContractEnd(today)) continue;
            count++;
            var contract = p.Order!.Contract!;
            await notifications.NotifyAsync(new EventMessage(NotificationTypes.ContractEnded, p.Id,
                    $"Posição encerrada por fim de vigência — Pedido {p.Order.Number}",
                    $"{PositionCommandService.Describe(p)}: encerrada automaticamente em {p.ClosedAt:dd/MM/yyyy} " +
                    $"por fim de vigência ({p.TermEndDate:dd/MM/yyyy}) sem preenchimento.",
                    links.Position(p.Id)),
                roles: [Roles.Nacc], userIds: [contract.CommercialOwnerId], ct: ct);
        }
        return count;
    }
}

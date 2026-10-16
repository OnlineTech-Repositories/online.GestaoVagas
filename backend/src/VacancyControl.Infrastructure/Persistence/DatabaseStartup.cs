using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace VacancyControl.Infrastructure.Persistence;

/// <summary>
/// Estado do banco na partida: as requisições e as rotinas em segundo plano esperam por ele.
///
/// Antes, a inicialização do banco rodava antes de o servidor escutar a porta: sem banco, a API encerrava, a
/// plataforma reiniciava o processo e o ciclo se repetia sem que o motivo ficasse claro — o mesmo que a aplicação
/// financeira viveu duas vezes na implantação. Agora o servidor sobe de qualquer forma, responde 503 com o motivo
/// (<see cref="Failure"/>) e tenta de novo a cada 30 segundos.
/// </summary>
public sealed class DatabaseReadiness
{
    private readonly TaskCompletionSource ready = new(TaskCreationOptions.RunContinuationsAsynchronously);

    public bool IsReady => ready.Task.IsCompleted;

    /// <summary>Último erro da inicialização, sem a senha (a mensagem do Npgsql não a inclui).</summary>
    public string? Failure { get; private set; }

    /// <summary>Destino da conexão, para a resposta 503 e o log (sem a senha).</summary>
    public string Target { get; init; } = "";

    public Task WaitAsync(CancellationToken ct) => ready.Task.WaitAsync(ct);

    internal void MarkReady()
    {
        Failure = null;
        ready.TrySetResult();
    }

    internal void MarkFailed(string reason) => Failure = reason;
}

/// <summary>Aplica migrations e o seed na partida, com nova tentativa a cada 30 segundos enquanto o banco falhar.</summary>
public sealed class DatabaseStartupService(IServiceProvider services, DatabaseReadiness readiness, ILogger<DatabaseStartupService> logger)
    : BackgroundService
{
    private static readonly TimeSpan RetryInterval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        while (!stoppingToken.IsCancellationRequested)
        {
            try
            {
                await DatabaseInitializer.InitializeAsync(services, stoppingToken);
                readiness.MarkReady();
                logger.LogInformation("Banco pronto: {Target}.", readiness.Target);
                return;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                readiness.MarkFailed(ex.GetBaseException().Message);
                logger.LogError(ex, "Banco indisponível ({Target}). Nova tentativa em {Seconds} s; até lá a API responde 503.",
                    readiness.Target, RetryInterval.TotalSeconds);
            }
            await Task.Delay(RetryInterval, stoppingToken);
        }
    }
}

public static class DatabaseStartupExtensions
{
    /// <summary>Registra a inicialização do banco em segundo plano (ver <see cref="DatabaseReadiness"/>).</summary>
    public static IServiceCollection AddDatabaseStartup(this IServiceCollection services, string target)
    {
        services.AddSingleton(new DatabaseReadiness { Target = target });
        services.AddHostedService<DatabaseStartupService>();
        return services;
    }
}

using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;
using Microsoft.Extensions.Options;
using SendGrid;
using SendGrid.Helpers.Mail;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Infrastructure.Persistence;

namespace VacancyControl.Infrastructure.Email;

/// <summary>Configuração do SendGrid. A API Key vem de variável de ambiente / user-secrets (SendGrid__ApiKey).</summary>
public sealed class SendGridOptions
{
    public const string Section = "SendGrid";
    public string? ApiKey { get; set; }
    public string FromEmail { get; set; } = "";
    public string FromName { get; set; } = "Controle de Vagas";
    /// <summary>Quando falso, os e-mails são apenas registrados em log (desenvolvimento).</summary>
    public bool Enabled { get; set; } = true;
}

public interface IEmailSender
{
    Task SendAsync(string to, string subject, string htmlBody, CancellationToken ct = default);
}

public sealed class SendGridEmailSender(IOptions<SendGridOptions> options, ILogger<SendGridEmailSender> logger) : IEmailSender
{
    public async Task SendAsync(string to, string subject, string htmlBody, CancellationToken ct = default)
    {
        var o = options.Value;
        if (!o.Enabled || string.IsNullOrWhiteSpace(o.ApiKey))
        {
            logger.LogInformation("Envio de e-mail desabilitado. Para: {To} | Assunto: {Subject}", to, subject);
            return;
        }

        var client = new SendGridClient(o.ApiKey);
        var message = MailHelper.CreateSingleEmail(new EmailAddress(o.FromEmail, o.FromName), new EmailAddress(to), subject, null, htmlBody);
        var response = await client.SendEmailAsync(message, ct);
        if (!response.IsSuccessStatusCode)
        {
            var body = await response.Body.ReadAsStringAsync(ct);
            throw new InvalidOperationException($"SendGrid retornou {(int)response.StatusCode}: {body}");
        }
    }
}

/// <summary>Processa a caixa de saída de e-mails com novas tentativas (até 5).</summary>
public sealed class EmailOutboxProcessor(IServiceScopeFactory scopeFactory, DatabaseReadiness database, ILogger<EmailOutboxProcessor> logger)
    : BackgroundService
{
    private const int MaxAttempts = 5;
    private static readonly TimeSpan Interval = TimeSpan.FromSeconds(30);

    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        await database.WaitAsync(stoppingToken);
        using var timer = new PeriodicTimer(Interval);
        do
        {
            try
            {
                await ProcessBatchAsync(stoppingToken);
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogError(ex, "Falha ao processar a caixa de saída de e-mails.");
            }
        } while (await timer.WaitForNextTickAsync(stoppingToken));
    }

    private async Task ProcessBatchAsync(CancellationToken ct)
    {
        using var scope = scopeFactory.CreateScope();
        var db = scope.ServiceProvider.GetRequiredService<AppDbContext>();
        var sender = scope.ServiceProvider.GetRequiredService<IEmailSender>();
        var clock = scope.ServiceProvider.GetRequiredService<IClock>();

        var pending = await db.EmailMessages
            .Where(m => m.Status == EmailStatus.PENDING && m.Attempts < MaxAttempts)
            .OrderBy(m => m.CreatedAt).Take(50).ToListAsync(ct);

        foreach (var message in pending)
        {
            message.Attempts++;
            try
            {
                await sender.SendAsync(message.To, message.Subject, message.HtmlBody, ct);
                message.Status = EmailStatus.SENT;
                message.SentAt = clock.UtcNow;
                message.LastError = null;
            }
            catch (Exception ex) when (ex is not OperationCanceledException)
            {
                logger.LogWarning(ex, "Falha ao enviar e-mail {Id} (tentativa {Attempt}).", message.Id, message.Attempts);
                message.LastError = ex.Message.Length > 2000 ? ex.Message[..2000] : ex.Message;
                if (message.Attempts >= MaxAttempts) message.Status = EmailStatus.FAILED;
            }
            await db.SaveChangesAsync(ct);
        }
    }
}

using System.Net;
using Microsoft.AspNetCore.HttpOverrides;
using VacancyControl.Infrastructure.Persistence;

namespace VacancyControl.Api.Infrastructure;

/// <summary>
/// Ajustes de execução para plataforma gerenciada (Render, Azure App Service), no modelo da aplicação financeira:
/// porta vinda da plataforma, confiança no proxy declarada, guardas que recusam configuração perdedora de dados e
/// um log de partida que deixa visível toda proteção desligada.
/// </summary>
public sealed record HostingSettings(string? Platform, bool TrustProxy, bool InMemoryDatabase)
{
    /// <summary>Render e App Service têm disco efêmero e terminam o HTTPS num proxy à frente da aplicação.</summary>
    public static HostingSettings From(IConfiguration config)
    {
        var platform = !string.IsNullOrEmpty(config["RENDER"]) ? "Render"
            : !string.IsNullOrEmpty(config["WEBSITE_SITE_NAME"]) ? "Azure App Service"
            : null;
        return new HostingSettings(
            platform,
            // Em plataforma, a aplicação só é alcançável pelo proxy dela; fora dela, só quando declarado.
            config.GetValue("Proxy:Trusted", platform is not null),
            string.Equals(config["Database:Provider"], "InMemory", StringComparison.OrdinalIgnoreCase));
    }

    /// <summary>
    /// A plataforma informa a porta em PORT (o Render usa 10000) e encaminha para todas as interfaces. Sem isso a API
    /// escutava em localhost:5000/8080, a plataforma não a encontrava e o deploy ficava esperando até expirar.
    /// ASPNETCORE_URLS / ASPNETCORE_HTTP_PORTS, quando definidas, continuam valendo.
    /// </summary>
    public static void ApplyPort(WebApplicationBuilder builder)
    {
        var port = builder.Configuration["PORT"];
        var explicitUrls = !string.IsNullOrEmpty(builder.Configuration["urls"])
                           || !string.IsNullOrEmpty(builder.Configuration["http_ports"])
                           || !string.IsNullOrEmpty(Environment.GetEnvironmentVariable("ASPNETCORE_HTTP_PORTS"));
        if (int.TryParse(port, out var p) && p > 0 && !explicitUrls)
            builder.WebHost.UseUrls($"http://0.0.0.0:{p}");
    }

    /// <summary>
    /// O proxy recebe em HTTPS e repassa em HTTP com X-Forwarded-Proto/For. Sem confiar nele, a API se via em HTTP:
    /// o CSRF recusava emitir o token (cookie Secure em requisição sem TLS) e todo GET em /api respondia 500 — inclusive
    /// /api/saude, o que derrubava o health check do deploy —, e o limite de login e a auditoria registravam o IP do
    /// proxy, não o do usuário.
    /// </summary>
    public void ConfigureForwardedHeaders(IServiceCollection services)
    {
        if (!TrustProxy) return;
        services.Configure<ForwardedHeadersOptions>(o =>
        {
            o.ForwardedHeaders = ForwardedHeaders.XForwardedFor | ForwardedHeaders.XForwardedProto;
            // O endereço do proxy da plataforma muda a cada deploy; a aplicação não é exposta por outro caminho.
            o.KnownIPNetworks.Clear();
            o.KnownProxies.Clear();
        });
    }

    /// <summary>
    /// Recusa subir em plataforma de disco efêmero com o banco em memória: todos os dados seriam descartados no próximo
    /// deploy ou quando a aplicação adormecesse, sem nenhum aviso ao usuário. A saída explícita, só para demonstração,
    /// é Database__AllowEphemeral=true — e o aviso aparece em toda subida.
    /// </summary>
    public void EnsureSafe(IConfiguration config)
    {
        if (Platform is not null && InMemoryDatabase && !config.GetValue("Database:AllowEphemeral", false))
            throw new InvalidOperationException(
                $"Database__Provider=InMemory em {Platform}: os dados seriam perdidos a cada deploy ou reinício. "
                + "Configure o PostgreSQL (ConnectionStrings__Default ou DATABASE_URL) ou, só para demonstração, "
                + "defina Database__AllowEphemeral=true.");
    }

    /// <summary>Resumo da configuração na partida, com os alertas acima dele. Nunca registra senha ou chave.</summary>
    public void LogStartup(WebApplication app)
    {
        var config = app.Configuration;
        var env = app.Environment;
        var log = app.Services.GetRequiredService<ILoggerFactory>().CreateLogger("Partida");
        var database = app.Services.GetRequiredService<DatabaseReadiness>();

        var alerts = new List<string>();
        if (InMemoryDatabase && !env.IsDevelopment())
            alerts.Add("banco EM MEMÓRIA fora de Development: os dados somem a cada reinício.");
        if (Platform is not null && !TrustProxy)
            alerts.Add($"Proxy__Trusted=false em {Platform}: o CSRF falha e o IP registrado será o do proxy.");
        if (!env.IsDevelopment() && string.IsNullOrWhiteSpace(config["App:BaseUrl"]))
            alerts.Add("App__BaseUrl vazio: os links dos e-mails sairão sem endereço.");
        if (!config.GetValue("SendGrid:Enabled", true))
            alerts.Add("SendGrid__Enabled=false: os e-mails ficam só no log.");
        if (!InMemoryDatabase && !config.GetValue("Database:MigrateOnStartup", true))
            alerts.Add("Database__MigrateOnStartup=false: migrations pendentes não serão aplicadas.");
        if (database.Target.Contains("SSL Disable", StringComparison.Ordinal) && !IsInternalHost(database.Target))
            alerts.Add("PostgreSQL sem TLS num host externo: use sslmode=require.");
        foreach (var alert in alerts) log.LogWarning("ALERTA: {Alert}", alert);

        log.LogInformation(
            "Controle de Vagas {Version} | ambiente {Environment} | plataforma {Platform} | proxy confiável {Proxy} | "
            + "banco {Database} | migrations na partida {Migrate} | e-mail {Email} | BaseUrl {BaseUrl}",
            typeof(HostingSettings).Assembly.GetName().Version?.ToString(3), env.EnvironmentName, Platform ?? "local",
            TrustProxy ? "sim" : "não", database.Target, config.GetValue("Database:MigrateOnStartup", true) ? "sim" : "não",
            config.GetValue("SendGrid:Enabled", true) ? "SendGrid" : "desligado", config["App:BaseUrl"] ?? "");
    }

    // Hosts internos da plataforma (sem ponto, como dpg-xxxx-a no Render) e loopback dispensam TLS.
    private static bool IsInternalHost(string target)
    {
        var host = target.Split(':')[0];
        return !host.Contains('.') || host == "127.0.0.1" || host == "localhost" || IPAddress.TryParse(host, out _);
    }
}

/// <summary>Enquanto o banco não está pronto (partida ou queda), responde 503 dizendo o motivo, sem a senha.</summary>
public sealed class DatabaseReadinessMiddleware(RequestDelegate next, DatabaseReadiness database)
{
    public async Task InvokeAsync(HttpContext context)
    {
        if (database.IsReady)
        {
            await next(context);
            return;
        }

        var detail = database.Failure is null
            ? "A aplicação está preparando o banco de dados. Tente novamente em alguns segundos."
            : $"Banco de dados indisponível ({database.Target}): {database.Failure} Nova tentativa automática a cada 30 s.";
        context.Response.StatusCode = StatusCodes.Status503ServiceUnavailable;
        context.Response.Headers.RetryAfter = "30";
        if (context.Request.Path.StartsWithSegments("/api"))
            await context.Response.WriteAsJsonAsync(new { status = 503, title = "Serviço indisponível", detail });
        else
            await context.Response.WriteAsync(detail);
    }
}

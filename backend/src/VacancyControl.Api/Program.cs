using System.Text.Json.Serialization;
using System.Threading.RateLimiting;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using VacancyControl.Api.Infrastructure;
using VacancyControl.Application;
using VacancyControl.Application.Common;
using VacancyControl.Infrastructure;
using VacancyControl.Infrastructure.Identity;
using VacancyControl.Infrastructure.Persistence;

var builder = WebApplication.CreateBuilder(args);
var services = builder.Services;
var config = builder.Configuration;

// ---------------------------------------------------------------- plataforma (Render): porta, proxy e guardas de partida
var hosting = HostingSettings.From(config);
hosting.EnsureSafe(config);
HostingSettings.ApplyPort(builder);
hosting.ConfigureForwardedHeaders(services);
// Cookies exigem HTTPS fora de Development; localmente o ambiente pode rodar em http://localhost.
var cookieSecurePolicy = builder.Environment.IsDevelopment() ? CookieSecurePolicy.SameAsRequest : CookieSecurePolicy.Always;

// ---------------------------------------------------------------- camadas
services.AddApplication();
services.AddInfrastructure(config, enableBackgroundJobs: config.GetValue("Jobs:Enabled", true));
services.AddHttpContextAccessor();
services.AddScoped<ICurrentUser, HttpCurrentUser>();
services.AddSingleton<IAppLinks, AppLinks>();

// ---------------------------------------------------------------- autenticação (cookie HttpOnly, sessão de 30 min)
// AddIdentityCookies registra todos os esquemas que o Identity usa ao encerrar uma sessão inválida
// (ex.: usuário inativado), evitando erro 500 na validação do carimbo de segurança.
services.AddAuthentication(IdentityConstants.ApplicationScheme)
    .AddIdentityCookies(cookies => cookies.ApplicationCookie!.Configure(o =>
    {
        o.Cookie.Name = "vagas.session";
        o.Cookie.HttpOnly = true;
        o.Cookie.SecurePolicy = cookieSecurePolicy;
        o.Cookie.SameSite = SameSiteMode.Strict;
        o.ExpireTimeSpan = TimeSpan.FromMinutes(30); // seção 12: timeout por inatividade
        o.SlidingExpiration = true;
        o.Events.OnRedirectToLogin = ctx => { ctx.Response.StatusCode = StatusCodes.Status401Unauthorized; return Task.CompletedTask; };
        o.Events.OnRedirectToAccessDenied = ctx => { ctx.Response.StatusCode = StatusCodes.Status403Forbidden; return Task.CompletedTask; };
    }));
// Perfis alterados ou usuário inativado perdem a sessão em até 1 minuto.
services.Configure<SecurityStampValidatorOptions>(o => o.ValidationInterval = TimeSpan.FromMinutes(1));

services.AddAuthorizationBuilder()
    .SetFallbackPolicy(new AuthorizationPolicyBuilder().RequireAuthenticatedUser().Build());

services.AddAntiforgery(o =>
{
    o.HeaderName = "X-XSRF-TOKEN";
    o.Cookie.Name = "vagas.af";
    o.Cookie.SameSite = SameSiteMode.Strict;
    o.Cookie.SecurePolicy = cookieSecurePolicy;
});

services.AddRateLimiter(o =>
{
    o.RejectionStatusCode = StatusCodes.Status429TooManyRequests;
    o.AddPolicy(RateLimitPolicies.Login, ctx => RateLimitPartition.GetFixedWindowLimiter(
        ctx.Connection.RemoteIpAddress?.ToString() ?? "unknown",
        _ => new FixedWindowRateLimiterOptions { PermitLimit = 10, Window = TimeSpan.FromMinutes(1) }));
});

// ---------------------------------------------------------------- API REST / JSON
services.AddControllers()
    .AddJsonOptions(o => o.JsonSerializerOptions.Converters.Add(new JsonStringEnumConverter()));
services.AddProblemDetails();
services.AddExceptionHandler<ApiExceptionHandler>();
services.AddOpenApi();

var allowedOrigins = config.GetSection("App:AllowedOrigins").Get<string[]>() ?? [];
services.AddCors(o => o.AddDefaultPolicy(p => p
    .WithOrigins(allowedOrigins)
    .AllowAnyHeader()
    .AllowAnyMethod()
    .AllowCredentials()));

services.SkipKeyRingWarmup();
var app = builder.Build();

// ---------------------------------------------------------------- pipeline
// Primeiro de todos: esquema (HTTPS) e IP do usuário vêm do proxy da plataforma, quando ele é confiável.
if (hosting.TrustProxy) app.UseForwardedHeaders();
app.UseExceptionHandler();
if (app.Environment.IsDevelopment())
{
    app.MapOpenApi().AllowAnonymous();
    app.UseSwaggerUI(o => o.SwaggerEndpoint("/openapi/v1.json", "Controle de Vagas API"));
}
else
{
    app.UseHsts();
    // Atrás do proxy, quem redireciona HTTP para HTTPS é a plataforma; aqui só geraria um aviso por requisição.
    if (!hosting.TrustProxy) app.UseHttpsRedirection();
}
app.UseMiddleware<DatabaseReadinessMiddleware>();

// Front-end em JavaScript puro, sem build: os arquivos de wwwroot são publicados como estão.
// "no-cache" faz o navegador revalidar (ETag) e pegar a versão nova logo após a cópia dos arquivos.
app.UseDefaultFiles();
app.UseStaticFiles(new StaticFileOptions
{
    OnPrepareResponse = ctx => ctx.Context.Response.Headers.CacheControl = "no-cache",
});
app.UseCors();
app.UseRateLimiter();
app.UseAuthentication();
app.UseMiddleware<MustChangePasswordMiddleware>();
app.UseAuthorization();
app.UseMiddleware<AntiforgeryMiddleware>();

app.MapControllers();
app.MapFallbackToFile("index.html").AllowAnonymous();

// O banco é preparado em segundo plano (DatabaseStartupService): a API escuta a porta mesmo sem ele.
hosting.LogStartup(app);
await app.RunAsync();

namespace VacancyControl.Api.Infrastructure
{
    public static class RateLimitPolicies
    {
        public const string Login = "login";
    }

    /// <summary>Com senha provisória, o usuário só acessa a troca de senha, o "me" e o logout.</summary>
    public sealed class MustChangePasswordMiddleware(RequestDelegate next)
    {
        private static readonly string[] Allowed =
            ["/api/saude", "/api/auth/me", "/api/auth/change-password", "/api/auth/logout", "/api/auth/login"];

        public async Task InvokeAsync(HttpContext context)
        {
            if (context.Request.Path.StartsWithSegments("/api")
                && context.User.HasClaim(AppClaimsPrincipalFactory.MustChangePasswordClaim, "true")
                && !Allowed.Any(a => context.Request.Path.StartsWithSegments(a)))
            {
                context.Response.StatusCode = StatusCodes.Status403Forbidden;
                await context.Response.WriteAsJsonAsync(new
                {
                    status = 403,
                    title = "Troca de senha obrigatória",
                    detail = "Defina uma nova senha para continuar.",
                });
                return;
            }
            await next(context);
        }
    }
}

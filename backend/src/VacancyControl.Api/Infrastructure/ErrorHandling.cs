using Microsoft.AspNetCore.Antiforgery;
using Microsoft.AspNetCore.Diagnostics;
using Microsoft.AspNetCore.Mvc;
using VacancyControl.Application.Common;

namespace VacancyControl.Api.Infrastructure;

/// <summary>Converte exceções em respostas ProblemDetails (RFC 9457) com mensagens em pt-BR.</summary>
public sealed class ApiExceptionHandler(IProblemDetailsService problemDetails, ILogger<ApiExceptionHandler> logger) : IExceptionHandler
{
    public async ValueTask<bool> TryHandleAsync(HttpContext context, Exception exception, CancellationToken ct)
    {
        var (status, title, detail) = exception switch
        {
            BusinessRuleException e => (StatusCodes.Status422UnprocessableEntity, "Regra de negócio", e.Message),
            NotFoundException e => (StatusCodes.Status404NotFound, "Não encontrado", e.Message),
            ForbiddenException e => (StatusCodes.Status403Forbidden, "Acesso negado", e.Message),
            AntiforgeryValidationException => (StatusCodes.Status400BadRequest, "Requisição inválida",
                "Sessão expirada ou token de segurança inválido. Recarregue a página."),
            BadHttpRequestException e => (StatusCodes.Status400BadRequest, "Requisição inválida", e.Message),
            _ => (StatusCodes.Status500InternalServerError, "Erro interno",
                "Ocorreu um erro inesperado. Tente novamente ou contate o administrador.")
        };

        if (status == StatusCodes.Status500InternalServerError)
            logger.LogError(exception, "Erro não tratado em {Path}", context.Request.Path);

        var problem = new ProblemDetails { Status = status, Title = title, Detail = detail };
        // Campo do formulário recusado: a tela marca o campo, não só o topo (padrão de front-end, seção 6).
        if (exception is BusinessRuleException { Field: { } field })
            problem.Extensions["campos"] = new Dictionary<string, string> { [field] = detail };

        context.Response.StatusCode = status;
        return await problemDetails.TryWriteAsync(new ProblemDetailsContext
        {
            HttpContext = context,
            Exception = exception,
            ProblemDetails = problem,
        });
    }
}

/// <summary>
/// Proteção CSRF para a SPA: emite o cookie XSRF-TOKEN (lido por js/api.js) e valida o
/// cabeçalho X-XSRF-TOKEN em toda requisição que altera dados. Complementa o cookie de sessão SameSite=Strict.
/// </summary>
public sealed class AntiforgeryMiddleware(RequestDelegate next, IAntiforgery antiforgery)
{
    public const string CookieName = "XSRF-TOKEN";
    private static readonly string[] SafeMethods = ["GET", "HEAD", "OPTIONS", "TRACE"];

    public async Task InvokeAsync(HttpContext context)
    {
        var path = context.Request.Path;
        if (path.StartsWithSegments("/api"))
        {
            if (SafeMethods.Contains(context.Request.Method))
                IssueToken(context);
            else if (!path.StartsWithSegments("/api/auth/login"))
                await antiforgery.ValidateRequestAsync(context);
        }

        await next(context);
    }

    public static void IssueToken(HttpContext context)
    {
        // Fora de Development os cookies exigem HTTPS e o antiforgery lança exceção numa requisição HTTP. Ela só chega
        // assim quando não passou pelo proxy (o health check interno da plataforma), que não precisa de token.
        var development = context.RequestServices.GetRequiredService<IWebHostEnvironment>().IsDevelopment();
        if (!context.Request.IsHttps && !development) return;

        var antiforgery = context.RequestServices.GetRequiredService<IAntiforgery>();
        var tokens = antiforgery.GetAndStoreTokens(context);
        context.Response.Cookies.Append(CookieName, tokens.RequestToken!, new CookieOptions
        {
            HttpOnly = false,
            Secure = context.Request.IsHttps || !development,
            SameSite = SameSiteMode.Strict,
            Path = "/",
        });
    }
}

using System.Reflection;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Mvc;

namespace VacancyControl.Api.Controllers;

public sealed record HealthDto(string Status, string Versao);

/// <summary>
/// Saúde e versão da API. É a primeira chamada do front-end: entrega a versão exibida no menu
/// (nunca escrita à mão na tela) e, por ser um GET em /api, já emite o cookie CSRF.
/// </summary>
[ApiController]
[AllowAnonymous]
[Route("api/saude")]
public class HealthController : ControllerBase
{
    private static readonly string Version =
        (typeof(HealthController).Assembly.GetCustomAttribute<AssemblyInformationalVersionAttribute>()?.InformationalVersion
         ?? "0.0.0").Split('+')[0];

    [HttpGet]
    public HealthDto Get() => new("ok", Version);
}

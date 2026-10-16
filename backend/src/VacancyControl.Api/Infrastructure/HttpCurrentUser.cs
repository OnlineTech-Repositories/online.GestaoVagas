using System.Security.Claims;
using VacancyControl.Application.Common;

namespace VacancyControl.Api.Infrastructure;

/// <summary>Usuário da requisição HTTP. Fora de uma requisição (rotina diária), representa o sistema.</summary>
public sealed class HttpCurrentUser(IHttpContextAccessor accessor) : ICurrentUser
{
    private ClaimsPrincipal? Principal => accessor.HttpContext?.User;

    public Guid? UserId =>
        Guid.TryParse(Principal?.FindFirstValue(ClaimTypes.NameIdentifier), out var id) ? id : null;

    public string? IpAddress => accessor.HttpContext?.Connection.RemoteIpAddress?.ToString();

    public IReadOnlyCollection<string> Roles =>
        Principal?.FindAll(ClaimTypes.Role).Select(c => c.Value).ToList() ?? [];

    public bool IsInRole(string role) => Principal?.IsInRole(role) == true;
}

public sealed class AppLinks(IConfiguration configuration) : IAppLinks
{
    // O front-end usa roteamento por hash: os links apontam para "#/rota".
    private string BaseUrl => (configuration["App:BaseUrl"] ?? "").TrimEnd('/');

    public string Position(Guid id) => $"{BaseUrl}/#/posicoes/{id}";
    public string Order(Guid id) => $"{BaseUrl}/#/pedidos/{id}";
    public string ContractRates() => $"{BaseUrl}/#/valores";
}

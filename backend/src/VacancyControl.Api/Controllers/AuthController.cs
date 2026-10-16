using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Mvc;
using Microsoft.AspNetCore.RateLimiting;
using VacancyControl.Api.Infrastructure;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Application.Features.Parameters;
using VacancyControl.Application.Features.Users;

namespace VacancyControl.Api.Controllers;

public sealed record LoginRequest(string Email, string Password);

public sealed record MeDto(
    Guid Id, string Name, string Email, IReadOnlyList<string> Roles, bool MustChangePassword,
    bool CanSeeDetailedValues, bool CanSeeAggregatedValues, bool InitialLoadOpen);

[ApiController]
[Route("api/auth")]
public class AuthController(
    SignInManager<AppUser> signInManager,
    UserManager<AppUser> userManager,
    UserService users,
    ParameterService parameters,
    ICurrentUser currentUser) : ControllerBase
{
    private const string InvalidCredentials = "E-mail ou senha inválidos.";

    [AllowAnonymous]
    [EnableRateLimiting(RateLimitPolicies.Login)]
    [HttpPost("login")]
    public async Task<ActionResult<MeDto>> Login(LoginRequest request, CancellationToken ct)
    {
        var user = await userManager.FindByEmailAsync(request.Email?.Trim() ?? "");
        if (user is null || !user.Active) return Unauthorized(Problem401(InvalidCredentials));

        var result = await signInManager.PasswordSignInAsync(user, request.Password ?? "", isPersistent: false, lockoutOnFailure: true);
        if (result.IsLockedOut)
            return Unauthorized(Problem401("Usuário bloqueado temporariamente por excesso de tentativas. Tente novamente em 15 minutos."));
        if (!result.Succeeded) return Unauthorized(Problem401(InvalidCredentials));

        // O token CSRF é vinculado ao usuário: renova para a sessão recém-criada.
        HttpContext.User = await signInManager.CreateUserPrincipalAsync(user);
        AntiforgeryMiddleware.IssueToken(HttpContext);
        return await ToMeAsync(user, ct);
    }

    [HttpPost("logout")]
    public async Task<IActionResult> Logout()
    {
        await signInManager.SignOutAsync();
        return NoContent();
    }

    [HttpGet("me")]
    public async Task<ActionResult<MeDto>> Me(CancellationToken ct)
    {
        var user = await userManager.FindByIdAsync(currentUser.UserId.ToString()!);
        if (user is null || !user.Active) return Unauthorized();
        return await ToMeAsync(user, ct);
    }

    [HttpPost("change-password")]
    public async Task<ActionResult<MeDto>> ChangePassword(ChangePasswordRequest request, CancellationToken ct)
    {
        await users.ChangeOwnPasswordAsync(request, ct);
        var user = await userManager.FindByIdAsync(currentUser.UserId.ToString()!);
        await signInManager.RefreshSignInAsync(user!);
        HttpContext.User = await signInManager.CreateUserPrincipalAsync(user!);
        AntiforgeryMiddleware.IssueToken(HttpContext);
        return await ToMeAsync(user!, ct);
    }

    private async Task<MeDto> ToMeAsync(AppUser user, CancellationToken ct)
    {
        var roles = (await userManager.GetRolesAsync(user)).Order().ToList();
        return new MeDto(user.Id, user.Name, user.Email ?? "", roles, user.MustChangePassword,
            roles.Intersect(Application.Domain.Roles.SeeDetailedValues).Any(),
            roles.Intersect(Application.Domain.Roles.SeeAggregatedValues).Any(),
            await parameters.IsInitialLoadOpenAsync(ct));
    }

    private static ProblemDetails Problem401(string detail) =>
        new() { Status = StatusCodes.Status401Unauthorized, Title = "Não autorizado", Detail = detail };
}

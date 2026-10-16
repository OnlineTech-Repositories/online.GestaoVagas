using System.Security.Claims;
using Microsoft.AspNetCore.Identity;
using Microsoft.Extensions.Options;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Identity;

/// <summary>Inclui no cookie de sessão o nome do usuário e a obrigação de trocar a senha.</summary>
public sealed class AppClaimsPrincipalFactory(
    UserManager<AppUser> userManager, RoleManager<AppRole> roleManager, IOptions<IdentityOptions> options)
    : UserClaimsPrincipalFactory<AppUser, AppRole>(userManager, roleManager, options)
{
    public const string NameClaim = "display_name";
    public const string MustChangePasswordClaim = "must_change_password";

    protected override async Task<ClaimsIdentity> GenerateClaimsAsync(AppUser user)
    {
        var identity = await base.GenerateClaimsAsync(user);
        identity.AddClaim(new Claim(NameClaim, user.Name));
        if (user.MustChangePassword) identity.AddClaim(new Claim(MustChangePasswordClaim, "true"));
        return identity;
    }
}

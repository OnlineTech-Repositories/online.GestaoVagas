using Microsoft.AspNetCore.Identity;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Application.Features.Users;

public sealed record UserDto(Guid Id, string Name, string Email, IReadOnlyList<string> Roles, bool Active, bool MustChangePassword, bool LockedOut);
public sealed record CreateUserRequest(string Name, string Email, List<string> Roles, string TemporaryPassword);
public sealed record UpdateUserRequest(string Name, string Email, List<string> Roles, bool Active);
public sealed record ResetPasswordRequest(string TemporaryPassword);
public sealed record ChangePasswordRequest(string CurrentPassword, string NewPassword);
public sealed record UserOptionDto(Guid Id, string Name);

/// <summary>Gestão de usuários e perfis (ADMIN) e troca da própria senha.</summary>
public class UserService(UserManager<AppUser> userManager, IUserDirectory directory, IClock clock, IAuditContext audit, ICurrentUser user)
{
    public async Task<List<UserDto>> ListAsync(CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var result = new List<UserDto>();
        foreach (var u in userManager.Users.OrderBy(u => u.Name).ToList())
            result.Add(await ToDtoAsync(u));
        return result;
    }

    /// <summary>Usuários ativos de um perfil (ex.: responsável comercial do contrato).</summary>
    public async Task<List<UserOptionDto>> ListByRoleAsync(string role, CancellationToken ct = default)
    {
        if (!Roles.All.Contains(role)) throw new BusinessRuleException("Perfil inválido.", "roles");
        return (await directory.ListActiveByRolesAsync([role], ct)).OrderBy(u => u.Name).Select(u => new UserOptionDto(u.Id, u.Name)).ToList();
    }

    public async Task<UserDto> CreateAsync(CreateUserRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var roles = ValidateRoles(r.Roles);
        var appUser = new AppUser
        {
            Name = DateGuard.RequireText(r.Name, "Informe o nome.", "name"),
            Email = DateGuard.RequireText(r.Email, "Informe o e-mail.", "email").ToLowerInvariant(),
            UserName = r.Email.Trim().ToLowerInvariant(),
            EmailConfirmed = true,
            MustChangePassword = true,
            CreatedAt = clock.UtcNow,
        };

        audit.Set("CREATE_USER");
        Check(await userManager.CreateAsync(appUser, r.TemporaryPassword), "temporaryPassword");
        Check(await userManager.AddToRolesAsync(appUser, roles));
        return await ToDtoAsync(appUser);
    }

    public async Task<UserDto> UpdateAsync(Guid id, UpdateUserRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var appUser = await FindAsync(id);
        var roles = ValidateRoles(r.Roles);
        if (id == user.UserId && (!r.Active || !roles.Contains(Roles.Admin)))
            throw new BusinessRuleException("Você não pode desativar o próprio usuário nem remover o seu perfil de administrador.");

        var email = DateGuard.RequireText(r.Email, "Informe o e-mail.", "email").ToLowerInvariant();
        appUser.Name = DateGuard.RequireText(r.Name, "Informe o nome.", "name");
        appUser.Email = email;
        appUser.UserName = email;
        appUser.Active = r.Active;

        audit.Set("UPDATE_USER");
        Check(await userManager.UpdateAsync(appUser));
        var current = await userManager.GetRolesAsync(appUser);
        Check(await userManager.RemoveFromRolesAsync(appUser, current.Except(roles)));
        Check(await userManager.AddToRolesAsync(appUser, roles.Except(current)));
        // Invalida sessões abertas para que perfil/inativação valham imediatamente.
        Check(await userManager.UpdateSecurityStampAsync(appUser));
        return await ToDtoAsync(appUser);
    }

    public async Task ResetPasswordAsync(Guid id, ResetPasswordRequest r, CancellationToken ct = default)
    {
        Permissions.Require(user, Roles.Admin);
        var appUser = await FindAsync(id);
        audit.Set("RESET_PASSWORD");
        await ValidatePasswordAsync(appUser, r.TemporaryPassword, "temporaryPassword");
        Check(await userManager.RemovePasswordAsync(appUser));
        Check(await userManager.AddPasswordAsync(appUser, r.TemporaryPassword));
        appUser.MustChangePassword = true;
        Check(await userManager.SetLockoutEndDateAsync(appUser, null));
        Check(await userManager.UpdateAsync(appUser));
    }

    public async Task ChangeOwnPasswordAsync(ChangePasswordRequest r, CancellationToken ct = default)
    {
        var appUser = await FindAsync(user.UserId ?? throw new ForbiddenException());
        audit.Set("CHANGE_PASSWORD");
        var result = await userManager.ChangePasswordAsync(appUser, r.CurrentPassword, r.NewPassword);
        if (!result.Succeeded && result.Errors.Any(e => e.Code == "PasswordMismatch"))
            throw new BusinessRuleException("A senha atual está incorreta.", "currentPassword");
        Check(result, "newPassword");
        appUser.MustChangePassword = false;
        Check(await userManager.UpdateAsync(appUser));
    }

    private async Task ValidatePasswordAsync(AppUser appUser, string password, string field)
    {
        foreach (var validator in userManager.PasswordValidators)
            Check(await validator.ValidateAsync(userManager, appUser, password), field);
    }

    private async Task<AppUser> FindAsync(Guid id) =>
        await userManager.FindByIdAsync(id.ToString()) ?? throw new NotFoundException("Usuário não encontrado.");

    private async Task<UserDto> ToDtoAsync(AppUser u) => new(
        u.Id, u.Name, u.Email ?? "", (await userManager.GetRolesAsync(u)).Order().ToList(), u.Active, u.MustChangePassword,
        u.LockoutEnd is { } end && end > clock.UtcNow);

    private static List<string> ValidateRoles(IEnumerable<string>? roles)
    {
        var list = (roles ?? []).Select(r => r.Trim().ToUpperInvariant()).Distinct().ToList();
        if (list.Count == 0) throw new BusinessRuleException("Selecione ao menos um perfil.", "roles");
        if (list.Any(r => !Roles.All.Contains(r))) throw new BusinessRuleException("Perfil inválido.", "roles");
        return list;
    }

    /// <summary>Converte o erro do Identity em regra de negócio, apontando o campo de senha ou de e-mail.</summary>
    private static void Check(IdentityResult result, string? passwordField = null)
    {
        if (result.Succeeded) return;
        var first = result.Errors.First().Code;
        var field = first.StartsWith("Password", StringComparison.Ordinal) ? passwordField
            : first is "DuplicateUserName" or "DuplicateEmail" or "InvalidEmail" or "InvalidUserName" ? "email"
            : null;
        throw new BusinessRuleException(string.Join(" ", result.Errors.Select(e => e.Description)), field);
    }
}

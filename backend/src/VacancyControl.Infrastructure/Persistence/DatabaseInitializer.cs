using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Logging;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

/// <summary>
/// Aplica as migrations (quando habilitado) e cria os dados mínimos: perfis, parâmetros padrão (D5) e o
/// primeiro ADMIN. As credenciais do ADMIN vêm de configuração segura (Seed__AdminEmail / Seed__AdminPassword).
/// </summary>
public static class DatabaseInitializer
{
    public static async Task InitializeAsync(IServiceProvider services, CancellationToken ct = default)
    {
        using var scope = services.CreateScope();
        var sp = scope.ServiceProvider;
        var config = sp.GetRequiredService<IConfiguration>();
        var logger = sp.GetRequiredService<ILoggerFactory>().CreateLogger(typeof(DatabaseInitializer));
        var db = sp.GetRequiredService<AppDbContext>();
        sp.GetRequiredService<IAuditContext>().Set("SEED");

        if (!db.Database.IsRelational())
        {
            logger.LogWarning("Banco EM MEMÓRIA: os dados são perdidos ao reiniciar a API. Use somente para avaliação local.");
            await db.Database.EnsureCreatedAsync(ct);
        }
        else if (config.GetValue("Database:MigrateOnStartup", true))
        {
            logger.LogInformation("Aplicando migrations...");
            await db.Database.MigrateAsync(ct);
        }

        var roleManager = sp.GetRequiredService<RoleManager<AppRole>>();
        foreach (var role in Roles.All)
            if (!await roleManager.RoleExistsAsync(role))
                await roleManager.CreateAsync(new AppRole(role));

        var existingKeys = await db.SystemParameters.Select(p => p.Key).ToListAsync(ct);
        foreach (var (key, (value, description)) in ParameterKeys.Defaults.Where(d => !existingKeys.Contains(d.Key)))
            db.SystemParameters.Add(new SystemParameter { Key = key, Value = value, Description = description });
        await db.SaveChangesAsync(ct);

        var userManager = sp.GetRequiredService<UserManager<AppUser>>();
        await CreateFirstAdminAsync(userManager, config, logger);

        if (config.GetValue("Seed:DemoData", false))
            await DemoDataSeeder.SeedAsync(sp, config, logger, ct);
    }

    private static async Task CreateFirstAdminAsync(UserManager<AppUser> userManager, IConfiguration config, ILogger logger)
    {
        if ((await userManager.GetUsersInRoleAsync(Roles.Admin)).Count > 0) return;

        var email = config["Seed:AdminEmail"];
        var password = config["Seed:AdminPassword"];
        if (string.IsNullOrWhiteSpace(email) || string.IsNullOrWhiteSpace(password))
        {
            logger.LogWarning("Nenhum administrador cadastrado. Defina Seed__AdminEmail e Seed__AdminPassword para criar o primeiro ADMIN.");
            return;
        }

        var admin = new AppUser
        {
            Name = config["Seed:AdminName"] ?? "Administrador",
            Email = email.Trim().ToLowerInvariant(),
            UserName = email.Trim().ToLowerInvariant(),
            EmailConfirmed = true,
            MustChangePassword = true,
            CreatedAt = DateTimeOffset.UtcNow,
        };
        var result = await userManager.CreateAsync(admin, password);
        if (!result.Succeeded)
            throw new InvalidOperationException("Falha ao criar o ADMIN inicial: " + string.Join(" ", result.Errors.Select(e => e.Description)));
        await userManager.AddToRoleAsync(admin, Roles.Admin);
        logger.LogInformation("Administrador inicial criado: {Email}. A senha deverá ser trocada no primeiro acesso.", admin.Email);
    }
}

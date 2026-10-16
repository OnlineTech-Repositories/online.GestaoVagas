using Microsoft.AspNetCore.DataProtection;
using Microsoft.AspNetCore.Identity;
using Microsoft.EntityFrameworkCore;
using Microsoft.Extensions.Configuration;
using Microsoft.Extensions.DependencyInjection;
using Microsoft.Extensions.Hosting;
using VacancyControl.Application.Common;
using VacancyControl.Application.Domain.Entities;
using VacancyControl.Infrastructure.Email;
using VacancyControl.Infrastructure.Identity;
using VacancyControl.Infrastructure.Jobs;
using VacancyControl.Infrastructure.Persistence;
using VacancyControl.Infrastructure.Services;

namespace VacancyControl.Infrastructure;

public static class DependencyInjection
{
    public static IServiceCollection AddInfrastructure(this IServiceCollection services, IConfiguration configuration,
        bool enableBackgroundJobs = true)
    {
        services.AddSingleton(TimeProvider.System);
        services.AddSingleton<SaoPauloClock>();
        services.AddSingleton<IClock>(sp => sp.GetRequiredService<SaoPauloClock>());
        services.AddScoped<IAuditContext, AuditContext>();
        services.AddScoped<AuditSaveChangesInterceptor>();

        // Database:Provider = PostgreSQL (padrão) ou InMemory (somente para avaliação local, sem persistência).
        var useInMemory = string.Equals(configuration["Database:Provider"], "InMemory", StringComparison.OrdinalIgnoreCase);
        var connectionString = useInMemory
            ? null
            : PostgresConnection.Resolve(configuration)
              ?? throw new InvalidOperationException(
                  "Conexão PostgreSQL não configurada. Defina ConnectionStrings__Default (formato Host=...;Database=... ou a URL "
                  + "postgresql://...) ou DATABASE_URL. Para avaliação local sem banco, use Database__Provider=InMemory.");

        services.AddDbContext<AppDbContext>((sp, options) =>
        {
            if (useInMemory)
                options.UseInMemoryDatabase("controle_vagas");
            else
                options.UseNpgsql(connectionString, npgsql => npgsql.MigrationsHistoryTable("__ef_migrations_history"));
            options.UseSnakeCaseNamingConvention()
                .AddInterceptors(sp.GetRequiredService<AuditSaveChangesInterceptor>());
        });

        // Seção 12: senha mínima de 8 caracteres com maiúscula, número e caractere especial; hash PBKDF2 do Identity.
        services.AddIdentityCore<AppUser>(o =>
            {
                o.Password.RequiredLength = 8;
                o.Password.RequireUppercase = true;
                o.Password.RequireDigit = true;
                o.Password.RequireNonAlphanumeric = true;
                o.Password.RequireLowercase = false;
                o.User.RequireUniqueEmail = true;
                o.Lockout.MaxFailedAccessAttempts = 5;
                o.Lockout.DefaultLockoutTimeSpan = TimeSpan.FromMinutes(15);
                o.Lockout.AllowedForNewUsers = true;
            })
            .AddRoles<AppRole>()
            .AddEntityFrameworkStores<AppDbContext>()
            .AddErrorDescriber<PortugueseIdentityErrorDescriber>()
            .AddClaimsPrincipalFactory<AppClaimsPrincipalFactory>()
            .AddSignInManager()
            .AddDefaultTokenProviders();

        // Chaves que assinam o cookie de sessão e o token CSRF, guardadas no banco. Na plataforma o disco do processo é
        // descartado a cada deploy (e, no plano gratuito do Render, a cada vez que a aplicação adormece): com as chaves
        // no disco, todos os usuários eram desconectados nessas ocasiões.
        services.AddDataProtection()
            .SetApplicationName("controle-vagas")
            .PersistKeysToDbContext<AppDbContext>();

        services.AddDatabaseStartup(useInMemory ? "banco em memória" : PostgresConnection.Describe(connectionString!));

        services.AddScoped(typeof(IRepository<>), typeof(Repository<>));
        services.AddScoped<IUnitOfWork, UnitOfWork>();
        services.AddScoped<IEvidenceStorage, DbEvidenceStorage>();
        services.AddScoped<IContractRepository, ContractRepository>();
        services.AddScoped<IContractRateRepository, ContractRateRepository>();
        services.AddScoped<ISlaTargetRepository, SlaTargetRepository>();
        services.AddScoped<IOrderRepository, OrderRepository>();
        services.AddScoped<IPositionRepository, PositionRepository>();
        services.AddScoped<IAuditLogRepository, AuditLogRepository>();
        services.AddScoped<INotificationRepository, NotificationRepository>();
        services.AddScoped<IJobRunRepository, JobRunRepository>();
        services.AddScoped<IUserDirectory, UserDirectory>();

        services.Configure<SendGridOptions>(configuration.GetSection(SendGridOptions.Section));
        services.AddSingleton<IEmailSender, SendGridEmailSender>();

        if (enableBackgroundJobs)
        {
            services.AddHostedService<EmailOutboxProcessor>();
            services.AddHostedService<DailyJobScheduler>();
        }

        return services;
    }

    /// <summary>
    /// O Data Protection lê as chaves ao subir, só para adiantar o trabalho. Com o banco preparado em segundo plano
    /// (DatabaseStartupService), essa leitura corria contra a migration e registrava "relation data_protection_keys
    /// does not exist" em todo primeiro deploy. Sem ela, as chaves são lidas na primeira requisição, que só passa depois
    /// que o banco está pronto. Chamar depois de todos os registros: autenticação e antiforgery recadastram o serviço.
    /// </summary>
    public static IServiceCollection SkipKeyRingWarmup(this IServiceCollection services)
    {
        foreach (var d in services.Where(d => d.ServiceType == typeof(IHostedService)
                     && d.ImplementationType?.Name == "DataProtectionHostedService").ToList())
            services.Remove(d);
        return services;
    }
}

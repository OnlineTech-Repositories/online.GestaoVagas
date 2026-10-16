using Microsoft.AspNetCore.DataProtection.EntityFrameworkCore;
using Microsoft.AspNetCore.Identity;
using Microsoft.AspNetCore.Identity.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

public class AppDbContext(DbContextOptions<AppDbContext> options)
    : IdentityDbContext<AppUser, AppRole, Guid>(options), IDataProtectionKeyContext
{
    public DbSet<GroupEntity> GroupEntities => Set<GroupEntity>();
    public DbSet<Client> Clients => Set<Client>();
    public DbSet<Contract> Contracts => Set<Contract>();
    public DbSet<JobRole> JobRoles => Set<JobRole>();
    public DbSet<WorkLocation> WorkLocations => Set<WorkLocation>();
    public DbSet<ContractRate> ContractRates => Set<ContractRate>();
    public DbSet<Order> Orders => Set<Order>();
    public DbSet<Position> Positions => Set<Position>();
    public DbSet<OrderRhAnalyst> OrderRhAnalysts => Set<OrderRhAnalyst>();
    public DbSet<Candidate> Candidates => Set<Candidate>();
    public DbSet<PositionEvidence> PositionEvidences => Set<PositionEvidence>();
    public DbSet<EvidenceFile> EvidenceFiles => Set<EvidenceFile>();
    public DbSet<Termination> Terminations => Set<Termination>();
    public DbSet<Pause> Pauses => Set<Pause>();
    public DbSet<PauseReason> PauseReasons => Set<PauseReason>();
    public DbSet<SlaTarget> SlaTargets => Set<SlaTarget>();
    public DbSet<SystemParameter> SystemParameters => Set<SystemParameter>();
    public DbSet<AuditLog> AuditLogs => Set<AuditLog>();
    public DbSet<Notification> Notifications => Set<Notification>();
    public DbSet<EmailMessage> EmailMessages => Set<EmailMessage>();
    public DbSet<JobRun> JobRuns => Set<JobRun>();

    /// <summary>Chaves do Data Protection (cookie de sessão e CSRF), para sobreviverem ao deploy.</summary>
    public DbSet<DataProtectionKey> DataProtectionKeys => Set<DataProtectionKey>();

    protected override void OnModelCreating(ModelBuilder builder)
    {
        base.OnModelCreating(builder);
        builder.ApplyConfigurationsFromAssembly(typeof(AppDbContext).Assembly);

        // Nomes de tabelas do Identity no padrão do restante do banco.
        builder.Entity<AppUser>().ToTable("users");
        builder.Entity<AppRole>().ToTable("roles");
        builder.Entity<IdentityUserRole<Guid>>().ToTable("user_roles");
        builder.Entity<IdentityUserClaim<Guid>>().ToTable("user_claims");
        builder.Entity<IdentityUserLogin<Guid>>().ToTable("user_logins");
        builder.Entity<IdentityUserToken<Guid>>().ToTable("user_tokens");
        builder.Entity<IdentityRoleClaim<Guid>>().ToTable("role_claims");
        builder.Entity<AppUser>().Property(u => u.Name).HasMaxLength(150).IsRequired();

        foreach (var entityType in builder.Model.GetEntityTypes())
        {
            // Ids gerados na aplicação (UUID v7): o EF sempre trata entidades novas como inserção.
            if (typeof(BaseEntity).IsAssignableFrom(entityType.ClrType))
                builder.Entity(entityType.ClrType).Property(nameof(BaseEntity.Id)).ValueGeneratedNever();

            // Enums gravados como texto, legíveis no banco e em relatórios.
            foreach (var property in entityType.GetProperties())
            {
                var type = Nullable.GetUnderlyingType(property.ClrType) ?? property.ClrType;
                if (type.IsEnum) property.SetProviderClrType(typeof(string));
                if (type == typeof(decimal)) { property.SetPrecision(12); property.SetScale(2); }
            }
        }
    }
}

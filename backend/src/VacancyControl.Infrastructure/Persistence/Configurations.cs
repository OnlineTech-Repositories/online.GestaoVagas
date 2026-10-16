using VacancyControl.Application.Common;
using Microsoft.EntityFrameworkCore;
using Microsoft.EntityFrameworkCore.Metadata.Builders;
using VacancyControl.Application.Domain;
using VacancyControl.Application.Domain.Entities;

namespace VacancyControl.Infrastructure.Persistence;

internal sealed class GroupEntityConfiguration : IEntityTypeConfiguration<GroupEntity>
{
    public void Configure(EntityTypeBuilder<GroupEntity> b)
    {
        b.Property(x => x.Name).HasMaxLength(150).IsRequired();
        b.Property(x => x.Cnpj).HasMaxLength(14).IsRequired();
        b.HasIndex(x => x.Cnpj).IsUnique();
    }
}

internal sealed class ClientConfiguration : IEntityTypeConfiguration<Client>
{
    public void Configure(EntityTypeBuilder<Client> b)
    {
        b.Property(x => x.LegalName).HasMaxLength(200).IsRequired();
        b.Property(x => x.Cnpj).HasMaxLength(14).IsRequired();
        b.HasIndex(x => x.Cnpj).IsUnique();
    }
}

internal sealed class ContractConfiguration : IEntityTypeConfiguration<Contract>
{
    public void Configure(EntityTypeBuilder<Contract> b)
    {
        b.Property(x => x.Name).HasMaxLength(150).IsRequired();
        b.HasIndex(x => x.Name).IsUnique();
        b.HasOne(x => x.Client).WithMany().HasForeignKey(x => x.ClientId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.ContractingUnit).WithMany().HasForeignKey(x => x.ContractingUnitId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.GroupEntity).WithMany().HasForeignKey(x => x.GroupEntityId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne<AppUser>().WithMany().HasForeignKey(x => x.CommercialOwnerId).OnDelete(DeleteBehavior.Restrict);
        b.PrimitiveCollection(x => x.Modalities).ElementType().HasConversion<string>();
        b.ToTable(t => t.HasCheckConstraint("ck_contracts_modalities", "cardinality(modalities) > 0"));
    }
}

internal sealed class JobRoleConfiguration : IEntityTypeConfiguration<JobRole>
{
    public void Configure(EntityTypeBuilder<JobRole> b)
    {
        b.Property(x => x.Name).HasMaxLength(150).IsRequired();
        b.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class WorkLocationConfiguration : IEntityTypeConfiguration<WorkLocation>
{
    public void Configure(EntityTypeBuilder<WorkLocation> b)
    {
        b.Property(x => x.Name).HasMaxLength(200).IsRequired();
        b.Property(x => x.Code).HasMaxLength(50);
        b.Property(x => x.Cnpj).HasMaxLength(14);
        b.Ignore(x => x.IsUnit);
        b.HasOne(x => x.Client).WithMany().HasForeignKey(x => x.ClientId).OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class PauseReasonConfiguration : IEntityTypeConfiguration<PauseReason>
{
    public void Configure(EntityTypeBuilder<PauseReason> b)
    {
        b.Property(x => x.Name).HasMaxLength(150).IsRequired();
        b.HasIndex(x => x.Name).IsUnique();
    }
}

internal sealed class ContractRateConfiguration : IEntityTypeConfiguration<ContractRate>
{
    public void Configure(EntityTypeBuilder<ContractRate> b)
    {
        b.Ignore(x => x.DailyValue);
        b.HasOne(x => x.Contract).WithMany().HasForeignKey(x => x.ContractId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.JobRole).WithMany().HasForeignKey(x => x.JobRoleId).OnDelete(DeleteBehavior.Restrict);
        b.HasIndex(x => new { x.ContractId, x.JobRoleId, x.ValidFrom }).IsUnique();
        b.Property(x => x.RejectionReason).HasMaxLength(1000);
    }
}

internal sealed class SlaTargetConfiguration : IEntityTypeConfiguration<SlaTarget>
{
    public void Configure(EntityTypeBuilder<SlaTarget> b)
    {
        b.HasIndex(x => new { x.Modality, x.DemandType, x.ValidFrom }).IsUnique();
        b.ToTable(t => t.HasCheckConstraint("ck_sla_targets_days", "days > 0"));
    }
}

internal sealed class OrderConfiguration : IEntityTypeConfiguration<Order>
{
    public void Configure(EntityTypeBuilder<Order> b)
    {
        b.Property(x => x.Number).UseIdentityAlwaysColumn();
        b.Property(x => x.JobDescription).HasMaxLength(OrderTexts.JobDescriptionMaxLength);
        b.Property(x => x.NotApprovedReason).HasMaxLength(1000);
        b.Ignore(x => x.IsApproved);
        b.Ignore(x => x.HasJobconvoRecord);
        b.Ignore(x => x.ActiveRhAnalysts);
        b.Ignore(x => x.AwaitingRhAssignment);
        b.Ignore(x => x.CurrentPositions);
        b.Property(x => x.JobconvoCode).HasMaxLength(100);
        b.Property(x => x.JobconvoNotes).HasMaxLength(2000);
        b.HasIndex(x => x.Number).IsUnique();
        b.Ignore(x => x.Status);
        b.Property(x => x.Notes).HasMaxLength(2000);
        b.HasOne(x => x.Contract).WithMany().HasForeignKey(x => x.ContractId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.JobRole).WithMany().HasForeignKey(x => x.JobRoleId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.WorkLocation).WithMany().HasForeignKey(x => x.WorkLocationId).OnDelete(DeleteBehavior.Restrict);
        b.HasMany(x => x.Positions).WithOne(x => x.Order).HasForeignKey(x => x.OrderId).OnDelete(DeleteBehavior.Restrict);
        b.ToTable(t =>
        {
            t.HasCheckConstraint("ck_orders_quantity", "quantity >= 1");
            t.HasCheckConstraint("ck_orders_desired_start", "desired_start_date >= client_request_date");
        });
    }
}

internal sealed class PositionConfiguration : IEntityTypeConfiguration<Position>
{
    public void Configure(EntityTypeBuilder<Position> b)
    {
        b.Ignore(x => x.IsOpen);
        b.Ignore(x => x.IsClosed);
        b.Ignore(x => x.ActivePause);
        b.Ignore(x => x.StageStatus);
        b.Ignore(x => x.ActiveCandidate);
        b.Ignore(x => x.CanRegisterMissingCandidate);
        b.Ignore(x => x.IsAdmitted);
        b.Ignore(x => x.IsCurrentCycle);
        b.Ignore(x => x.NotReplaced);
        b.HasIndex(x => new { x.OrderId, x.SlotNumber, x.Cycle }).IsUnique();
        b.Property(x => x.EmployeeName).HasMaxLength(200);
        b.Property(x => x.EmployeeRegistration).HasMaxLength(50);
        b.Property(x => x.AdmissionRegistration).HasMaxLength(50);
        b.Property(x => x.FirstDayJustification).HasMaxLength(2000);
        b.Property(x => x.CancellationReason).HasMaxLength(1000);
        b.Property(x => x.TermAdjustJustification).HasMaxLength(1000);
        b.HasIndex(x => new { x.OrderId, x.Sequence }).IsUnique();
        b.HasIndex(x => x.Status);
        b.HasIndex(x => x.EmployeeRegistration);

        b.HasOne(x => x.OriginPosition).WithMany().HasForeignKey(x => x.OriginPositionId).OnDelete(DeleteBehavior.Restrict);
        b.HasOne(x => x.Rate).WithMany().HasForeignKey(x => x.RateId).OnDelete(DeleteBehavior.Restrict);
        // Reposição → desligamento que a originou (1:1).
        b.HasOne(x => x.Termination).WithOne(x => x.ReplacementPosition)
            .HasForeignKey<Position>(x => x.TerminationId).OnDelete(DeleteBehavior.Restrict);
        b.HasMany(x => x.Pauses).WithOne().HasForeignKey(x => x.PositionId).OnDelete(DeleteBehavior.Restrict);
        b.ToTable(t => t.HasCheckConstraint("ck_positions_replacement",
            "demand_type = 'NEW' OR (origin_position_id IS NOT NULL AND termination_id IS NOT NULL)"));
    }
}

internal sealed class TerminationConfiguration : IEntityTypeConfiguration<Termination>
{
    public void Configure(EntityTypeBuilder<Termination> b)
    {
        b.Property(x => x.Notes).HasMaxLength(2000);
        // RN-12: um único desligamento por posição de origem.
        b.HasOne(x => x.OriginPosition).WithOne(x => x.ExitTermination)
            .HasForeignKey<Termination>(x => x.OriginPositionId).OnDelete(DeleteBehavior.Restrict);
        b.HasIndex(x => x.OriginPositionId).IsUnique();
    }
}

internal sealed class OrderRhAnalystConfiguration : IEntityTypeConfiguration<OrderRhAnalyst>
{
    public void Configure(EntityTypeBuilder<OrderRhAnalyst> b)
    {
        b.Ignore(x => x.IsActive);
        b.Property(x => x.UserName).HasMaxLength(200);
        b.HasOne(x => x.Order).WithMany(x => x.RhAnalysts).HasForeignKey(x => x.OrderId).OnDelete(DeleteBehavior.Restrict);
        // Um analista aparece no máximo uma vez entre os responsáveis ativos do pedido.
        b.HasIndex(x => new { x.OrderId, x.UserId }).IsUnique().HasFilter("removed_at IS NULL")
            .HasDatabaseName("ux_order_rh_analysts_active");
    }
}

internal sealed class CandidateConfiguration : IEntityTypeConfiguration<Candidate>
{
    public void Configure(EntityTypeBuilder<Candidate> b)
    {
        b.Ignore(x => x.IsActive);
        b.Property(x => x.FullName).HasMaxLength(Candidate.FullNameMaxLength);
        b.Property(x => x.Cpf).HasMaxLength(11).IsFixedLength();
        b.Property(x => x.WithdrawalReason).HasMaxLength(200);
        b.HasOne(x => x.Position).WithMany(x => x.Candidates).HasForeignKey(x => x.PositionId).OnDelete(DeleteBehavior.Restrict);
        // No máximo um candidato ativo por posição.
        b.HasIndex(x => x.PositionId).IsUnique().HasFilter("withdrawn_at IS NULL").HasDatabaseName("ux_candidates_one_active");
        b.HasIndex(x => x.Cpf);
    }
}

internal sealed class PositionEvidenceConfiguration : IEntityTypeConfiguration<PositionEvidence>
{
    public void Configure(EntityTypeBuilder<PositionEvidence> b)
    {
        b.Property(x => x.FileName).HasMaxLength(EvidenceFiles.FileNameMaxLength);
        b.Property(x => x.ContentType).HasMaxLength(100);
        b.Property(x => x.StorageKey).HasMaxLength(200);
        b.HasOne(x => x.Position).WithMany(x => x.Evidences).HasForeignKey(x => x.PositionId).OnDelete(DeleteBehavior.Restrict);
    }
}

internal sealed class EvidenceFileConfiguration : IEntityTypeConfiguration<EvidenceFile>
{
    public void Configure(EntityTypeBuilder<EvidenceFile> b) => b.HasKey(x => x.Id);
}

internal sealed class PauseConfiguration : IEntityTypeConfiguration<Pause>
{
    public void Configure(EntityTypeBuilder<Pause> b)
    {
        b.Ignore(x => x.IsActive);
        b.HasOne(x => x.Reason).WithMany().HasForeignKey(x => x.ReasonId).OnDelete(DeleteBehavior.Restrict);
        b.ToTable(t => t.HasCheckConstraint("ck_pauses_dates", "end_date IS NULL OR end_date >= start_date"));
        // RN-17: no máximo uma pausa ativa por posição.
        b.HasIndex(x => x.PositionId).IsUnique().HasFilter("end_date IS NULL").HasDatabaseName("ux_pauses_one_active");
    }
}

internal sealed class SystemParameterConfiguration : IEntityTypeConfiguration<SystemParameter>
{
    public void Configure(EntityTypeBuilder<SystemParameter> b)
    {
        b.Property(x => x.Key).HasMaxLength(100).IsRequired();
        b.Property(x => x.Value).HasMaxLength(500).IsRequired();
        b.Property(x => x.Description).HasMaxLength(500);
        b.HasIndex(x => x.Key).IsUnique();
    }
}

internal sealed class AuditLogConfiguration : IEntityTypeConfiguration<AuditLog>
{
    public void Configure(EntityTypeBuilder<AuditLog> b)
    {
        b.Property(x => x.Id).UseIdentityAlwaysColumn();
        b.Property(x => x.Entity).HasMaxLength(100).IsRequired();
        b.Property(x => x.Action).HasMaxLength(100).IsRequired();
        b.Property(x => x.Field).HasMaxLength(100);
        b.Property(x => x.Ip).HasMaxLength(64);
        b.HasIndex(x => new { x.EntityId, x.Timestamp });
        b.HasIndex(x => x.Timestamp);
    }
}

internal sealed class NotificationConfiguration : IEntityTypeConfiguration<Notification>
{
    public void Configure(EntityTypeBuilder<Notification> b)
    {
        b.Property(x => x.Type).HasMaxLength(100).IsRequired();
        b.Property(x => x.Message).HasMaxLength(2000).IsRequired();
        b.HasIndex(x => new { x.UserId, x.ReadAt });
    }
}

internal sealed class EmailMessageConfiguration : IEntityTypeConfiguration<EmailMessage>
{
    public void Configure(EntityTypeBuilder<EmailMessage> b)
    {
        b.Property(x => x.To).HasMaxLength(256).IsRequired();
        b.Property(x => x.Subject).HasMaxLength(300).IsRequired();
        b.Property(x => x.LastError).HasMaxLength(2000);
        b.HasIndex(x => x.Status);
    }
}

internal sealed class JobRunConfiguration : IEntityTypeConfiguration<JobRun>
{
    public void Configure(EntityTypeBuilder<JobRun> b)
    {
        b.Property(x => x.JobName).HasMaxLength(50).IsRequired();
        b.HasIndex(x => new { x.JobName, x.RunDate }).IsUnique();
    }
}

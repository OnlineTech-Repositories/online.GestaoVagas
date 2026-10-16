namespace VacancyControl.Application.Domain.Entities;

public class Contract : BaseEntity
{
    public Guid ClientId { get; set; }
    public Client? Client { get; set; }
    /// <summary>Unidade contratante: obrigatória quando o cliente tem unidades; nula = cliente principal.</summary>
    public Guid? ContractingUnitId { get; set; }
    public WorkLocation? ContractingUnit { get; set; }
    /// <summary>Identificador do contrato = código interno gerado (<see cref="Domain.ContractCode"/>); nunca muda.</summary>
    public string Name { get; set; } = "";
    public Guid GroupEntityId { get; set; }
    public GroupEntity? GroupEntity { get; set; }
    public List<Modality> Modalities { get; set; } = [];
    public DateOnly StartDate { get; set; }
    public DateOnly? EndDate { get; set; }
    public Guid CommercialOwnerId { get; set; }
    /// <summary>Meta contratual (dias) para vaga nova.</summary>
    public int? SlaNewDays { get; set; }
    /// <summary>Meta contratual (dias) para reposição.</summary>
    public int? SlaReplacementDays { get; set; }
    public ContractStatus Status { get; set; } = ContractStatus.ACTIVE;
}

/// <summary>Valor mensal de venda por cargo no contrato, versionado por <see cref="ValidFrom"/>.</summary>
public class ContractRate : BaseEntity
{
    public Guid ContractId { get; set; }
    public Contract? Contract { get; set; }
    public Guid JobRoleId { get; set; }
    public JobRole? JobRole { get; set; }
    public decimal? MonthlyValue { get; set; }
    /// <summary>Somente R&amp;S; informativo.</summary>
    public decimal? FeeValue { get; set; }
    public DateOnly ValidFrom { get; set; }
    public RateStatus Status { get; set; } = RateStatus.PENDING;
    public Guid? ValidatedBy { get; set; }
    public DateTimeOffset? ValidatedAt { get; set; }
    public string? RejectionReason { get; set; }

    /// <summary>RN-20: valor diário = mensal / 30.</summary>
    public decimal? DailyValue => MonthlyValue / 30m;
}

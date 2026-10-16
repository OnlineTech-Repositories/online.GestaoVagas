namespace VacancyControl.Application.Domain.Entities;

/// <summary>CNPJ do Grupo ON LINE (parâmetro).</summary>
public class GroupEntity : BaseEntity
{
    public string Name { get; set; } = "";
    public string Cnpj { get; set; } = "";
    public bool Active { get; set; } = true;
}

public class Client : BaseEntity
{
    public string LegalName { get; set; } = "";
    public string Cnpj { get; set; } = "";
    public bool Active { get; set; } = true;
    /// <summary>Rede com várias lojas, filiais ou unidades: as unidades são os locais de trabalho do cliente.</summary>
    public bool HasMultipleUnits { get; set; }
}

/// <summary>Cargo (parâmetro).</summary>
public class JobRole : BaseEntity
{
    public string Name { get; set; } = "";
    public bool Active { get; set; } = true;
}

/// <summary>
/// Local de trabalho. Sem cliente = local geral (cadastro auxiliar do ADMIN); com cliente = unidade do cliente
/// (loja, filial), mantida no cadastro do cliente.
/// </summary>
public class WorkLocation : BaseEntity
{
    public string Name { get; set; } = "";
    public Guid? ClientId { get; set; }
    public Client? Client { get; set; }
    public bool Active { get; set; } = true;
    /// <summary>Código da unidade, único entre as unidades do cliente (ex.: "Loja 045").</summary>
    public string? Code { get; set; }
    /// <summary>CNPJ da filial (opcional).</summary>
    public string? Cnpj { get; set; }
    /// <summary>Exclusão lógica da unidade (RN-26): sai das listas, mas continua no banco e no histórico.</summary>
    public DateTimeOffset? RemovedAt { get; set; }

    public bool IsUnit => ClientId is not null;
}

/// <summary>Motivo de pausa: apenas motivos de responsabilidade do cliente (D6).</summary>
public class PauseReason : BaseEntity
{
    public string Name { get; set; } = "";
    public bool Active { get; set; } = true;
}

/// <summary>Meta padrão de SLA por modalidade e tipo de demanda, versionada por data.</summary>
public class SlaTarget : BaseEntity
{
    public Modality Modality { get; set; }
    public DemandType DemandType { get; set; }
    public int Days { get; set; }
    public DateOnly ValidFrom { get; set; }
}

public class SystemParameter : BaseEntity
{
    public string Key { get; set; } = "";
    public string Value { get; set; } = "";
    public string? Description { get; set; }
}

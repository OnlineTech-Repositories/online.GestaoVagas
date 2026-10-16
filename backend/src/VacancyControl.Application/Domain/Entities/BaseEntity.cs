namespace VacancyControl.Application.Domain.Entities;

/// <summary>Campos comuns a todas as tabelas (seção 5). Datas de auditoria preenchidas pela camada de dados.</summary>
public abstract class BaseEntity
{
    public Guid Id { get; protected set; } = Guid.CreateVersion7();
    public DateTimeOffset CreatedAt { get; set; }
    public Guid? CreatedBy { get; set; }
    public DateTimeOffset? UpdatedAt { get; set; }
    public Guid? UpdatedBy { get; set; }
}

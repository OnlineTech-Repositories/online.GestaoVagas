using VacancyControl.Application.Common;

namespace VacancyControl.Application.Domain.Entities;

/// <summary>Dados do candidato informados pelo RH ao aprovar (ou corrigir) o candidato da posição.</summary>
public sealed record CandidateData(string? FullName, DateOnly? BirthDate, CandidateSex? Sex, string? Cpf);

/// <summary>
/// Candidato selecionado para a posição. Cada posição tem no máximo um candidato ativo; quem desiste (ou não
/// comparece à admissão) fica registrado com <see cref="WithdrawnAt"/>, formando o histórico de candidatos da posição.
/// Cadastro e alterações ficam em <see cref="BaseEntity"/> (quem e quando) e no log de auditoria (valores).
/// </summary>
public class Candidate : BaseEntity
{
    public const int FullNameMaxLength = 200;

    public Guid PositionId { get; internal set; }
    public Position? Position { get; internal set; }
    public string FullName { get; internal set; } = "";
    public DateOnly BirthDate { get; internal set; }
    public CandidateSex Sex { get; internal set; }
    /// <summary>CPF só com os 11 dígitos.</summary>
    public string Cpf { get; internal set; } = "";
    /// <summary>Data em que o candidato foi aprovado na posição.</summary>
    public DateOnly ApprovedAt { get; internal set; }
    public DateTimeOffset? WithdrawnAt { get; internal set; }
    public string? WithdrawalReason { get; internal set; }

    public bool IsActive => WithdrawnAt is null;

    internal Candidate() { }

    internal Candidate(Position position, DateOnly approvedAt, CandidateData data, DateOnly today)
    {
        PositionId = position.Id;
        Position = position;
        ApprovedAt = approvedAt;
        Apply(data, today);
    }

    /// <summary>Valida e grava os dados: nome, nascimento (não futuro), sexo e CPF com dígitos verificadores.</summary>
    internal void Apply(CandidateData data, DateOnly today)
    {
        var name = string.Join(' ', (data.FullName ?? "").Split(' ', StringSplitOptions.RemoveEmptyEntries));
        if (name.Length == 0) throw new BusinessRuleException("Informe o nome completo do candidato.", "fullName");
        if (name.Length > FullNameMaxLength)
            throw new BusinessRuleException($"O nome deve ter no máximo {FullNameMaxLength} caracteres.", "fullName");
        if (data.BirthDate is not { } birth) throw new BusinessRuleException("Informe a data de nascimento.", "birthDate");
        if (birth > today) throw new BusinessRuleException("A data de nascimento não pode ser uma data futura.", "birthDate");
        if (birth.Year < 1900) throw new BusinessRuleException("Informe uma data de nascimento válida.", "birthDate");
        if (data.Sex is not { } sex || !Enum.IsDefined(sex)) throw new BusinessRuleException("Selecione o sexo.", "sex");

        FullName = name;
        BirthDate = birth;
        Sex = sex;
        Cpf = Common.Cpf.Require(data.Cpf, "cpf");
    }

    internal void Withdraw(DateTimeOffset at, string reason)
    {
        WithdrawnAt = at;
        WithdrawalReason = reason;
    }
}

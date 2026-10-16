using VacancyControl.Application.Domain;

namespace VacancyControl.Application.Common;

public static class Cnpj
{
    /// <summary>Remove a máscara e retorna apenas os 14 dígitos.</summary>
    public static string Normalize(string? value) => new((value ?? "").Where(char.IsDigit).ToArray());

    public static bool IsValid(string? value)
    {
        var d = Normalize(value);
        if (d.Length != 14 || d.Distinct().Count() == 1) return false;

        static int CheckDigit(string digits, int[] weights)
        {
            var sum = digits.Select((c, i) => (c - '0') * weights[i]).Sum();
            var rest = sum % 11;
            return rest < 2 ? 0 : 11 - rest;
        }

        int[] w1 = [5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        int[] w2 = [6, 5, 4, 3, 2, 9, 8, 7, 6, 5, 4, 3, 2];
        var first = CheckDigit(d[..12], w1);
        var second = CheckDigit(d[..12] + first, w2);
        return d[12] - '0' == first && d[13] - '0' == second;
    }

    public static string Require(string? value, string? field = null)
    {
        if (!IsValid(value)) throw new BusinessRuleException("CNPJ inválido.", field);
        return Normalize(value);
    }
}

public static class Cpf
{
    /// <summary>Remove a máscara e retorna apenas os 11 dígitos.</summary>
    public static string Normalize(string? value) => new((value ?? "").Where(char.IsDigit).ToArray());

    public static bool IsValid(string? value)
    {
        var d = Normalize(value);
        if (d.Length != 11 || d.Distinct().Count() == 1) return false;

        static int CheckDigit(string digits)
        {
            var sum = digits.Select((c, i) => (c - '0') * (digits.Length + 1 - i)).Sum();
            var rest = sum % 11;
            return rest < 2 ? 0 : 11 - rest;
        }

        var first = CheckDigit(d[..9]);
        var second = CheckDigit(d[..9] + first);
        return d[9] - '0' == first && d[10] - '0' == second;
    }

    public static string Require(string? value, string? field = null)
    {
        if (string.IsNullOrWhiteSpace(value)) throw new BusinessRuleException("Informe o CPF.", field);
        if (!IsValid(value)) throw new BusinessRuleException("CPF inválido: confira os dígitos.", field);
        return Normalize(value);
    }

    public static string Format(string digits) =>
        digits.Length == 11 ? $"{digits[..3]}.{digits[3..6]}.{digits[6..9]}-{digits[9..]}" : digits;

    /// <summary>CPF mascarado para quem não vê os dados completos (LGPD): ***.456.789-**.</summary>
    public static string Mask(string? value)
    {
        var d = Normalize(value);
        return d.Length == 11 ? $"***.{d[3..6]}.{d[6..9]}-**" : "***";
    }
}

/// <summary>Validações de datas de marcos (RN-24 e bloqueio de datas futuras).</summary>
public static class DateGuard
{
    public static void NotFuture(DateOnly date, DateOnly today, string label, string? field = null)
    {
        if (date > today) throw new BusinessRuleException($"{label} não pode ser uma data futura.", field);
    }

    /// <summary>
    /// RN-24: com a carga inicial encerrada, data de marco anterior à data de registro exige justificativa.
    /// Retorna true quando a data é retroativa (para sinalizar a posição).
    /// </summary>
    public static bool CheckRetroactive(DateOnly date, DateOnly today, bool initialLoadOpen, string? justification, string label)
    {
        if (initialLoadOpen || date >= today) return false;
        if (string.IsNullOrWhiteSpace(justification))
            throw new BusinessRuleException($"{label} é anterior à data de hoje. Informe uma justificativa.", "justification");
        return true;
    }

    public static string? Clean(string? text) => string.IsNullOrWhiteSpace(text) ? null : text.Trim();

    public static string RequireText(string? text, string message, string? field = null) =>
        string.IsNullOrWhiteSpace(text) ? throw new BusinessRuleException(message, field) : text.Trim();
}

public static class Permissions
{
    public static void Require(ICurrentUser user, params string[] roles)
    {
        if (!user.IsInAnyRole(roles)) throw new ForbiddenException();
    }

    public static bool CanSeeDetailedValues(ICurrentUser user) => user.IsInAnyRole(Roles.SeeDetailedValues);
    public static bool CanSeeAggregatedValues(ICurrentUser user) => user.IsInAnyRole(Roles.SeeAggregatedValues);
}

/// <summary>
/// Quem executa o recrutamento de um pedido: o Gestor de RH (qualquer pedido) ou um Analista de RH responsável por ele.
/// </summary>
public static class RhAccess
{
    public static bool CanAct(ICurrentUser user, VacancyControl.Application.Domain.Entities.Order order) =>
        user.IsInRole(Roles.RhManager)
        || (user.IsInRole(Roles.Rh) && user.UserId is { } id && order.IsRhAnalyst(id));

    public static void Require(ICurrentUser user, VacancyControl.Application.Domain.Entities.Order order)
    {
        if (CanAct(user, order)) return;
        throw user.IsInRole(Roles.Rh)
            ? new ForbiddenException("Você não está entre os analistas de RH responsáveis por este pedido.")
            : new ForbiddenException();
    }
}

namespace VacancyControl.Application.Domain;

/// <summary>Perfis do sistema (seção 4 da SPEC). Um usuário pode ter vários.</summary>
public static class Roles
{
    public const string Commercial = "COMMERCIAL";
    public const string Nacc = "NACC";
    public const string Dp = "DP";
    /// <summary>Analista de RH (RH / R&amp;S): executa o recrutamento dos pedidos atribuídos a ele.</summary>
    public const string Rh = "RH";
    /// <summary>Gestor de RH: distribui os pedidos entre os analistas e também executa o recrutamento em qualquer pedido.</summary>
    public const string RhManager = "RH_MANAGER";
    public const string Manager = "MANAGER";
    public const string Controllership = "CONTROLLERSHIP";
    public const string Admin = "ADMIN";

    public static readonly IReadOnlyList<string> All =
        [Commercial, Nacc, Dp, Rh, RhManager, Manager, Controllership, Admin];

    /// <summary>Perfis que veem valores em R$ por contrato e por posição (seção 4.2, D2).</summary>
    public static readonly IReadOnlyList<string> SeeDetailedValues = [Commercial, Controllership, Admin];

    /// <summary>Perfis que veem R$ agregado no painel (seção 4.2, D2).</summary>
    public static readonly IReadOnlyList<string> SeeAggregatedValues = [Commercial, Controllership, Admin, Manager];
}

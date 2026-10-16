using VacancyControl.Application.Domain;

namespace VacancyControl.Tests;

/// <summary>Código interno do contrato: CT-AAAA-UNIDADE-SEQUENCIAL.</summary>
public class ContractCodeTests
{
    [Theory]
    [InlineData("LJ-001", "LJ-001")]
    [InlineData("Loja Moema", "LOJA-MOEMA")]
    [InlineData("Logística Exemplo Ltda (demo)", "LOGISTICA-EXEMPLO")]
    [InlineData("CENCOSUD", "CENCOSUD")]
    [InlineData("Supermercados São João do Rio Preto", "SUPERMERCADOS-SAO")]
    [InlineData("Abcdefghijklmnopqrstuvwxyz", "ABCDEFGHIJKLMNOPQRST")]
    [InlineData("  ###  ", "CLIENTE")]
    public void Segment_IsUppercaseAsciiUpTo20CharsCutBetweenWords(string source, string expected)
    {
        var segment = ContractCode.Segment(source);

        Assert.Equal(expected, segment);
        Assert.True(segment.Length <= ContractCode.SegmentMaxLength);
    }

    [Fact]
    public void Build_FollowsThePattern()
    {
        Assert.Equal("CT-2026-LOJA-MOEMA-0001", ContractCode.Build(2026, "LOJA-MOEMA", 1));
    }

    [Fact]
    public void NextSequence_CountsOnlyTheSameYearAndUnit()
    {
        var prefix = ContractCode.Prefix(2026, "LJ-001");
        string[] existing = ["CT-2026-LJ-001-0001", "CT-2026-LJ-001-0002", "CT-2026-LJ-002-0007", "CT-2025-LJ-001-0009"];

        Assert.Equal(3, ContractCode.NextSequence(prefix, existing));
        Assert.Equal(1, ContractCode.NextSequence(ContractCode.Prefix(2027, "LJ-001"), existing));
    }

    [Fact]
    public void NextSequence_DoesNotConfuseUnitsThatShareAPrefix()
    {
        // "LJ-001" não pode contar os contratos de "LJ-001-A".
        var prefix = ContractCode.Prefix(2026, "LJ-001");
        string[] existing = ["CT-2026-LJ-001-A-0004", "CT-2026-LJ-001-0001"];

        Assert.Equal(2, ContractCode.NextSequence(prefix, existing));
    }
}

using System.Globalization;
using System.Text;

namespace VacancyControl.Application.Domain;

/// <summary>
/// Código interno do contrato: CT-AAAA-UNIDADE-SEQUENCIAL (ex.: CT-2026-LJ-001-0001).
/// AAAA = ano do registro; UNIDADE = código da unidade contratante ou, sem unidade, o nome do cliente;
/// SEQUENCIAL = 4 dígitos por ano e unidade. Gerado uma vez e nunca alterado.
/// </summary>
public static class ContractCode
{
    public const int SegmentMaxLength = 20;

    /// <summary>Prefixo do código, até o hífen antes do sequencial.</summary>
    public static string Prefix(int year, string segment) => $"CT-{year}-{segment}-";

    public static string Build(int year, string segment, int sequence) =>
        $"{Prefix(year, segment)}{sequence.ToString("D4", CultureInfo.InvariantCulture)}";

    /// <summary>
    /// Trecho UNIDADE: maiúsculas, sem acentos, só letras e dígitos separados por hífen e até 20 caracteres,
    /// cortando entre palavras ("Logística Exemplo Ltda" → "LOGISTICA-EXEMPLO").
    /// </summary>
    public static string Segment(string text)
    {
        var plain = new StringBuilder();
        foreach (var c in text.Normalize(NormalizationForm.FormD))
        {
            if (CharUnicodeInfo.GetUnicodeCategory(c) == UnicodeCategory.NonSpacingMark) continue;
            plain.Append(char.IsAsciiLetterOrDigit(c) ? char.ToUpperInvariant(c) : ' ');
        }

        var words = plain.ToString().Split(' ', StringSplitOptions.RemoveEmptyEntries);
        if (words.Length == 0) return "CLIENTE";

        var segment = words[0].Length > SegmentMaxLength ? words[0][..SegmentMaxLength] : words[0];
        foreach (var word in words.Skip(1))
        {
            if (segment.Length + 1 + word.Length > SegmentMaxLength) break;
            segment += "-" + word;
        }
        return segment;
    }

    /// <summary>Próximo sequencial a partir dos códigos já existentes com o mesmo prefixo.</summary>
    public static int NextSequence(string prefix, IEnumerable<string> existingCodes) =>
        existingCodes
            .Where(c => c.StartsWith(prefix, StringComparison.Ordinal))
            .Select(c => int.TryParse(c[prefix.Length..], NumberStyles.None, CultureInfo.InvariantCulture, out var n) ? n : 0)
            .DefaultIfEmpty(0)
            .Max() + 1;
}

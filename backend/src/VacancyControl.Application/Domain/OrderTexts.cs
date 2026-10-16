namespace VacancyControl.Application.Domain;

public static class OrderTexts
{
    public const int JobDescriptionMaxLength = 4000;

    /// <summary>Texto livre do pedido: quebras de linha padronizadas e espaços das pontas removidos; vazio = nulo.</summary>
    public static string? CleanMultiline(string? text) =>
        string.IsNullOrWhiteSpace(text) ? null : text.Replace("\r\n", "\n").Replace('\r', '\n').Trim();
}

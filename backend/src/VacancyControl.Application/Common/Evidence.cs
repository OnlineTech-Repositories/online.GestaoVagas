namespace VacancyControl.Application.Common;

/// <summary>
/// Armazenamento do conteúdo das evidências. Hoje fica no banco (mesma transação da operação); a interface permite
/// trocar por SharePoint (D4) sem mexer nas regras.
/// </summary>
public interface IEvidenceStorage
{
    /// <summary>Guarda o conteúdo e devolve a chave para ler depois. Não salva: entra na transação da operação.</summary>
    string Add(byte[] content);
    Task<byte[]?> ReadAsync(string key, CancellationToken ct = default);
}

/// <summary>Arquivo enviado pelo usuário.</summary>
public sealed record EvidenceUpload(string FileName, string ContentType, byte[] Content);

/// <summary>Regras dos anexos de evidência: PDF, JPG ou PNG de até 10 MB, conferidos pelo conteúdo do arquivo.</summary>
public static class EvidenceFiles
{
    public const long MaxBytes = 10 * 1024 * 1024;
    public const int FileNameMaxLength = 255;

    /// <summary>Valida o arquivo e devolve o nome limpo e o tipo detectado pelo conteúdo (não pelo que o navegador informou).</summary>
    public static (string FileName, string ContentType) Validate(EvidenceUpload file)
    {
        if (file.Content.Length == 0) throw new BusinessRuleException("O arquivo de evidência está vazio.", "evidence");
        if (file.Content.Length > MaxBytes)
            throw new BusinessRuleException("A evidência deve ter no máximo 10 MB.", "evidence");
        var type = Detect(file.Content)
                   ?? throw new BusinessRuleException("Anexe um arquivo PDF, JPG ou PNG.", "evidence");

        var name = Path.GetFileName((file.FileName ?? "").Replace('\\', '/'));
        name = new string(name.Where(c => !char.IsControl(c)).ToArray()).Trim();
        if (name.Length == 0) name = "evidencia" + Extension(type);
        if (name.Length > FileNameMaxLength) name = name[^FileNameMaxLength..];
        return (name, type);
    }

    private static string? Detect(byte[] c)
    {
        if (c.Length >= 5 && c[0] == '%' && c[1] == 'P' && c[2] == 'D' && c[3] == 'F' && c[4] == '-') return "application/pdf";
        if (c.Length >= 3 && c[0] == 0xFF && c[1] == 0xD8 && c[2] == 0xFF) return "image/jpeg";
        if (c.Length >= 8 && c[0] == 0x89 && c[1] == 'P' && c[2] == 'N' && c[3] == 'G' && c[4] == 0x0D && c[5] == 0x0A
            && c[6] == 0x1A && c[7] == 0x0A) return "image/png";
        return null;
    }

    private static string Extension(string type) => type switch
    {
        "application/pdf" => ".pdf",
        "image/jpeg" => ".jpg",
        _ => ".png",
    };
}

namespace VacancyControl.Application.Domain.Entities;

/// <summary>
/// Evidência anexada a um marco da posição (por exemplo, o comparecimento no 1º dia). Aqui ficam só os metadados;
/// o conteúdo fica no armazenamento de evidências (<see cref="Common.IEvidenceStorage"/>), identificado por
/// <see cref="StorageKey"/>. Quem anexou e quando ficam em <see cref="BaseEntity"/>.
/// </summary>
public class PositionEvidence : BaseEntity
{
    public Guid PositionId { get; internal set; }
    public Position? Position { get; internal set; }
    public EvidenceKind Kind { get; internal set; }
    public string FileName { get; internal set; } = "";
    public string ContentType { get; internal set; } = "";
    public long SizeBytes { get; internal set; }
    public string StorageKey { get; internal set; } = "";

    internal PositionEvidence() { }

    internal PositionEvidence(Position position, EvidenceKind kind, string fileName, string contentType, long sizeBytes,
        string storageKey)
    {
        PositionId = position.Id;
        Position = position;
        Kind = kind;
        FileName = fileName;
        ContentType = contentType;
        SizeBytes = sizeBytes;
        StorageKey = storageKey;
    }
}

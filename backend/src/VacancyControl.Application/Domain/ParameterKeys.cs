namespace VacancyControl.Application.Domain;

/// <summary>Chaves de <see cref="Entities.SystemParameter"/> e seus valores padrão (seções 5.2 e 15).</summary>
public static class ParameterKeys
{
    public const string AtRiskDays = "AT_RISK_DAYS";
    public const string StaleDays = "STALE_DAYS";
    public const string EarlyReplacementWindowDays = "EARLY_REPLACEMENT_WINDOW_DAYS";
    public const string InitialLoadOpen = "INITIAL_LOAD_OPEN";
    public const string AllowLegacyTermination = "ALLOW_LEGACY_TERMINATION";
    public const string LossOnCancelAfterOpen = "LOSS_ON_CANCEL_AFTER_OPEN";
    public const string DailyDigestTime = "DAILY_DIGEST_TIME";
    public const string RequestEvidenceRequired = "REQUEST_EVIDENCE_REQUIRED";

    public static readonly IReadOnlyDictionary<string, (string Value, string Description)> Defaults =
        new Dictionary<string, (string, string)>
        {
            [AtRiskDays] = ("2", "Dias antes do prazo para a posição ficar Em risco"),
            [StaleDays] = ("3", "Dias sem atualização para gerar alerta"),
            [EarlyReplacementWindowDays] = ("30", "Janela (dias) da taxa de reposição precoce"),
            [InitialLoadOpen] = ("true", "Período de carga inicial aberto"),
            [AllowLegacyTermination] = ("true", "Permite desligamento avulso (sem posição de origem)"),
            [LossOnCancelAfterOpen] = ("true", "Conta perda até o cancelamento de posição já aberta"),
            [DailyDigestTime] = ("07:00", "Horário da rotina diária (HH:mm, America/Sao_Paulo)"),
            [RequestEvidenceRequired] = ("false", "Exige evidência da solicitação do cliente no pedido"),
        };
}

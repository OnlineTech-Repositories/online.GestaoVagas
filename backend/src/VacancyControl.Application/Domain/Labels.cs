namespace VacancyControl.Application.Domain;

/// <summary>Rótulos em pt-BR para mensagens e e-mails (glossário, seção 16).</summary>
public static class Labels
{
    public static string Of(PositionStatus s) => s switch
    {
        PositionStatus.AWAITING_CONFIRMATION => "Aguardando confirmação",
        PositionStatus.OPEN => "Aberta",
        PositionStatus.RECRUITING => "Em recrutamento",
        PositionStatus.CANDIDATE_APPROVED => "Candidato selecionado",
        PositionStatus.IN_ADMISSION => "Em admissão",
        PositionStatus.AWAITING_FIRST_DAY => "Aguardando 1º dia",
        PositionStatus.PAUSED => "Pausada",
        PositionStatus.FILLED => "Preenchida",
        PositionStatus.CLOSED_CLIENT_CANCELLED => "Encerrada: cliente cancelou",
        PositionStatus.CLOSED_CONTRACT_ENDED => "Encerrada: contrato encerrou",
        _ => s.ToString()
    };

    public static string Of(DemandType d) => d == DemandType.NEW ? "Vaga nova" : "Reposição";

    public static string Of(OrderApprovalStatus s) => s switch
    {
        OrderApprovalStatus.AWAITING_CLIENT_APPROVAL => "Aguardando aprovação do cliente",
        OrderApprovalStatus.APPROVED => "Aprovado",
        OrderApprovalStatus.NOT_APPROVED => "Não aprovado",
        _ => s.ToString()
    };

    public static string Of(CandidateSex s) => s switch
    {
        CandidateSex.FEMALE => "Feminino",
        CandidateSex.MALE => "Masculino",
        CandidateSex.NOT_INFORMED => "Não informado",
        _ => s.ToString()
    };

    public static string Of(Modality m) => m switch
    {
        Modality.RS => "R&S",
        Modality.MOT => "MOT",
        Modality.MOE => "MOE",
        Modality.FAC => "Facilities",
        _ => m.ToString()
    };
}

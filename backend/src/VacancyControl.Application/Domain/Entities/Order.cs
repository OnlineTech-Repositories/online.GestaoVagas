using VacancyControl.Application.Common;

namespace VacancyControl.Application.Domain.Entities;

/// <summary>Pedido: solicitação do cliente de um cargo em determinada quantidade.</summary>
public class Order : BaseEntity
{
    /// <summary>Número sequencial exibido ao usuário (gerado pelo banco).</summary>
    public long Number { get; internal set; }
    public Guid ContractId { get; set; }
    public Contract? Contract { get; set; }
    public Modality Modality { get; set; }
    public Guid JobRoleId { get; set; }
    public JobRole? JobRole { get; set; }
    public int Quantity { get; set; }
    public Guid WorkLocationId { get; set; }
    public WorkLocation? WorkLocation { get; set; }
    public DateOnly ClientRequestDate { get; set; }
    public DateOnly DesiredStartDate { get; set; }
    public TermType TermType { get; set; }
    public DateOnly? TermEndDate { get; set; }
    public int? TermDurationDays { get; set; }
    public string? Notes { get; set; }
    /// <summary>Descrição da vaga: atividades, responsabilidades, requisitos e qualificações (texto livre, com parágrafos).</summary>
    public string? JobDescription { get; set; }
    /// <summary>Criado por desligamento avulso (D1).</summary>
    public bool IsLegacy { get; set; }
    /// <summary>
    /// Data de registro do pedido. Padrão: hoje. Pode ser retroativa durante a carga inicial
    /// ou, depois dela, com justificativa (RN-24).
    /// </summary>
    public DateOnly RegisteredAt { get; set; }
    public List<Position> Positions { get; set; } = [];
    /// <summary>Analistas de RH responsáveis (ativos e removidos, para o histórico).</summary>
    public List<OrderRhAnalyst> RhAnalysts { get; set; } = [];

    public IEnumerable<OrderRhAnalyst> ActiveRhAnalysts => RhAnalysts.Where(a => a.IsActive).OrderBy(a => a.UserName);

    public bool IsRhAnalyst(Guid userId) => RhAnalysts.Any(a => a.IsActive && a.UserId == userId);

    /// <summary>"Aguardando atribuição do RH": pedido em andamento, com posição aberta e sem analista responsável.</summary>
    public bool AwaitingRhAssignment =>
        ApprovalStatus != OrderApprovalStatus.NOT_APPROVED && Positions.Any(p => p.IsOpen) && !RhAnalysts.Any(a => a.IsActive);

    public OrderApprovalStatus ApprovalStatus { get; set; } = OrderApprovalStatus.AWAITING_CLIENT_APPROVAL;
    /// <summary>Data em que o cliente aprovou (ou recusou) formalmente o pedido.</summary>
    public DateOnly? ClientDecisionDate { get; set; }
    /// <summary>Quando e por quem a decisão foi registrada no sistema.</summary>
    public DateTimeOffset? ApprovalRecordedAt { get; set; }
    public Guid? ApprovalRecordedBy { get; set; }
    public string? NotApprovedReason { get; set; }

    public bool IsApproved => ApprovalStatus == OrderApprovalStatus.APPROVED;

    /// <summary>
    /// Publicação no JobConvo, registrada uma vez pelo RH para o pedido inteiro. Nulo = ainda não informada;
    /// false = recrutamento sem publicação (com justificativa).
    /// </summary>
    public bool? JobconvoPublished { get; set; }
    public string? JobconvoCode { get; set; }
    public DateOnly? JobconvoPublishedAt { get; set; }
    /// <summary>Justificativa / observações da publicação (ou o motivo de não publicar).</summary>
    public string? JobconvoNotes { get; set; }
    public DateTimeOffset? JobconvoRecordedAt { get; set; }
    public Guid? JobconvoRecordedBy { get; set; }

    /// <summary>Com a publicação informada, as posições abertas do pedido ficam "Em recrutamento" (RN-06).</summary>
    public bool HasJobconvoRecord => JobconvoPublished is not null;

    public OrderStatus Status => ComputeStatus(Positions);

    /// <summary>Uma posição por vaga: o ciclo atual de cada uma (reposições substituem o ciclo anterior).</summary>
    public IEnumerable<Position> CurrentPositions => Positions.Where(p => p.IsCurrentCycle);

    /// <summary>
    /// Aprovação formal do cliente. As vagas novas ainda sem abertura passam a abrir nesta data (início do SLA);
    /// quem chama grava a meta de SLA de cada uma (<see cref="Position.OpenOnApproval"/>).
    /// </summary>
    public IReadOnlyList<Position> Approve(DateOnly decisionDate, Guid? recordedBy, DateTimeOffset recordedAt)
    {
        EnsureAwaitingApproval();
        if (decisionDate < ClientRequestDate)
            throw new BusinessRuleException("A aprovação não pode ser anterior à solicitação do cliente.", "date");
        ApprovalStatus = OrderApprovalStatus.APPROVED;
        ClientDecisionDate = decisionDate;
        ApprovalRecordedAt = recordedAt;
        ApprovalRecordedBy = recordedBy;
        return Positions.Where(p => p.DemandType == DemandType.NEW && p.OpenedAt is null && p.IsOpen).ToList();
    }

    /// <summary>O cliente não aprovou: todas as posições abertas são encerradas como "cliente cancelou", sem perda.</summary>
    public void Reject(DateOnly decisionDate, string reason, Guid? recordedBy, DateTimeOffset recordedAt)
    {
        EnsureAwaitingApproval();
        var text = string.IsNullOrWhiteSpace(reason)
            ? throw new BusinessRuleException("Informe o motivo da não aprovação.", "reason")
            : reason.Trim();
        if (decisionDate < ClientRequestDate)
            throw new BusinessRuleException("A decisão não pode ser anterior à solicitação do cliente.", "date");
        ApprovalStatus = OrderApprovalStatus.NOT_APPROVED;
        ClientDecisionDate = decisionDate;
        ApprovalRecordedAt = recordedAt;
        ApprovalRecordedBy = recordedBy;
        NotApprovedReason = text;
        foreach (var position in Positions.Where(p => p.IsOpen))
            position.Cancel(decisionDate < position.ActivePause?.StartDate ? position.ActivePause.StartDate : decisionDate,
                $"Cliente não aprovou o pedido: {text}");
    }

    /// <summary>
    /// RN-06 no pedido: registra (ou atualiza) a publicação no JobConvo. Publicado exige código e data; não publicado
    /// exige justificativa. As posições abertas do pedido passam a "Em recrutamento"; as que entrarem depois herdam.
    /// Retorna as posições que mudaram de etapa.
    /// </summary>
    public IReadOnlyList<Position> RecordJobconvo(bool published, string? code, DateOnly? publishedAt, string? notes,
        Guid? recordedBy, DateTimeOffset recordedAt)
    {
        if (ApprovalStatus == OrderApprovalStatus.NOT_APPROVED)
            throw new BusinessRuleException("O cliente não aprovou este pedido: não há recrutamento a registrar.");
        var cleanNotes = string.IsNullOrWhiteSpace(notes) ? null : notes.Trim();
        if (published)
        {
            if (string.IsNullOrWhiteSpace(code))
                throw new BusinessRuleException("Informe o código da vaga no JobConvo.", "code");
            if (publishedAt is not { } date)
                throw new BusinessRuleException("Informe a data da publicação.", "publishedAt");
            if (date < ClientRequestDate)
                throw new BusinessRuleException("A publicação não pode ser anterior à solicitação do cliente.", "publishedAt");
            JobconvoCode = code.Trim();
            JobconvoPublishedAt = date;
        }
        else
        {
            if (cleanNotes is null)
                throw new BusinessRuleException("Informe a justificativa de não publicar a vaga no JobConvo.", "justification");
            JobconvoCode = null;
            JobconvoPublishedAt = null;
        }
        JobconvoPublished = published;
        JobconvoNotes = cleanNotes;
        JobconvoRecordedAt = recordedAt;
        JobconvoRecordedBy = recordedBy;
        return Positions.Where(p => p.StartRecruitingFromOrder()).ToList();
    }

    /// <summary>
    /// Define os analistas de RH responsáveis (inclui, substitui ou remove). Quem sai é removido logicamente, mantendo o
    /// histórico. Retorna quem entrou e quem saiu, para os avisos.
    /// </summary>
    public (IReadOnlyList<OrderRhAnalyst> Added, IReadOnlyList<OrderRhAnalyst> Removed) SetRhAnalysts(
        IReadOnlyCollection<(Guid Id, string Name)> analysts, Guid? changedBy, DateTimeOffset changedAt)
    {
        if (ApprovalStatus == OrderApprovalStatus.NOT_APPROVED)
            throw new BusinessRuleException("O cliente não aprovou este pedido: não há atendimento a distribuir.");
        var wanted = analysts.DistinctBy(a => a.Id).ToList();

        var removed = RhAnalysts.Where(a => a.IsActive && wanted.All(w => w.Id != a.UserId)).ToList();
        foreach (var a in removed)
        {
            a.RemovedAt = changedAt;
            a.RemovedBy = changedBy;
        }

        var added = wanted.Where(w => !IsRhAnalyst(w.Id))
            .Select(w => new OrderRhAnalyst(this, w.Id, w.Name, changedBy, changedAt))
            .ToList();
        RhAnalysts.AddRange(added);
        return (added, removed);
    }

    private void EnsureAwaitingApproval()
    {
        if (ApprovalStatus != OrderApprovalStatus.AWAITING_CLIENT_APPROVAL)
            throw new BusinessRuleException($"O pedido já está \"{Labels.Of(ApprovalStatus)}\".");
    }

    /// <summary>Status do pedido pelo ciclo atual de cada vaga (um colaborador desligado não conta como vaga preenchida).</summary>
    public static OrderStatus ComputeStatus(IReadOnlyCollection<Position> positions)
    {
        var current = positions.Where(p => p.IsCurrentCycle).ToList();
        if (current.Count == 0 || current.Any(p => p.IsOpen)) return OrderStatus.IN_PROGRESS;
        return current.Any(p => p.Status == PositionStatus.FILLED) ? OrderStatus.FULFILLED : OrderStatus.CANCELLED;
    }
}

/// <summary>Validações de vigência compartilhadas entre pedido e posição (RN-03).</summary>
public static class TermRules
{
    public static void Validate(TermType type, DateOnly? endDate, int? durationDays, DateOnly desiredStartDate)
    {
        switch (type)
        {
            case TermType.FIXED_END when endDate is null:
                throw new BusinessRuleException("Informe a data fim da vigência.", "termEndDate");
            case TermType.FIXED_END when endDate < desiredStartDate:
                throw new BusinessRuleException("A data fim da vigência deve ser igual ou posterior à data de início desejada.", "termEndDate");
            case TermType.PRESERVED_DURATION when durationDays is null or < 1:
                throw new BusinessRuleException("Informe a duração da vigência em dias (mínimo 1).", "termDurationDays");
        }
    }

    /// <summary>Mantém apenas os campos pertinentes ao tipo de vigência.</summary>
    public static (DateOnly? EndDate, int? DurationDays) Normalize(TermType type, DateOnly? endDate, int? durationDays) =>
        type switch
        {
            TermType.FIXED_END => (endDate, null),
            TermType.PRESERVED_DURATION => (null, durationDays),
            _ => (null, null)
        };
}

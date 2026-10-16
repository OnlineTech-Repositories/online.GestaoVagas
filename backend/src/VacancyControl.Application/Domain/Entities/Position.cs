using VacancyControl.Application.Common;

namespace VacancyControl.Application.Domain.Entities;

/// <summary>
/// Posição: cada vaga individual do pedido e unidade de controle do sistema.
/// As transições da máquina de estados (seção 6) ficam concentradas aqui; permissões e
/// persistência ficam nos serviços.
/// </summary>
public class Position : BaseEntity
{
    public Guid OrderId { get; internal set; }
    public Order? Order { get; internal set; }
    /// <summary>Número interno do registro dentro do pedido (único; reposições recebem o próximo).</summary>
    public int Sequence { get; internal set; }
    /// <summary>
    /// Número da vaga no pedido (1..N), exibido ao usuário. A reposição herda o número da vaga de origem: cada
    /// reposição é um novo ciclo de atendimento da mesma vaga.
    /// </summary>
    public int SlotNumber { get; internal set; }
    /// <summary>Ciclo de atendimento da vaga: 1 = vaga nova; 2 em diante = reposições.</summary>
    public int Cycle { get; internal set; } = 1;
    public DemandType DemandType { get; internal set; }
    public Guid? OriginPositionId { get; internal set; }
    public Position? OriginPosition { get; internal set; }
    /// <summary>Desligamento que originou esta reposição.</summary>
    public Guid? TerminationId { get; internal set; }
    public Termination? Termination { get; internal set; }
    /// <summary>Desligamento do colaborador que ocupava esta posição (quando ela é origem de reposição).</summary>
    public Termination? ExitTermination { get; internal set; }

    public PositionStatus Status { get; internal set; }
    public PositionStatus? PreviousStatus { get; internal set; }

    /// <summary>
    /// Início da janela descoberta de vagas novas. Igual à data desejada do pedido, exceto para
    /// posições acrescentadas depois (RN-05), que têm a própria data.
    /// </summary>
    public DateOnly DesiredStartDate { get; internal set; }
    public DateOnly? OpenedAt { get; internal set; }
    public DateOnly? CandidateApprovedAt { get; internal set; }
    public DateOnly? AdmissionAt { get; internal set; }
    /// <summary>Matrícula informada pelo RH na admissão (opcional); preenche a confirmação do 1º dia.</summary>
    public string? AdmissionRegistration { get; internal set; }
    public DateOnly? FirstDayAt { get; internal set; }
    public string? EmployeeName { get; internal set; }
    public string? EmployeeRegistration { get; internal set; }
    /// <summary>Confirmação do 1º dia pelo NACC: justificativa, quem confirmou e quando.</summary>
    public string? FirstDayJustification { get; internal set; }
    public DateTimeOffset? FirstDayConfirmedAt { get; internal set; }
    public Guid? FirstDayConfirmedBy { get; internal set; }
    public DateOnly? ClosedAt { get; internal set; }
    public string? CancellationReason { get; internal set; }

    public TermType TermType { get; internal set; }
    public DateOnly? TermEndDate { get; internal set; }
    public int? TermDurationDays { get; internal set; }
    public string? TermAdjustJustification { get; internal set; }

    /// <summary>Versão do valor por cargo vigente na abertura (snapshot).</summary>
    public Guid? RateId { get; internal set; }
    public ContractRate? Rate { get; internal set; }
    /// <summary>Meta de SLA gravada na abertura (snapshot, RN-19).</summary>
    public int? SlaTargetDays { get; internal set; }
    public SlaTargetSource SlaTargetSource { get; internal set; } = SlaTargetSource.NONE;
    public bool HasRetroactiveDates { get; internal set; }

    public List<Pause> Pauses { get; internal set; } = [];
    /// <summary>Candidatos selecionados (o ativo e os que desistiram ou não compareceram).</summary>
    public List<Candidate> Candidates { get; internal set; } = [];
    public List<PositionEvidence> Evidences { get; internal set; } = [];

    public Candidate? ActiveCandidate => Candidates.FirstOrDefault(c => c.IsActive);

    internal Position() { }

    public bool IsClosed => Status is PositionStatus.CLOSED_CLIENT_CANCELLED or PositionStatus.CLOSED_CONTRACT_ENDED;

    /// <summary>"Estado aberto" = qualquer status exceto FILLED e CLOSED_*.</summary>
    public bool IsOpen => Status != PositionStatus.FILLED && !IsClosed;

    public Pause? ActivePause => Pauses.FirstOrDefault(p => p.IsActive);

    /// <summary>Ciclo atual da vaga: ainda não teve o ocupante desligado (o desligamento abre o próximo ciclo).</summary>
    public bool IsCurrentCycle => ExitTermination is null;

    /// <summary>Reposição que o cliente decidiu não repor: a vaga termina aqui.</summary>
    public bool NotReplaced => DemandType == DemandType.REPLACEMENT && Termination?.ClientDecision == ClientDecision.NOT_REPLACE;

    /// <summary>Status efetivo da etapa, ignorando a pausa (para saber o responsável pela próxima ação).</summary>
    public PositionStatus StageStatus => Status == PositionStatus.PAUSED && PreviousStatus is { } prev ? prev : Status;

    // ---------------------------------------------------------------- criação

    /// <summary>RN-02: cada posição de um pedido nasce NEW / OPEN, com snapshots de valor e meta.</summary>
    /// <summary>
    /// <paramref name="openedAt"/> nulo = pedido aguardando a aprovação do cliente: a posição abre (e o SLA começa)
    /// na aprovação.
    /// </summary>
    public static Position CreateNew(Order order, int sequence, DateOnly desiredStartDate, DateOnly? openedAt,
        ContractRate? rate, int? slaTargetDays, SlaTargetSource slaSource, int? slotNumber = null)
    {
        return new Position
        {
            OrderId = order.Id,
            Order = order,
            Sequence = sequence,
            SlotNumber = slotNumber ?? sequence,
            Cycle = 1,
            DemandType = DemandType.NEW,
            // Pedido com a publicação no JobConvo já informada: a posição acrescentada herda e nasce em recrutamento.
            Status = order.HasJobconvoRecord ? PositionStatus.RECRUITING : PositionStatus.OPEN,
            DesiredStartDate = desiredStartDate,
            OpenedAt = openedAt,
            TermType = order.TermType,
            TermEndDate = order.TermEndDate,
            TermDurationDays = order.TermDurationDays,
            RateId = rate?.Id,
            Rate = rate,
            SlaTargetDays = slaTargetDays,
            SlaTargetSource = slaSource,
        };
    }

    /// <summary>D1: posição de origem já preenchida, criada pelo desligamento avulso.</summary>
    public static Position CreateLegacyFilled(Order order, DateOnly? firstDayAt, string employeeName,
        string employeeRegistration, ContractRate? rate)
    {
        RequireEmployee(employeeName, employeeRegistration);
        return new Position
        {
            OrderId = order.Id,
            Order = order,
            Sequence = 1,
            SlotNumber = 1,
            Cycle = 1,
            DemandType = DemandType.NEW,
            Status = PositionStatus.FILLED,
            DesiredStartDate = order.DesiredStartDate,
            OpenedAt = firstDayAt,
            FirstDayAt = firstDayAt,
            EmployeeName = employeeName.Trim(),
            EmployeeRegistration = employeeRegistration.Trim(),
            TermType = order.TermType,
            TermEndDate = order.TermEndDate,
            TermDurationDays = order.TermDurationDays,
            RateId = rate?.Id,
            Rate = rate,
        };
    }

    /// <summary>RN-14: reposição no mesmo pedido, aguardando o cliente, herdando vigência e valor da origem.</summary>
    public static Position CreateReplacement(Position origin, Termination termination, int sequence)
    {
        var replacement = new Position
        {
            OrderId = origin.OrderId,
            Order = origin.Order,
            Sequence = sequence,
            SlotNumber = origin.SlotNumber,
            Cycle = origin.Cycle + 1,
            DemandType = DemandType.REPLACEMENT,
            OriginPositionId = origin.Id,
            OriginPosition = origin,
            TerminationId = termination.Id,
            Termination = termination,
            Status = PositionStatus.AWAITING_CONFIRMATION,
            DesiredStartDate = termination.LastWorkedDay.AddDays(1),
            TermType = origin.TermType,
            TermEndDate = origin.TermEndDate,
            TermDurationDays = origin.TermDurationDays,
            RateId = origin.RateId,
            Rate = origin.Rate,
        };
        termination.ReplacementPosition = replacement;
        return replacement;
    }

    // ---------------------------------------------------------------- transições

    /// <summary>Decisão REPLACE: abre a reposição na data da decisão.</summary>
    public void ConfirmReplacement(DateOnly decisionAt, int? slaTargetDays, SlaTargetSource slaSource)
    {
        EnsureStatus(PositionStatus.AWAITING_CONFIRMATION);
        var termination = RequireTermination();
        termination.ClientDecision = ClientDecision.REPLACE;
        termination.ClientDecisionAt = decisionAt;
        OpenedAt = decisionAt;
        SlaTargetDays = slaTargetDays;
        SlaTargetSource = slaSource;
        Status = PositionStatus.OPEN;
        StartRecruitingFromOrder(); // a reposição herda a publicação do pedido
    }

    /// <summary>Decisão NOT_REPLACE: encerra sem perda (RN-15).</summary>
    public void DeclineReplacement(DateOnly decisionAt)
    {
        EnsureStatus(PositionStatus.AWAITING_CONFIRMATION);
        var termination = RequireTermination();
        termination.ClientDecision = ClientDecision.NOT_REPLACE;
        termination.ClientDecisionAt = decisionAt;
        ClosedAt = decisionAt;
        Status = PositionStatus.CLOSED_CLIENT_CANCELLED;
    }

    /// <summary>
    /// RN-06: a posição entra em recrutamento quando o pedido tem a publicação no JobConvo informada
    /// (<see cref="Entities.Order.RecordJobconvo"/>). Pausada na etapa "Aberta", volta da pausa já em recrutamento.
    /// Retorna true quando a etapa mudou.
    /// </summary>
    internal bool StartRecruitingFromOrder()
    {
        if (Order is not { HasJobconvoRecord: true }) return false;
        if (Status == PositionStatus.OPEN)
        {
            Status = PositionStatus.RECRUITING;
            return true;
        }
        if (Status == PositionStatus.PAUSED && PreviousStatus == PositionStatus.OPEN)
        {
            PreviousStatus = PositionStatus.RECRUITING;
            return true;
        }
        return false;
    }

    /// <summary>Aprovação do cliente: a vaga nova abre na data da aprovação e grava a meta de SLA (RN-19).</summary>
    internal void OpenOnApproval(DateOnly openedAt, int? slaTargetDays, SlaTargetSource slaSource)
    {
        if (DemandType != DemandType.NEW || OpenedAt is not null) return;
        OpenedAt = openedAt;
        SlaTargetDays = slaTargetDays;
        SlaTargetSource = slaSource;
    }

    /// <summary>Aprova o candidato e registra os dados dele, individualizados por posição.</summary>
    public Candidate ApproveCandidate(DateOnly approvedAt, CandidateData data, DateOnly today)
    {
        EnsureStatus(PositionStatus.RECRUITING);
        EnsureOrderApproved();
        var candidate = new Candidate(this, approvedAt, data, today);
        Candidates.Add(candidate);
        CandidateApprovedAt = approvedAt;
        Status = PositionStatus.CANDIDATE_APPROVED;
        return candidate;
    }

    /// <summary>Anexa a evidência de um marco (os metadados; o conteúdo já está no armazenamento de evidências).</summary>
    public PositionEvidence AttachEvidence(EvidenceKind kind, string fileName, string contentType, long sizeBytes, string storageKey)
    {
        var evidence = new PositionEvidence(this, kind, fileName, contentType, sizeBytes, storageKey);
        Evidences.Add(evidence);
        return evidence;
    }

    /// <summary>Corrige os dados do candidato selecionado (os valores anteriores ficam no histórico).</summary>
    /// <summary>
    /// Corrige os dados do candidato. Posição aprovada antes do cadastro de candidatos (em "Candidato selecionado",
    /// "Em admissão" ou "Aguardando 1º dia", sem candidato): registra o candidato com a data de aprovação já gravada.
    /// </summary>
    public Candidate CorrectCandidate(CandidateData data, DateOnly today)
    {
        if (ActiveCandidate is { } candidate)
        {
            candidate.Apply(data, today);
            return candidate;
        }
        if (!CanRegisterMissingCandidate)
            throw new BusinessRuleException("A posição não tem candidato selecionado.");
        var created = new Candidate(this, CandidateApprovedAt ?? today, data, today);
        Candidates.Add(created);
        return created;
    }

    /// <summary>Candidato selecionado (ou em admissão) sem candidato cadastrado: dados anteriores à regra do candidato.</summary>
    public bool CanRegisterMissingCandidate =>
        ActiveCandidate is null
        && StageStatus is PositionStatus.CANDIDATE_APPROVED or PositionStatus.IN_ADMISSION or PositionStatus.AWAITING_FIRST_DAY;

    /// <summary>Admissão registrada, com ou sem matrícula, e o 1º dia ainda não confirmado.</summary>
    public bool IsAdmitted => Status is PositionStatus.IN_ADMISSION or PositionStatus.AWAITING_FIRST_DAY;

    /// <summary>
    /// Informa ou corrige a matrícula da admissão, antes da confirmação do 1º dia. Com a matrícula, a admissão está
    /// concluída: a posição passa a "Aguardando 1º dia". Retorna true quando a admissão acabou de ser concluída.
    /// </summary>
    public bool SetAdmissionRegistration(string? registration)
    {
        if (!IsAdmitted)
            throw new BusinessRuleException(
                $"Ação não permitida: a posição está \"{Labels.Of(Status)}\". A matrícula é informada só antes da confirmação do 1º dia.");
        var clean = string.IsNullOrWhiteSpace(registration)
            ? throw new BusinessRuleException("Informe a matrícula.", "registration")
            : registration.Trim();
        if (clean.Length > 50) throw new BusinessRuleException("A matrícula deve ter no máximo 50 caracteres.", "registration");
        var completed = Status == PositionStatus.IN_ADMISSION;
        AdmissionRegistration = clean;
        Status = PositionStatus.AWAITING_FIRST_DAY;
        return completed;
    }

    public void RegisterAdmission(DateOnly admissionAt, string? registration = null)
    {
        EnsureStatus(PositionStatus.CANDIDATE_APPROVED);
        EnsureOrderApproved();
        var cleanRegistration = string.IsNullOrWhiteSpace(registration) ? null : registration.Trim();
        if (cleanRegistration is { Length: > 50 })
            throw new BusinessRuleException("A matrícula deve ter no máximo 50 caracteres.", "registration");
        AdmissionAt = admissionAt;
        AdmissionRegistration = cleanRegistration;
        // Com a matrícula, a admissão já está concluída e só falta a confirmação do 1º dia.
        Status = cleanRegistration is null ? PositionStatus.IN_ADMISSION : PositionStatus.AWAITING_FIRST_DAY;
    }

    /// <summary>
    /// RN-07/RN-08: 1º dia efetivo (≥ abertura). Nome e matrícula não são digitados aqui: vêm do candidato selecionado e
    /// da admissão, e ficam preservados. Faltando algum, a correção é feita na origem antes da confirmação.
    /// </summary>
    public void ConfirmFirstDay(DateOnly firstDayAt, string? justification, Guid? confirmedBy, DateTimeOffset confirmedAt)
    {
        if (Status == PositionStatus.IN_ADMISSION)
            throw new BusinessRuleException(
                "A matrícula não foi informada na admissão: o RH do pedido ou o DP deve informá-la antes da confirmação.",
                "employeeRegistration");
        EnsureStatus(PositionStatus.AWAITING_FIRST_DAY);
        EnsureOrderApproved();
        var candidate = ActiveCandidate ?? throw new BusinessRuleException(
            "A posição não tem candidato cadastrado: o RH do pedido deve registrar os dados do candidato antes da confirmação.",
            "employeeName");
        var registration = AdmissionRegistration ?? throw new BusinessRuleException(
            "A matrícula não foi informada na admissão: o RH do pedido ou o DP deve informá-la antes da confirmação.",
            "employeeRegistration");
        if (string.IsNullOrWhiteSpace(justification))
            throw new BusinessRuleException("Informe a justificativa da confirmação do 1º dia.", "justification");
        if (OpenedAt is { } opened && firstDayAt < opened)
            throw new BusinessRuleException("O 1º dia efetivo não pode ser anterior à data de abertura da posição.", "date");
        FirstDayAt = firstDayAt;
        FirstDayJustification = justification.Trim();
        FirstDayConfirmedAt = confirmedAt;
        FirstDayConfirmedBy = confirmedBy;
        EmployeeName = candidate.FullName;
        EmployeeRegistration = registration;
        Status = PositionStatus.FILLED;
    }

    /// <summary>Candidato desistiu: volta a recrutamento (valor anterior fica no AuditLog).</summary>
    public void CandidateWithdrew(DateTimeOffset at)
    {
        EnsureStatus(PositionStatus.CANDIDATE_APPROVED);
        ActiveCandidate?.Withdraw(at, "Candidato desistiu");
        CandidateApprovedAt = null;
        Status = PositionStatus.RECRUITING;
    }

    /// <summary>Admitido não compareceu: volta a recrutamento (valor anterior fica no AuditLog).</summary>
    public void AdmissionNoShow(DateTimeOffset at)
    {
        if (!IsAdmitted) EnsureStatus(PositionStatus.IN_ADMISSION);
        ActiveCandidate?.Withdraw(at, "Admitido não compareceu");
        AdmissionAt = null;
        AdmissionRegistration = null;
        Status = PositionStatus.RECRUITING;
    }

    /// <summary>RN-17: no máximo uma pausa ativa e sem sobreposição.</summary>
    public Pause StartPause(Guid reasonId, DateOnly startDate)
    {
        if (!IsOpen || Status == PositionStatus.PAUSED)
            throw new BusinessRuleException($"Não é possível pausar uma posição com status \"{Labels.Of(Status)}\".");
        if (ActivePause is not null)
            throw new BusinessRuleException("A posição já possui uma pausa ativa.");
        if (Pauses.Any(p => p.EndDate > startDate))
            throw new BusinessRuleException("A pausa não pode se sobrepor a outra pausa da posição.", "date");

        var pause = new Pause(Id, reasonId, startDate);
        Pauses.Add(pause);
        PreviousStatus = Status;
        Status = PositionStatus.PAUSED;
        return pause;
    }

    public Pause EndPause(DateOnly endDate)
    {
        EnsureStatus(PositionStatus.PAUSED);
        var pause = ActivePause ?? throw new BusinessRuleException("A posição não possui pausa ativa.");
        if (endDate < pause.StartDate)
            throw new BusinessRuleException("A data de fim da pausa deve ser igual ou posterior à data de início.", "date");
        pause.EndDate = endDate;
        Status = PreviousStatus ?? PositionStatus.OPEN;
        PreviousStatus = null;
        return pause;
    }

    /// <summary>Cancelamento pelo cliente (RN-10). Uma pausa ativa é encerrada na mesma data.</summary>
    public void Cancel(DateOnly closedAt, string reason)
    {
        EnsureOpen();
        if (string.IsNullOrWhiteSpace(reason))
            throw new BusinessRuleException("Informe o motivo do cancelamento.", "reason");
        if (ActivePause is { } pause && closedAt < pause.StartDate)
            throw new BusinessRuleException("A data de cancelamento não pode ser anterior ao início da pausa ativa.", "date");
        Close(PositionStatus.CLOSED_CLIENT_CANCELLED, closedAt);
        CancellationReason = reason.Trim();
    }

    /// <summary>
    /// Job diário: FIXED_END e hoje &gt; data fim → CLOSED_CONTRACT_ENDED com closed_at = data fim + 1.
    /// Retorna false quando a posição não se enquadra.
    /// </summary>
    public bool CloseByContractEnd(DateOnly today)
    {
        if (!IsOpen || TermType != TermType.FIXED_END || TermEndDate is not { } end || today <= end)
            return false;
        Close(PositionStatus.CLOSED_CONTRACT_ENDED, end.AddDays(1));
        return true;
    }

    /// <summary>RN-23: ajuste de vigência até FILLED, com justificativa.</summary>
    public void AdjustTerm(TermType type, DateOnly? endDate, int? durationDays, string justification)
    {
        EnsureOpen();
        if (string.IsNullOrWhiteSpace(justification))
            throw new BusinessRuleException("Informe a justificativa do ajuste de vigência.", "justification");
        TermRules.Validate(type, endDate, durationDays, DesiredStartDate);
        (TermEndDate, TermDurationDays) = TermRules.Normalize(type, endDate, durationDays);
        TermType = type;
        TermAdjustJustification = justification.Trim();
    }

    internal void MarkRetroactive() => HasRetroactiveDates = true;

    // ---------------------------------------------------------------- auxiliares

    private void Close(PositionStatus status, DateOnly closedAt)
    {
        if (ActivePause is { } pause)
            pause.EndDate = closedAt < pause.StartDate ? pause.StartDate : closedAt;
        ClosedAt = closedAt;
        Status = status;
        PreviousStatus = null;
    }

    /// <summary>Antes da aprovação do cliente o RH só prepara o recrutamento (até "Em recrutamento").</summary>
    private void EnsureOrderApproved()
    {
        if (Order is { IsApproved: false })
            throw new BusinessRuleException(
                "O pedido ainda aguarda a aprovação do cliente: até lá, a posição pode avançar só até \"Em recrutamento\".");
    }

    internal void EnsureOpen()
    {
        if (!IsOpen)
            throw new BusinessRuleException($"Ação não permitida: a posição está \"{Labels.Of(Status)}\".");
    }

    private void EnsureStatus(PositionStatus expected)
    {
        if (Status != expected)
            throw new BusinessRuleException(
                $"Ação não permitida: a posição está \"{Labels.Of(Status)}\" e precisa estar \"{Labels.Of(expected)}\".");
    }

    private Termination RequireTermination() =>
        Termination ?? throw new InvalidOperationException("Desligamento da reposição não carregado.");

    private static void RequireEmployee(string name, string registration)
    {
        if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(registration))
            throw new BusinessRuleException("Informe o nome e a matrícula do colaborador.", "employeeName");
    }
}

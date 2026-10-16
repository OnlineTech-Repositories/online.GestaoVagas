namespace VacancyControl.Application.Domain;

/// <summary>R&amp;S, Mão de Obra Temporária, Mão de Obra Efetiva, Facilities.</summary>
public enum Modality { RS, MOT, MOE, FAC }

public enum DemandType { NEW, REPLACEMENT }

public enum TermType { FIXED_END, PRESERVED_DURATION, INDEFINITE }

public enum PositionStatus
{
    AWAITING_CONFIRMATION,
    OPEN,
    RECRUITING,
    CANDIDATE_APPROVED,
    IN_ADMISSION,
    /// <summary>Admissão concluída (com matrícula): aguarda só a confirmação do 1º dia pelo NACC.</summary>
    AWAITING_FIRST_DAY,
    PAUSED,
    FILLED,
    CLOSED_CLIENT_CANCELLED,
    CLOSED_CONTRACT_ENDED
}

/// <summary>Calculado, não persistido.</summary>
public enum OrderStatus { IN_PROGRESS, FULFILLED, CANCELLED }

/// <summary>Aprovação formal do pedido pelo cliente. Todo pedido nasce aguardando aprovação.</summary>
public enum OrderApprovalStatus { AWAITING_CLIENT_APPROVAL, APPROVED, NOT_APPROVED }

public enum CandidateSex { FEMALE, MALE, NOT_INFORMED }

/// <summary>Marco da posição a que a evidência se refere.</summary>
public enum EvidenceKind { FIRST_DAY }

/// <summary>Calculado, não persistido.</summary>
public enum SlaSituation { ON_TIME, AT_RISK, OVERDUE, NO_TARGET }

public enum RateStatus { PENDING, VALIDATED, REJECTED }

public enum TerminationSource { DP, NACC, CLIENT }

public enum TerminationType { RESIGNATION, DISMISSAL, CONTRACT_END, ABANDONMENT, OTHER }

public enum ClientDecision { REPLACE, NOT_REPLACE }

public enum ContractStatus { ACTIVE, CLOSED }

public enum SlaTargetSource { CONTRACT, DEFAULT, NONE }

public enum EmailStatus { PENDING, SENT, FAILED }

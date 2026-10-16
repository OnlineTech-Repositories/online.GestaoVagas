import {
  ClientDecision,
  DemandType,
  Modality,
  MoneyStatus,
  OrderStatus,
  PositionStatus,
  RateStatus,
  Role,
  SlaSituation,
  SlaTargetSource,
  TermType,
  TerminationSource,
  TerminationType,
} from './models';

/** Rótulos em pt-BR (glossário, seção 16 da SPEC). */

export const MODALITY: Record<Modality, string> = {
  RS: 'R&S',
  MOT: 'Mão de Obra Temporária',
  MOE: 'Mão de Obra Efetiva',
  FAC: 'Facilities',
};

export const MODALITY_SHORT: Record<Modality, string> = { RS: 'R&S', MOT: 'MOT', MOE: 'MOE', FAC: 'Facilities' };

export const DEMAND_TYPE: Record<DemandType, string> = { NEW: 'Vaga nova', REPLACEMENT: 'Reposição' };

export const TERM_TYPE: Record<TermType, string> = {
  FIXED_END: 'Data fim fixa',
  PRESERVED_DURATION: 'Duração preservada',
  INDEFINITE: 'Indeterminado',
};

export const POSITION_STATUS: Record<PositionStatus, string> = {
  AWAITING_CONFIRMATION: 'Aguardando confirmação',
  OPEN: 'Aberta',
  RECRUITING: 'Em recrutamento',
  CANDIDATE_APPROVED: 'Candidato aprovado',
  IN_ADMISSION: 'Em admissão',
  PAUSED: 'Pausada',
  FILLED: 'Preenchida',
  CLOSED_CLIENT_CANCELLED: 'Encerrada: cliente cancelou',
  CLOSED_CONTRACT_ENDED: 'Encerrada: contrato encerrou',
};

export const ORDER_STATUS: Record<OrderStatus, string> = {
  IN_PROGRESS: 'Em andamento',
  FULFILLED: 'Atendido',
  CANCELLED: 'Cancelado',
};

export const SLA_SITUATION: Record<SlaSituation, string> = {
  ON_TIME: 'No prazo',
  AT_RISK: 'Em risco',
  OVERDUE: 'Vencido',
  NO_TARGET: 'Sem meta',
};

export const SLA_TARGET_SOURCE: Record<SlaTargetSource, string> = {
  CONTRACT: 'Meta do contrato',
  DEFAULT: 'Meta padrão',
  NONE: 'Sem meta',
};

export const RATE_STATUS: Record<RateStatus, string> = {
  PENDING: 'Pendente de validação',
  VALIDATED: 'Validado',
  REJECTED: 'Rejeitado',
};

export const MONEY_STATUS: Record<MoneyStatus, string> = {
  NOT_APPLICABLE: 'Não se aplica (R&S)',
  NO_RATE: 'Sem valor cadastrado',
  PENDING: 'Pendente de validação',
  VALIDATED: 'Validado',
  REJECTED: 'Valor rejeitado',
};

export const TERMINATION_SOURCE: Record<TerminationSource, string> = { DP: 'DP', NACC: 'NACC', CLIENT: 'Cliente' };

export const TERMINATION_TYPE: Record<TerminationType, string> = {
  RESIGNATION: 'Pedido de demissão',
  DISMISSAL: 'Dispensa',
  CONTRACT_END: 'Término de contrato',
  ABANDONMENT: 'Abandono',
  OTHER: 'Outro',
};

export const CLIENT_DECISION: Record<ClientDecision, string> = { REPLACE: 'Repor', NOT_REPLACE: 'Não repor' };

export const ROLE: Record<Role, string> = {
  COMMERCIAL: 'Comercial',
  NACC: 'NACC',
  DP: 'DP',
  RH: 'RH / R&S',
  MANAGER: 'Gestor',
  CONTROLLERSHIP: 'Controladoria',
  ADMIN: 'Administrador',
};

export const AUDIT_ACTION: Record<string, string> = {
  CREATE: 'Criação',
  UPDATE: 'Alteração',
  CREATE_ORDER: 'Pedido criado',
  ADD_POSITIONS: 'Posições acrescentadas',
  REGISTER_TERMINATION: 'Desligamento registrado',
  REGISTER_LEGACY_TERMINATION: 'Desligamento avulso',
  CLIENT_DECISION_REPLACE: 'Cliente decidiu repor',
  CLIENT_DECISION_NOT_REPLACE: 'Cliente decidiu não repor',
  START_RECRUITING: 'Recrutamento iniciado',
  APPROVE_CANDIDATE: 'Candidato aprovado',
  REGISTER_ADMISSION: 'Admissão registrada',
  CONFIRM_FIRST_DAY: '1º dia confirmado',
  CANDIDATE_WITHDREW: 'Candidato desistiu',
  ADMISSION_NO_SHOW: 'Admitido não compareceu',
  START_PAUSE: 'Pausa iniciada',
  END_PAUSE: 'Pausa encerrada',
  CANCEL: 'Cancelamento',
  ADJUST_TERM: 'Vigência ajustada',
  CORRECT_DATE: 'Correção de data',
  DAILY_JOB: 'Rotina diária',
  CREATE_RATE: 'Valor cadastrado',
  UPDATE_RATE: 'Valor corrigido',
};

export const FIELD: Record<string, string> = {
  Status: 'Status',
  PreviousStatus: 'Status anterior',
  OpenedAt: 'Abertura',
  JobconvoCode: 'Código JobConvo',
  JobconvoOpenedAt: 'Abertura no JobConvo',
  CandidateApprovedAt: 'Aprovação do candidato',
  AdmissionAt: 'Admissão',
  FirstDayAt: '1º dia efetivo',
  EmployeeName: 'Colaborador',
  EmployeeRegistration: 'Matrícula',
  ClosedAt: 'Encerramento',
  CancellationReason: 'Motivo do cancelamento',
  TermType: 'Tipo de vigência',
  TermEndDate: 'Fim da vigência',
  TermDurationDays: 'Duração (dias)',
  TermAdjustJustification: 'Justificativa da vigência',
  HasRetroactiveDates: 'Datas retroativas',
  ClientDecision: 'Decisão do cliente',
  ClientDecisionAt: 'Data da decisão',
  LastWorkedDay: 'Último dia trabalhado',
  RegisteredAt: 'Data de registro',
  StartDate: 'Início da pausa',
  EndDate: 'Fim da pausa',
  DesiredStartDate: 'Início desejado',
  RateId: 'Valor por cargo',
  SlaTargetDays: 'Meta de SLA',
};

export function enumOptions<T extends string>(labels: Record<T, string>): { value: T; label: string }[] {
  return (Object.keys(labels) as T[]).map((value) => ({ value, label: labels[value] }));
}

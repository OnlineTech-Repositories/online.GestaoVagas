/**
 * Listas fechadas do domínio, exportadas como constantes para que a regra, o painel e as telas usem a MESMA
 * definição — duas listas equivalentes divergem na primeira mudança de fluxo.
 */

const values = (...names) => Object.freeze(Object.fromEntries(names.map((n) => [n, n])));

/** R&S, Mão de Obra Temporária, Mão de Obra Efetiva, Facilities. */
export const Modality = values('RS', 'MOT', 'MOE', 'FAC');
export const DemandType = values('NEW', 'REPLACEMENT');
export const TermType = values('FIXED_END', 'PRESERVED_DURATION', 'INDEFINITE');

export const PositionStatus = values(
  'AWAITING_CONFIRMATION', 'OPEN', 'RECRUITING', 'CANDIDATE_APPROVED', 'IN_ADMISSION',
  // Admissão concluída (com matrícula): aguarda só a confirmação do 1º dia pelo NACC.
  'AWAITING_FIRST_DAY', 'PAUSED', 'FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED',
  // Retirada do quadro do pedido pelo ADMIN, a pedido do cliente (redução de posições): encerra como o cancelamento.
  'CLOSED_HEADCOUNT_REDUCED',
);

/** Calculado, não persistido. */
export const OrderStatus = values('IN_PROGRESS', 'FULFILLED', 'CANCELLED');
/**
 * Aprovação formal do pedido pelo cliente: todo pedido nasce aguardando. Com valor por cargo novo ou alterado, antes
 * passa pela validação da Controladoria (AWAITING_CONTROLLERSHIP; fluxo integrado de 26/10/2026).
 */
export const OrderApprovalStatus = values('AWAITING_CONTROLLERSHIP', 'AWAITING_CLIENT_APPROVAL', 'APPROVED', 'NOT_APPROVED');
/** Solicitação de validação do pedido pela Controladoria (vazia quando o pedido usou o valor já validado). */
export const ControllershipStatus = values('PENDING', 'RETURNED', 'VALIDATED');
/** Histórico da solicitação: envio, devolução para ajustes, reenvio e validação. */
export const OrderReviewAction = values('SUBMITTED', 'RETURNED', 'RESUBMITTED', 'VALIDATED');
export const CandidateSex = values('FEMALE', 'MALE', 'NOT_INFORMED');
/** FIRST_DAY: comparecimento no 1º dia. HEADCOUNT_REDUCTION: solicitação do cliente para reduzir o quadro. */
export const EvidenceKind = values('FIRST_DAY', 'HEADCOUNT_REDUCTION');
/** Calculado, não persistido. */
export const SlaSituation = values('ON_TIME', 'AT_RISK', 'OVERDUE', 'NO_TARGET');
export const RateStatus = values('PENDING', 'VALIDATED', 'REJECTED');
export const TerminationSource = values('DP', 'NACC', 'CLIENT');
export const TerminationType = values('RESIGNATION', 'DISMISSAL', 'CONTRACT_END', 'ABANDONMENT', 'OTHER');
export const ClientDecision = values('REPLACE', 'NOT_REPLACE');
export const ContractStatus = values('ACTIVE', 'CLOSED');
export const SlaTargetSource = values('CONTRACT', 'DEFAULT', 'NONE');
export const EmailStatus = values('PENDING', 'SENT', 'FAILED');
/** Situação do valor em R$ da posição (RN-21/RN-22). */
export const MoneyStatus = values('NOT_APPLICABLE', 'NO_RATE', 'PENDING', 'VALIDATED', 'REJECTED');

/**
 * Etapa da vaga no acompanhamento do RH (calculada, não persistida): o status do fluxo, com a pausa e a espera pela
 * decisão do cliente em etapas próprias — continuam pendentes, mas não estão com o recrutamento.
 */
export const RhStage = values(
  'AWAITING_CLIENT', 'OPEN', 'RECRUITING', 'CANDIDATE_APPROVED', 'IN_ADMISSION', 'AWAITING_FIRST_DAY', 'PAUSED', 'FILLED',
);

/** Status que encerram a posição: fora do "estado aberto". */
export const CLOSED_STATUSES = Object.freeze(['FILLED', 'CLOSED_CLIENT_CANCELLED', 'CLOSED_CONTRACT_ENDED', 'CLOSED_HEADCOUNT_REDUCED']);

/** Perfis do sistema (seção 4 da SPEC). Um usuário pode ter vários. */
export const Roles = Object.freeze({
  Commercial: 'COMMERCIAL',
  Nacc: 'NACC',
  Dp: 'DP',
  /** Analista de RH: executa o recrutamento dos pedidos atribuídos a ele. */
  Rh: 'RH',
  /** Gestor de RH: distribui os pedidos entre os analistas e executa o recrutamento em qualquer pedido. */
  RhManager: 'RH_MANAGER',
  /** Responsável por Admissões: o único que registra admissões (individuais e em lote) e cuida da matrícula. */
  Admissions: 'ADMISSIONS',
  Manager: 'MANAGER',
  Controllership: 'CONTROLLERSHIP',
  Admin: 'ADMIN',
});
export const ALL_ROLES = Object.freeze(Object.values(Roles));
/** Perfis que veem valores em R$ por contrato e por posição (seção 4.2, D2). */
export const SEE_DETAILED_VALUES = Object.freeze([Roles.Commercial, Roles.Controllership, Roles.Admin]);
/** Perfis que veem R$ agregado no painel (seção 4.2, D2). */
export const SEE_AGGREGATED_VALUES = Object.freeze([Roles.Commercial, Roles.Controllership, Roles.Admin, Roles.Manager]);

/** Parâmetros do sistema e seus valores padrão (seções 5.2 e 15). */
export const ParameterKeys = Object.freeze({
  AtRiskDays: 'AT_RISK_DAYS',
  StaleDays: 'STALE_DAYS',
  EarlyReplacementWindowDays: 'EARLY_REPLACEMENT_WINDOW_DAYS',
  InitialLoadOpen: 'INITIAL_LOAD_OPEN',
  AllowLegacyTermination: 'ALLOW_LEGACY_TERMINATION',
  LossOnCancelAfterOpen: 'LOSS_ON_CANCEL_AFTER_OPEN',
  DailyDigestTime: 'DAILY_DIGEST_TIME',
  RequestEvidenceRequired: 'REQUEST_EVIDENCE_REQUIRED',
  FirstDayReminderDays: 'FIRST_DAY_REMINDER_DAYS',
  AdmissionsDigestTime: 'ADMISSIONS_DIGEST_TIME',
});

export const PARAMETER_DEFAULTS = Object.freeze({
  AT_RISK_DAYS: ['2', 'Dias antes do prazo para a posição ficar Em risco'],
  STALE_DAYS: ['3', 'Dias sem atualização para gerar alerta'],
  EARLY_REPLACEMENT_WINDOW_DAYS: ['30', 'Janela (dias) da taxa de reposição precoce'],
  INITIAL_LOAD_OPEN: ['true', 'Período de carga inicial aberto'],
  ALLOW_LEGACY_TERMINATION: ['true', 'Permite desligamento avulso (sem posição de origem)'],
  LOSS_ON_CANCEL_AFTER_OPEN: ['true', 'Conta perda até o cancelamento de posição já aberta'],
  DAILY_DIGEST_TIME: ['07:00', 'Horário da rotina diária (HH:mm, America/Sao_Paulo)'],
  REQUEST_EVIDENCE_REQUIRED: ['false', 'Exige evidência da solicitação do cliente no pedido'],
  FIRST_DAY_REMINDER_DAYS: ['1', 'Dias úteis entre os lembretes ao NACC das confirmações do 1º dia pendentes (0 desliga)'],
  ADMISSIONS_DIGEST_TIME: ['07:00', 'Horário do resumo diário das admissões pendentes (HH:mm, dias úteis, America/Sao_Paulo)'],
  // Metas dos KPIs (seção 11): vazias = "sem meta", como a SPEC pede enquanto não forem definidas.
  KPI_TARGET_COMMUNICATION_DAYS: ['', 'Meta do KPI: tempo médio de comunicação, em dias (vazio = sem meta)'],
  KPI_TARGET_FILL_DAYS: ['', 'Meta do KPI: tempo médio de preenchimento, em dias (vazio = sem meta)'],
  KPI_TARGET_UNCOVERED_AVG_DAYS: ['', 'Meta do KPI: tempo médio total descoberto por posição, em dias (vazio = sem meta)'],
  KPI_TARGET_SLA_PERCENT: ['', 'Meta do KPI: % de posições preenchidas no SLA (vazio = sem meta)'],
  KPI_TARGET_UNCOVERED_POSITION_DAYS: ['', 'Meta do KPI: dias-posto descobertos no período (vazio = sem meta)'],
  KPI_TARGET_LOST_VALUE: ['', 'Meta do KPI: faturamento perdido no período, em R$ (vazio = sem meta)'],
  KPI_TARGET_OVERDUE_BACKLOG: ['', 'Meta do KPI: backlog vencido, em posições (vazio = sem meta)'],
  KPI_TARGET_EARLY_REPLACEMENT_PERCENT: ['', 'Meta do KPI: % de reposição precoce (vazio = sem meta)'],
});

/**
 * KPIs da seção 11, com a meta (parâmetro) e o sentido: 'down' = quanto menor, melhor; 'up' = quanto maior, melhor.
 * A mesma lista monta os cartões da tela e a aba de indicadores do Excel.
 */
export const KPIS = Object.freeze([
  { key: 'communication', label: 'Tempo médio de comunicação', unit: 'days', target: 'KPI_TARGET_COMMUNICATION_DAYS', better: 'down' },
  { key: 'fill', label: 'Tempo médio de preenchimento', unit: 'days', target: 'KPI_TARGET_FILL_DAYS', better: 'down' },
  { key: 'uncoveredAvg', label: 'Tempo médio total descoberto', unit: 'days', target: 'KPI_TARGET_UNCOVERED_AVG_DAYS', better: 'down' },
  { key: 'slaPercent', label: '% no SLA', unit: 'percent', target: 'KPI_TARGET_SLA_PERCENT', better: 'up' },
  { key: 'uncoveredPositionDays', label: 'Dias-posto descobertos', unit: 'int', target: 'KPI_TARGET_UNCOVERED_POSITION_DAYS', better: 'down' },
  { key: 'lost', label: 'Faturamento perdido', unit: 'money', target: 'KPI_TARGET_LOST_VALUE', better: 'down', money: true },
  { key: 'overdueBacklog', label: 'Backlog vencido', unit: 'int', target: 'KPI_TARGET_OVERDUE_BACKLOG', better: 'down' },
  { key: 'earlyReplacement', label: 'Taxa de reposição precoce', unit: 'percent', target: 'KPI_TARGET_EARLY_REPLACEMENT_PERCENT', better: 'down' },
]);

/** Rótulos em pt-BR para mensagens e e-mails (glossário, seção 16). */
export const Labels = Object.freeze({
  positionStatus: {
    AWAITING_CONFIRMATION: 'Aguardando confirmação',
    OPEN: 'Aberta',
    RECRUITING: 'Em recrutamento',
    CANDIDATE_APPROVED: 'Candidato selecionado',
    IN_ADMISSION: 'Em admissão',
    AWAITING_FIRST_DAY: 'Aguardando 1º dia',
    PAUSED: 'Pausada',
    FILLED: 'Preenchida',
    CLOSED_CLIENT_CANCELLED: 'Encerrada: cliente cancelou',
    CLOSED_HEADCOUNT_REDUCED: 'Cancelada por redução do quadro',
    CLOSED_CONTRACT_ENDED: 'Encerrada: contrato encerrou',
  },
  demandType: { NEW: 'Vaga nova', REPLACEMENT: 'Reposição' },
  approvalStatus: {
    AWAITING_CONTROLLERSHIP: 'Aguardando aprovação da Controladoria',
    AWAITING_CLIENT_APPROVAL: 'Aguardando aprovação do cliente',
    APPROVED: 'Aprovado',
    NOT_APPROVED: 'Não aprovado',
  },
});

export const NotificationTypes = Object.freeze({
  OrderCreated: 'ORDER_CREATED',
  OrderApproved: 'ORDER_APPROVED',
  OrderNotApproved: 'ORDER_NOT_APPROVED',
  RhAssigned: 'RH_ASSIGNED',
  RhUnassigned: 'RH_UNASSIGNED',
  TerminationRegistered: 'TERMINATION_REGISTERED',
  ReplacementConfirmed: 'REPLACEMENT_CONFIRMED',
  AdmissionRegistered: 'ADMISSION_REGISTERED',
  PauseStarted: 'PAUSE_STARTED',
  PauseEnded: 'PAUSE_ENDED',
  RatePending: 'RATE_PENDING',
  RateRejected: 'RATE_REJECTED',
  RateValidated: 'RATE_VALIDATED',
  ContractEnded: 'CONTRACT_ENDED',
  SlaAtRisk: 'SLA_AT_RISK',
  SlaOverdue: 'SLA_OVERDUE',
  // Aviso antigo, um por posição; desde 22/10/2026 as posições paradas vão consolidadas por pedido.
  PositionStale: 'POSITION_STALE',
  OrderPositionsStale: 'ORDER_POSITIONS_STALE',
  FirstDayPending: 'FIRST_DAY_PENDING',
  AdmissionPending: 'ADMISSION_PENDING',
  OrderReviewPending: 'ORDER_REVIEW_PENDING',
  OrderReviewReturned: 'ORDER_REVIEW_RETURNED',
});

/** Alertas da rotina diária registrados em position_alerts (um por posição; vaga parada, um por período parado). */
export const AlertKind = values('AT_RISK', 'OVERDUE', 'STALE');

/** Tipos espelhando os contratos JSON da API (datas `DateOnly` trafegam como 'yyyy-MM-dd'). */

export type IsoDate = string;

export type Modality = 'RS' | 'MOT' | 'MOE' | 'FAC';
export type DemandType = 'NEW' | 'REPLACEMENT';
export type TermType = 'FIXED_END' | 'PRESERVED_DURATION' | 'INDEFINITE';
export type PositionStatus =
  | 'AWAITING_CONFIRMATION'
  | 'OPEN'
  | 'RECRUITING'
  | 'CANDIDATE_APPROVED'
  | 'IN_ADMISSION'
  | 'PAUSED'
  | 'FILLED'
  | 'CLOSED_CLIENT_CANCELLED'
  | 'CLOSED_CONTRACT_ENDED';
export type OrderStatus = 'IN_PROGRESS' | 'FULFILLED' | 'CANCELLED';
export type SlaSituation = 'ON_TIME' | 'AT_RISK' | 'OVERDUE' | 'NO_TARGET';
export type RateStatus = 'PENDING' | 'VALIDATED' | 'REJECTED';
export type TerminationSource = 'DP' | 'NACC' | 'CLIENT';
export type TerminationType = 'RESIGNATION' | 'DISMISSAL' | 'CONTRACT_END' | 'ABANDONMENT' | 'OTHER';
export type ClientDecision = 'REPLACE' | 'NOT_REPLACE';
export type ContractStatus = 'ACTIVE' | 'CLOSED';
export type SlaTargetSource = 'CONTRACT' | 'DEFAULT' | 'NONE';
export type MoneyStatus = 'NOT_APPLICABLE' | 'NO_RATE' | 'PENDING' | 'VALIDATED' | 'REJECTED';

export type Role = 'COMMERCIAL' | 'NACC' | 'DP' | 'RH' | 'MANAGER' | 'CONTROLLERSHIP' | 'ADMIN';

export interface Me {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  mustChangePassword: boolean;
  canSeeDetailedValues: boolean;
  canSeeAggregatedValues: boolean;
  initialLoadOpen: boolean;
}

export interface PagedResult<T> {
  items: T[];
  total: number;
}

export interface PositionSummary {
  id: string;
  orderId: string;
  orderNumber: number;
  sequence: number;
  clientName: string;
  contractName: string;
  groupEntityName: string;
  modality: Modality;
  jobRoleName: string;
  workLocationName: string;
  demandType: DemandType;
  status: PositionStatus;
  stageStatus: PositionStatus;
  openedAt: IsoDate | null;
  uncoveredStart: IsoDate;
  uncoveredDays: number;
  pausedDays: number;
  fillTime: number | null;
  slaTargetDays: number | null;
  slaDeadline: IsoDate | null;
  slaSituation: SlaSituation | null;
  lost: number | null;
  deferred: number | null;
  moneyStatus: MoneyStatus | null;
  employeeName: string | null;
  jobconvoCode: string | null;
  hasRetroactiveDates: boolean;
  lastUpdate: string;
}

export interface Pause {
  id: string;
  reasonId: string;
  reasonName: string;
  startDate: IsoDate;
  endDate: IsoDate | null;
  days: number;
}

export interface Termination {
  id: string;
  originPositionId: string;
  originEmployeeName: string | null;
  originEmployeeRegistration: string | null;
  lastWorkedDay: IsoDate;
  source: TerminationSource;
  terminationType: TerminationType;
  notes: string | null;
  clientDecision: ClientDecision | null;
  clientDecisionAt: IsoDate | null;
  registeredAt: IsoDate;
  replacementPositionId: string | null;
}

export interface Metrics {
  uncoveredDays: number;
  uncoveredStart: IsoDate;
  uncoveredEndExclusive: IsoDate;
  pausedDays: number;
  registrationTime: number | null;
  communicationTime: number | null;
  confirmationTime: number | null;
  fillTime: number | null;
  slaTargetDays: number | null;
  slaTargetSource: SlaTargetSource;
  slaDeadline: IsoDate | null;
  slaSituation: SlaSituation | null;
  dailyValue: number | null;
  lost: number | null;
  deferred: number | null;
  moneyStatus: MoneyStatus | null;
}

export interface HistoryEntry {
  timestamp: string;
  userName: string | null;
  entity: string;
  action: string;
  field: string | null;
  oldValue: string | null;
  newValue: string | null;
  justification: string | null;
}

export type PositionAction =
  | 'DECIDE'
  | 'START_RECRUITING'
  | 'APPROVE_CANDIDATE'
  | 'REGISTER_ADMISSION'
  | 'CONFIRM_FIRST_DAY'
  | 'CANDIDATE_WITHDREW'
  | 'ADMISSION_NO_SHOW'
  | 'START_PAUSE'
  | 'END_PAUSE'
  | 'CANCEL'
  | 'ADJUST_TERM'
  | 'REGISTER_TERMINATION'
  | 'CORRECT_DATES';

export interface PositionDetail {
  summary: PositionSummary;
  clientRequestDate: IsoDate;
  orderRegisteredAt: IsoDate;
  desiredStartDate: IsoDate;
  orderNotes: string | null;
  isLegacyOrder: boolean;
  jobconvoCode: string | null;
  jobconvoOpenedAt: IsoDate | null;
  candidateApprovedAt: IsoDate | null;
  admissionAt: IsoDate | null;
  firstDayAt: IsoDate | null;
  employeeName: string | null;
  employeeRegistration: string | null;
  closedAt: IsoDate | null;
  cancellationReason: string | null;
  termType: TermType;
  termEndDate: IsoDate | null;
  termDurationDays: number | null;
  termAdjustJustification: string | null;
  termination: Termination | null;
  exitTermination: Termination | null;
  pauses: Pause[];
  metrics: Metrics;
  allowedActions: PositionAction[];
  history: HistoryEntry[];
}

export interface OrderSummary {
  id: string;
  number: number;
  clientName: string;
  contractName: string;
  modality: Modality;
  jobRoleName: string;
  workLocationName: string;
  quantity: number;
  clientRequestDate: IsoDate;
  desiredStartDate: IsoDate;
  registeredAt: IsoDate;
  status: OrderStatus;
  openPositions: number;
  filledPositions: number;
  isLegacy: boolean;
}

export interface OrderDetail {
  summary: OrderSummary;
  contractId: string;
  jobRoleId: string;
  workLocationId: string;
  termType: TermType;
  termEndDate: IsoDate | null;
  termDurationDays: number | null;
  notes: string | null;
  createdByName: string | null;
  canAddPositions: boolean;
  canCorrectDates: boolean;
  positions: PositionSummary[];
}

export interface Dashboard {
  today: IsoDate;
  monthStart: IsoDate;
  openPositions: number;
  overdue: number;
  atRisk: number;
  awaitingClient: number;
  paused: number;
  uncoveredDaysInMonth: number;
  lostInMonth: number | null;
  deferredInMonth: number | null;
  pendingValidationInMonth: number | null;
  pendingValidationCount: number;
  critical: PositionSummary[];
}

export interface Client {
  id: string;
  legalName: string;
  cnpj: string;
  active: boolean;
}

export interface Contract {
  id: string;
  clientId: string;
  clientName: string;
  name: string;
  groupEntityId: string;
  groupEntityName: string;
  modalities: Modality[];
  startDate: IsoDate;
  endDate: IsoDate | null;
  commercialOwnerId: string;
  commercialOwnerName: string | null;
  slaNewDays: number | null;
  slaReplacementDays: number | null;
  status: ContractStatus;
}

export interface ContractRate {
  id: string;
  contractId: string;
  contractName: string;
  clientName: string;
  jobRoleId: string;
  jobRoleName: string;
  monthlyValue: number | null;
  dailyValue: number | null;
  feeValue: number | null;
  validFrom: IsoDate;
  status: RateStatus;
  createdByName: string | null;
  createdAt: string;
  validatedByName: string | null;
  validatedAt: string | null;
  rejectionReason: string | null;
}

export interface NamedItem {
  id: string;
  name: string;
  active: boolean;
}

export interface GroupEntity {
  id: string;
  name: string;
  cnpj: string;
  active: boolean;
}

export interface WorkLocation {
  id: string;
  name: string;
  clientId: string | null;
  clientName: string | null;
  active: boolean;
}

export interface SlaTarget {
  id: string;
  modality: Modality;
  demandType: DemandType;
  days: number;
  validFrom: IsoDate;
}

export interface Parameter {
  key: string;
  value: string;
  description: string | null;
}

export interface User {
  id: string;
  name: string;
  email: string;
  roles: Role[];
  active: boolean;
  mustChangePassword: boolean;
  lockedOut: boolean;
}

export interface UserOption {
  id: string;
  name: string;
}

export interface FilledPosition {
  positionId: string;
  employeeName: string;
  employeeRegistration: string;
  clientName: string;
  contractName: string;
  jobRoleName: string;
  workLocationName: string;
  firstDayAt: IsoDate | null;
  orderNumber: number;
  sequence: number;
}

export interface TerminationResult {
  terminationId: string;
  replacementPositionId: string;
}

export interface AppNotification {
  id: string;
  type: string;
  entityId: string | null;
  message: string;
  createdAt: string;
  readAt: string | null;
}

export interface ProblemDetails {
  status?: number;
  title?: string;
  detail?: string;
  errors?: Record<string, string[]>;
}

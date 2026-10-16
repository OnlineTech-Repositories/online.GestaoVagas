import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Observable } from 'rxjs';
import {
  AppNotification,
  Client,
  Contract,
  ContractRate,
  Dashboard,
  FilledPosition,
  GroupEntity,
  NamedItem,
  OrderDetail,
  OrderSummary,
  PagedResult,
  Parameter,
  PositionDetail,
  PositionSummary,
  RateStatus,
  SlaTarget,
  TerminationResult,
  User,
  UserOption,
  WorkLocation,
} from './models';

type QueryValue = string | number | boolean | null | undefined | readonly (string | number)[];

/** Monta parâmetros de query ignorando valores vazios. */
export function toParams(query: Record<string, QueryValue>): HttpParams {
  let params = new HttpParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === null || value === undefined || value === '') continue;
    if (Array.isArray(value)) value.forEach((v) => (params = params.append(key, String(v))));
    else params = params.set(key, String(value));
  }
  return params;
}

/** Cliente tipado da API REST. Todas as chamadas usam caminho relativo (/api) e cookie de sessão. */
@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  // ------------------------------------------------------------ painel e posições
  dashboard(): Observable<Dashboard> {
    return this.http.get<Dashboard>('/api/dashboard');
  }

  positions(query: Record<string, QueryValue>): Observable<PagedResult<PositionSummary>> {
    return this.http.get<PagedResult<PositionSummary>>('/api/positions', { params: toParams(query) });
  }

  position(id: string): Observable<PositionDetail> {
    return this.http.get<PositionDetail>(`/api/positions/${id}`);
  }

  positionAction(id: string, path: string, body: unknown): Observable<PositionDetail> {
    return this.http.post<PositionDetail>(`/api/positions/${id}/${path}`, body);
  }

  // ------------------------------------------------------------ pedidos
  orders(query: Record<string, QueryValue> = {}): Observable<OrderSummary[]> {
    return this.http.get<OrderSummary[]>('/api/orders', { params: toParams(query) });
  }

  order(id: string): Observable<OrderDetail> {
    return this.http.get<OrderDetail>(`/api/orders/${id}`);
  }

  createOrder(body: unknown): Observable<OrderDetail> {
    return this.http.post<OrderDetail>('/api/orders', body);
  }

  addPositions(id: string, body: unknown): Observable<OrderDetail> {
    return this.http.post<OrderDetail>(`/api/orders/${id}/positions`, body);
  }

  correctOrderDate(id: string, body: unknown): Observable<OrderDetail> {
    return this.http.post<OrderDetail>(`/api/orders/${id}/date-corrections`, body);
  }

  // ------------------------------------------------------------ desligamentos
  filledPositions(term: string): Observable<FilledPosition[]> {
    return this.http.get<FilledPosition[]>('/api/terminations/filled-positions', { params: toParams({ term }) });
  }

  registerTermination(body: unknown): Observable<TerminationResult> {
    return this.http.post<TerminationResult>('/api/terminations', body);
  }

  registerLegacyTermination(body: unknown): Observable<TerminationResult> {
    return this.http.post<TerminationResult>('/api/terminations/legacy', body);
  }

  // ------------------------------------------------------------ clientes, contratos e valores
  clients(): Observable<Client[]> {
    return this.http.get<Client[]>('/api/clients');
  }

  saveClient(id: string | null, body: unknown): Observable<Client> {
    return id ? this.http.put<Client>(`/api/clients/${id}`, body) : this.http.post<Client>('/api/clients', body);
  }

  contracts(query: { clientId?: string | null; onlyActive?: boolean } = {}): Observable<Contract[]> {
    return this.http.get<Contract[]>('/api/contracts', { params: toParams(query) });
  }

  saveContract(id: string | null, body: unknown): Observable<Contract> {
    return id ? this.http.put<Contract>(`/api/contracts/${id}`, body) : this.http.post<Contract>('/api/contracts', body);
  }

  rates(query: { contractId?: string | null; status?: RateStatus | null } = {}): Observable<ContractRate[]> {
    return this.http.get<ContractRate[]>('/api/contract-rates', { params: toParams(query) });
  }

  saveRate(id: string | null, body: unknown): Observable<ContractRate> {
    return id
      ? this.http.put<ContractRate>(`/api/contract-rates/${id}`, body)
      : this.http.post<ContractRate>('/api/contract-rates', body);
  }

  validateRate(id: string): Observable<ContractRate> {
    return this.http.post<ContractRate>(`/api/contract-rates/${id}/validate`, {});
  }

  rejectRate(id: string, reason: string): Observable<ContractRate> {
    return this.http.post<ContractRate>(`/api/contract-rates/${id}/reject`, { reason });
  }

  // ------------------------------------------------------------ cadastros auxiliares
  jobRoles(): Observable<NamedItem[]> {
    return this.http.get<NamedItem[]>('/api/catalogs/job-roles');
  }

  pauseReasons(): Observable<NamedItem[]> {
    return this.http.get<NamedItem[]>('/api/catalogs/pause-reasons');
  }

  groupEntities(): Observable<GroupEntity[]> {
    return this.http.get<GroupEntity[]>('/api/catalogs/group-entities');
  }

  workLocations(): Observable<WorkLocation[]> {
    return this.http.get<WorkLocation[]>('/api/catalogs/work-locations');
  }

  slaTargets(): Observable<SlaTarget[]> {
    return this.http.get<SlaTarget[]>('/api/catalogs/sla-targets');
  }

  saveCatalog<T>(catalog: string, id: string | null, body: unknown): Observable<T> {
    return id
      ? this.http.put<T>(`/api/catalogs/${catalog}/${id}`, body)
      : this.http.post<T>(`/api/catalogs/${catalog}`, body);
  }

  parameters(): Observable<Parameter[]> {
    return this.http.get<Parameter[]>('/api/parameters');
  }

  updateParameter(key: string, value: string): Observable<Parameter> {
    return this.http.put<Parameter>(`/api/parameters/${key}`, { value });
  }

  // ------------------------------------------------------------ usuários e notificações
  users(): Observable<User[]> {
    return this.http.get<User[]>('/api/users');
  }

  usersByRole(role: string): Observable<UserOption[]> {
    return this.http.get<UserOption[]>(`/api/users/by-role/${role}`);
  }

  saveUser(id: string | null, body: unknown): Observable<User> {
    return id ? this.http.put<User>(`/api/users/${id}`, body) : this.http.post<User>('/api/users', body);
  }

  resetPassword(id: string, temporaryPassword: string): Observable<void> {
    return this.http.post<void>(`/api/users/${id}/reset-password`, { temporaryPassword });
  }

  notifications(unreadOnly = false): Observable<AppNotification[]> {
    return this.http.get<AppNotification[]>('/api/notifications', { params: toParams({ unreadOnly }) });
  }

  unreadCount(): Observable<number> {
    return this.http.get<number>('/api/notifications/unread-count');
  }

  markRead(id: string): Observable<void> {
    return this.http.post<void>(`/api/notifications/${id}/read`, {});
  }

  markAllRead(): Observable<void> {
    return this.http.post<void>('/api/notifications/read-all', {});
  }
}

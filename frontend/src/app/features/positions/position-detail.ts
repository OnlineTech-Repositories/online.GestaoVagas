import { DatePipe } from '@angular/common';
import { Component, computed, inject, input } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import {
  AUDIT_ACTION,
  CLIENT_DECISION,
  DEMAND_TYPE,
  FIELD,
  MODALITY,
  MONEY_STATUS,
  POSITION_STATUS,
  SLA_TARGET_SOURCE,
  TERM_TYPE,
  TERMINATION_SOURCE,
  TERMINATION_TYPE,
} from '../../core/labels';
import { PositionAction, PositionDetail } from '../../core/models';
import { Notify } from '../../core/notify';
import { SlaChip, StatusChip } from '../../shared/chips';
import { DateBrPipe, formatDate, LabelPipe, MoneyPipe } from '../../shared/format';
import { ACTION_LABEL, PositionActionData, PositionActionDialog } from './position-action-dialog';

interface TimelineItem {
  label: string;
  date: string | null;
  detail?: string | null;
}

@Component({
  selector: 'app-position-detail',
  imports: [
    RouterLink,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatTableModule,
    MatTooltipModule,
    MatProgressBarModule,
    StatusChip,
    SlaChip,
    DateBrPipe,
    MoneyPipe,
    LabelPipe,
    DatePipe,
  ],
  templateUrl: './position-detail.html',
  styleUrl: './position-detail.scss',
})
export class PositionDetailPage {
  /** Parâmetro da rota (withComponentInputBinding). */
  readonly id = input.required<string>();

  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(Auth);

  protected readonly labels = {
    demand: DEMAND_TYPE,
    modality: MODALITY,
    term: TERM_TYPE,
    money: MONEY_STATUS,
    slaSource: SLA_TARGET_SOURCE,
    source: TERMINATION_SOURCE,
    type: TERMINATION_TYPE,
    decision: CLIENT_DECISION,
  };
  protected readonly actionLabel = ACTION_LABEL;

  protected readonly position = rxResource({ params: () => this.id(), stream: ({ params }) => this.api.position(params) });
  private readonly pauseReasons = rxResource({ stream: () => this.api.pauseReasons() });

  protected readonly error = computed(() => (this.position.error() ? errorMessage(this.position.error()) : null));

  /** Ações principais (fluxo) e secundárias (exceções e correções). */
  protected readonly primaryActions = computed(() =>
    (this.position.value()?.allowedActions ?? []).filter((a) =>
      ['DECIDE', 'START_RECRUITING', 'APPROVE_CANDIDATE', 'REGISTER_ADMISSION', 'CONFIRM_FIRST_DAY', 'END_PAUSE', 'REGISTER_TERMINATION'].includes(a),
    ),
  );
  protected readonly secondaryActions = computed(() =>
    (this.position.value()?.allowedActions ?? []).filter((a) => !this.primaryActions().includes(a)),
  );

  protected readonly timeline = computed<TimelineItem[]>(() => {
    const p = this.position.value();
    if (!p) return [];
    const t = p.termination;
    const items: TimelineItem[] = [];
    if (t) {
      items.push({ label: 'Último dia trabalhado do colaborador anterior', date: t.lastWorkedDay, detail: t.originEmployeeName });
      items.push({ label: 'Desligamento registrado', date: t.registeredAt });
      items.push({
        label: 'Decisão do cliente',
        date: t.clientDecisionAt,
        detail: t.clientDecision ? CLIENT_DECISION[t.clientDecision] : 'Aguardando',
      });
    } else {
      items.push({ label: 'Solicitação do cliente', date: p.clientRequestDate });
      items.push({ label: 'Registro do pedido', date: p.orderRegisteredAt });
      items.push({ label: 'Início desejado', date: p.desiredStartDate });
    }
    items.push({ label: 'Abertura da posição', date: p.summary.openedAt });
    items.push({ label: 'Vaga no JobConvo', date: p.jobconvoOpenedAt, detail: p.jobconvoCode });
    items.push({ label: 'Candidato aprovado', date: p.candidateApprovedAt });
    items.push({ label: 'Admissão', date: p.admissionAt });
    items.push({
      label: '1º dia efetivo',
      date: p.firstDayAt,
      detail: p.employeeName ? `${p.employeeName} (matr. ${p.employeeRegistration})` : null,
    });
    if (p.closedAt) {
      items.push({ label: POSITION_STATUS[p.summary.status], date: p.closedAt, detail: p.cancellationReason });
    }
    return items;
  });

  protected readonly historyColumns = ['timestamp', 'user', 'action', 'change', 'justification'];

  open(action: PositionAction): void {
    const position = this.position.value();
    if (!position) return;
    if (action === 'REGISTER_TERMINATION') {
      void this.router.navigate(['/desligamentos/novo'], { queryParams: { positionId: position.summary.id } });
      return;
    }
    this.dialog
      .open<PositionActionDialog, PositionActionData, PositionDetail>(PositionActionDialog, {
        width: '520px',
        maxWidth: '95vw',
        data: { action, position, pauseReasons: this.pauseReasons.value() ?? [] },
      })
      .afterClosed()
      .subscribe((updated) => {
        if (!updated) return;
        this.position.set(updated);
        this.notify.success('Registro salvo.');
      });
  }

  auditAction(action: string): string {
    return AUDIT_ACTION[action] ?? action;
  }

  fieldLabel(field: string | null): string {
    return field ? (FIELD[field] ?? field) : '';
  }

  /** Datas ISO e status ficam legíveis no histórico. */
  auditValue(value: string | null): string {
    if (value === null || value === '') return '—';
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return formatDate(value);
    return (POSITION_STATUS as Record<string, string>)[value] ?? value;
  }
}

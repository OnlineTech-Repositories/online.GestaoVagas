import { Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatRadioModule } from '@angular/material/radio';
import { MatSelectModule } from '@angular/material/select';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { enumOptions, TERM_TYPE } from '../../core/labels';
import { NamedItem, PositionAction, PositionDetail, TermType } from '../../core/models';
import { formatDate, todayIso } from '../../shared/format';

export interface PositionActionData {
  action: PositionAction;
  position: PositionDetail;
  pauseReasons: NamedItem[];
}

export const ACTION_LABEL: Record<PositionAction, string> = {
  DECIDE: 'Registrar decisão do cliente',
  START_RECRUITING: 'Informar vaga no JobConvo',
  APPROVE_CANDIDATE: 'Aprovar candidato',
  REGISTER_ADMISSION: 'Registrar admissão',
  CONFIRM_FIRST_DAY: 'Confirmar 1º dia efetivo',
  CANDIDATE_WITHDREW: 'Candidato desistiu',
  ADMISSION_NO_SHOW: 'Admitido não compareceu',
  START_PAUSE: 'Iniciar pausa',
  END_PAUSE: 'Encerrar pausa',
  CANCEL: 'Cancelar posição',
  ADJUST_TERM: 'Ajustar vigência',
  REGISTER_TERMINATION: 'Registrar desligamento',
  CORRECT_DATES: 'Corrigir data',
};

type Field = 'date' | 'decision' | 'jobconvoCode' | 'employee' | 'reason' | 'cancelReason' | 'term' | 'correction';

const FIELDS: Partial<Record<PositionAction, Field[]>> = {
  DECIDE: ['decision', 'date'],
  START_RECRUITING: ['jobconvoCode', 'date'],
  APPROVE_CANDIDATE: ['date'],
  REGISTER_ADMISSION: ['date'],
  CONFIRM_FIRST_DAY: ['date', 'employee'],
  CANDIDATE_WITHDREW: [],
  ADMISSION_NO_SHOW: [],
  START_PAUSE: ['reason', 'date'],
  END_PAUSE: ['date'],
  CANCEL: ['date', 'cancelReason'],
  ADJUST_TERM: ['term'],
  CORRECT_DATES: ['correction', 'date'],
};

const DATE_LABEL: Partial<Record<PositionAction, string>> = {
  DECIDE: 'Data da decisão',
  START_RECRUITING: 'Abertura da vaga no JobConvo',
  APPROVE_CANDIDATE: 'Data da aprovação',
  REGISTER_ADMISSION: 'Data da admissão',
  CONFIRM_FIRST_DAY: '1º dia efetivo no posto',
  START_PAUSE: 'Início da pausa',
  END_PAUSE: 'Fim da pausa',
  CANCEL: 'Data do cancelamento',
  CORRECT_DATES: 'Data correta',
};

/** Ações que exigem justificativa sempre (as demais, só para data retroativa — RN-24). */
const ALWAYS_JUSTIFY: PositionAction[] = ['ADJUST_TERM', 'CORRECT_DATES'];

interface CorrectionOption {
  value: string;
  label: string;
  current: string;
  pauseId?: string;
}

@Component({
  selector: 'app-position-action-dialog',
  imports: [
    ReactiveFormsModule,
    MatDialogModule,
    MatButtonModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatRadioModule,
    MatProgressBarModule,
  ],
  templateUrl: './position-action-dialog.html',
})
export class PositionActionDialog {
  protected readonly data = inject<PositionActionData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<PositionActionDialog, PositionDetail>);
  private readonly api = inject(Api);
  private readonly auth = inject(Auth);

  protected readonly title = ACTION_LABEL[this.data.action];
  protected readonly fields = new Set(FIELDS[this.data.action] ?? []);
  protected readonly dateLabel = DATE_LABEL[this.data.action] ?? 'Data';
  protected readonly termOptions = enumOptions(TERM_TYPE);
  protected readonly activeReasons = this.data.pauseReasons.filter((r) => r.active);
  protected readonly corrections = this.correctionOptions();
  private readonly p = this.data.position;
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  protected readonly form = inject(NonNullableFormBuilder).group({
    date: [this.data.action === 'START_RECRUITING' ? '' : todayIso()],
    decision: ['REPLACE'],
    jobconvoCode: [this.p.jobconvoCode ?? ''],
    employeeName: [''],
    employeeRegistration: [''],
    reasonId: [''],
    cancelReason: [''],
    termType: [this.p.termType as TermType],
    termEndDate: [this.p.termEndDate ?? ''],
    termDurationDays: [this.p.termDurationDays as number | null],
    correction: [''],
    justification: [''],
  });

  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  /** Mostra a justificativa como obrigatória quando a ação exige ou a data é retroativa fora da carga inicial. */
  protected readonly justificationRequired = computed(() => {
    if (ALWAYS_JUSTIFY.includes(this.data.action) || this.data.action === 'CANCEL') return false;
    const date = this.values().date;
    return !this.auth.user()?.initialLoadOpen && !!date && date < todayIso();
  });

  protected readonly selectedCorrection = computed(() =>
    this.corrections.find((c) => c.value === this.values().correction),
  );

  submit(): void {
    const v = this.form.getRawValue();
    const problem = this.validate(v);
    if (problem) {
      this.error.set(problem);
      return;
    }
    const [path, body] = this.request(v);
    this.saving.set(true);
    this.error.set(null);
    this.api.positionAction(this.p.summary.id, path, body).subscribe({
      next: (detail) => this.ref.close(detail),
      error: (err) => {
        this.error.set(errorMessage(err));
        this.saving.set(false);
      },
    });
  }

  private validate(v: ReturnType<typeof this.form.getRawValue>): string | null {
    const f = this.fields;
    if (f.has('date') && !v.date && this.data.action !== 'START_RECRUITING') return 'Informe a data.';
    if (f.has('jobconvoCode') && !v.jobconvoCode.trim()) return 'Informe o código da vaga no JobConvo.';
    if (f.has('employee') && (!v.employeeName.trim() || !v.employeeRegistration.trim()))
      return 'Informe o nome e a matrícula do colaborador.';
    if (f.has('reason') && !v.reasonId) return 'Selecione o motivo da pausa.';
    if (f.has('cancelReason') && !v.cancelReason.trim()) return 'Informe o motivo do cancelamento.';
    if (f.has('correction') && !v.correction) return 'Selecione a data a corrigir.';
    if (ALWAYS_JUSTIFY.includes(this.data.action) && !v.justification.trim()) return 'Informe a justificativa.';
    if (this.justificationRequired() && !v.justification.trim())
      return 'A data é anterior a hoje: informe a justificativa (RN-24).';
    return null;
  }

  private request(v: ReturnType<typeof this.form.getRawValue>): [string, unknown] {
    const justification = v.justification.trim() || null;
    switch (this.data.action) {
      case 'DECIDE':
        return ['decision', { decision: v.decision, decisionAt: v.date, justification }];
      case 'START_RECRUITING':
        return ['recruiting', { jobconvoCode: v.jobconvoCode, jobconvoOpenedAt: v.date || null, justification }];
      case 'APPROVE_CANDIDATE':
        return ['candidate-approval', { date: v.date, justification }];
      case 'REGISTER_ADMISSION':
        return ['admission', { date: v.date, justification }];
      case 'CONFIRM_FIRST_DAY':
        return [
          'first-day',
          { date: v.date, employeeName: v.employeeName, employeeRegistration: v.employeeRegistration, justification },
        ];
      case 'CANDIDATE_WITHDREW':
        return ['candidate-withdrawal', { justification }];
      case 'ADMISSION_NO_SHOW':
        return ['admission-no-show', { justification }];
      case 'START_PAUSE':
        return ['pause', { reasonId: v.reasonId, startDate: v.date, justification }];
      case 'END_PAUSE':
        return ['pause/end', { date: v.date, justification }];
      case 'CANCEL':
        return ['cancellation', { date: v.date, reason: v.cancelReason }];
      case 'ADJUST_TERM':
        return [
          'term',
          {
            termType: v.termType,
            termEndDate: v.termType === 'FIXED_END' ? v.termEndDate || null : null,
            termDurationDays: v.termType === 'PRESERVED_DURATION' ? v.termDurationDays : null,
            justification,
          },
        ];
      case 'CORRECT_DATES': {
        const c = this.selectedCorrection();
        return ['date-corrections', { field: c?.pauseId ? c.value.split(':')[0] : c?.value, pauseId: c?.pauseId ?? null, date: v.date, justification }];
      }
      default:
        throw new Error(`Ação sem formulário: ${this.data.action}`);
    }
  }

  /** Datas já registradas que podem ser corrigidas (RN-25). */
  private correctionOptions(): CorrectionOption[] {
    const p = this.data.position;
    const t = p.termination;
    const options: (CorrectionOption | null)[] = [
      p.jobconvoOpenedAt ? { value: 'JOBCONVO_OPENED_AT', label: 'Abertura no JobConvo', current: p.jobconvoOpenedAt } : null,
      p.candidateApprovedAt ? { value: 'CANDIDATE_APPROVED_AT', label: 'Aprovação do candidato', current: p.candidateApprovedAt } : null,
      p.admissionAt ? { value: 'ADMISSION_AT', label: 'Admissão', current: p.admissionAt } : null,
      p.firstDayAt ? { value: 'FIRST_DAY_AT', label: '1º dia efetivo', current: p.firstDayAt } : null,
      p.closedAt && p.summary.status === 'CLOSED_CLIENT_CANCELLED' && t?.clientDecision !== 'NOT_REPLACE'
        ? { value: 'CLOSED_AT', label: 'Data do cancelamento', current: p.closedAt }
        : null,
      t?.clientDecisionAt ? { value: 'CLIENT_DECISION_AT', label: 'Decisão do cliente', current: t.clientDecisionAt } : null,
      t ? { value: 'LAST_WORKED_DAY', label: 'Último dia trabalhado (origem)', current: t.lastWorkedDay } : null,
      t ? { value: 'TERMINATION_REGISTERED_AT', label: 'Registro do desligamento', current: t.registeredAt } : null,
      ...p.pauses.flatMap((pause, i) => [
        { value: `PAUSE_START:${pause.id}`, label: `Início da pausa ${i + 1}`, current: pause.startDate, pauseId: pause.id },
        pause.endDate
          ? { value: `PAUSE_END:${pause.id}`, label: `Fim da pausa ${i + 1}`, current: pause.endDate, pauseId: pause.id }
          : null,
      ]),
    ];
    return options
      .filter((o): o is CorrectionOption => o !== null)
      .map((o) => ({ ...o, label: `${o.label} (atual: ${formatDate(o.current)})` }));
  }
}

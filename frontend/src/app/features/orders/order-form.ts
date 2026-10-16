import { Component, computed, inject, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { Router, RouterLink } from '@angular/router';
import { forkJoin } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { enumOptions, MODALITY, TERM_TYPE } from '../../core/labels';
import { Modality, TermType } from '../../core/models';
import { Notify } from '../../core/notify';
import { DateBrPipe, LabelPipe, todayIso } from '../../shared/format';

/** Novo pedido (RN-01 a RN-04) com prévia das N posições que serão criadas. */
@Component({
  selector: 'app-order-form',
  imports: [
    ReactiveFormsModule,
    RouterLink,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatProgressBarModule,
    DateBrPipe,
    LabelPipe,
  ],
  templateUrl: './order-form.html',
})
export class OrderForm {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(Auth);

  protected readonly termOptions = enumOptions(TERM_TYPE);
  protected readonly modalityLabels = MODALITY;
  protected readonly termLabels = TERM_TYPE;

  protected readonly form = inject(NonNullableFormBuilder).group({
    contractId: ['', Validators.required],
    modality: ['' as Modality | '', Validators.required],
    jobRoleId: ['', Validators.required],
    quantity: [1, [Validators.required, Validators.min(1), Validators.max(1000)]],
    workLocationId: ['', Validators.required],
    clientRequestDate: [todayIso(), Validators.required],
    desiredStartDate: [todayIso(), Validators.required],
    termType: ['INDEFINITE' as TermType, Validators.required],
    termEndDate: [''],
    termDurationDays: [null as number | null],
    notes: [''],
    registeredAt: [todayIso(), Validators.required],
    justification: [''],
  });

  private readonly values = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });

  protected readonly catalogs = rxResource({
    stream: () =>
      forkJoin({
        contracts: this.api.contracts({ onlyActive: true }),
        jobRoles: this.api.jobRoles(),
        workLocations: this.api.workLocations(),
      }),
  });

  protected readonly contract = computed(() =>
    this.catalogs.value()?.contracts.find((c) => c.id === this.values().contractId),
  );
  protected readonly activeJobRoles = computed(() => (this.catalogs.value()?.jobRoles ?? []).filter((j) => j.active));
  /** Locais ativos do cliente do contrato ou sem cliente vinculado. */
  protected readonly locations = computed(() => {
    const clientId = this.contract()?.clientId;
    return (this.catalogs.value()?.workLocations ?? []).filter((l) => l.active && (!l.clientId || l.clientId === clientId));
  });
  protected readonly preview = computed(() => {
    const quantity = Math.min(Math.max(Number(this.values().quantity) || 0, 0), 1000);
    return Array.from({ length: quantity }, (_, i) => i + 1);
  });
  protected readonly retroactive = computed(() => {
    const registeredAt = this.values().registeredAt;
    return !this.auth.user()?.initialLoadOpen && !!registeredAt && registeredAt < todayIso();
  });

  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  constructor() {
    // Seleciona automaticamente a modalidade quando o contrato só tem uma.
    this.form.controls.contractId.valueChanges.pipe(takeUntilDestroyed()).subscribe((contractId) => {
      const modalities = this.catalogs.value()?.contracts.find((c) => c.id === contractId)?.modalities ?? [];
      this.form.patchValue({ modality: modalities.length === 1 ? modalities[0] : '', workLocationId: '' });
    });
  }

  submit(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set('Preencha os campos obrigatórios.');
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.error.set(null);
    this.api
      .createOrder({
        ...v,
        termEndDate: v.termType === 'FIXED_END' ? v.termEndDate || null : null,
        termDurationDays: v.termType === 'PRESERVED_DURATION' ? v.termDurationDays : null,
        notes: v.notes || null,
        justification: v.justification || null,
      })
      .subscribe({
        next: (order) => {
          this.notify.success(`Pedido ${order.summary.number} criado com ${order.positions.length} posição(ões).`);
          void this.router.navigate(['/pedidos', order.summary.id]);
        },
        error: (err) => {
          this.error.set(errorMessage(err));
          this.saving.set(false);
        },
      });
  }
}

import { Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { forkJoin, Observable } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { enumOptions, RATE_STATUS } from '../../core/labels';
import { ContractRate, RateStatus } from '../../core/models';
import { Notify } from '../../core/notify';
import { ConfirmDialog, ConfirmDialogData } from '../../shared/confirm-dialog';
import { DateBrPipe, LabelPipe, MoneyPipe, todayIso } from '../../shared/format';

/** Valores por cargo (versionados). COMMERCIAL cadastra; CONTROLLERSHIP valida ou rejeita. */
@Component({
  selector: 'app-rates',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatCardModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatTooltipModule,
    MatProgressBarModule,
    DateBrPipe,
    MoneyPipe,
    LabelPipe,
  ],
  templateUrl: './rates.html',
})
export class RatesPage {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  protected readonly auth = inject(Auth);

  protected readonly statusLabels = RATE_STATUS;
  protected readonly statusOptions = enumOptions(RATE_STATUS);
  protected readonly columns = ['contract', 'role', 'monthly', 'daily', 'fee', 'validFrom', 'status', 'actions'];

  protected readonly contractId = signal<string | null>(null);
  protected readonly status = signal<RateStatus | null>(this.auth.hasRole('CONTROLLERSHIP') ? 'PENDING' : null);
  protected readonly editing = signal<ContractRate | null>(null);
  protected readonly saving = signal(false);

  protected readonly catalogs = rxResource({
    stream: () => forkJoin({ contracts: this.api.contracts(), jobRoles: this.api.jobRoles() }),
  });
  protected readonly rates = rxResource({
    params: () => ({ contractId: this.contractId(), status: this.status() }),
    stream: ({ params }) => this.api.rates(params),
  });

  protected readonly canRegister = computed(() => this.auth.hasRole('COMMERCIAL'));
  protected readonly canValidate = computed(() => this.auth.hasRole('CONTROLLERSHIP'));

  protected readonly form = inject(NonNullableFormBuilder).group({
    contractId: ['', Validators.required],
    jobRoleId: ['', Validators.required],
    monthlyValue: [null as number | null],
    feeValue: [null as number | null],
    validFrom: [todayIso(), Validators.required],
  });

  edit(rate: ContractRate | null): void {
    this.editing.set(rate);
    this.form.reset({
      contractId: rate?.contractId ?? '',
      jobRoleId: rate?.jobRoleId ?? '',
      monthlyValue: rate?.monthlyValue ?? null,
      feeValue: rate?.feeValue ?? null,
      validFrom: rate?.validFrom ?? todayIso(),
    });
    if (rate) {
      this.form.controls.contractId.disable();
      this.form.controls.jobRoleId.disable();
    } else {
      this.form.controls.contractId.enable();
      this.form.controls.jobRoleId.enable();
    }
  }

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    const rate = this.editing();
    this.run(this.api.saveRate(rate?.id ?? null, this.form.getRawValue()), 'Valor enviado para validação da Controladoria.', () =>
      this.edit(null),
    );
  }

  validate(rate: ContractRate): void {
    this.confirm({
      title: 'Validar valor',
      message: `Validar ${rate.jobRoleName} em ${rate.contractName}: ${this.money(rate.monthlyValue)} a partir de ${rate.validFrom.split('-').reverse().join('/')}?`,
      confirmText: 'Validar',
    }).subscribe((ok) => ok && this.run(this.api.validateRate(rate.id), 'Valor validado.'));
  }

  reject(rate: ContractRate): void {
    this.confirm({
      title: 'Rejeitar valor',
      message: `Rejeitar o valor de ${rate.jobRoleName} em ${rate.contractName}? O autor será notificado.`,
      confirmText: 'Rejeitar',
      textLabel: 'Motivo da rejeição',
    }).subscribe((reason) => typeof reason === 'string' && this.run(this.api.rejectRate(rate.id, reason), 'Valor rejeitado.'));
  }

  private money(value: number | null): string {
    return value === null ? '—' : value.toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  }

  private confirm(data: ConfirmDialogData): Observable<string | true | undefined> {
    return this.dialog.open<ConfirmDialog, ConfirmDialogData, string | true>(ConfirmDialog, { width: '480px', data }).afterClosed();
  }

  private run(request: Observable<unknown>, message: string, done?: () => void): void {
    this.saving.set(true);
    request.subscribe({
      next: () => {
        this.saving.set(false);
        this.notify.success(message);
        this.rates.reload();
        done?.();
      },
      error: (err) => {
        this.saving.set(false);
        this.notify.error(err);
      },
    });
  }
}

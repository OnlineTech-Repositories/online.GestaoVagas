import { Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { forkJoin } from 'rxjs';
import { Api } from '../../core/api';
import { errorMessage } from '../../core/http';
import { enumOptions, MODALITY } from '../../core/labels';
import { Client, Contract, ContractStatus, Modality } from '../../core/models';
import { formatCnpj, todayIso } from '../../shared/format';

@Component({
  selector: 'app-client-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Editar cliente' : 'Novo cliente' }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="form-grid dialog-form">
        <mat-form-field>
          <mat-label>Razão social</mat-label>
          <input matInput formControlName="legalName" maxlength="200" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>CNPJ</mat-label>
          <input matInput formControlName="cnpj" maxlength="18" placeholder="00.000.000/0000-00" />
        </mat-form-field>
        <mat-checkbox formControlName="active">Ativo</mat-checkbox>
        @if (error()) {
          <p class="error-text" role="alert">{{ error() }}</p>
        }
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancelar</button>
      <button mat-flat-button (click)="save()" [disabled]="saving()">Salvar</button>
    </mat-dialog-actions>
  `,
})
export class ClientDialog {
  protected readonly data = inject<Client | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ClientDialog, boolean>);
  private readonly api = inject(Api);

  protected readonly form = inject(NonNullableFormBuilder).group({
    legalName: [this.data?.legalName ?? '', Validators.required],
    cnpj: [formatCnpj(this.data?.cnpj), Validators.required],
    active: [this.data?.active ?? true],
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  save(): void {
    if (this.form.invalid) {
      this.error.set('Preencha a razão social e o CNPJ.');
      return;
    }
    this.saving.set(true);
    this.api.saveClient(this.data?.id ?? null, this.form.getRawValue()).subscribe({
      next: () => this.ref.close(true),
      error: (err) => {
        this.error.set(errorMessage(err));
        this.saving.set(false);
      },
    });
  }
}

export interface ContractDialogData {
  contract: Contract | null;
  clients: Client[];
}

@Component({
  selector: 'app-contract-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule],
  template: `
    <h2 mat-dialog-title>{{ data.contract ? 'Editar contrato' : 'Novo contrato' }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="form-grid dialog-form">
        <mat-form-field>
          <mat-label>Cliente</mat-label>
          <mat-select formControlName="clientId">
            @for (c of data.clients; track c.id) {
              <mat-option [value]="c.id">{{ c.legalName }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <mat-form-field>
          <mat-label>Identificador do contrato</mat-label>
          <input matInput formControlName="name" maxlength="150" />
        </mat-form-field>
        <div class="row">
          <mat-form-field>
            <mat-label>CNPJ do Grupo responsável</mat-label>
            <mat-select formControlName="groupEntityId">
              @for (g of options.value()?.groups ?? []; track g.id) {
                @if (g.active || g.id === form.controls.groupEntityId.value) {
                  <mat-option [value]="g.id">{{ g.name }}</mat-option>
                }
              }
            </mat-select>
          </mat-form-field>
          <mat-form-field>
            <mat-label>Responsável comercial</mat-label>
            <mat-select formControlName="commercialOwnerId">
              @for (u of options.value()?.owners ?? []; track u.id) {
                <mat-option [value]="u.id">{{ u.name }}</mat-option>
              }
            </mat-select>
          </mat-form-field>
        </div>
        <mat-form-field>
          <mat-label>Modalidades</mat-label>
          <mat-select formControlName="modalities" multiple>
            @for (m of modalityOptions; track m.value) {
              <mat-option [value]="m.value">{{ m.label }}</mat-option>
            }
          </mat-select>
        </mat-form-field>
        <div class="row">
          <mat-form-field>
            <mat-label>Início</mat-label>
            <input matInput type="date" formControlName="startDate" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Fim (opcional)</mat-label>
            <input matInput type="date" formControlName="endDate" />
          </mat-form-field>
        </div>
        <div class="row">
          <mat-form-field>
            <mat-label>Meta SLA vaga nova (dias)</mat-label>
            <input matInput type="number" min="1" formControlName="slaNewDays" />
          </mat-form-field>
          <mat-form-field>
            <mat-label>Meta SLA reposição (dias)</mat-label>
            <input matInput type="number" min="1" formControlName="slaReplacementDays" />
          </mat-form-field>
        </div>
        <mat-form-field>
          <mat-label>Status</mat-label>
          <mat-select formControlName="status">
            <mat-option value="ACTIVE">Ativo</mat-option>
            <mat-option value="CLOSED">Encerrado</mat-option>
          </mat-select>
        </mat-form-field>
        @if (error()) {
          <p class="error-text" role="alert">{{ error() }}</p>
        }
      </form>
    </mat-dialog-content>
    <mat-dialog-actions align="end">
      <button mat-button mat-dialog-close>Cancelar</button>
      <button mat-flat-button (click)="save()" [disabled]="saving()">Salvar</button>
    </mat-dialog-actions>
  `,
})
export class ContractDialog {
  protected readonly data = inject<ContractDialogData>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<ContractDialog, boolean>);
  private readonly api = inject(Api);

  protected readonly modalityOptions = enumOptions(MODALITY);
  protected readonly options = rxResource({
    stream: () => forkJoin({ groups: this.api.groupEntities(), owners: this.api.usersByRole('COMMERCIAL') }),
  });

  private readonly c = this.data.contract;
  protected readonly form = inject(NonNullableFormBuilder).group({
    clientId: [this.c?.clientId ?? '', Validators.required],
    name: [this.c?.name ?? '', Validators.required],
    groupEntityId: [this.c?.groupEntityId ?? '', Validators.required],
    commercialOwnerId: [this.c?.commercialOwnerId ?? '', Validators.required],
    modalities: [this.c?.modalities ?? ([] as Modality[]), Validators.required],
    startDate: [this.c?.startDate ?? todayIso(), Validators.required],
    endDate: [this.c?.endDate ?? ''],
    slaNewDays: [this.c?.slaNewDays ?? (null as number | null)],
    slaReplacementDays: [this.c?.slaReplacementDays ?? (null as number | null)],
    status: [this.c?.status ?? ('ACTIVE' as ContractStatus)],
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  save(): void {
    if (this.form.invalid) {
      this.error.set('Preencha os campos obrigatórios.');
      return;
    }
    const v = this.form.getRawValue();
    this.saving.set(true);
    this.api
      .saveContract(this.c?.id ?? null, {
        ...v,
        endDate: v.endDate || null,
        slaNewDays: v.slaNewDays || null,
        slaReplacementDays: v.slaReplacementDays || null,
      })
      .subscribe({
        next: () => this.ref.close(true),
        error: (err) => {
          this.error.set(errorMessage(err));
          this.saving.set(false);
        },
      });
  }
}

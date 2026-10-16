import { Component, inject, signal } from '@angular/core';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MAT_DIALOG_DATA, MatDialogModule, MatDialogRef } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { Api } from '../../core/api';
import { errorMessage } from '../../core/http';
import { enumOptions, ROLE } from '../../core/labels';
import { Role, User } from '../../core/models';
import { Notify } from '../../core/notify';
import { passwordPolicy } from '../auth/change-password';

@Component({
  selector: 'app-user-dialog',
  imports: [ReactiveFormsModule, MatDialogModule, MatButtonModule, MatFormFieldModule, MatInputModule, MatSelectModule, MatCheckboxModule],
  template: `
    <h2 mat-dialog-title>{{ data ? 'Editar usuário' : 'Novo usuário' }}</h2>
    <mat-dialog-content>
      <form [formGroup]="form" class="form-grid dialog-form">
        <mat-form-field>
          <mat-label>Nome</mat-label>
          <input matInput formControlName="name" maxlength="150" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>E-mail</mat-label>
          <input matInput type="email" formControlName="email" />
        </mat-form-field>
        <mat-form-field>
          <mat-label>Perfis</mat-label>
          <mat-select formControlName="roles" multiple>
            @for (r of roleOptions; track r.value) {
              <mat-option [value]="r.value">{{ r.label }}</mat-option>
            }
          </mat-select>
          <mat-hint>Quem cadastra valores (Comercial) não os valida: somente a Controladoria valida.</mat-hint>
        </mat-form-field>
        @if (!data) {
          <mat-form-field>
            <mat-label>Senha provisória</mat-label>
            <input matInput type="text" formControlName="password" autocomplete="new-password" />
            <mat-hint>O usuário deverá trocá-la no primeiro acesso.</mat-hint>
          </mat-form-field>
        } @else {
          <mat-checkbox formControlName="active">Ativo</mat-checkbox>
          <div class="row">
            <mat-form-field>
              <mat-label>Nova senha provisória</mat-label>
              <input matInput type="text" formControlName="password" autocomplete="new-password" />
            </mat-form-field>
            <button mat-stroked-button type="button" (click)="resetPassword()" [disabled]="saving()">Redefinir senha</button>
          </div>
        }
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
export class UserDialog {
  protected readonly data = inject<User | null>(MAT_DIALOG_DATA);
  private readonly ref = inject(MatDialogRef<UserDialog, boolean>);
  private readonly api = inject(Api);
  private readonly notify = inject(Notify);

  protected readonly roleOptions = enumOptions(ROLE);
  protected readonly form = inject(NonNullableFormBuilder).group({
    name: [this.data?.name ?? '', Validators.required],
    email: [this.data?.email ?? '', [Validators.required, Validators.email]],
    roles: [this.data?.roles ?? ([] as Role[]), Validators.required],
    active: [this.data?.active ?? true],
    password: ['', this.data ? [] : [Validators.required, passwordPolicy]],
  });
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  save(): void {
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      this.error.set(
        this.form.controls.password.hasError('policy')
          ? 'A senha deve ter 8+ caracteres, com maiúscula, número e caractere especial.'
          : 'Preencha os campos obrigatórios.',
      );
      return;
    }
    const v = this.form.getRawValue();
    const body = this.data
      ? { name: v.name, email: v.email, roles: v.roles, active: v.active }
      : { name: v.name, email: v.email, roles: v.roles, temporaryPassword: v.password };
    this.saving.set(true);
    this.api.saveUser(this.data?.id ?? null, body).subscribe({
      next: () => this.ref.close(true),
      error: (err) => {
        this.error.set(errorMessage(err));
        this.saving.set(false);
      },
    });
  }

  resetPassword(): void {
    const password = this.form.controls.password.value;
    if (passwordPolicy(this.form.controls.password)) {
      this.error.set('A senha deve ter 8+ caracteres, com maiúscula, número e caractere especial.');
      return;
    }
    this.saving.set(true);
    this.api.resetPassword(this.data!.id, password).subscribe({
      next: () => {
        this.saving.set(false);
        this.error.set(null);
        this.form.controls.password.reset();
        this.notify.success('Senha redefinida. O usuário deverá trocá-la no próximo acesso.');
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.saving.set(false);
      },
    });
  }
}

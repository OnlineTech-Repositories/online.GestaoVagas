import { Component, inject, signal } from '@angular/core';
import { AbstractControl, NonNullableFormBuilder, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatInputModule } from '@angular/material/input';
import { Router } from '@angular/router';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { Notify } from '../../core/notify';

/** Política da seção 12: mínimo de 8 caracteres, maiúscula, número e caractere especial. */
export function passwordPolicy(control: AbstractControl<string>): ValidationErrors | null {
  const v = control.value ?? '';
  const ok = v.length >= 8 && /[A-Z]/.test(v) && /\d/.test(v) && /[^A-Za-z0-9]/.test(v);
  return ok ? null : { policy: true };
}

@Component({
  selector: 'app-change-password',
  imports: [ReactiveFormsModule, MatCardModule, MatFormFieldModule, MatInputModule, MatButtonModule],
  template: `
    <div class="auth-page">
      <mat-card class="auth-card">
        <mat-card-header>
          <mat-card-title>Trocar senha</mat-card-title>
          @if (auth.user()?.mustChangePassword) {
            <mat-card-subtitle>Sua senha é provisória. Defina uma nova senha para continuar.</mat-card-subtitle>
          }
        </mat-card-header>
        <mat-card-content>
          <form [formGroup]="form" (ngSubmit)="submit()" class="form-grid">
            <mat-form-field>
              <mat-label>Senha atual</mat-label>
              <input matInput type="password" formControlName="currentPassword" autocomplete="current-password" />
            </mat-form-field>
            <mat-form-field>
              <mat-label>Nova senha</mat-label>
              <input matInput type="password" formControlName="newPassword" autocomplete="new-password" />
              <mat-hint>Mínimo de 8 caracteres, com letra maiúscula, número e caractere especial.</mat-hint>
              @if (form.controls.newPassword.hasError('policy') && form.controls.newPassword.touched) {
                <mat-error>A senha não atende à política.</mat-error>
              }
            </mat-form-field>
            <mat-form-field>
              <mat-label>Confirme a nova senha</mat-label>
              <input matInput type="password" formControlName="confirm" autocomplete="new-password" />
            </mat-form-field>
            @if (error()) {
              <p class="error-text" role="alert">{{ error() }}</p>
            }
            <div class="actions">
              <button mat-button type="button" (click)="cancel()">
                {{ auth.user()?.mustChangePassword ? 'Sair' : 'Voltar' }}
              </button>
              <button mat-flat-button type="submit" [disabled]="loading()">Salvar</button>
            </div>
          </form>
        </mat-card-content>
      </mat-card>
    </div>
  `,
})
export class ChangePassword {
  protected readonly auth = inject(Auth);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);

  protected readonly form = inject(NonNullableFormBuilder).group({
    currentPassword: ['', Validators.required],
    newPassword: ['', [Validators.required, passwordPolicy]],
    confirm: ['', Validators.required],
  });
  protected readonly loading = signal(false);
  protected readonly error = signal<string | null>(null);

  submit(): void {
    const { currentPassword, newPassword, confirm } = this.form.getRawValue();
    if (this.form.invalid) {
      this.form.markAllAsTouched();
      return;
    }
    if (newPassword !== confirm) {
      this.error.set('A confirmação não confere com a nova senha.');
      return;
    }
    this.loading.set(true);
    this.error.set(null);
    this.auth.changePassword(currentPassword, newPassword).subscribe({
      next: () => {
        this.notify.success('Senha alterada.');
        void this.router.navigate(['/']);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.loading.set(false);
      },
    });
  }

  cancel(): void {
    if (this.auth.user()?.mustChangePassword) this.auth.logout();
    else void this.router.navigate(['/']);
  }
}

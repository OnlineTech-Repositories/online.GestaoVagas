import { inject, Injectable } from '@angular/core';
import { MatSnackBar } from '@angular/material/snack-bar';
import { errorMessage } from './http';

@Injectable({ providedIn: 'root' })
export class Notify {
  private readonly snackBar = inject(MatSnackBar);

  success(message: string): void {
    this.snackBar.open(message, 'OK', { duration: 4000, panelClass: 'snack-success' });
  }

  error(error: unknown): void {
    this.snackBar.open(typeof error === 'string' ? error : errorMessage(error), 'Fechar', {
      duration: 8000,
      panelClass: 'snack-error',
    });
  }
}

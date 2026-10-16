import { HttpClient } from '@angular/common/http';
import { computed, inject, Injectable, signal } from '@angular/core';
import { Router } from '@angular/router';
import { catchError, firstValueFrom, of, tap } from 'rxjs';
import { Me, Role } from './models';

/** Sessão do usuário (cookie HttpOnly no servidor; aqui só o estado de exibição). */
@Injectable({ providedIn: 'root' })
export class Auth {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private readonly current = signal<Me | null>(null);
  private loaded = false;

  readonly user = this.current.asReadonly();
  readonly isAuthenticated = computed(() => this.current() !== null);

  /** Carrega a sessão existente uma vez (chamado pelos guards). */
  async ensureLoaded(): Promise<Me | null> {
    if (!this.loaded) {
      const me = await firstValueFrom(this.http.get<Me>('/api/auth/me').pipe(catchError(() => of(null))));
      this.current.set(me);
      this.loaded = true;
    }
    return this.current();
  }

  login(email: string, password: string) {
    return this.http.post<Me>('/api/auth/login', { email, password }).pipe(tap((me) => this.setUser(me)));
  }

  changePassword(currentPassword: string, newPassword: string) {
    return this.http
      .post<Me>('/api/auth/change-password', { currentPassword, newPassword })
      .pipe(tap((me) => this.setUser(me)));
  }

  refresh() {
    return this.http.get<Me>('/api/auth/me').pipe(tap((me) => this.setUser(me)));
  }

  logout(): void {
    this.http
      .post('/api/auth/logout', {})
      .pipe(catchError(() => of(null)))
      .subscribe(() => this.clear());
  }

  /** Sessão expirada ou encerrada: limpa o estado e volta ao login. */
  clear(): void {
    this.current.set(null);
    this.loaded = true;
    void this.router.navigate(['/login']);
  }

  hasRole(...roles: Role[]): boolean {
    const me = this.current();
    return !!me && roles.some((r) => me.roles.includes(r));
  }

  private setUser(me: Me): void {
    this.current.set(me);
    this.loaded = true;
  }
}

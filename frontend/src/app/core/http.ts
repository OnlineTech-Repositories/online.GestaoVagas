import { HttpErrorResponse, HttpInterceptorFn } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, throwError } from 'rxjs';
import { Auth } from './auth';
import { ProblemDetails } from './models';

/** Sessão expirada (401) em qualquer chamada, exceto o próprio login/me, leva de volta ao login. */
export const sessionInterceptor: HttpInterceptorFn = (req, next) => {
  const auth = inject(Auth);
  return next(req).pipe(
    catchError((error: unknown) => {
      if (
        error instanceof HttpErrorResponse &&
        error.status === 401 &&
        !req.url.endsWith('/api/auth/login') &&
        !req.url.endsWith('/api/auth/me')
      ) {
        auth.clear();
      }
      return throwError(() => error);
    }),
  );
};

/** Extrai a mensagem amigável (ProblemDetails) de um erro HTTP. */
export function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const problem = error.error as ProblemDetails | null;
    if (problem?.errors) {
      const first = Object.values(problem.errors).flat()[0];
      if (first) return first;
    }
    if (problem?.detail) return problem.detail;
    if (error.status === 0) return 'Não foi possível conectar ao servidor.';
    if (error.status === 403) return 'Você não tem permissão para executar esta ação.';
    if (error.status === 429) return 'Muitas tentativas. Aguarde um minuto e tente novamente.';
  }
  return 'Ocorreu um erro inesperado.';
}

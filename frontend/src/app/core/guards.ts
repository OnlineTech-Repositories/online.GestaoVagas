import { inject } from '@angular/core';
import { CanActivateFn, Router } from '@angular/router';
import { Auth } from './auth';
import { Role } from './models';

/** Exige sessão ativa; com senha provisória, força a troca de senha. */
export const authGuard: CanActivateFn = async () => {
  const auth = inject(Auth);
  const router = inject(Router);
  const me = await auth.ensureLoaded();
  if (!me) return router.parseUrl('/login');
  if (me.mustChangePassword) return router.parseUrl('/trocar-senha');
  return true;
};

export const sessionGuard: CanActivateFn = async () => {
  const me = await inject(Auth).ensureLoaded();
  return me ? true : inject(Router).parseUrl('/login');
};

export const anonymousGuard: CanActivateFn = async () => {
  const me = await inject(Auth).ensureLoaded();
  return me ? inject(Router).parseUrl('/') : true;
};

/** Restringe a rota a perfis (a autorização definitiva é sempre feita no backend). */
export function roleGuard(...roles: Role[]): CanActivateFn {
  return () => (inject(Auth).hasRole(...roles) ? true : inject(Router).parseUrl('/'));
}

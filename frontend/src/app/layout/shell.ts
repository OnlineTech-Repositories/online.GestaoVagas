import { BreakpointObserver } from '@angular/cdk/layout';
import { Component, computed, DestroyRef, inject, OnInit, signal } from '@angular/core';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { MatBadgeModule } from '@angular/material/badge';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { MatMenuModule } from '@angular/material/menu';
import { MatSidenavModule } from '@angular/material/sidenav';
import { MatToolbarModule } from '@angular/material/toolbar';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import { filter, map, startWith, switchMap, timer } from 'rxjs';
import { Api } from '../core/api';
import { Auth } from '../core/auth';
import { ROLE } from '../core/labels';
import { Role } from '../core/models';

interface NavItem {
  path: string;
  label: string;
  icon: string;
  roles?: Role[];
  exact?: boolean;
}

const NAV: NavItem[] = [
  { path: '/', label: 'Painel', icon: 'dashboard', exact: true },
  { path: '/posicoes', label: 'Posições', icon: 'work' },
  { path: '/pedidos', label: 'Pedidos', icon: 'assignment' },
  { path: '/pedidos/novo', label: 'Novo pedido', icon: 'add_circle', roles: ['COMMERCIAL', 'NACC'] },
  { path: '/desligamentos/novo', label: 'Registrar desligamento', icon: 'person_remove', roles: ['DP', 'NACC'] },
  { path: '/clientes', label: 'Clientes e contratos', icon: 'business', roles: ['COMMERCIAL', 'ADMIN'] },
  { path: '/valores', label: 'Valores por cargo', icon: 'payments', roles: ['COMMERCIAL', 'CONTROLLERSHIP', 'ADMIN'] },
  { path: '/admin', label: 'Administração', icon: 'settings', roles: ['ADMIN'] },
];

@Component({
  selector: 'app-shell',
  imports: [
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    MatSidenavModule,
    MatToolbarModule,
    MatListModule,
    MatIconModule,
    MatButtonModule,
    MatBadgeModule,
    MatMenuModule,
  ],
  templateUrl: './shell.html',
  styleUrl: './shell.scss',
})
export class Shell implements OnInit {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly destroyRef = inject(DestroyRef);
  protected readonly auth = inject(Auth);

  protected readonly isMobile = toSignal(
    inject(BreakpointObserver)
      .observe('(max-width: 960px)')
      .pipe(map((r) => r.matches)),
    { initialValue: false },
  );
  protected readonly menuOpen = signal(false);
  protected readonly unread = signal(0);

  protected readonly nav = computed(() => NAV.filter((item) => !item.roles || this.auth.hasRole(...item.roles)));
  protected readonly roles = computed(() => (this.auth.user()?.roles ?? []).map((r) => ROLE[r]).join(', '));

  ngOnInit(): void {
    // Atualiza o contador de notificações a cada minuto e a cada navegação.
    const navigation$ = this.router.events.pipe(filter((e) => e instanceof NavigationEnd), startWith(null));
    navigation$
      .pipe(
        switchMap(() => timer(0, 60_000)),
        switchMap(() => this.api.unreadCount()),
        takeUntilDestroyed(this.destroyRef),
      )
      .subscribe({ next: (count) => this.unread.set(count), error: () => undefined });

    this.router.events
      .pipe(filter((e) => e instanceof NavigationEnd), takeUntilDestroyed(this.destroyRef))
      .subscribe(() => this.menuOpen.set(false));
  }
}

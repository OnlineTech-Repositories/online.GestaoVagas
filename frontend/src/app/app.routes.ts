import { Routes } from '@angular/router';
import { anonymousGuard, authGuard, roleGuard, sessionGuard } from './core/guards';

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [anonymousGuard],
    title: 'Entrar — Controle de Vagas',
    loadComponent: () => import('./features/auth/login').then((m) => m.Login),
  },
  {
    path: 'trocar-senha',
    canActivate: [sessionGuard],
    title: 'Trocar senha — Controle de Vagas',
    loadComponent: () => import('./features/auth/change-password').then((m) => m.ChangePassword),
  },
  {
    path: '',
    canActivate: [authGuard],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      {
        path: '',
        title: 'Painel — Controle de Vagas',
        loadComponent: () => import('./features/dashboard/dashboard').then((m) => m.DashboardPage),
      },
      {
        path: 'posicoes',
        title: 'Posições — Controle de Vagas',
        loadComponent: () => import('./features/positions/position-list').then((m) => m.PositionList),
      },
      {
        path: 'posicoes/:id',
        title: 'Posição — Controle de Vagas',
        loadComponent: () => import('./features/positions/position-detail').then((m) => m.PositionDetailPage),
      },
      {
        path: 'pedidos',
        title: 'Pedidos — Controle de Vagas',
        loadComponent: () => import('./features/orders/order-list').then((m) => m.OrderList),
      },
      {
        path: 'pedidos/novo',
        title: 'Novo pedido — Controle de Vagas',
        canActivate: [roleGuard('COMMERCIAL', 'NACC')],
        loadComponent: () => import('./features/orders/order-form').then((m) => m.OrderForm),
      },
      {
        path: 'pedidos/:id',
        title: 'Pedido — Controle de Vagas',
        loadComponent: () => import('./features/orders/order-detail').then((m) => m.OrderDetailPage),
      },
      {
        path: 'desligamentos/novo',
        title: 'Registrar desligamento — Controle de Vagas',
        canActivate: [roleGuard('DP', 'NACC')],
        loadComponent: () => import('./features/terminations/termination-form').then((m) => m.TerminationForm),
      },
      {
        path: 'clientes',
        title: 'Clientes e contratos — Controle de Vagas',
        canActivate: [roleGuard('COMMERCIAL', 'ADMIN')],
        loadComponent: () => import('./features/clients/clients').then((m) => m.ClientsPage),
      },
      {
        path: 'valores',
        title: 'Valores por cargo — Controle de Vagas',
        canActivate: [roleGuard('COMMERCIAL', 'CONTROLLERSHIP', 'ADMIN')],
        loadComponent: () => import('./features/rates/rates').then((m) => m.RatesPage),
      },
      {
        path: 'notificacoes',
        title: 'Notificações — Controle de Vagas',
        loadComponent: () => import('./features/notifications/notifications').then((m) => m.NotificationsPage),
      },
      {
        path: 'admin',
        title: 'Administração — Controle de Vagas',
        canActivate: [roleGuard('ADMIN')],
        loadComponent: () => import('./features/admin/admin').then((m) => m.AdminPage),
      },
    ],
  },
  { path: '**', redirectTo: '' },
];

import { DatePipe } from '@angular/common';
import { Component, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatIconModule } from '@angular/material/icon';
import { MatListModule } from '@angular/material/list';
import { Router } from '@angular/router';
import { Api } from '../../core/api';
import { AppNotification } from '../../core/models';
import { Notify } from '../../core/notify';

const ORDER_TYPES = ['ORDER_CREATED'];
const RATE_TYPES = ['RATE_PENDING', 'RATE_REJECTED'];

@Component({
  selector: 'app-notifications',
  imports: [MatListModule, MatButtonModule, MatIconModule, DatePipe],
  template: `
    <div class="page-header">
      <h1>Notificações</h1>
      <button mat-stroked-button (click)="markAll()"><mat-icon>done_all</mat-icon> Marcar todas como lidas</button>
    </div>
    <mat-list>
      @for (n of items.value() ?? []; track n.id) {
        <mat-list-item class="notification" [class.unread]="!n.readAt" (click)="open(n)">
          <mat-icon matListItemIcon>{{ n.readAt ? 'notifications_none' : 'notifications_active' }}</mat-icon>
          <span matListItemTitle class="wrap">{{ n.message }}</span>
          <span matListItemLine>{{ n.createdAt | date: 'dd/MM/yyyy HH:mm' }}</span>
        </mat-list-item>
      } @empty {
        <p class="muted">Nenhuma notificação.</p>
      }
    </mat-list>
  `,
})
export class NotificationsPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly notify = inject(Notify);

  protected readonly items = rxResource({ stream: () => this.api.notifications() });

  open(n: AppNotification): void {
    if (!n.readAt) this.api.markRead(n.id).subscribe();
    if (!n.entityId) return;
    if (ORDER_TYPES.includes(n.type)) void this.router.navigate(['/pedidos', n.entityId]);
    else if (RATE_TYPES.includes(n.type)) void this.router.navigate(['/valores']);
    else void this.router.navigate(['/posicoes', n.entityId]);
  }

  markAll(): void {
    this.api.markAllRead().subscribe({ next: () => this.items.reload(), error: (e) => this.notify.error(e) });
  }
}

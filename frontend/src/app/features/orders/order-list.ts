import { Component, computed, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { enumOptions, MODALITY_SHORT, ORDER_STATUS } from '../../core/labels';
import { OrderStatus } from '../../core/models';
import { DateBrPipe, LabelPipe } from '../../shared/format';

@Component({
  selector: 'app-order-list',
  imports: [
    FormsModule,
    RouterLink,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatSelectModule,
    MatProgressBarModule,
    DateBrPipe,
    LabelPipe,
  ],
  template: `
    <div class="page-header">
      <h1>Pedidos</h1>
      @if (auth.hasRole('COMMERCIAL', 'NACC')) {
        <a mat-flat-button routerLink="/pedidos/novo"><mat-icon>add</mat-icon> Novo pedido</a>
      }
    </div>

    <div class="filters">
      <mat-form-field>
        <mat-label>Cliente</mat-label>
        <mat-select [ngModel]="clientId()" (ngModelChange)="clientId.set($event)">
          <mat-option [value]="null">Todos</mat-option>
          @for (c of clients.value() ?? []; track c.id) {
            <mat-option [value]="c.id">{{ c.legalName }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
      <mat-form-field>
        <mat-label>Status</mat-label>
        <mat-select [ngModel]="status()" (ngModelChange)="status.set($event)">
          <mat-option [value]="null">Todos</mat-option>
          @for (o of statusOptions; track o.value) {
            <mat-option [value]="o.value">{{ o.label }}</mat-option>
          }
        </mat-select>
      </mat-form-field>
    </div>

    @if (orders.isLoading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    @if (error()) {
      <p class="error-text">{{ error() }}</p>
    }

    <div class="table-wrap">
      <table mat-table [dataSource]="orders.value() ?? []">
        <ng-container matColumnDef="number">
          <th mat-header-cell *matHeaderCellDef>Pedido</th>
          <td mat-cell *matCellDef="let o"><a class="link" [routerLink]="['/pedidos', o.id]">{{ o.number }}</a></td>
        </ng-container>
        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Cliente / contrato</th>
          <td mat-cell *matCellDef="let o">
            <div>{{ o.clientName }}</div>
            <small class="muted">{{ o.contractName }}</small>
          </td>
        </ng-container>
        <ng-container matColumnDef="role">
          <th mat-header-cell *matHeaderCellDef>Cargo</th>
          <td mat-cell *matCellDef="let o">
            <div>{{ o.jobRoleName }}</div>
            <small class="muted">{{ o.modality | label: modality }} · {{ o.workLocationName }}</small>
          </td>
        </ng-container>
        <ng-container matColumnDef="quantity">
          <th mat-header-cell *matHeaderCellDef class="num">Qtd.</th>
          <td mat-cell *matCellDef="let o" class="num">{{ o.quantity }}</td>
        </ng-container>
        <ng-container matColumnDef="progress">
          <th mat-header-cell *matHeaderCellDef class="num">Preenchidas / abertas</th>
          <td mat-cell *matCellDef="let o" class="num">{{ o.filledPositions }} / {{ o.openPositions }}</td>
        </ng-container>
        <ng-container matColumnDef="dates">
          <th mat-header-cell *matHeaderCellDef>Solicitação / início</th>
          <td mat-cell *matCellDef="let o">{{ o.clientRequestDate | dateBr }} → {{ o.desiredStartDate | dateBr }}</td>
        </ng-container>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let o">{{ o.status | label: orderStatus }}</td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns"></tr>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell empty" [attr.colspan]="columns.length">Nenhum pedido encontrado.</td>
        </tr>
      </table>
    </div>
  `,
})
export class OrderList {
  private readonly api = inject(Api);
  protected readonly auth = inject(Auth);

  protected readonly modality = MODALITY_SHORT;
  protected readonly orderStatus = ORDER_STATUS;
  protected readonly statusOptions = enumOptions(ORDER_STATUS);
  protected readonly columns = ['number', 'client', 'role', 'quantity', 'progress', 'dates', 'status'];

  protected readonly clientId = signal<string | null>(null);
  protected readonly status = signal<OrderStatus | null>(null);

  protected readonly clients = rxResource({ stream: () => this.api.clients() });
  protected readonly orders = rxResource({
    params: () => ({ clientId: this.clientId(), status: this.status() }),
    stream: ({ params }) => this.api.orders(params),
  });
  protected readonly error = computed(() => (this.orders.error() ? errorMessage(this.orders.error()) : null));
}

import { Component, input } from '@angular/core';
import { MatIconModule } from '@angular/material/icon';
import { MatTableModule } from '@angular/material/table';
import { MatTooltipModule } from '@angular/material/tooltip';
import { RouterLink } from '@angular/router';
import { DEMAND_TYPE, MONEY_STATUS } from '../core/labels';
import { PositionSummary } from '../core/models';
import { SlaChip, StatusChip } from './chips';
import { DateBrPipe, LabelPipe, MoneyPipe } from './format';

/** Tabela de posições reutilizada no painel, na lista e no detalhe do pedido. */
@Component({
  selector: 'app-position-table',
  imports: [MatTableModule, MatIconModule, MatTooltipModule, RouterLink, StatusChip, SlaChip, DateBrPipe, MoneyPipe, LabelPipe],
  template: `
    <div class="table-wrap">
      <table mat-table [dataSource]="rows()" class="position-table">
        <ng-container matColumnDef="position">
          <th mat-header-cell *matHeaderCellDef>Pedido / posição</th>
          <td mat-cell *matCellDef="let p">
            <a [routerLink]="['/posicoes', p.id]" class="link">{{ p.orderNumber }}-{{ p.sequence }}</a>
            @if (p.hasRetroactiveDates) {
              <mat-icon class="inline-icon" matTooltip="Possui datas retroativas">history</mat-icon>
            }
          </td>
        </ng-container>
        <ng-container matColumnDef="client">
          <th mat-header-cell *matHeaderCellDef>Cliente / cargo</th>
          <td mat-cell *matCellDef="let p">
            <div>{{ p.clientName }}</div>
            <small class="muted">{{ p.jobRoleName }} · {{ p.workLocationName }}</small>
          </td>
        </ng-container>
        <ng-container matColumnDef="demand">
          <th mat-header-cell *matHeaderCellDef>Tipo</th>
          <td mat-cell *matCellDef="let p">{{ p.demandType | label: demandLabels }}</td>
        </ng-container>
        <ng-container matColumnDef="status">
          <th mat-header-cell *matHeaderCellDef>Status</th>
          <td mat-cell *matCellDef="let p"><app-status-chip [status]="p.status" /></td>
        </ng-container>
        <ng-container matColumnDef="sla">
          <th mat-header-cell *matHeaderCellDef>SLA</th>
          <td mat-cell *matCellDef="let p">
            <app-sla-chip [situation]="p.slaSituation" [stage]="p.stageStatus" />
            @if (p.slaDeadline) {
              <small class="muted block">prazo {{ p.slaDeadline | dateBr }}</small>
            }
          </td>
        </ng-container>
        <ng-container matColumnDef="opened">
          <th mat-header-cell *matHeaderCellDef>Abertura</th>
          <td mat-cell *matCellDef="let p">{{ p.openedAt | dateBr }}</td>
        </ng-container>
        <ng-container matColumnDef="uncovered">
          <th mat-header-cell *matHeaderCellDef class="num">Dias descobertos</th>
          <td mat-cell *matCellDef="let p" class="num">{{ p.uncoveredDays }}</td>
        </ng-container>
        <ng-container matColumnDef="fill">
          <th mat-header-cell *matHeaderCellDef class="num">Preenchimento</th>
          <td mat-cell *matCellDef="let p" class="num">{{ p.fillTime ?? '—' }}</td>
        </ng-container>
        <ng-container matColumnDef="money">
          <th mat-header-cell *matHeaderCellDef class="num">Perdido / postergado</th>
          <td mat-cell *matCellDef="let p" class="num">
            @if (p.moneyStatus === 'NOT_APPLICABLE' || p.moneyStatus === 'NO_RATE') {
              <small class="muted">{{ p.moneyStatus | label: moneyLabels }}</small>
            } @else {
              <span [class.pending]="p.moneyStatus !== 'VALIDATED'"
                [matTooltip]="p.moneyStatus !== 'VALIDATED' ? (p.moneyStatus | label: moneyLabels) + ' — fora dos totais' : ''">
                {{ p.lost | money }}
                @if (p.deferred) {
                  <small class="muted block">post. {{ p.deferred | money }}</small>
                }
              </span>
            }
          </td>
        </ng-container>
        <ng-container matColumnDef="employee">
          <th mat-header-cell *matHeaderCellDef>Colaborador</th>
          <td mat-cell *matCellDef="let p">{{ p.employeeName ?? '—' }}</td>
        </ng-container>

        <tr mat-header-row *matHeaderRowDef="columns()"></tr>
        <tr mat-row *matRowDef="let row; columns: columns()"></tr>
        <tr class="mat-row" *matNoDataRow>
          <td class="mat-cell empty" [attr.colspan]="columns().length">Nenhuma posição encontrada.</td>
        </tr>
      </table>
    </div>
  `,
})
export class PositionTable {
  readonly rows = input.required<PositionSummary[]>();
  readonly columns = input<string[]>(['position', 'client', 'demand', 'status', 'sla', 'opened', 'uncovered', 'fill']);

  protected readonly demandLabels = DEMAND_TYPE;
  protected readonly moneyLabels = MONEY_STATUS;
}

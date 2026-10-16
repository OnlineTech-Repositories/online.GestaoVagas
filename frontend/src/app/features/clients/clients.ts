import { Component, inject, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatDialog } from '@angular/material/dialog';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { forkJoin } from 'rxjs';
import { Api } from '../../core/api';
import { MODALITY_SHORT } from '../../core/labels';
import { Client, Contract } from '../../core/models';
import { CnpjPipe, DateBrPipe } from '../../shared/format';
import { ClientDialog, ContractDialog, ContractDialogData } from './client-dialogs';

@Component({
  selector: 'app-clients',
  imports: [MatTabsModule, MatTableModule, MatButtonModule, MatIconModule, MatProgressBarModule, CnpjPipe, DateBrPipe],
  template: `
    <div class="page-header">
      <h1>Clientes e contratos</h1>
    </div>
    @if (data.isLoading()) {
      <mat-progress-bar mode="indeterminate" />
    }
    <mat-tab-group [selectedIndex]="tab()" (selectedIndexChange)="tab.set($event)">
      <mat-tab label="Clientes">
        <div class="tab-body">
          <div class="actions-bar"><button mat-flat-button (click)="editClient(null)"><mat-icon>add</mat-icon> Novo cliente</button></div>
          <div class="table-wrap">
            <table mat-table [dataSource]="data.value()?.clients ?? []">
              <ng-container matColumnDef="name">
                <th mat-header-cell *matHeaderCellDef>Razão social</th>
                <td mat-cell *matCellDef="let c">{{ c.legalName }}</td>
              </ng-container>
              <ng-container matColumnDef="cnpj">
                <th mat-header-cell *matHeaderCellDef>CNPJ</th>
                <td mat-cell *matCellDef="let c">{{ c.cnpj | cnpj }}</td>
              </ng-container>
              <ng-container matColumnDef="active">
                <th mat-header-cell *matHeaderCellDef>Situação</th>
                <td mat-cell *matCellDef="let c">{{ c.active ? 'Ativo' : 'Inativo' }}</td>
              </ng-container>
              <ng-container matColumnDef="edit">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let c" class="num">
                  <button mat-icon-button aria-label="Editar" (click)="editClient(c)"><mat-icon>edit</mat-icon></button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="clientColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: clientColumns" [class.inactive]="!row.active"></tr>
            </table>
          </div>
        </div>
      </mat-tab>
      <mat-tab label="Contratos">
        <div class="tab-body">
          <div class="actions-bar"><button mat-flat-button (click)="editContract(null)"><mat-icon>add</mat-icon> Novo contrato</button></div>
          <div class="table-wrap">
            <table mat-table [dataSource]="data.value()?.contracts ?? []">
              <ng-container matColumnDef="client">
                <th mat-header-cell *matHeaderCellDef>Cliente / contrato</th>
                <td mat-cell *matCellDef="let c">
                  <div>{{ c.clientName }}</div>
                  <small class="muted">{{ c.name }}</small>
                </td>
              </ng-container>
              <ng-container matColumnDef="group">
                <th mat-header-cell *matHeaderCellDef>CNPJ do Grupo</th>
                <td mat-cell *matCellDef="let c">{{ c.groupEntityName }}</td>
              </ng-container>
              <ng-container matColumnDef="modalities">
                <th mat-header-cell *matHeaderCellDef>Modalidades</th>
                <td mat-cell *matCellDef="let c">{{ modalities(c) }}</td>
              </ng-container>
              <ng-container matColumnDef="period">
                <th mat-header-cell *matHeaderCellDef>Vigência</th>
                <td mat-cell *matCellDef="let c">{{ c.startDate | dateBr }} → {{ c.endDate ? (c.endDate | dateBr) : 'indeterminado' }}</td>
              </ng-container>
              <ng-container matColumnDef="sla">
                <th mat-header-cell *matHeaderCellDef>SLA nova / reposição</th>
                <td mat-cell *matCellDef="let c">{{ c.slaNewDays ?? '—' }} / {{ c.slaReplacementDays ?? '—' }}</td>
              </ng-container>
              <ng-container matColumnDef="owner">
                <th mat-header-cell *matHeaderCellDef>Comercial</th>
                <td mat-cell *matCellDef="let c">{{ c.commercialOwnerName }}</td>
              </ng-container>
              <ng-container matColumnDef="status">
                <th mat-header-cell *matHeaderCellDef>Status</th>
                <td mat-cell *matCellDef="let c">{{ c.status === 'ACTIVE' ? 'Ativo' : 'Encerrado' }}</td>
              </ng-container>
              <ng-container matColumnDef="edit">
                <th mat-header-cell *matHeaderCellDef></th>
                <td mat-cell *matCellDef="let c" class="num">
                  <button mat-icon-button aria-label="Editar" (click)="editContract(c)"><mat-icon>edit</mat-icon></button>
                </td>
              </ng-container>
              <tr mat-header-row *matHeaderRowDef="contractColumns"></tr>
              <tr mat-row *matRowDef="let row; columns: contractColumns" [class.inactive]="row.status !== 'ACTIVE'"></tr>
            </table>
          </div>
        </div>
      </mat-tab>
    </mat-tab-group>
  `,
})
export class ClientsPage {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);

  protected readonly tab = signal(0);
  protected readonly clientColumns = ['name', 'cnpj', 'active', 'edit'];
  protected readonly contractColumns = ['client', 'group', 'modalities', 'period', 'sla', 'owner', 'status', 'edit'];

  protected readonly data = rxResource({
    stream: () => forkJoin({ clients: this.api.clients(), contracts: this.api.contracts() }),
  });

  modalities(c: Contract): string {
    return c.modalities.map((m) => MODALITY_SHORT[m]).join(', ');
  }

  editClient(client: Client | null): void {
    this.dialog
      .open(ClientDialog, { width: '480px', maxWidth: '95vw', data: client })
      .afterClosed()
      .subscribe((saved) => saved && this.data.reload());
  }

  editContract(contract: Contract | null): void {
    this.dialog
      .open<ContractDialog, ContractDialogData>(ContractDialog, {
        width: '640px',
        maxWidth: '95vw',
        data: { contract, clients: (this.data.value()?.clients ?? []).filter((c) => c.active || c.id === contract?.clientId) },
      })
      .afterClosed()
      .subscribe((saved) => saved && this.data.reload());
  }
}

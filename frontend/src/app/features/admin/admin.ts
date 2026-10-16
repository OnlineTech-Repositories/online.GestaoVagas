import { Component, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { FormsModule, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatDialog } from '@angular/material/dialog';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatSelectModule } from '@angular/material/select';
import { MatTableModule } from '@angular/material/table';
import { MatTabsModule } from '@angular/material/tabs';
import { MatTooltipModule } from '@angular/material/tooltip';
import { Observable } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { DEMAND_TYPE, enumOptions, MODALITY, ROLE } from '../../core/labels';
import { NamedItem, Parameter, User } from '../../core/models';
import { Notify } from '../../core/notify';
import { CnpjPipe, DateBrPipe, LabelPipe, todayIso } from '../../shared/format';
import { UserDialog } from './user-dialog';

/** Cadastro simples (nome + ativo) usado para cargos e motivos de pausa. */
@Component({
  selector: 'app-named-catalog',
  imports: [ReactiveFormsModule, MatTableModule, MatButtonModule, MatIconModule, MatFormFieldModule, MatInputModule, MatCheckboxModule],
  template: `
    <form [formGroup]="form" (ngSubmit)="save()" class="filters">
      <mat-form-field class="grow">
        <mat-label>{{ editingId() ? 'Editar' : 'Novo' }} — {{ label() }}</mat-label>
        <input matInput formControlName="name" maxlength="150" />
      </mat-form-field>
      <mat-checkbox formControlName="active">Ativo</mat-checkbox>
      <button mat-flat-button type="submit">Salvar</button>
      @if (editingId()) {
        <button mat-button type="button" (click)="reset()">Cancelar</button>
      }
    </form>
    <div class="table-wrap">
      <table mat-table [dataSource]="items.value() ?? []">
        <ng-container matColumnDef="name">
          <th mat-header-cell *matHeaderCellDef>Nome</th>
          <td mat-cell *matCellDef="let i">{{ i.name }}</td>
        </ng-container>
        <ng-container matColumnDef="active">
          <th mat-header-cell *matHeaderCellDef>Situação</th>
          <td mat-cell *matCellDef="let i">{{ i.active ? 'Ativo' : 'Inativo' }}</td>
        </ng-container>
        <ng-container matColumnDef="edit">
          <th mat-header-cell *matHeaderCellDef></th>
          <td mat-cell *matCellDef="let i" class="num">
            <button mat-icon-button aria-label="Editar" (click)="edit(i)"><mat-icon>edit</mat-icon></button>
          </td>
        </ng-container>
        <tr mat-header-row *matHeaderRowDef="columns"></tr>
        <tr mat-row *matRowDef="let row; columns: columns" [class.inactive]="!row.active"></tr>
      </table>
    </div>
  `,
})
export class NamedCatalog {
  readonly catalog = input.required<'job-roles' | 'pause-reasons'>();
  readonly label = input.required<string>();

  private readonly api = inject(Api);
  private readonly notify = inject(Notify);

  protected readonly columns = ['name', 'active', 'edit'];
  protected readonly editingId = signal<string | null>(null);
  protected readonly form = inject(NonNullableFormBuilder).group({ name: ['', Validators.required], active: [true] });
  protected readonly items = rxResource({
    params: () => this.catalog(),
    stream: ({ params }) => (params === 'job-roles' ? this.api.jobRoles() : this.api.pauseReasons()),
  });

  edit(item: NamedItem): void {
    this.editingId.set(item.id);
    this.form.setValue({ name: item.name, active: item.active });
  }

  reset(): void {
    this.editingId.set(null);
    this.form.reset({ name: '', active: true });
  }

  save(): void {
    if (this.form.invalid) return;
    this.api.saveCatalog(this.catalog(), this.editingId(), this.form.getRawValue()).subscribe({
      next: () => {
        this.notify.success('Salvo.');
        this.reset();
        this.items.reload();
      },
      error: (err) => this.notify.error(err),
    });
  }
}

@Component({
  selector: 'app-admin',
  imports: [
    FormsModule,
    ReactiveFormsModule,
    MatTabsModule,
    MatTableModule,
    MatButtonModule,
    MatIconModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatTooltipModule,
    NamedCatalog,
    CnpjPipe,
    DateBrPipe,
    LabelPipe,
  ],
  templateUrl: './admin.html',
})
export class AdminPage {
  private readonly api = inject(Api);
  private readonly dialog = inject(MatDialog);
  private readonly notify = inject(Notify);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly auth = inject(Auth);

  protected readonly roleLabels = ROLE;
  protected readonly modalityLabels = MODALITY;
  protected readonly demandLabels = DEMAND_TYPE;
  protected readonly modalityOptions = enumOptions(MODALITY);
  protected readonly demandOptions = enumOptions(DEMAND_TYPE);

  protected readonly users = rxResource({ stream: () => this.api.users() });
  protected readonly parameters = rxResource({ stream: () => this.api.parameters() });
  protected readonly groups = rxResource({ stream: () => this.api.groupEntities() });
  protected readonly locations = rxResource({ stream: () => this.api.workLocations() });
  protected readonly clients = rxResource({ stream: () => this.api.clients() });
  protected readonly slaTargets = rxResource({ stream: () => this.api.slaTargets() });

  protected readonly userColumns = ['name', 'email', 'roles', 'status', 'actions'];
  protected readonly parameterValues: Record<string, string> = {};

  protected readonly groupEditing = signal<string | null>(null);
  protected readonly groupForm = this.fb.group({ name: ['', Validators.required], cnpj: ['', Validators.required], active: [true] });

  protected readonly locationEditing = signal<string | null>(null);
  protected readonly locationForm = this.fb.group({
    name: ['', Validators.required],
    clientId: [null as string | null],
    active: [true],
  });

  protected readonly slaForm = this.fb.group({
    modality: ['MOT', Validators.required],
    demandType: ['NEW', Validators.required],
    days: [10, [Validators.required, Validators.min(1)]],
    validFrom: [todayIso(), Validators.required],
  });

  // ------------------------------------------------------------ usuários
  editUser(user: User | null): void {
    this.dialog
      .open(UserDialog, { width: '560px', maxWidth: '95vw', data: user })
      .afterClosed()
      .subscribe((saved) => saved && this.users.reload());
  }

  roles(user: User): string {
    return user.roles.map((r) => ROLE[r]).join(', ');
  }

  // ------------------------------------------------------------ parâmetros
  parameterValue(p: Parameter): string {
    return this.parameterValues[p.key] ?? p.value;
  }

  saveParameter(p: Parameter): void {
    const value = this.parameterValue(p);
    this.run(this.api.updateParameter(p.key, value), 'Parâmetro atualizado.', () => {
      delete this.parameterValues[p.key];
      this.parameters.reload();
      if (p.key === 'INITIAL_LOAD_OPEN') this.auth.refresh().subscribe();
    });
  }

  isBoolean(p: Parameter): boolean {
    return p.value === 'true' || p.value === 'false';
  }

  // ------------------------------------------------------------ CNPJs do Grupo
  editGroup(id: string | null, name = '', cnpj = '', active = true): void {
    this.groupEditing.set(id);
    this.groupForm.setValue({ name, cnpj, active });
  }

  saveGroup(): void {
    if (this.groupForm.invalid) return;
    this.run(this.api.saveCatalog('group-entities', this.groupEditing(), this.groupForm.getRawValue()), 'Salvo.', () => {
      this.editGroup(null);
      this.groups.reload();
    });
  }

  // ------------------------------------------------------------ locais
  editLocation(id: string | null, name = '', clientId: string | null = null, active = true): void {
    this.locationEditing.set(id);
    this.locationForm.setValue({ name, clientId, active });
  }

  saveLocation(): void {
    if (this.locationForm.invalid) return;
    this.run(this.api.saveCatalog('work-locations', this.locationEditing(), this.locationForm.getRawValue()), 'Salvo.', () => {
      this.editLocation(null);
      this.locations.reload();
    });
  }

  // ------------------------------------------------------------ metas de SLA
  saveSla(): void {
    if (this.slaForm.invalid) return;
    this.run(this.api.saveCatalog('sla-targets', null, this.slaForm.getRawValue()), 'Meta cadastrada.', () =>
      this.slaTargets.reload(),
    );
  }

  private run(request: Observable<unknown>, message: string, done: () => void): void {
    request.subscribe({
      next: () => {
        this.notify.success(message);
        done();
      },
      error: (err) => this.notify.error(err),
    });
  }
}

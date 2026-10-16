import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCheckboxModule } from '@angular/material/checkbox';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatPaginatorModule, PageEvent } from '@angular/material/paginator';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { ActivatedRoute, Router } from '@angular/router';
import { debounceTime, forkJoin } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { DEMAND_TYPE, enumOptions, MODALITY, POSITION_STATUS, SLA_SITUATION } from '../../core/labels';
import { DemandType, Modality, PositionStatus, SlaSituation } from '../../core/models';
import { PositionTable } from '../../shared/position-table';

@Component({
  selector: 'app-position-list',
  imports: [
    ReactiveFormsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatCheckboxModule,
    MatButtonModule,
    MatIconModule,
    MatExpansionModule,
    MatPaginatorModule,
    MatProgressBarModule,
    PositionTable,
  ],
  templateUrl: './position-list.html',
})
export class PositionList implements OnInit {
  private readonly api = inject(Api);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly auth = inject(Auth);

  protected readonly statusOptions = enumOptions(POSITION_STATUS);
  protected readonly slaOptions = enumOptions(SLA_SITUATION);
  protected readonly modalityOptions = enumOptions(MODALITY);
  protected readonly demandOptions = enumOptions(DEMAND_TYPE);

  protected readonly form = inject(NonNullableFormBuilder).group({
    search: [''],
    clientId: [''],
    contractId: [''],
    modality: ['' as Modality | ''],
    jobRoleId: [''],
    demandType: ['' as DemandType | ''],
    groupEntityId: [''],
    workLocationId: [''],
    status: [[] as PositionStatus[]],
    sla: [[] as SlaSituation[]],
    openedFrom: [''],
    openedTo: [''],
    onlyOpen: [false],
  });

  protected readonly page = signal({ index: 0, size: 50 });
  private readonly filters = signal(this.form.getRawValue());

  protected readonly catalogs = rxResource({
    stream: () =>
      forkJoin({
        clients: this.api.clients(),
        contracts: this.api.contracts(),
        jobRoles: this.api.jobRoles(),
        groupEntities: this.api.groupEntities(),
        workLocations: this.api.workLocations(),
      }),
  });

  protected readonly result = rxResource({
    params: () => ({ f: this.filters(), p: this.page() }),
    stream: ({ params: { f, p } }) =>
      this.api.positions({
        search: f.search,
        clientId: f.clientId,
        contractId: f.contractId,
        modality: f.modality,
        jobRoleId: f.jobRoleId,
        demandType: f.demandType,
        groupEntityId: f.groupEntityId,
        workLocationId: f.workLocationId,
        status: f.status,
        slaSituation: f.sla,
        openedFrom: f.openedFrom,
        openedTo: f.openedTo,
        onlyOpen: f.onlyOpen || null,
        sort: 'uncovered',
        page: p.index + 1,
        pageSize: p.size,
      }),
  });

  protected readonly error = computed(() => (this.result.error() ? errorMessage(this.result.error()) : null));
  protected readonly columns = computed(() => {
    const base = ['position', 'client', 'demand', 'status', 'sla', 'opened', 'uncovered', 'fill', 'employee'];
    return this.auth.user()?.canSeeDetailedValues ? [...base, 'money'] : base;
  });

  constructor() {
    this.form.valueChanges.pipe(debounceTime(350), takeUntilDestroyed()).subscribe(() => {
      this.page.update((p) => ({ ...p, index: 0 }));
      this.filters.set(this.form.getRawValue());
    });
  }

  ngOnInit(): void {
    // Filtros vindos do painel (ex.: ?sla=OVERDUE, ?status=PAUSED, ?onlyOpen=true).
    const q = this.route.snapshot.queryParamMap;
    this.form.patchValue(
      {
        status: q.getAll('status') as PositionStatus[],
        sla: q.getAll('sla') as SlaSituation[],
        onlyOpen: q.get('onlyOpen') === 'true',
      },
      { emitEvent: false },
    );
    this.filters.set(this.form.getRawValue());
  }

  onPage(event: PageEvent): void {
    this.page.set({ index: event.pageIndex, size: event.pageSize });
  }

  clear(): void {
    this.form.reset();
    void this.router.navigate([], { queryParams: {} });
  }
}

import { NgTemplateOutlet } from '@angular/common';
import { Component, computed, inject, OnInit, signal } from '@angular/core';
import { rxResource, takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { FormControl, NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatListModule } from '@angular/material/list';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { MatTabsModule } from '@angular/material/tabs';
import { ActivatedRoute, Router } from '@angular/router';
import { debounceTime, distinctUntilChanged, forkJoin, Observable, switchMap } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { enumOptions, MODALITY, TERM_TYPE, TERMINATION_SOURCE, TERMINATION_TYPE } from '../../core/labels';
import { FilledPosition, Modality, TerminationResult, TerminationSource, TerminationType, TermType } from '../../core/models';
import { Notify } from '../../core/notify';
import { DateBrPipe, LabelPipe, todayIso } from '../../shared/format';

/** Registrar desligamento (DP, NACC): busca do colaborador entre as posições preenchidas ou desligamento avulso (D1). */
@Component({
  selector: 'app-termination-form',
  imports: [
    NgTemplateOutlet,
    ReactiveFormsModule,
    MatCardModule,
    MatTabsModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatButtonModule,
    MatIconModule,
    MatListModule,
    MatProgressBarModule,
    DateBrPipe,
    LabelPipe,
  ],
  templateUrl: './termination-form.html',
})
export class TerminationForm implements OnInit {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly notify = inject(Notify);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly auth = inject(Auth);

  protected readonly sourceOptions = enumOptions(TERMINATION_SOURCE);
  protected readonly typeOptions = enumOptions(TERMINATION_TYPE);
  protected readonly termOptions = enumOptions(TERM_TYPE);
  protected readonly modalityLabels = MODALITY;

  protected readonly search = new FormControl('', { nonNullable: true });
  protected readonly results = signal<FilledPosition[]>([]);
  protected readonly selected = signal<FilledPosition | null>(null);
  protected readonly saving = signal(false);
  protected readonly error = signal<string | null>(null);

  /** Dados comuns do desligamento. */
  protected readonly form = this.fb.group({
    lastWorkedDay: [todayIso(), Validators.required],
    source: ['DP' as TerminationSource, Validators.required],
    terminationType: ['RESIGNATION' as TerminationType, Validators.required],
    notes: [''],
    registeredAt: [todayIso(), Validators.required],
    justification: [''],
  });

  /** Dados do desligamento avulso (D1): a posição de origem não existe no sistema. */
  protected readonly legacy = this.fb.group({
    contractId: ['', Validators.required],
    modality: ['' as Modality | '', Validators.required],
    jobRoleId: ['', Validators.required],
    workLocationId: ['', Validators.required],
    termType: ['INDEFINITE' as TermType, Validators.required],
    termEndDate: [''],
    termDurationDays: [null as number | null],
    employeeName: ['', Validators.required],
    employeeRegistration: ['', Validators.required],
    firstDayAt: [''],
  });

  protected readonly catalogs = rxResource({
    stream: () =>
      forkJoin({
        contracts: this.api.contracts({ onlyActive: true }),
        jobRoles: this.api.jobRoles(),
        workLocations: this.api.workLocations(),
      }),
  });

  private readonly legacyValues = toSignal(this.legacy.valueChanges, { initialValue: this.legacy.getRawValue() });
  private readonly formValues = toSignal(this.form.valueChanges, { initialValue: this.form.getRawValue() });
  protected readonly legacyContract = computed(() =>
    this.catalogs.value()?.contracts.find((c) => c.id === this.legacyValues().contractId),
  );
  protected readonly retroactive = computed(() => {
    const registeredAt = this.formValues().registeredAt;
    return !this.auth.user()?.initialLoadOpen && !!registeredAt && registeredAt < todayIso();
  });

  constructor() {
    this.search.valueChanges
      .pipe(
        debounceTime(300),
        distinctUntilChanged(),
        switchMap((term) => this.api.filledPositions(term)),
        takeUntilDestroyed(),
      )
      .subscribe({ next: (r) => this.results.set(r), error: (e) => this.notify.error(e) });

    this.form.patchValue({ source: this.auth.hasRole('DP') ? 'DP' : 'NACC' });
  }

  ngOnInit(): void {
    // Vindo do detalhe da posição: pré-seleciona o colaborador.
    const positionId = this.route.snapshot.queryParamMap.get('positionId');
    this.api.filledPositions('').subscribe((list) => {
      this.results.set(list);
      if (positionId) {
        const match = list.find((p) => p.positionId === positionId);
        if (match) this.selected.set(match);
        else
          this.api.position(positionId).subscribe((p) => {
            if (p.employeeName) this.search.setValue(p.employeeRegistration ?? p.employeeName);
          });
      }
    });
  }

  submitExisting(): void {
    const origin = this.selected();
    if (!origin) {
      this.error.set('Selecione o colaborador.');
      return;
    }
    if (this.invalid(this.form)) return;
    this.send(this.api.registerTermination({ originPositionId: origin.positionId, ...this.common() }));
  }

  submitLegacy(): void {
    if (this.invalid(this.form) || this.invalid(this.legacy)) return;
    const l = this.legacy.getRawValue();
    this.send(
      this.api.registerLegacyTermination({
        ...l,
        termEndDate: l.termType === 'FIXED_END' ? l.termEndDate || null : null,
        termDurationDays: l.termType === 'PRESERVED_DURATION' ? l.termDurationDays : null,
        firstDayAt: l.firstDayAt || null,
        ...this.common(),
      }),
    );
  }

  private common() {
    const v = this.form.getRawValue();
    return { ...v, notes: v.notes || null, justification: v.justification || null };
  }

  private invalid(group: { invalid: boolean; markAllAsTouched(): void }): boolean {
    if (!group.invalid) return false;
    group.markAllAsTouched();
    this.error.set('Preencha os campos obrigatórios.');
    return true;
  }

  private send(request: Observable<TerminationResult>): void {
    this.saving.set(true);
    this.error.set(null);
    request.subscribe({
      next: (result) => {
        this.notify.success('Desligamento registrado. A reposição aguarda a decisão do cliente.');
        void this.router.navigate(['/posicoes', result.replacementPositionId]);
      },
      error: (err) => {
        this.error.set(errorMessage(err));
        this.saving.set(false);
      },
    });
  }
}

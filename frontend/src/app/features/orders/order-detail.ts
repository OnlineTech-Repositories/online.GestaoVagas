import { Component, computed, inject, input, signal } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { NonNullableFormBuilder, ReactiveFormsModule, Validators } from '@angular/forms';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatExpansionModule } from '@angular/material/expansion';
import { MatFormFieldModule } from '@angular/material/form-field';
import { MatIconModule } from '@angular/material/icon';
import { MatInputModule } from '@angular/material/input';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { MatSelectModule } from '@angular/material/select';
import { RouterLink } from '@angular/router';
import { Observable } from 'rxjs';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { MODALITY, ORDER_STATUS, TERM_TYPE } from '../../core/labels';
import { OrderDetail } from '../../core/models';
import { Notify } from '../../core/notify';
import { DateBrPipe, LabelPipe, todayIso } from '../../shared/format';
import { PositionTable } from '../../shared/position-table';

@Component({
  selector: 'app-order-detail',
  imports: [
    RouterLink,
    ReactiveFormsModule,
    MatCardModule,
    MatButtonModule,
    MatIconModule,
    MatExpansionModule,
    MatFormFieldModule,
    MatInputModule,
    MatSelectModule,
    MatProgressBarModule,
    PositionTable,
    DateBrPipe,
    LabelPipe,
  ],
  templateUrl: './order-detail.html',
})
export class OrderDetailPage {
  readonly id = input.required<string>();

  private readonly api = inject(Api);
  private readonly notify = inject(Notify);
  private readonly fb = inject(NonNullableFormBuilder);
  protected readonly auth = inject(Auth);

  protected readonly labels = { modality: MODALITY, status: ORDER_STATUS, term: TERM_TYPE };
  protected readonly order = rxResource({ params: () => this.id(), stream: ({ params }) => this.api.order(params) });
  protected readonly error = computed(() => (this.order.error() ? errorMessage(this.order.error()) : null));
  protected readonly saving = signal(false);

  protected readonly columns = computed(() => {
    const base = ['position', 'demand', 'status', 'sla', 'opened', 'uncovered', 'fill', 'employee'];
    return this.auth.user()?.canSeeDetailedValues ? [...base, 'money'] : base;
  });

  protected readonly addForm = this.fb.group({
    quantity: [1, [Validators.required, Validators.min(1), Validators.max(1000)]],
    desiredStartDate: [todayIso(), Validators.required],
    justification: [''],
  });

  protected readonly correctionForm = this.fb.group({
    field: ['DESIRED_START_DATE', Validators.required],
    date: [todayIso(), Validators.required],
    justification: ['', Validators.required],
  });

  addPositions(): void {
    if (this.addForm.invalid) return;
    this.run(this.api.addPositions(this.id(), this.addForm.getRawValue()), 'Posições acrescentadas.');
  }

  correctDate(): void {
    if (this.correctionForm.invalid) {
      this.correctionForm.markAllAsTouched();
      return;
    }
    this.run(this.api.correctOrderDate(this.id(), this.correctionForm.getRawValue()), 'Data corrigida.', () =>
      this.correctionForm.controls.justification.reset(),
    );
  }

  private run(request: Observable<OrderDetail>, message: string, done?: () => void): void {
    this.saving.set(true);
    request.subscribe({
      next: (order) => {
        this.order.set(order);
        this.saving.set(false);
        this.notify.success(message);
        done?.();
      },
      error: (err) => {
        this.saving.set(false);
        this.notify.error(err);
      },
    });
  }
}

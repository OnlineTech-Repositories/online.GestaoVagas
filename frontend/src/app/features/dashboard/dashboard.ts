import { Component, computed, inject } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { MatButtonModule } from '@angular/material/button';
import { MatCardModule } from '@angular/material/card';
import { MatIconModule } from '@angular/material/icon';
import { MatProgressBarModule } from '@angular/material/progress-bar';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Auth } from '../../core/auth';
import { errorMessage } from '../../core/http';
import { DateBrPipe, MoneyPipe } from '../../shared/format';
import { PositionTable } from '../../shared/position-table';

@Component({
  selector: 'app-dashboard',
  imports: [MatCardModule, MatIconModule, MatButtonModule, MatProgressBarModule, RouterLink, PositionTable, MoneyPipe, DateBrPipe],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
})
export class DashboardPage {
  private readonly api = inject(Api);
  protected readonly auth = inject(Auth);

  protected readonly data = rxResource({ stream: () => this.api.dashboard() });
  protected readonly error = computed(() => (this.data.error() ? errorMessage(this.data.error()) : null));

  protected readonly columns = computed(() => {
    const base = ['position', 'client', 'demand', 'status', 'sla', 'uncovered', 'fill'];
    return this.auth.user()?.canSeeDetailedValues ? [...base, 'money'] : base;
  });
}

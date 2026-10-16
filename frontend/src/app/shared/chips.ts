import { Component, computed, input } from '@angular/core';
import { POSITION_STATUS, SLA_SITUATION } from '../core/labels';
import { PositionStatus, SlaSituation } from '../core/models';

/** Situação do SLA com a cor da SPEC: verde (no prazo), amarelo (em risco), vermelho (vencido), cinza (sem meta). */
@Component({
  selector: 'app-sla-chip',
  template: `<span [class]="cssClass()">{{ text() }}</span>`,
})
export class SlaChip {
  readonly situation = input<SlaSituation | null>(null);
  /** Status da etapa (ignora pausa): reposição aguardando o cliente não tem SLA do RH. */
  readonly stage = input<PositionStatus | null>(null);

  readonly text = computed(() => {
    const s = this.situation();
    if (s) return SLA_SITUATION[s];
    return this.stage() === 'AWAITING_CONFIRMATION' ? 'Aguardando cliente' : '—';
  });

  readonly cssClass = computed(() => {
    switch (this.situation()) {
      case 'ON_TIME':
        return 'chip chip-green';
      case 'AT_RISK':
        return 'chip chip-yellow';
      case 'OVERDUE':
        return 'chip chip-red';
      default:
        return 'chip chip-grey';
    }
  });
}

@Component({
  selector: 'app-status-chip',
  template: `<span [class]="cssClass()">{{ text() }}</span>`,
})
export class StatusChip {
  readonly status = input.required<PositionStatus>();

  readonly text = computed(() => POSITION_STATUS[this.status()]);

  readonly cssClass = computed(() => {
    const s = this.status();
    if (s === 'FILLED') return 'chip chip-green';
    if (s.startsWith('CLOSED')) return 'chip chip-grey';
    if (s === 'PAUSED' || s === 'AWAITING_CONFIRMATION') return 'chip chip-yellow';
    return 'chip chip-blue';
  });
}

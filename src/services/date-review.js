import { DateIssue, orderDateIssues, positionDateIssues, retroactiveMessage } from '../domain/date-checks.js';
import { today as todayDate } from '../domain/dates.js';
import { BusinessRuleError, WarningsPendingError } from '../domain/errors.js';
import { clean } from '../domain/guards.js';
import { isInitialLoadOpen } from './parameters.js';

/**
 * Revisão das datas de uma operação, antes de gravar (decisão do usuário em 19/10/2026: avisam, não bloqueiam).
 *
 *   1. `watchOrder`/`watchPosition` fotografam os avisos que o registro já tinha;
 *   2. a operação aplica as datas em memória (o domínio continua barrando só o impossível);
 *   3. `retroactive` registra o aviso de data passada e, fora da carga inicial, exige a justificativa (RN-24);
 *   4. `settle` compara com a foto: o que a operação acrescentou vira aviso. Sem a confirmação da tela, nada é
 *      gravado e a resposta traz os avisos; confirmados, segue para o save.
 *
 * Comparar com a foto é o que mantém a tela quieta quando a pessoa mexe em outra coisa de uma posição que já tinha
 * uma data fora do esperado: o aviso aparece quando a data entra, e depois fica como selo.
 */
export class DateReview {
  constructor(ctx) {
    this.ctx = ctx;
    this.today = todayDate();
    this.warnings = [];
    this.seen = new Set();
    this.sources = [];
    this.missing = null;
    this.loadOpen = null;
  }

  /** `fresh`: registro novo — tudo o que ele tiver de fora do esperado é aviso. */
  track(source, { fresh = false } = {}) {
    if (!fresh) for (const issue of source()) this.seen.add(issue.message);
    this.sources.push(source);
    return this;
  }

  /**
   * O pedido e as posições dele (inclusive as que a operação acrescentar). A abertura (ou o encerramento) que é a
   * própria decisão do cliente já sai no aviso do pedido: não se repete por posição (o selo da posição continua).
   */
  watchOrder(order, options) {
    const decided = (p, issue) => Boolean(order.clientDecisionDate) && (
      (issue.key.startsWith('p:opened') && p.openedAt === order.clientDecisionDate)
      || (issue.key.startsWith('p:closed') && p.closedAt === order.clientDecisionDate));
    return this.track(() => [
      ...orderDateIssues(order, this.today),
      ...(order.positions ?? []).flatMap((p) => positionDateIssues(p, this.today).filter((i) => !decided(p, i))),
    ], options);
  }

  watchPosition(p, options) {
    return this.track(() => positionDateIssues(p, this.today), options);
  }

  /**
   * Data de evento anterior a hoje: aviso sempre; fora da carga inicial, justificativa obrigatória (RN-24). Devolve
   * true quando a posição deve ser marcada com "datas retroativas" (a RN-24 vale).
   */
  async retroactive(date, label, justification, field = 'justification') {
    if (!date || date >= this.today) return false;
    this.loadOpen ??= await isInitialLoadOpen();
    this.warnings.push({ kind: DateIssue.RETROACTIVE, message: retroactiveMessage(label, date) });
    if (this.loadOpen) return false;
    if (!clean(justification) && !this.missing) this.missing = { field, label };
    return true;
  }

  /** Fecha a revisão: sem confirmação, devolve os avisos (nada gravado); confirmada, exige a justificativa que faltar. */
  settle() {
    for (const source of this.sources) {
      for (const issue of source()) {
        if (this.seen.has(issue.message)) continue;
        this.seen.add(issue.message);
        this.warnings.push(issue);
      }
    }
    const unique = [...new Map(this.warnings.map((w) => [w.message, w])).values()];
    if (unique.length && !this.ctx.confirmWarnings) throw new WarningsPendingError(unique, this.missing?.field ?? null);
    if (this.missing) {
      throw new BusinessRuleError(`${this.missing.label} é anterior à data de hoje. Informe uma justificativa.`, this.missing.field);
    }
    return unique;
  }
}

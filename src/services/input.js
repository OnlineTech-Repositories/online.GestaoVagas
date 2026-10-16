import { isDate } from '../domain/dates.js';
import { ValidationError } from '../domain/errors.js';

/**
 * Leitura do corpo da requisição: converte cada campo para o tipo esperado e ACUMULA os erros, em vez de parar no
 * primeiro — a tela marca todos os campos recusados de uma vez (padrão de front-end, seção 6).
 *
 * Só a forma é verificada aqui (data válida, número, opção da lista). As regras de negócio ficam no domínio.
 */
export class Input {
  constructor(body) {
    this.body = body && typeof body === 'object' ? body : {};
    this.errors = {};
  }

  raw(name) {
    const v = this.body[name];
    return v === '' ? null : v ?? null;
  }

  fail(name, message) {
    this.errors[name] ??= message;
    return null;
  }

  text(name, { required = false, message = 'Campo obrigatório.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    if (typeof v !== 'string' && typeof v !== 'number') return this.fail(name, 'Valor inválido.');
    return String(v);
  }

  date(name, { required = true, message = 'Informe a data.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    const text = String(v).slice(0, 10);
    return isDate(text) ? text : this.fail(name, 'Data inválida.');
  }

  int(name, { required = false, message = 'Informe um número inteiro.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    const n = Number(v);
    return Number.isInteger(n) ? n : this.fail(name, 'Informe um número inteiro.');
  }

  decimal(name, { required = false, message = 'Informe o valor.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    const n = Number(typeof v === 'string' ? v.replace(',', '.') : v);
    return Number.isFinite(n) ? n : this.fail(name, 'Valor inválido.');
  }

  bool(name, fallback = false) {
    const v = this.raw(name);
    if (v === null) return fallback;
    if (typeof v === 'boolean') return v;
    if (/^(true|1)$/i.test(String(v))) return true;
    if (/^(false|0)$/i.test(String(v))) return false;
    return this.fail(name, 'Valor inválido.') ?? fallback;
  }

  option(name, options, { required = true, message = 'Selecione uma opção.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    const allowed = Object.values(options);
    const match = allowed.find((o) => o.toLowerCase() === String(v).toLowerCase());
    return match ?? this.fail(name, 'Opção inválida.');
  }

  options(name, options, { message = 'Selecione ao menos uma opção.' } = {}) {
    const v = this.raw(name);
    if (v === null) return [];
    if (!Array.isArray(v)) return this.fail(name, message) ?? [];
    const allowed = Object.values(options);
    const out = [];
    for (const item of v) {
      const match = allowed.find((o) => o.toLowerCase() === String(item).toLowerCase());
      if (!match) return this.fail(name, 'Opção inválida.') ?? [];
      out.push(match);
    }
    return out;
  }

  id(name, { required = true, message = 'Selecione uma opção.' } = {}) {
    const v = this.raw(name);
    if (v === null) return required ? this.fail(name, message) : null;
    return isId(v) ? String(v).toLowerCase() : this.fail(name, 'Identificador inválido.');
  }

  ids(name) {
    const v = this.raw(name);
    if (v === null) return [];
    if (!Array.isArray(v) || !v.every(isId)) return this.fail(name, 'Identificador inválido.') ?? [];
    return v.map((x) => String(x).toLowerCase());
  }

  /** Lança 400 com todos os campos recusados; sem erros, segue. */
  done() {
    if (Object.keys(this.errors).length) throw new ValidationError(this.errors);
  }
}

export const isId = (v) => typeof v === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v);

/** Parâmetro de rota/consulta que deve ser um id; inválido = 404 (como a restrição {id:guid} das rotas .NET). */
export const routeId = (v) => (isId(v) ? v.toLowerCase() : null);

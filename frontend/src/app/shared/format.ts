import { Pipe, PipeTransform } from '@angular/core';
import { IsoDate } from '../core/models';

const brl = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });

/** 'yyyy-MM-dd' → 'dd/MM/yyyy' sem conversão de fuso (datas são DATE, sem hora). */
export function formatDate(value: IsoDate | null | undefined): string {
  if (!value) return '—';
  const [y, m, d] = value.substring(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

export function formatMoney(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : brl.format(value);
}

/** Data de hoje (fuso do navegador) no formato 'yyyy-MM-dd', usada como padrão dos formulários. */
export function todayIso(): IsoDate {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

export function formatCnpj(value: string | null | undefined): string {
  const d = (value ?? '').replace(/\D/g, '');
  return d.length === 14 ? `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}` : (value ?? '');
}

@Pipe({ name: 'dateBr' })
export class DateBrPipe implements PipeTransform {
  transform(value: IsoDate | null | undefined): string {
    return formatDate(value);
  }
}

@Pipe({ name: 'money' })
export class MoneyPipe implements PipeTransform {
  transform(value: number | null | undefined): string {
    return formatMoney(value);
  }
}

@Pipe({ name: 'cnpj' })
export class CnpjPipe implements PipeTransform {
  transform(value: string | null | undefined): string {
    return formatCnpj(value);
  }
}

@Pipe({ name: 'label' })
export class LabelPipe implements PipeTransform {
  transform<T extends string>(value: T | null | undefined, labels: Record<T, string>): string {
    return value ? (labels[value] ?? value) : '—';
  }
}

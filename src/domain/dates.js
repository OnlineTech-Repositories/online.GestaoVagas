/**
 * Datas do domínio. Uma data é texto 'AAAA-MM-DD' (o DateOnly da versão .NET) e um instante é ISO em UTC.
 *
 * Toda conta de dias é diferença simples entre datas, em dias corridos (seção 8 da SPEC), feita sobre o número do dia
 * em UTC — sem horário no meio, não há fuso nem horário de verão para deslocar o resultado.
 *
 * "Hoje" é sempre a data em America/Sao_Paulo (SPEC, seção 0). A aplicação financeira registra o defeito de usar o
 * dia em UTC: depois das 21h o sistema já vivia no dia seguinte.
 */

const DAY_MS = 86_400_000;
const ZONE = 'America/Sao_Paulo';
const isoDay = new Intl.DateTimeFormat('en-CA', { timeZone: ZONE, year: 'numeric', month: '2-digit', day: '2-digit' });
const hourMinute = new Intl.DateTimeFormat('en-GB', { timeZone: ZONE, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

let clockOverride = null;

/** Para testes: fixa o relógio (função que devolve um Date). */
export function setClock(fn) {
  clockOverride = fn;
}

const nowDate = () => (clockOverride ? clockOverride() : new Date());

export const utcNow = () => nowDate().toISOString();

/** Data de hoje em São Paulo. */
export const today = () => isoDay.format(nowDate());

/** Hora atual em São Paulo, 'HH:MM'. */
export const localTime = () => hourMinute.format(nowDate());

/** Dia da semana em São Paulo (0 = domingo). */
export const localWeekday = () => new Date(`${today()}T12:00:00Z`).getUTCDay();

export const isDate = (value) => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
  && !Number.isNaN(Date.parse(`${value}T00:00:00Z`))
  && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;

const dayNumber = (d) => Math.round(Date.parse(`${d}T00:00:00Z`) / DAY_MS);
const fromDayNumber = (n) => new Date(n * DAY_MS).toISOString().slice(0, 10);

export const addDays = (d, days) => fromDayNumber(dayNumber(d) + days);

/** Dias de `from` até `to` (to − from). */
export const diffDays = (from, to) => dayNumber(to) - dayNumber(from);

export const minDate = (a, b) => (a < b ? a : b);
export const maxDate = (a, b) => (a > b ? a : b);

export function addMonths(d, months) {
  const [y, m, day] = d.split('-').map(Number);
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(Math.min(day, last)).padStart(2, '0')}`;
}

export const addYears = (d, years) => addMonths(d, years * 12);

export const monthStart = (d) => `${d.slice(0, 7)}-01`;

/** 'AAAA-MM-DD' → 'DD/MM/AAAA' (mensagens e e-mails). */
export const formatBr = (d) => (d ? `${d.slice(8, 10)}/${d.slice(5, 7)}/${d.slice(0, 4)}` : '');

/** Ano da data. */
export const yearOf = (d) => Number(d.slice(0, 4));

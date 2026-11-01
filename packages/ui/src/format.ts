import { unitEntry } from '@pg/api-client';
/**
 * Display formatting only. These helpers never compute business values: money arrives
 * as a decimal string and is regrouped as text, so no binary floating point touches it.
 */

const LOCALE = 'ru-RU';
const NBSP_NARROW = ' ';
const MONEY_RE = /^(0|[1-9][0-9]*)\.([0-9]{2})$/;

export const CITY_TIMEZONE_DEFAULT = 'Asia/Almaty';

/** "1234567.50" -> "1 234 567,50 ₸". Returns null for a value that is not canonical Money. */
export function formatMoney(value: string | null | undefined, opts: { currency?: boolean } = {}): string | null {
  if (value == null) return null;
  const m = MONEY_RE.exec(value);
  if (!m) return null;
  const int = m[1]!.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP_NARROW);
  const text = `${int},${m[2]}`;
  return opts.currency === false ? text : `${text}${NBSP_NARROW}₸`;
}

export function formatNumber(value: number | null | undefined, decimals = 0): string | null {
  if (value == null || !Number.isFinite(value)) return null;
  return new Intl.NumberFormat(LOCALE, {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(value);
}

/** Probability 0..1 -> "87 %". Out-of-range input is a contract violation and is not shown. */
export function formatProbability(p: number | null | undefined, decimals = 0): string | null {
  if (p == null || !Number.isFinite(p) || p < 0 || p > 1) return null;
  return new Intl.NumberFormat(LOCALE, {
    style: 'percent',
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  }).format(p);
}

export function formatDateTime(iso: string | null | undefined, timeZone = CITY_TIMEZONE_DEFAULT): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).format(d);
}

/** Calendar date "YYYY-MM-DD" is not a timestamp: format without timezone shifts. */
export function formatDate(date: string | null | undefined): string | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return null;
  return `${m[3]}.${m[2]}.${m[1]}`;
}

/**
 * Units: the canonical registry is contracts/units.json (key, dimension, display_decimals).
 * The UI only adds Russian labels by machine key. A key missing from the registry is shown
 * verbatim-or-labelled with known=false so it can be flagged, never hidden or guessed.
 */
const UNIT_LABELS: Record<string, string> = {
  '1': 'доля',
  percent: '%',
  m: 'м',
  m2: 'м²',
  m3: 'м³',
  degC: '°C',
  kg_per_year: 'кг/год',
  t_CO2_per_year: 'т CO₂/год',
  persons: 'чел.',
  piece: 'шт.',
  KZT: '₸',
};

export interface UnitDisplay {
  label: string;
  /** Registered in contracts/units.json. */
  known: boolean;
  decimals: number | null;
}

export function unitLabel(key: string): UnitDisplay {
  const entry = unitEntry(key);
  return { label: UNIT_LABELS[key] ?? key, known: entry !== null, decimals: entry?.display_decimals ?? null };
}

/** Russian labels exist for these keys; used by the drift test against the registry. */
export const UNIT_LABEL_KEYS = Object.keys(UNIT_LABELS);

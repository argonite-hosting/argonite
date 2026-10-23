import { locale, t } from './i18n';

interface Formatters {
  compact: Intl.NumberFormat;
  full: Intl.NumberFormat;
  date: Intl.DateTimeFormat;
  rel: Intl.RelativeTimeFormat;
}

const cache = new Map<string, Formatters>();

function fmt(): Formatters {
  const id = locale.get();
  let f = cache.get(id);
  if (!f) {
    f = {
      compact: new Intl.NumberFormat(id, { notation: 'compact', maximumFractionDigits: 1 }),
      full: new Intl.NumberFormat(id),
      date: new Intl.DateTimeFormat(id, { year: 'numeric', month: 'short', day: 'numeric' }),
      rel: new Intl.RelativeTimeFormat(id, { numeric: 'auto' }),
    };
    cache.set(id, f);
  }
  return f;
}

export function count(n: number): string {
  return n < 1000 ? fmt().full.format(n) : fmt().compact.format(n);
}

export function number(n: number): string {
  return fmt().full.format(n);
}

export function date(ms: number | null | undefined): string {
  return ms ? fmt().date.format(new Date(ms)) : '—';
}

export function ago(ms: number | null | undefined): string {
  if (!ms) return '—';
  const rel = fmt().rel;
  const diff = (ms - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return t('just now');
  if (abs < 3600) return rel.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rel.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 30) return rel.format(Math.round(diff / 86400), 'day');
  if (abs < 86400 * 365) return rel.format(Math.round(diff / (86400 * 30)), 'month');
  return rel.format(Math.round(diff / (86400 * 365)), 'year');
}

export function bytes(n: number): string {
  const f = fmt().full;
  if (n < 1024) return `${f.format(n)} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toLocaleString(locale.get(), { maximumFractionDigits: 1 })} KB`;
  return `${(n / 1024 / 1024).toLocaleString(locale.get(), { maximumFractionDigits: n < 10 * 1024 * 1024 ? 2 : 1 })} MB`;
}

export function initials(name: string): string {
  const parts = name.trim().split(/[\s_-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '?') + (parts[1]?.[0] ?? '')).toUpperCase();
}

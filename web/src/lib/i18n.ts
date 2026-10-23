// Interface translations. Strings are written in English in the code and wrapped in t(); each locale
// file maps those English strings to its own wording. Anything missing falls back to English, so a
// half-finished translation never breaks a page.
import { Store, useStore } from './observable';

export interface LocaleInfo {
  id: string;
  name: string;
}

export const LOCALES: LocaleInfo[] = [
  { id: 'en', name: 'English' },
  { id: 'es', name: 'Español' },
  { id: 'pt-BR', name: 'Português (Brasil)' },
  { id: 'de', name: 'Deutsch' },
  { id: 'fr', name: 'Français' },
  { id: 'pl', name: 'Polski' },
  { id: 'ru', name: 'Русский' },
  { id: 'zh-CN', name: '简体中文' },
  { id: 'ja', name: '日本語' },
];

type Entry = string | Partial<Record<Intl.LDMLPluralRule, string>>;
type Dictionary = Record<string, Entry>;

const KEY = 'argonite-locale';
const files = import.meta.glob<{ default: Dictionary }>('../locales/*.json');
let dict: Dictionary = {};
let rules = new Intl.PluralRules('en');

export const locale = new Store<string>('en');

function detect(): string {
  try {
    const saved = localStorage.getItem(KEY);
    if (saved && LOCALES.some((l) => l.id === saved)) return saved;
  } catch {
    // Storage blocked; fall back to the browser's languages.
  }
  for (const lang of navigator.languages ?? [navigator.language]) {
    const exact = LOCALES.find((l) => l.id.toLowerCase() === lang.toLowerCase());
    if (exact) return exact.id;
    const base = LOCALES.find((l) => l.id.split('-')[0] === lang.split('-')[0].toLowerCase());
    if (base) return base.id;
  }
  return 'en';
}

async function load(id: string): Promise<Dictionary> {
  if (id === 'en') return {};
  const file = files[`../locales/${id}.json`];
  return file ? (await file()).default : {};
}

export async function setLocale(id: string, remember = true): Promise<void> {
  const next = LOCALES.some((l) => l.id === id) ? id : 'en';
  try {
    dict = await load(next);
  } catch {
    dict = {};
  }
  rules = new Intl.PluralRules(next);
  document.documentElement.lang = next;
  if (remember) {
    try {
      localStorage.setItem(KEY, next);
    } catch {
      // Not remembered, but still applied.
    }
  }
  locale.set(next);
}

export function initLocale(): Promise<void> {
  return setLocale(detect(), false);
}

function fill(text: string, vars?: Record<string, string | number>): string {
  return vars ? text.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : text;
}

export function t(text: string, vars?: Record<string, string | number>): string {
  const entry = dict[text];
  return fill(typeof entry === 'string' && entry ? entry : text, vars);
}

// Plurals: pass the English singular and plural; translations can supply every plural form their
// language has. {n} is filled with the formatted number.
export function tn(n: number, one: string, other: string, vars?: Record<string, string | number>): string {
  const entry = dict[other];
  const all = { ...vars, n: n.toLocaleString(locale.get()) };
  if (entry && typeof entry === 'object') {
    const form = entry[rules.select(n)] ?? entry.other;
    if (form) return fill(form, all);
  }
  return fill(n === 1 ? one : other, all);
}

export function useLocale(): string {
  return useStore(locale);
}

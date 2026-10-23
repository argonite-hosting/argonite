import { Store } from './observable';

export type ThemeChoice = 'system' | 'light' | 'dark';
const KEY = 'argonite-theme';

function initial(): ThemeChoice {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'light' || v === 'dark' ? v : 'system';
  } catch {
    return 'system';
  }
}

export const theme = new Store<ThemeChoice>(initial());

export function setTheme(choice: ThemeChoice): void {
  theme.set(choice);
  const root = document.documentElement;
  if (choice === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', choice);
  try {
    if (choice === 'system') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, choice);
  } catch {
    // Private mode or blocked storage; the choice still applies for this visit.
  }
}

export function resolvedTheme(): 'light' | 'dark' {
  const choice = theme.get();
  if (choice !== 'system') return choice;
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

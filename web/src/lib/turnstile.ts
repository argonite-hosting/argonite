import { TURNSTILE_SITE_KEY } from '../config';

interface TurnstileApi {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
}

declare global {
  interface Window {
    turnstile?: TurnstileApi;
  }
}

let loader: Promise<TurnstileApi> | null = null;

export const turnstileEnabled = !!TURNSTILE_SITE_KEY;

function load(): Promise<TurnstileApi> {
  loader ??= new Promise((resolve, reject) => {
    if (window.turnstile) return resolve(window.turnstile);
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error('Turnstile failed to load')));
    s.onerror = () => {
      loader = null;
      reject(new Error('Could not load the verification challenge. Check ad blockers and try again.'));
    };
    document.head.appendChild(s);
  });
  return loader;
}

export async function mountTurnstile(el: HTMLElement, onToken: (token: string | null) => void): Promise<{ reset(): void; remove(): void }> {
  const api = await load();
  const id = api.render(el, {
    sitekey: TURNSTILE_SITE_KEY,
    theme: 'auto',
    size: 'flexible',
    callback: (t: string) => onToken(t),
    'expired-callback': () => onToken(null),
    'error-callback': () => onToken(null),
  });
  return {
    reset: () => {
      onToken(null);
      api.reset(id);
    },
    remove: () => api.remove(id),
  };
}

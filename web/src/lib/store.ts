import type { Me } from '../../../shared/types';
import { api } from './api';
import { t } from './i18n';
import { Store, useStore } from './observable';

export { Store, useStore };

export interface Session {
  ready: boolean;
  user: Me | null;
}

export const session = new Store<Session>({ ready: false, user: null });

let inflight: Promise<void> | null = null;

export function refreshSession(): Promise<void> {
  inflight ??= api<{ user: Me | null }>('GET', '/api/me')
    .then((r) => session.set({ ready: true, user: r.user }))
    .catch(() => session.set({ ready: true, user: null }))
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useSession(): Session {
  return useStore(session);
}

export function isStaff(user: Me | null): boolean {
  return !!user && (user.role === 'moderator' || user.role === 'admin');
}

export interface Toast {
  id: number;
  kind: 'success' | 'error' | 'info';
  title: string;
  body?: string;
}

export const toasts = new Store<Toast[]>([]);
let toastId = 0;

export function toast(kind: Toast['kind'], title: string, body?: string, ttl = 5000): void {
  const id = ++toastId;
  toasts.set([...toasts.get().slice(-3), { id, kind, title, body }]);
  if (ttl > 0) setTimeout(() => dismissToast(id), ttl);
}

export function dismissToast(id: number): void {
  toasts.set(toasts.get().filter((t) => t.id !== id));
}

export function errorToast(e: unknown, title?: string): void {
  toast('error', title ?? t('Something went wrong'), e instanceof Error ? e.message : String(e), 8000);
}

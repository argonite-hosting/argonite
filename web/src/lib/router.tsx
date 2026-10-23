import type { ComponentChildren, JSX, PartialAnchorHTMLAttributes, TargetedMouseEvent } from 'preact';
import { useEffect, useState } from 'preact/hooks';
import { Store, useStore } from './observable';

export interface Location {
  path: string;
  query: URLSearchParams;
  hash: string;
}

function read(): Location {
  const path = window.location.pathname.replace(/\/+$/, '') || '/';
  return { path, query: new URLSearchParams(window.location.search), hash: window.location.hash };
}

const location = new Store<Location>(read());

window.addEventListener('popstate', () => location.set(read()));

export function navigate(to: string, opts: { replace?: boolean; scroll?: boolean } = {}): void {
  const url = new URL(to, window.location.origin);
  if (url.origin !== window.location.origin) {
    window.location.assign(url.toString());
    return;
  }
  const next = url.pathname + url.search + url.hash;
  const current = window.location.pathname + window.location.search + window.location.hash;
  if (next !== current) {
    if (opts.replace) window.history.replaceState(null, '', next);
    else window.history.pushState(null, '', next);
  }
  location.set(read());
  if (opts.scroll !== false) window.scrollTo({ top: 0 });
}

export function setQuery(params: Record<string, string | null | undefined>, replace = true): void {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(params)) {
    if (v === null || v === undefined || v === '') q.delete(k);
    else q.set(k, v);
  }
  const s = q.toString();
  navigate(window.location.pathname + (s ? `?${s}` : ''), { replace, scroll: false });
}

export function useLocation(): Location {
  return useStore(location);
}

type LinkProps = Omit<PartialAnchorHTMLAttributes<HTMLAnchorElement>, 'role' | 'href'> & { href: string; role?: 'link' | 'menuitem' | 'tab'; children?: ComponentChildren };

export function Link({ href, onClick, ...rest }: LinkProps) {
  const handle = (e: TargetedMouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!href.startsWith('/') || href.startsWith('//')) return;
    e.preventDefault();
    navigate(href);
  };
  return <a href={href} onClick={handle} {...rest} />;
}

export interface Route {
  pattern: RegExp;
  keys: string[];
  load: () => Promise<{ default: (props: { params: Record<string, string> }) => JSX.Element | null }>;
}

export function route(path: string, load: Route['load']): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { pattern: new RegExp(`^${source}$`), keys, load };
}

export function match(routes: Route[], path: string): { route: Route; params: Record<string, string> } | null {
  for (const r of routes) {
    const m = r.pattern.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => {
      try {
        params[k] = decodeURIComponent(m[i + 1]);
      } catch {
        params[k] = m[i + 1];
      }
    });
    return { route: r, params };
  }
  return null;
}

type PageComponent = (props: { params: Record<string, string> }) => JSX.Element | null;
const loaded = new Map<Route, PageComponent>();

export function useRoutePage(routes: Route[], fallback: Route) {
  const loc = useLocation();
  const hit = match(routes, loc.path) ?? { route: fallback, params: {} };
  const [state, setState] = useState<{ route: Route; Page: PageComponent } | null>(() => {
    const ready = loaded.get(hit.route);
    return ready ? { route: hit.route, Page: ready } : null;
  });
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const ready = loaded.get(hit.route);
    if (ready) {
      setState({ route: hit.route, Page: ready });
      return;
    }
    let cancelled = false;
    setFailed(false);
    hit.route
      .load()
      .then((mod) => {
        loaded.set(hit.route, mod.default);
        if (!cancelled) setState({ route: hit.route, Page: mod.default });
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [hit.route]);

  const current = state && state.route === hit.route ? state.Page : null;
  return { Page: current, params: hit.params, failed, path: loc.path };
}

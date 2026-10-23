import type { Env } from '../env';

export interface Ctx {
  request: Request;
  env: Env;
  exec: ExecutionContext;
  url: URL;
  params: Record<string, string>;
}

export type Handler = (ctx: Ctx) => Promise<Response> | Response;

interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

export class Router {
  private routes: Route[] = [];

  on(method: string, pattern: string, handler: Handler): this {
    const keys: string[] = [];
    const source = pattern
      .split('/')
      .map((part) => {
        if (part.startsWith(':')) {
          keys.push(part.slice(1));
          return '([^/]+)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      })
      .join('/');
    this.routes.push({ method, regex: new RegExp(`^${source}/?$`), keys, handler });
    return this;
  }

  get(p: string, h: Handler) {
    return this.on('GET', p, h);
  }
  post(p: string, h: Handler) {
    return this.on('POST', p, h);
  }
  put(p: string, h: Handler) {
    return this.on('PUT', p, h);
  }
  patch(p: string, h: Handler) {
    return this.on('PATCH', p, h);
  }
  delete(p: string, h: Handler) {
    return this.on('DELETE', p, h);
  }

  match(method: string, path: string): { handler: Handler; params: Record<string, string> } | 'method' | null {
    let pathMatched = false;
    for (const route of this.routes) {
      const m = route.regex.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (route.method !== method && !(method === 'HEAD' && route.method === 'GET')) continue;
      const params: Record<string, string> = {};
      route.keys.forEach((k, i) => {
        try {
          params[k] = decodeURIComponent(m[i + 1]);
        } catch {
          params[k] = '';
        }
      });
      return { handler: route.handler, params };
    }
    return pathMatched ? 'method' : null;
  }
}

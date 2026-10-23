import { siteUrl } from './runtime';

export class HttpError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields?: Record<string, string>,
  ) {
    super(message);
  }
}

export const badRequest = (message: string, fields?: Record<string, string>) => new HttpError(400, 'bad_request', message, fields);
export const unauthorized = (message = 'Sign in to continue.') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'You do not have permission to do that.') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Not found.') => new HttpError(404, 'not_found', message);
export const conflict = (message: string) => new HttpError(409, 'conflict', message);

const BASE_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy': "default-src 'none'; frame-ancestors 'none'",
  'Cross-Origin-Resource-Policy': 'cross-origin',
  'Strict-Transport-Security': 'max-age=63072000; includeSubDomains; preload',
};

export function withBaseHeaders(headers: Headers): Headers {
  for (const [k, v] of Object.entries(BASE_HEADERS)) if (!headers.has(k)) headers.set(k, v);
  return headers;
}

export function json(data: unknown, status = 200, extra?: HeadersInit): Response {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  if (!headers.has('Cache-Control')) headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers: withBaseHeaders(headers) });
}

export function errorResponse(err: HttpError): Response {
  return json({ error: err.code, message: err.message, ...(err.fields ? { fields: err.fields } : {}) }, err.status);
}

export function isSiteOrigin(origin: string | null): boolean {
  return origin === siteUrl();
}

// /api and /auth only answer the site itself, with cookies. /v1 is public and cookie-free.
export function applyCors(request: Request, response: Response, mode: 'site' | 'public'): Response {
  const headers = new Headers(response.headers);
  if (mode === 'public') {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Expose-Headers', 'Content-Length, Content-Disposition, X-Argonite-Sha256, X-Argonite-Sha512');
  } else {
    const origin = request.headers.get('Origin');
    if (origin && isSiteOrigin(origin)) {
      headers.set('Access-Control-Allow-Origin', origin);
      headers.set('Access-Control-Allow-Credentials', 'true');
      headers.append('Vary', 'Origin');
    }
  }
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}

export function preflight(request: Request, mode: 'site' | 'public'): Response {
  const headers = new Headers({ 'Access-Control-Max-Age': '600' });
  if (mode === 'public') {
    headers.set('Access-Control-Allow-Origin', '*');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type');
  } else {
    const origin = request.headers.get('Origin');
    if (!origin || !isSiteOrigin(origin)) return new Response(null, { status: 403 });
    headers.set('Access-Control-Allow-Origin', origin);
    headers.set('Access-Control-Allow-Credentials', 'true');
    headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
    headers.set('Access-Control-Allow-Headers', 'Content-Type, X-Requested-With');
    headers.set('Vary', 'Origin');
  }
  return new Response(null, { status: 204, headers: withBaseHeaders(headers) });
}

export async function readJson<T = Record<string, unknown>>(request: Request, maxBytes = 262_144): Promise<T> {
  const type = request.headers.get('Content-Type') ?? '';
  if (!type.toLowerCase().startsWith('application/json')) throw badRequest('Expected a JSON body.');
  const declared = Number(request.headers.get('Content-Length') ?? '0');
  if (declared > maxBytes) throw new HttpError(413, 'too_large', 'Request body is too large.');
  const text = await readTextLimited(request, maxBytes);
  try {
    const parsed = JSON.parse(text);
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('not an object');
    return parsed as T;
  } catch {
    throw badRequest('Malformed JSON body.');
  }
}

export async function readTextLimited(request: Request, maxBytes: number): Promise<string> {
  const bytes = await readBytesLimited(request, maxBytes);
  return new TextDecoder().decode(bytes);
}

export async function readBytesLimited(request: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  if (!request.body) return new Uint8Array(0);
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new HttpError(413, 'too_large', 'Request body is too large.');
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

export function clientIp(request: Request): string {
  return request.headers.get('CF-Connecting-IP') ?? '0.0.0.0';
}

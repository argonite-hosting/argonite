import type { ApiError as ApiErrorBody } from '../../../shared/types';
import { API_URL } from '../config';
import { t } from './i18n';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public fields: Record<string, string> = {},
  ) {
    super(message);
  }
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = null;
    }
  }
  if (!res.ok) {
    const body = (data ?? {}) as Partial<ApiErrorBody>;
    throw new ApiError(res.status, body.error ?? 'error', body.message ?? `Request failed (${res.status}).`, body.fields ?? {});
  }
  return data as T;
}

function networkError(): ApiError {
  return new ApiError(0, 'network', t('Could not reach the server. Check your connection and try again.'));
}

// Public reads never send cookies, so they're cacheable and safe to embed anywhere.
// Public reads are cached for 30 seconds (at Cloudflare and in the browser). After you change
// something, your own reads skip those caches for a few minutes so you see your edit straight away;
// everyone else catches up when the cache expires.
const FRESH_KEY = 'argonite-fresh';
const FRESH_MS = 5 * 60_000;

function markFresh(): void {
  try {
    sessionStorage.setItem(FRESH_KEY, String(Date.now()));
  } catch {
    // Storage blocked: reads simply stay cached.
  }
}

function freshStamp(): string | null {
  try {
    const at = Number(sessionStorage.getItem(FRESH_KEY));
    return at && Date.now() - at < FRESH_MS ? String(at) : null;
  } catch {
    return null;
  }
}

export async function pub<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  const stamp = !init?.method || init.method === 'GET' ? freshStamp() : null;
  const url = stamp ? `${API_URL}${path}${path.includes('?') ? '&' : '?'}_fresh=${stamp}` : API_URL + path;
  try {
    res = await fetch(url, { ...init, ...(stamp ? { cache: 'no-store' as RequestCache } : {}), credentials: 'omit' });
  } catch {
    throw networkError();
  }
  return parse<T>(res);
}

export async function api<T>(method: string, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'X-Requested-With': 'argonite' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(API_URL + path, {
      method,
      credentials: 'include',
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal,
    });
  } catch (e) {
    if ((e as Error).name === 'AbortError') throw e;
    throw networkError();
  }
  const out = await parse<T>(res);
  if (method !== 'GET') markFresh();
  return out;
}

export interface UploadProgress {
  loaded: number;
  total: number;
}

// fetch() still can't report upload progress, so file uploads go through XHR.
export function upload<T>(method: string, path: string, body: Blob, onProgress: (p: UploadProgress) => void, contentType = 'application/octet-stream'): Promise<T> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(method, API_URL + path);
    xhr.withCredentials = true;
    xhr.setRequestHeader('X-Requested-With', 'argonite');
    xhr.setRequestHeader('Content-Type', contentType);
    xhr.upload.onprogress = (e) => onProgress({ loaded: e.loaded, total: e.lengthComputable ? e.total : body.size });
    xhr.onerror = () => reject(networkError());
    xhr.onabort = () => reject(new ApiError(0, 'aborted', t('Upload cancelled.')));
    xhr.onload = () => {
      const res = new Response(xhr.responseText, { status: xhr.status });
      parse<T>(res).then((v) => {
        markFresh();
        resolve(v);
      }, reject);
    };
    xhr.send(body);
  });
}

export function loginUrl(returnTo: string): string {
  return `${API_URL}/auth/login?return=${encodeURIComponent(returnTo)}`;
}

export function downloadUrl(versionId: string): string {
  return `${API_URL}/v1/download/${versionId}`;
}

export function fileDownloadUrl(fileId: string): string {
  return `${API_URL}/v1/download/file/${fileId}`;
}

// Images from authors' repositories come with the SHA-256 recorded when they were stored, as
// "#sha256=<hex>" on the URL. They're fetched, checked and shown from memory, so a file changed on
// GitHub never reaches the page. Links without a hash are never shown.
import { useEffect, useState } from 'preact/hooks';

const cache = new Map<string, Promise<string | null>>();

function hex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function load(url: string): Promise<string | null> {
  const at = url.indexOf('#sha256=');
  const expected = at > 0 ? url.slice(at + 8).toLowerCase() : '';
  if (!/^[0-9a-f]{64}$/.test(expected)) return null;
  try {
    const res = await fetch(url.slice(0, at), { credentials: 'omit', referrerPolicy: 'no-referrer' });
    if (!res.ok) return null;
    const buf = await res.arrayBuffer();
    if (hex(await crypto.subtle.digest('SHA-256', buf)) !== expected) return null;
    const type = res.headers.get('Content-Type') ?? '';
    return URL.createObjectURL(new Blob([buf], type.startsWith('image/') ? { type } : {}));
  } catch {
    return null;
  }
}

export function verifiedImage(url: string): Promise<string | null> {
  let pending = cache.get(url);
  if (!pending) {
    pending = load(url);
    cache.set(url, pending);
  }
  return pending;
}

// undefined while checking, null when missing or not matching, otherwise a URL safe to show.
export function useVerifiedImage(url: string | null | undefined): string | null | undefined {
  const [src, setSrc] = useState<string | null | undefined>(url ? undefined : null);
  useEffect(() => {
    if (!url) {
      setSrc(null);
      return;
    }
    let alive = true;
    setSrc(undefined);
    verifiedImage(url).then((s) => alive && setSrc(s));
    return () => {
      alive = false;
    };
  }, [url]);
  return src;
}

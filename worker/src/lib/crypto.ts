const CROCKFORD = '0123456789abcdefghjkmnpqrstvwxyz';
const enc = new TextEncoder();

export function newId(now = Date.now()): string {
  let time = '';
  let t = now;
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rand = crypto.getRandomValues(new Uint8Array(16));
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rand[i] % 32];
  return time + tail;
}

export function bytesToB64url(bytes: Uint8Array): string {
  return bytesToB64(bytes).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function b64urlToBytes(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4);
  return b64ToBytes(b64);
}

export function bytesToB64(bytes: Uint8Array): string {
  let bin = '';
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function b64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export function randomToken(bytes = 32): string {
  return bytesToB64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(input: string | Uint8Array<ArrayBuffer>): Promise<string> {
  const data = typeof input === 'string' ? enc.encode(input) : input;
  return toHex(await crypto.subtle.digest('SHA-256', data));
}

export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return toHex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function aesKey(secretB64: string): Promise<CryptoKey> {
  const raw = b64ToBytes(secretB64);
  if (raw.length !== 32) throw new Error('TOKEN_ENCRYPTION_KEY must be 32 bytes of base64');
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

export async function seal(secretB64: string, plaintext: string, aad = ''): Promise<string> {
  const key = await aesKey(secretB64);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(aad) }, key, enc.encode(plaintext));
  return `v1.${bytesToB64url(iv)}.${bytesToB64url(new Uint8Array(ct))}`;
}

export async function open(secretB64: string, sealed: string, aad = ''): Promise<string | null> {
  const [v, ivPart, ctPart] = sealed.split('.');
  if (v !== 'v1' || !ivPart || !ctPart) return null;
  try {
    const key = await aesKey(secretB64);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: b64urlToBytes(ivPart), additionalData: enc.encode(aad) },
      key,
      b64urlToBytes(ctPart),
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function pkceChallenge(verifier: string): Promise<string> {
  return bytesToB64url(new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(verifier))));
}

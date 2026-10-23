// Checks the identity tokens GitHub Actions issues to a running workflow. The sandbox machines prove
// who they are with one, so they hold no secret that a mod running on them could steal.
import { b64urlToBytes } from './crypto';
import { actionsJwksUrl } from './runtime';

export const ACTIONS_ISSUER = 'https://token.actions.githubusercontent.com';
const KEY_TTL_MS = 60 * 60 * 1000;
const REFETCH_GAP_MS = 5 * 60 * 1000;
const SKEW_S = 60;

export interface ActionsClaims {
  iss: string;
  aud: string | string[];
  exp: number;
  nbf?: number;
  iat: number;
  repository: string;
  repository_id: string;
  repository_owner_id: string;
  workflow_ref: string;
  ref: string;
  event_name: string;
  run_id: string;
  run_attempt: string;
  runner_environment: string;
}

interface Jwk {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
}

let cache: { at: number; keys: Map<string, CryptoKey> } | null = null;
let lastFetch = 0;

async function loadKeys(fetcher: typeof fetch): Promise<Map<string, CryptoKey>> {
  lastFetch = Date.now();
  const res = await fetcher(actionsJwksUrl(), { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`jwks ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  const keys = new Map<string, CryptoKey>();
  for (const k of body.keys ?? []) {
    if (k.kty !== 'RSA' || !k.kid || !k.n || !k.e) continue;
    keys.set(k.kid, await crypto.subtle.importKey('jwk', { kty: 'RSA', n: k.n, e: k.e, alg: 'RS256', ext: true }, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']));
  }
  cache = { at: Date.now(), keys };
  return keys;
}

async function keyFor(kid: string, fetcher: typeof fetch): Promise<CryptoKey | null> {
  const fresh = cache && Date.now() - cache.at < KEY_TTL_MS;
  if (fresh && cache!.keys.has(kid)) return cache!.keys.get(kid)!;
  // An unknown key id refetches the set, but not more often than every few minutes.
  if (fresh && Date.now() - lastFetch < REFETCH_GAP_MS) return null;
  return (await loadKeys(fetcher)).get(kid) ?? null;
}

export function resetActionsKeys(): void {
  cache = null;
  lastFetch = 0;
}

function decodePart<T>(part: string): T {
  return JSON.parse(new TextDecoder().decode(b64urlToBytes(part))) as T;
}

// Returns the token's claims when it's a valid, unexpired token from GitHub Actions for this audience.
export async function verifyActionsToken(token: string, audience: string, fetcher: typeof fetch = fetch): Promise<ActionsClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3 || token.length > 8192) return null;
  let header: { alg?: string; kid?: string; typ?: string };
  let claims: ActionsClaims;
  try {
    header = decodePart(parts[0]);
    claims = decodePart(parts[1]);
  } catch {
    return null;
  }
  if (header.alg !== 'RS256' || typeof header.kid !== 'string') return null;
  const key = await keyFor(header.kid, fetcher);
  if (!key) return null;
  const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, b64urlToBytes(parts[2]), new TextEncoder().encode(`${parts[0]}.${parts[1]}`));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  const auds = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (claims.iss !== ACTIONS_ISSUER || !auds.includes(audience)) return null;
  if (typeof claims.exp !== 'number' || claims.exp < now - SKEW_S) return null;
  if (typeof claims.nbf === 'number' && claims.nbf > now + SKEW_S) return null;
  if (typeof claims.iat !== 'number' || claims.iat > now + SKEW_S) return null;
  return claims;
}

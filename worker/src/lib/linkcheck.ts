// Checks links users publish against known malware and phishing lists before they're saved.
//
// - Every site is looked up through Cloudflare's malware-blocking resolver (1.1.1.2), which answers
//   0.0.0.0 for domains on its threat lists.
// - With URLHAUS_KEY set, abuse.ch URLhaus is asked about the site and, for big shared hosts such as
//   GitHub where one bad file says nothing about the rest, about the exact URL.
// Verdicts are cached in D1 and refreshed in the background, so most saves need no lookups at all.
import type { Env } from '../env';
import { sha256Hex } from './crypto';
import { HttpError, badRequest } from './http';

const OK_FOR = 7 * 86_400_000;
const BAD_FOR = 30 * 86_400_000;
const MAX_SITES = 40;
// New lookups per save; anything past this is saved as unknown and checked within minutes.
const MAX_LOOKUPS = 15;
const TIMEOUT_MS = 3000;

// Large shared hosts: their domains are never on blocklists, so only the exact URLs are checked.
const SHARED_HOSTS = new Set([
  'github.com', 'raw.githubusercontent.com', 'objects.githubusercontent.com', 'user-images.githubusercontent.com', 'gist.github.com', 'gist.githubusercontent.com',
  'gitlab.com', 'bitbucket.org', 'codeberg.org', 'modrinth.com', 'cdn.modrinth.com', 'curseforge.com', 'www.curseforge.com', 'mediafilez.forgecdn.net', 'edge.forgecdn.net',
  'youtube.com', 'www.youtube.com', 'youtu.be', 'www.youtube-nocookie.com', 'discord.gg', 'discord.com', 'cdn.discordapp.com', 'media.discordapp.net',
  'imgur.com', 'i.imgur.com', 'drive.google.com', 'docs.google.com', 'dropbox.com', 'www.dropbox.com', 'mediafire.com', 'www.mediafire.com',
  'patreon.com', 'www.patreon.com', 'ko-fi.com', 'paypal.com', 'www.paypal.com', 'buymeacoffee.com', 'www.buymeacoffee.com',
  'minecraft.net', 'www.minecraft.net', 'minecraft.wiki', 'en.wikipedia.org', 'twitter.com', 'x.com', 'reddit.com', 'www.reddit.com', 'twitch.tv', 'www.twitch.tv',
]);

// Browsers accept https:/x, https:\\x and https:///x as well, so any run of slashes counts.
const URL_IN_TEXT = /\bhttps?:[/\\]+[^\s<>"'`)\]]+|\bwww\.[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s<>"'`)\]]*/gi;
const NAMED: Record<string, string> = { colon: ':', sol: '/', bsol: '\\', period: '.', dot: '.', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", lpar: '(', rpar: ')', commat: '@', num: '#' };

// Undo HTML character references, which browsers decode inside href and src before following them.
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);?/gi, (m, ref: string) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' || ref[1] === 'X' ? Number.parseInt(ref.slice(2), 16) : Number.parseInt(ref.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return NAMED[ref.toLowerCase()] ?? m;
  });
}

export interface BadLink {
  url: string;
  host: string;
}

function normalise(raw: string): URL | null {
  try {
    const fixed = raw.replace(/^(https?):[/\\]+/i, '$1://').replace(/\\/g, '/');
    const url = new URL(/^https?:\/\//i.test(fixed) ? fixed : `https://${fixed}`);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    url.hash = '';
    url.hostname = url.hostname.replace(/\.$/, '').toLowerCase();
    return url;
  } catch {
    return null;
  }
}

export function extractLinks(...texts: (string | null | undefined)[]): URL[] {
  const seen = new Map<string, URL>();
  for (const text of texts) {
    for (const m of decodeEntities(text ?? '').matchAll(URL_IN_TEXT)) {
      const url = normalise(m[0].replace(/[.,;:!?]+$/, ''));
      if (url && !seen.has(url.href)) seen.set(url.href, url);
    }
  }
  return [...seen.values()];
}

async function timed(input: string, init?: RequestInit): Promise<Response> {
  return fetch(input, { ...init, signal: AbortSignal.timeout(TIMEOUT_MS) });
}

// 'bad' or 'ok', or null when the lookup itself failed.
async function cloudflareVerdict(host: string): Promise<'ok' | 'bad' | null> {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host) || host.includes(':')) return 'ok';
  try {
    const res = await timed(`https://security.cloudflare-dns.com/dns-query?name=${encodeURIComponent(host)}&type=A`, { headers: { Accept: 'application/dns-json' } });
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
    return data.Answer?.some((a) => a.type === 1 && a.data === '0.0.0.0') ? 'bad' : 'ok';
  } catch {
    return null;
  }
}

async function urlhaus(env: Env, kind: 'host' | 'url', value: string): Promise<'ok' | 'bad' | null> {
  if (!env.URLHAUS_KEY) return 'ok';
  try {
    const res = await timed(`https://urlhaus-api.abuse.ch/v1/${kind}/`, {
      method: 'POST',
      headers: { 'Auth-Key': env.URLHAUS_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ [kind]: value }).toString(),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { query_status?: string; url_status?: string; urls?: { url_status?: string }[] };
    if (data.query_status === 'no_results' || data.query_status === 'invalid_url' || data.query_status === 'invalid_host') return 'ok';
    if (data.query_status !== 'ok') return null;
    if (kind === 'url') return data.url_status === 'online' || data.url_status === 'unknown' ? 'bad' : 'ok';
    return data.urls?.some((u) => u.url_status === 'online') ? 'bad' : 'ok';
  } catch {
    return null;
  }
}

interface Target {
  key: string;
  kind: 'host' | 'url';
  value: string;
}

async function lookup(env: Env, t: Target): Promise<{ verdict: 'ok' | 'bad' | 'unknown'; source: string | null }> {
  if (t.kind === 'url') {
    const v = await urlhaus(env, 'url', t.value);
    return v === 'bad' ? { verdict: 'bad', source: 'urlhaus' } : { verdict: v ?? 'unknown', source: null };
  }
  const [cf, uh] = await Promise.all([cloudflareVerdict(t.value), urlhaus(env, 'host', t.value)]);
  if (cf === 'bad') return { verdict: 'bad', source: 'cloudflare' };
  if (uh === 'bad') return { verdict: 'bad', source: 'urlhaus' };
  return { verdict: cf === null || uh === null ? 'unknown' : 'ok', source: null };
}

async function targetsFor(urls: URL[]): Promise<{ target: Target; url: URL }[]> {
  const out = new Map<string, { target: Target; url: URL }>();
  for (const url of urls) {
    const host = url.hostname;
    if (SHARED_HOSTS.has(host)) {
      const key = `u:${await sha256Hex(url.href)}`;
      if (!out.has(key)) out.set(key, { target: { key, kind: 'url', value: url.href }, url });
    } else {
      const key = `h:${host}`;
      if (!out.has(key)) out.set(key, { target: { key, kind: 'host', value: host }, url });
    }
  }
  return [...out.values()];
}

// Unknown verdicts are stored as checked long ago, so the background job picks them up first.
function save(env: Env, t: Target, verdict: string, source: string | null): D1PreparedStatement {
  return env.DB.prepare(
    `INSERT INTO link_checks (key, kind, value, verdict, source, checked_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET verdict = excluded.verdict, source = excluded.source, checked_at = excluded.checked_at`,
  ).bind(t.key, t.kind, t.value, verdict, source, verdict === 'unknown' ? 0 : Date.now());
}

// Returns the links that are known to be malicious. Lookups that fail don't block the save; they're
// recorded as unknown and retried in the background.
export async function findBadLinks(env: Env, urls: URL[]): Promise<BadLink[]> {
  const targets = await targetsFor(urls);
  if (!targets.length) return [];
  const sites = new Set(targets.map((t) => t.url.hostname));
  if (sites.size > MAX_SITES) throw badRequest(`Link to at most ${MAX_SITES} different websites.`);
  const rows = await env.DB.prepare('SELECT key, verdict, checked_at FROM link_checks WHERE key IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify(targets.map((t) => t.target.key)))
    .all<{ key: string; verdict: string; checked_at: number }>();
  const cached = new Map(rows.results.map((r) => [r.key, r]));
  const now = Date.now();
  const bad: BadLink[] = [];
  const writes: D1PreparedStatement[] = [];
  let lookups = 0;
  await Promise.all(
    targets.map(async ({ target, url }) => {
      const hit = cached.get(target.key);
      let verdict = hit?.verdict;
      const fresh = hit && (hit.verdict === 'bad' ? now - hit.checked_at < BAD_FOR : hit.verdict === 'ok' && now - hit.checked_at < OK_FOR);
      if (!fresh) {
        if (lookups++ < MAX_LOOKUPS) {
          const result = await lookup(env, target);
          verdict = result.verdict;
          writes.push(save(env, target, result.verdict, result.source));
        } else if (!hit) writes.push(save(env, target, 'unknown', null));
      }
      if (verdict === 'bad') bad.push({ url: url.href, host: url.hostname });
    }),
  );
  if (writes.length) await env.DB.batch(writes);
  return bad;
}

// Throws a 400 naming the first bad link, so the author can remove it.
export async function assertSafeLinks(env: Env, field: string, ...texts: (string | null | undefined)[]): Promise<void> {
  const bad = await findBadLinks(env, extractLinks(...texts));
  if (bad.length) {
    throw new HttpError(400, 'malicious_link', `The link to ${bad[0].host} is on a list of known malware or phishing sites. Remove it to save.`, { [field]: `Blocked link: ${bad[0].host}` });
  }
}

// Re-checks the oldest verdicts so links that turn bad after they were saved get caught.
export async function refreshLinkChecks(env: Env, max = 20): Promise<void> {
  const due = await env.DB.prepare("SELECT key, kind, value FROM link_checks WHERE checked_at < ? OR verdict = 'unknown' ORDER BY checked_at LIMIT ?")
    .bind(Date.now() - OK_FOR, max)
    .all<Target>();
  const writes: D1PreparedStatement[] = [];
  for (const t of due.results) {
    const { verdict, source } = await lookup(env, t);
    writes.push(save(env, t, verdict, source));
  }
  if (writes.length) await env.DB.batch(writes);
}

// What the site needs to disable links that were found bad after they were published.
export async function blockedLinks(env: Env): Promise<{ hosts: string[]; urls: string[] }> {
  const rows = await env.DB.prepare("SELECT kind, value FROM link_checks WHERE verdict = 'bad' LIMIT 5000").all<{ kind: string; value: string }>();
  return {
    hosts: rows.results.filter((r) => r.kind === 'host').map((r) => r.value),
    urls: rows.results.filter((r) => r.kind === 'url').map((r) => r.value),
  };
}

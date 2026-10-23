import { SITE } from '../../../shared/config';
import { adminIds } from '../env';
import { open, pkceChallenge, randomToken, safeEqual, seal } from '../lib/crypto';
import { authorizeUrl, exchangeCode, gh, storeTokens, type GitHubUser } from '../lib/github';
import { assertSameSite, rateLimit } from '../lib/guard';
import { clientIp, json } from '../lib/http';
import { apiUrl, siteUrl } from '../lib/runtime';
import { newId } from '../lib/crypto';
import type { Ctx, Router } from '../lib/router';
import { OAUTH_COOKIE, cookie, createSession, destroySession, parseCookies } from '../lib/session';

const STATE_TTL_MS = 10 * 60 * 1000;

interface OAuthState {
  state: string;
  verifier: string;
  returnTo: string;
  exp: number;
}

export function safeReturnPath(raw: string | null): string {
  if (!raw || raw.length > 300) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\') || /[\u0000-\u001f]/.test(raw)) return '/';
  return raw;
}

function redirect(location: string, cookies: string[] = []): Response {
  const headers = new Headers({ Location: location, 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer' });
  for (const c of cookies) headers.append('Set-Cookie', c);
  return new Response(null, { status: 303, headers });
}

async function login(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_AUTH, `login:${clientIp(ctx.request)}`);
  const verifier = randomToken(48);
  const payload: OAuthState = {
    state: randomToken(24),
    verifier,
    returnTo: safeReturnPath(ctx.url.searchParams.get('return')),
    exp: Date.now() + STATE_TTL_MS,
  };
  const sealed = await seal(ctx.env.TOKEN_ENCRYPTION_KEY, JSON.stringify(payload), 'oauth-state');
  const redirectUri = `${apiUrl()}/auth/callback`;
  // Lax, because GitHub sends the user back with a cross-site top-level navigation.
  return redirect(authorizeUrl(ctx.env, redirectUri, payload.state, await pkceChallenge(verifier)), [
    cookie(OAUTH_COOKIE, sealed, STATE_TTL_MS / 1000, 'Lax'),
  ]);
}

async function callback(ctx: Ctx): Promise<Response> {
  const site = siteUrl();
  const clear = cookie(OAUTH_COOKIE, '', 0, 'Lax');
  const fail = (reason: string) => redirect(`${site}/auth/error?reason=${encodeURIComponent(reason)}`, [clear]);

  await rateLimit(ctx.env.RL_AUTH, `callback:${clientIp(ctx.request)}`);
  const raw = parseCookies(ctx.request.headers.get('Cookie')).get(OAUTH_COOKIE);
  const opened = raw ? await open(ctx.env.TOKEN_ENCRYPTION_KEY, raw, 'oauth-state') : null;
  if (!opened) return fail('expired');
  const st = JSON.parse(opened) as OAuthState;
  const state = ctx.url.searchParams.get('state') ?? '';
  if (st.exp < Date.now() || !safeEqual(state, st.state)) return fail('state');
  if (ctx.url.searchParams.get('error')) return fail('denied');
  const code = ctx.url.searchParams.get('code');
  if (!code || code.length > 200) return fail('code');

  let tokens;
  let ghUser: GitHubUser;
  try {
    tokens = await exchangeCode(ctx.env, code, st.verifier, `${apiUrl()}/auth/callback`);
    ghUser = await gh<GitHubUser>(tokens.access_token!, 'GET', '/user');
  } catch {
    return fail('github');
  }

  const now = Date.now();
  const avatar = /^https:\/\/avatars\.githubusercontent\.com\//.test(ghUser.avatar_url)
    ? ghUser.avatar_url
    : `https://avatars.githubusercontent.com/u/${ghUser.id}?v=4`;
  const login = ghUser.login;
  const existing = await ctx.env.DB.prepare('SELECT id FROM users WHERE github_id = ?').bind(ghUser.id).first<{ id: string }>();
  const userId = existing?.id ?? newId();
  const installationId = await findInstallationId(tokens.access_token!);

  await ctx.env.DB.batch([
    // GitHub logins can be released and claimed by someone else; the newest holder wins the handle.
    ctx.env.DB.prepare("UPDATE users SET username_lower = '~' || github_id WHERE username_lower = ? AND github_id != ?").bind(
      login.toLowerCase(),
      ghUser.id,
    ),
    existing
      ? ctx.env.DB.prepare(
          'UPDATE users SET username = ?, username_lower = ?, avatar_url = ?, installation_id = COALESCE(?, installation_id), updated_at = ? WHERE id = ?',
        ).bind(login, login.toLowerCase(), avatar, installationId, now, userId)
      : ctx.env.DB.prepare(
          `INSERT INTO users (id, github_id, username, username_lower, display_name, avatar_url, github_created_at, installation_id, role, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          userId,
          ghUser.id,
          login,
          login.toLowerCase(),
          ghUser.name ? ghUser.name.slice(0, 64) : null,
          avatar,
          Date.parse(ghUser.created_at) || now,
          installationId,
          adminIds(ctx.env).includes(ghUser.id) ? 'admin' : 'user',
          now,
          now,
        ),
  ]);
  await storeTokens(ctx.env, userId, tokens);
  const sessionCookie = await createSession(ctx.env, userId);
  return redirect(`${site}${st.returnTo}`, [clear, sessionCookie]);
}

async function findInstallationId(token: string): Promise<number | null> {
  try {
    const data = await gh<{ installations: { id: number; app_slug: string }[] }>(token, 'GET', '/user/installations?per_page=100');
    return data.installations.find((i) => i.app_slug === SITE.github.appSlug)?.id ?? null;
  } catch {
    return null;
  }
}

async function logout(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const cleared = await destroySession(ctx.env, ctx.request);
  return json({ ok: true }, 200, { 'Set-Cookie': cleared });
}

export function authRoutes(r: Router): void {
  r.get('/auth/login', login);
  r.get('/auth/callback', callback);
  r.post('/auth/logout', logout);
}

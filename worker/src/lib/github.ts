import { SITE } from '../../../shared/config';
import type { Env } from '../env';
import { open, seal } from './crypto';
import { HttpError } from './http';
import { githubApi, rawBase } from './runtime';

const UA = `${SITE.name}-API`;
const REFRESH_SKEW_MS = 5 * 60 * 1000;

export class GitHubError extends HttpError {
  constructor(
    public ghStatus: number,
    message: string,
  ) {
    super(ghStatus === 401 ? 401 : 502, ghStatus === 401 ? 'github_reauth' : 'github_error', message);
  }
}

export interface GitHubUser {
  id: number;
  login: string;
  name: string | null;
  avatar_url: string;
  created_at: string;
}

export interface GitHubRepo {
  id: number;
  full_name: string;
  html_url: string;
  private: boolean;
  archived: boolean;
  disabled: boolean;
  default_branch: string;
  size: number;
  owner: { id: number; login: string; type: string };
  permissions?: { admin: boolean; push: boolean; pull: boolean };
}

export interface GitHubRelease {
  id: number;
  tag_name: string;
  name: string | null;
  body: string | null;
  draft: boolean;
  prerelease: boolean;
  html_url: string;
  upload_url: string;
  assets: { id: number; name: string; size: number; state: string }[];
}

interface TokenResponse {
  access_token?: string;
  expires_in?: number;
  refresh_token?: string;
  refresh_token_expires_in?: number;
  error?: string;
  error_description?: string;
}

export function ghHeaders(token: string | null, extra?: Record<string, string>): Record<string, string> {
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': UA,
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}

export async function gh<T>(token: string | null, method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path.startsWith('https://') ? path : `${githubApi()}${path}`, {
    method,
    headers: ghHeaders(token, body !== undefined ? { 'Content-Type': 'application/json' } : undefined),
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 204) return undefined as T;
  const text = await res.text();
  let data: unknown = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }
  if (!res.ok) {
    const msg = (data as { message?: string } | null)?.message ?? `GitHub returned ${res.status}`;
    throw new GitHubError(res.status, githubMessage(res.status, msg));
  }
  return data as T;
}

export function githubMessage(status: number, msg: string): string {
  if (status === 401) return 'Your GitHub session expired. Sign in again.';
  if (status === 403 && /rate limit/i.test(msg)) return 'GitHub is rate limiting requests right now. Try again in a few minutes.';
  if (status === 403 || status === 404) return `GitHub refused the request: ${msg}. Make sure the ${SITE.name} app is installed on this repository.`;
  if (status === 422) return `GitHub rejected the request: ${msg}`;
  return `GitHub error: ${msg}`;
}

export function authorizeUrl(env: Env, redirectUri: string, state: string, challenge: string): string {
  const u = new URL('https://github.com/login/oauth/authorize');
  u.searchParams.set('client_id', env.GITHUB_CLIENT_ID);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return u.toString();
}

async function tokenRequest(env: Env, params: Record<string, string>): Promise<TokenResponse> {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: { Accept: 'application/json', 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ client_id: env.GITHUB_CLIENT_ID, client_secret: env.GITHUB_CLIENT_SECRET, ...params }),
  });
  if (!res.ok) throw new GitHubError(502, 'GitHub sign-in failed.');
  return (await res.json()) as TokenResponse;
}

export async function exchangeCode(env: Env, code: string, verifier: string, redirectUri: string): Promise<TokenResponse> {
  const t = await tokenRequest(env, { code, code_verifier: verifier, redirect_uri: redirectUri });
  if (!t.access_token) throw new HttpError(400, 'oauth_failed', t.error_description ?? 'GitHub sign-in failed.');
  return t;
}

export async function storeTokens(env: Env, userId: string, t: TokenResponse): Promise<void> {
  const now = Date.now();
  await env.DB.prepare(
    `INSERT INTO github_tokens (user_id, access_token, access_expires_at, refresh_token, refresh_expires_at, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
     ON CONFLICT(user_id) DO UPDATE SET access_token = ?2, access_expires_at = ?3, refresh_token = ?4, refresh_expires_at = ?5, updated_at = ?6`,
  )
    .bind(
      userId,
      await seal(env.TOKEN_ENCRYPTION_KEY, t.access_token!, `gh-access:${userId}`),
      t.expires_in ? now + t.expires_in * 1000 : null,
      t.refresh_token ? await seal(env.TOKEN_ENCRYPTION_KEY, t.refresh_token, `gh-refresh:${userId}`) : null,
      t.refresh_token_expires_in ? now + t.refresh_token_expires_in * 1000 : null,
      now,
    )
    .run();
}

interface TokenRow {
  access_token: string;
  access_expires_at: number | null;
  refresh_token: string | null;
  refresh_expires_at: number | null;
  updated_at: number;
}

const reauth = () => new HttpError(401, 'github_reauth', 'Your GitHub session expired. Sign out and sign in again.');

export async function userToken(env: Env, userId: string): Promise<string> {
  const row = await env.DB.prepare('SELECT * FROM github_tokens WHERE user_id = ?').bind(userId).first<TokenRow>();
  if (!row) throw reauth();
  const now = Date.now();
  if (!row.access_expires_at || row.access_expires_at - REFRESH_SKEW_MS > now) {
    const token = await open(env.TOKEN_ENCRYPTION_KEY, row.access_token, `gh-access:${userId}`);
    if (!token) throw reauth();
    return token;
  }
  if (!row.refresh_token || (row.refresh_expires_at && row.refresh_expires_at < now)) throw reauth();
  const refresh = await open(env.TOKEN_ENCRYPTION_KEY, row.refresh_token, `gh-refresh:${userId}`);
  if (!refresh) throw reauth();
  const t = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refresh });
  if (!t.access_token) {
    // Another request may have rotated the refresh token a moment ago; use theirs if so.
    const latest = await env.DB.prepare('SELECT * FROM github_tokens WHERE user_id = ?').bind(userId).first<TokenRow>();
    if (latest && latest.updated_at > row.updated_at && latest.access_expires_at && latest.access_expires_at > now) {
      const token = await open(env.TOKEN_ENCRYPTION_KEY, latest.access_token, `gh-access:${userId}`);
      if (token) return token;
    }
    throw reauth();
  }
  await storeTokens(env, userId, t);
  return t.access_token;
}

export async function revokeGrant(env: Env, accessToken: string): Promise<void> {
  await fetch(`${githubApi()}/applications/${env.GITHUB_CLIENT_ID}/grant`, {
    method: 'DELETE',
    headers: {
      ...ghHeaders(null),
      Authorization: `Basic ${btoa(`${env.GITHUB_CLIENT_ID}:${env.GITHUB_CLIENT_SECRET}`)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ access_token: accessToken }),
  }).catch(() => undefined);
}

export function getRepo(token: string, repoId: number): Promise<GitHubRepo> {
  return gh<GitHubRepo>(token, 'GET', `/repositories/${repoId}`);
}

// Resolve the repo fresh every time so renames and transfers never point us at the wrong place.
export async function writableRepo(token: string, repoId: number): Promise<GitHubRepo> {
  const repo = await getRepo(token, repoId);
  if (repo.id !== repoId) throw new HttpError(409, 'repo_changed', 'The linked repository changed. Relink it in project settings.');
  if (repo.private) throw new HttpError(409, 'repo_private', 'The linked repository is private. Make it public so downloads work.');
  if (repo.archived || repo.disabled) throw new HttpError(409, 'repo_archived', 'The linked repository is archived.');
  if (!repo.permissions?.push) throw new HttpError(403, 'repo_forbidden', 'You need write access to the linked repository.');
  return repo;
}

export function repoPath(repo: Pick<GitHubRepo, 'full_name'>): string {
  const [owner, name] = repo.full_name.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

export async function dispatchScan(env: Env, jobId?: string): Promise<boolean> {
  if (!env.SCANNER_DISPATCH_TOKEN) {
    console.error(JSON.stringify({ dispatch: 'scan', error: 'SCANNER_DISPATCH_TOKEN is not set' }));
    return false;
  }
  const [owner, repo] = SITE.github.sourceRepo.split('/');
  const res = await fetch(`${githubApi()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`, {
    method: 'POST',
    headers: ghHeaders(env.SCANNER_DISPATCH_TOKEN, { 'Content-Type': 'application/json' }),
    body: JSON.stringify({ event_type: 'argonite-scan', client_payload: jobId ? { job_id: jobId } : {} }),
  });
  if (res.status !== 204) console.error(JSON.stringify({ dispatch: 'scan', status: res.status, body: (await res.text()).slice(0, 300) }));
  return res.status === 204;
}

export function rawUrl(fullName: string, commit: string, path: string): string {
  return `${rawBase()}/${fullName}/${commit}/${path}`;
}

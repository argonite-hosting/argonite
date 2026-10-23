import type { Role } from '../../../shared/types';
import { adminIds, type Env } from '../env';
import { randomToken, sha256Hex } from './crypto';
import { forbidden, unauthorized } from './http';
import type { Ctx } from './router';

export const SESSION_COOKIE = '__Host-argonite_session';
export const OAUTH_COOKIE = '__Host-argonite_oauth';
const SESSION_TTL_MS = 30 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 24 * 3600 * 1000;

export interface SessionUser {
  id: string;
  githubId: number;
  username: string;
  displayName: string | null;
  avatarUrl: string;
  bio: string | null;
  role: Role;
  banned: boolean;
  githubCreatedAt: number;
  approvedUploads: number;
  installationId: number | null;
  createdAt: number;
}

export interface UserRow {
  id: string;
  github_id: number;
  username: string;
  display_name: string | null;
  avatar_url: string;
  bio: string | null;
  role: Role;
  banned: number;
  github_created_at: number;
  approved_uploads: number;
  installation_id: number | null;
  created_at: number;
}

export function userFromRow(row: UserRow, env: Env): SessionUser {
  return {
    id: row.id,
    githubId: row.github_id,
    username: row.username,
    displayName: row.display_name,
    avatarUrl: row.avatar_url,
    bio: row.bio,
    role: adminIds(env).includes(row.github_id) ? 'admin' : row.role,
    banned: row.banned === 1,
    githubCreatedAt: row.github_created_at,
    approvedUploads: row.approved_uploads,
    installationId: row.installation_id,
    createdAt: row.created_at,
  };
}

export function parseCookies(header: string | null): Map<string, string> {
  const out = new Map<string, string>();
  if (!header) return out;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out.set(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return out;
}

export function cookie(name: string, value: string, maxAgeSeconds: number, sameSite: 'Strict' | 'Lax' = 'Strict'): string {
  return `${name}=${value}; Path=/; Secure; HttpOnly; SameSite=${sameSite}; Max-Age=${maxAgeSeconds}`;
}

const cache = new WeakMap<Request, Promise<SessionUser | null>>();

export function currentUser(ctx: Ctx): Promise<SessionUser | null> {
  let pending = cache.get(ctx.request);
  if (!pending) {
    pending = loadSession(ctx);
    cache.set(ctx.request, pending);
  }
  return pending;
}

async function loadSession(ctx: Ctx): Promise<SessionUser | null> {
  const token = parseCookies(ctx.request.headers.get('Cookie')).get(SESSION_COOKIE);
  if (!token || token.length > 128) return null;
  const id = await sha256Hex(token);
  const row = await ctx.env.DB.prepare(
    `SELECT s.expires_at AS s_expires, s.last_seen_at AS s_seen, u.* FROM sessions s
     JOIN users u ON u.id = s.user_id
     WHERE s.id = ? AND u.deleted_at IS NULL`,
  )
    .bind(id)
    .first<UserRow & { s_expires: number; s_seen: number }>();
  if (!row) return null;
  const now = Date.now();
  if (row.s_expires < now) {
    ctx.exec.waitUntil(ctx.env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(id).run());
    return null;
  }
  if (now - row.s_seen > TOUCH_INTERVAL_MS) {
    ctx.exec.waitUntil(ctx.env.DB.prepare('UPDATE sessions SET last_seen_at = ? WHERE id = ?').bind(now, id).run());
  }
  return userFromRow(row, ctx.env);
}

export async function requireUser(ctx: Ctx): Promise<SessionUser> {
  const user = await currentUser(ctx);
  if (!user) throw unauthorized();
  return user;
}

export async function requireActiveUser(ctx: Ctx): Promise<SessionUser> {
  const user = await requireUser(ctx);
  if (user.banned) throw forbidden('Your account is suspended.');
  return user;
}

export async function requireModerator(ctx: Ctx): Promise<SessionUser> {
  const user = await requireActiveUser(ctx);
  if (user.role !== 'moderator' && user.role !== 'admin') throw forbidden();
  return user;
}

export async function requireAdmin(ctx: Ctx): Promise<SessionUser> {
  const user = await requireActiveUser(ctx);
  if (user.role !== 'admin') throw forbidden();
  return user;
}

export async function createSession(env: Env, userId: string): Promise<string> {
  const token = randomToken(32);
  const now = Date.now();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, created_at, expires_at, last_seen_at) VALUES (?, ?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, now, now + SESSION_TTL_MS, now)
    .run();
  return cookie(SESSION_COOKIE, token, SESSION_TTL_MS / 1000);
}

export async function destroySession(env: Env, request: Request): Promise<string> {
  const token = parseCookies(request.headers.get('Cookie')).get(SESSION_COOKIE);
  if (token && token.length <= 128) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(await sha256Hex(token)).run();
  }
  return cookie(SESSION_COOKIE, '', 0);
}

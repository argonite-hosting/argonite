import { PERM_ALL, has } from '../../../shared/permissions';
import type { Env } from '../env';
import { newId } from './crypto';
import { projectKeyColumn } from './db';
import { HttpError, badRequest, clientIp, forbidden, isSiteOrigin, notFound } from './http';
import type { Ctx } from './router';
import type { SessionUser } from './session';

export async function rateLimit(limiter: RateLimit, key: string): Promise<void> {
  const { success } = await limiter.limit({ key });
  if (!success) throw new HttpError(429, 'rate_limited', 'Too many requests. Slow down and try again shortly.');
}

// Every state-changing /api call must come from our own pages. SameSite cookies already cover this; this is belt and braces.
export function assertSameSite(ctx: Ctx): void {
  const origin = ctx.request.headers.get('Origin');
  if (!isSiteOrigin(origin)) throw forbidden('Cross-site request blocked.');
  if (ctx.request.headers.get('X-Requested-With') !== 'argonite') throw forbidden('Missing request header.');
}

export async function verifyTurnstile(env: Env, request: Request, token: unknown): Promise<void> {
  if (!env.TURNSTILE_SECRET) throw new HttpError(500, 'misconfigured', 'Bot protection is not configured.');
  if (typeof token !== 'string' || !token || token.length > 2048) throw badRequest('Complete the verification challenge.');
  const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ secret: env.TURNSTILE_SECRET, response: token, remoteip: clientIp(request) }),
  });
  const data = (await res.json().catch(() => ({ success: false }))) as { success: boolean };
  if (!data.success) throw badRequest('Verification failed. Refresh the challenge and try again.');
}

export function audit(env: Env, actorId: string | null, action: string, targetType: string, targetId: string, details: Record<string, unknown> = {}) {
  return env.DB.prepare('INSERT INTO audit_log (id, actor_id, action, target_type, target_id, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
    newId(),
    actorId,
    action,
    targetType,
    targetId,
    JSON.stringify(details),
    Date.now(),
  );
}

export interface ProjectAccess {
  id: string;
  slug: string;
  name: string;
  type: string;
  status: string;
  owner_id: string;
  org_id: string | null;
  repo_id: number;
  repo_full_name: string;
  repo_status: string;
  installation_id: number | null;
  archived: number;
  role: 'owner' | 'maintainer' | 'org' | null;
  perms: number;
}

interface AccessRow extends Omit<ProjectAccess, 'role' | 'perms'> {
  member_role: 'owner' | 'maintainer' | null;
  member_perms: number | null;
  org_role: 'owner' | 'member' | null;
  org_perms: number | null;
}

// Effective permissions: the project owner and organisation owners can do everything; everyone else
// gets the union of their project row and their organisation row.
export async function projectAccess(env: Env, idOrSlug: string, user: SessionUser | null): Promise<ProjectAccess> {
  const key = idOrSlug.toLowerCase();
  const row = await env.DB.prepare(
    `SELECT p.id, p.slug, p.name, p.type, p.status, p.owner_id, p.org_id, p.repo_id, p.repo_full_name, p.repo_status, p.installation_id, p.archived,
            m.role AS member_role, m.permissions AS member_perms, om.role AS org_role, om.permissions AS org_perms
     FROM projects p
     LEFT JOIN members m ON m.project_id = p.id AND m.user_id = ?2 AND m.accepted = 1
     LEFT JOIN org_members om ON om.org_id = p.org_id AND om.user_id = ?2 AND om.accepted = 1
     WHERE p.${projectKeyColumn(key)} = ?1`,
  )
    .bind(key, user?.id ?? '')
    .first<AccessRow>();
  if (!row || row.status === 'removed') throw notFound('Project not found.');
  const isOwner = !!user && row.owner_id === user.id;
  const orgOwner = row.org_role === 'owner';
  const perms = isOwner || orgOwner ? PERM_ALL : (row.member_perms ?? 0) | (row.org_perms ?? 0);
  const role: ProjectAccess['role'] = isOwner ? 'owner' : row.member_role ? row.member_role : row.org_role ? 'org' : null;
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    type: row.type,
    status: row.status,
    owner_id: row.owner_id,
    org_id: row.org_id,
    repo_id: row.repo_id,
    repo_full_name: row.repo_full_name,
    repo_status: row.repo_status,
    installation_id: row.installation_id,
    archived: row.archived,
    role,
    perms,
  };
}

export async function requireMember(env: Env, projectId: string, user: SessionUser): Promise<ProjectAccess> {
  const access = await projectAccess(env, projectId, user);
  if (!access.role) throw forbidden('You are not a member of this project.');
  return access;
}

export async function requirePerm(env: Env, projectId: string, user: SessionUser, flag: number): Promise<ProjectAccess> {
  const access = await requireMember(env, projectId, user);
  if (!has(access.perms, flag)) throw forbidden('Your role in this project does not allow that.');
  return access;
}

export function isStaff(user: SessionUser | null): boolean {
  return !!user && (user.role === 'moderator' || user.role === 'admin');
}

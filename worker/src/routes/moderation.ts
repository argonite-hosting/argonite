import { SITE } from '../../../shared/config';
import { REPORT_REASONS } from '../../../shared/taxonomy';
import type { AuditEntry, Report, ReviewItem } from '../../../shared/types';
import { cleanMultiline, cleanText, isId } from '../../../shared/validate';
import { newId } from '../lib/crypto';
import { assetDownloadUrl, projectRepo } from '../lib/app';
import { PROJECT_SELECT, loadVersions, recomputeProject, toSummary, type ProjectRow } from '../lib/db';
import { goLive } from '../lib/publish';
import { assertSameSite, audit, projectAccess, rateLimit } from '../lib/guard';
import { badRequest, conflict, forbidden, json, notFound, readJson } from '../lib/http';
import { oneOf, str } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { sandboxEnabled } from '../lib/sandbox';
import { requireActiveUser, requireAdmin, requireModerator } from '../lib/session';

const REASON_IDS = REPORT_REASONS.map((r) => r.id);

async function createReport(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `report:${user.id}`);
  const body = await readJson(ctx.request);
  const targetType = oneOf(body, 'targetType', ['project', 'version', 'user', 'comment', 'collection', 'organization', 'server'] as const, true)!;
  const targetId = str(body, 'targetId', { required: true, max: 26 })!;
  const reason = oneOf(body, 'reason', REASON_IDS, true)!;
  const details = cleanMultiline(str(body, 'details', { max: 3000 }) ?? '');
  if (!isId(targetId)) throw badRequest('Invalid target.');
  if (details.length < 10) throw badRequest('Add a few words so moderators know what to look for.', { details: 'At least 10 characters.' });
  const table = { project: 'projects', version: 'versions', user: 'users', comment: 'comments', collection: 'collections', organization: 'organizations', server: 'servers' }[targetType];
  const exists = await ctx.env.DB.prepare(`SELECT 1 FROM ${table} WHERE id = ?`).bind(targetId).first();
  if (!exists) throw notFound('Nothing to report there.');
  const recent = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM reports WHERE reporter_id = ? AND created_at > ?')
    .bind(user.id, Date.now() - 86_400_000)
    .first<{ n: number }>();
  if ((recent?.n ?? 0) >= 20) throw badRequest('You have sent a lot of reports today. Thanks — moderators will get to them.');
  try {
    await ctx.env.DB.prepare('INSERT INTO reports (id, reporter_id, target_type, target_id, reason, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(newId(), user.id, targetType, targetId, reason, details, Date.now())
      .run();
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('You already have an open report about this.');
    throw e;
  }
  return json({ ok: true }, 201);
}

async function queue(ctx: Ctx): Promise<Response> {
  await requireModerator(ctx);
  const status = ctx.url.searchParams.get('status') === 'rejected' ? 'rejected' : 'review';
  const versions = await loadVersions(ctx.env, { statuses: [status], includeScan: true, staff: true, limit: 100 });
  const projectIds = [...new Set(versions.map((v) => v.projectId))];
  const rows = projectIds.length
    ? await ctx.env.DB.prepare(`${PROJECT_SELECT} WHERE p.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify(projectIds)).all<ProjectRow>()
    : { results: [] as ProjectRow[] };
  const byId = new Map(rows.results.map((r) => [r.id, toSummary(r)]));
  const items: ReviewItem[] = versions.flatMap((v) => (byId.has(v.projectId) ? [{ version: v, project: byId.get(v.projectId)! }] : []));
  // Which test machines a moderator can start from here (none when behaviour tests aren't set up).
  return json({ items, sandboxSystems: sandboxEnabled(ctx.env) ? SITE.sandbox.systems : [] });
}

async function decide(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  const body = await readJson(ctx.request);
  const action = oneOf(body, 'action', ['approve', 'reject', 'revoke', 'restore'] as const, true)!;
  const reason = cleanText(str(body, 'reason', { max: 500 }) ?? '');
  const v = await ctx.env.DB.prepare(
    `SELECT v.id, v.status, v.project_id, v.author_id,
       (SELECT COUNT(*) FROM files f WHERE f.version_id = v.id) AS files,
       (SELECT COUNT(*) FROM files f WHERE f.version_id = v.id AND f.sha256 IS NOT NULL) AS verified
     FROM versions v WHERE v.id = ?`,
  )
    .bind(ctx.params.id)
    .first<{ id: string; status: string; project_id: string; author_id: string; files: number; verified: number }>();
  if (!v) throw notFound('Version not found.');

  const allowed: Record<typeof action, string[]> = {
    approve: ['review'],
    reject: ['review', 'scanning', 'live'],
    revoke: ['live', 'review'],
    restore: ['revoked', 'rejected', 'unavailable'],
  };
  if (!allowed[action].includes(v.status)) throw conflict(`Cannot ${action} a version that is ${v.status}.`);
  // Nobody signs off their own work: moderators can't approve or restore versions of projects they're
  // part of. Admins can, so a site with a single admin still works.
  if ((action === 'approve' || action === 'restore') && mod.role !== 'admin') {
    const own = v.author_id === mod.id || (await projectAccess(ctx.env, v.project_id, mod)).role !== null;
    if (own) throw forbidden('Another moderator has to review versions of projects you’re part of.');
  }
  if ((action === 'approve' || action === 'restore') && (!v.files || v.verified !== v.files)) throw conflict('Not every file in this version has a verified fingerprint, so it cannot go live.');
  // A rejected version's files are retired; bringing it back can't put a second copy of a file up.
  if (action === 'restore' && v.status === 'rejected') {
    const copy = await ctx.env.DB.prepare(
      `SELECT p.name, x.version_number FROM files f JOIN files o ON o.sha512 = f.sha512 AND o.id != f.id AND o.retired = 0
       JOIN versions x ON x.id = o.version_id JOIN projects p ON p.id = x.project_id
       WHERE f.version_id = ? LIMIT 1`,
    )
      .bind(v.id)
      .first<{ name: string; version_number: string }>();
    if (copy) throw conflict(`The same file is already on the site in ${copy.name} ${copy.version_number}. Revoke or delete that version first.`);
  }
  if ((action === 'reject' || action === 'revoke') && reason.length < 3) throw badRequest('Give a reason; the author will see it.', { reason: 'Required.' });

  if (action === 'approve' || action === 'restore') {
    // The GitHub release gets published here, right before the version goes live.
    const outcome = await goLive(ctx.env, v.id, mod.id, `version.${action}`);
    return json({ ok: true, status: outcome === 'live' ? 'live' : 'unavailable' });
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE versions SET status = ?, status_reason = ?, publish_pending = 0 WHERE id = ?').bind(action === 'reject' ? 'rejected' : 'revoked', reason, v.id),
    ...recomputeProject(ctx.env, v.project_id),
    audit(ctx.env, mod.id, `version.${action}`, 'version', v.id, { reason, from: v.status }),
  ]);
  return json({ ok: true });
}

async function projectStatus(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  const body = await readJson(ctx.request);
  const status = oneOf(body, 'status', ['active', 'delisted', 'removed'] as const, true)!;
  const reason = cleanText(str(body, 'reason', { max: 500 }) ?? '');
  if (status !== 'active' && reason.length < 3) throw badRequest('Give a reason.', { reason: 'Required.' });
  const p = await ctx.env.DB.prepare('SELECT id, status, published_at, repo_status FROM projects WHERE id = ?')
    .bind(ctx.params.id)
    .first<{ id: string; status: string; published_at: number | null; repo_status: string }>();
  if (!p) throw notFound('Project not found.');
  const target = status === 'active' && !p.published_at ? 'draft' : status;
  const stmts = [
    ctx.env.DB.prepare('UPDATE projects SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').bind(target, reason || null, Date.now(), p.id),
    audit(ctx.env, mod.id, `project.${status}`, 'project', p.id, { reason, from: p.status }),
  ];
  const resetRepo = body.resetRepo === true && p.repo_status === 'transferred';
  if (resetRepo) stmts.push(ctx.env.DB.prepare("UPDATE projects SET repo_status = 'ok' WHERE id = ?").bind(p.id));
  await ctx.env.DB.batch(stmts);
  return json({ ok: true });
}

async function ban(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  const body = await readJson(ctx.request);
  const banned = body.banned === true;
  const reason = cleanText(str(body, 'reason', { max: 500 }) ?? '');
  if (banned && reason.length < 3) throw badRequest('Give a reason.', { reason: 'Required.' });
  const target = await ctx.env.DB.prepare('SELECT id, role FROM users WHERE id = ? AND deleted_at IS NULL').bind(ctx.params.id).first<{ id: string; role: string }>();
  if (!target) throw notFound('User not found.');
  if (target.id === mod.id) throw badRequest('You cannot ban yourself.');
  if (target.role !== 'user' && mod.role !== 'admin') throw badRequest('Only admins can ban staff.');
  const stmts = [
    ctx.env.DB.prepare('UPDATE users SET banned = ?, ban_reason = ?, updated_at = ? WHERE id = ?').bind(banned ? 1 : 0, banned ? reason : null, Date.now(), target.id),
    audit(ctx.env, mod.id, banned ? 'user.ban' : 'user.unban', 'user', target.id, { reason }),
  ];
  if (banned) {
    stmts.push(ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(target.id));
    stmts.push(
      ctx.env.DB.prepare("UPDATE projects SET status = 'delisted', status_reason = 'Owner suspended' WHERE owner_id = ? AND status = 'active'").bind(target.id),
    );
  }
  await ctx.env.DB.batch(stmts);
  return json({ ok: true });
}

async function setRole(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const admin = await requireAdmin(ctx);
  const body = await readJson(ctx.request);
  const role = oneOf(body, 'role', ['user', 'moderator', 'admin'] as const, true)!;
  const res = await ctx.env.DB.prepare('UPDATE users SET role = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL').bind(role, Date.now(), ctx.params.id).run();
  if (!res.meta.changes) throw notFound('User not found.');
  await audit(ctx.env, admin.id, 'user.role', 'user', ctx.params.id, { role }).run();
  return json({ ok: true });
}

async function lookupUser(ctx: Ctx): Promise<Response> {
  await requireModerator(ctx);
  const name = (ctx.url.searchParams.get('username') ?? '').toLowerCase();
  const row = await ctx.env.DB.prepare(
    'SELECT id, username, avatar_url, role, banned, ban_reason, created_at, approved_uploads FROM users WHERE username_lower = ? AND deleted_at IS NULL',
  )
    .bind(name)
    .first();
  if (!row) throw notFound('User not found.');
  return json({ user: row });
}

async function reports(ctx: Ctx): Promise<Response> {
  await requireModerator(ctx);
  const status = ctx.url.searchParams.get('status');
  const filter = status === 'resolved' || status === 'dismissed' ? status : 'open';
  const rows = await ctx.env.DB.prepare(
    `SELECT r.*, u.username AS reporter_username, u.avatar_url AS reporter_avatar,
       CASE r.target_type
         WHEN 'project' THEN (SELECT name FROM projects WHERE id = r.target_id)
         WHEN 'version' THEN (SELECT p.name || ' ' || v.version_number FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = r.target_id)
         WHEN 'comment' THEN (SELECT 'Comment by ' || u.username || ' on ' || p.name FROM comments c JOIN users u ON u.id = c.author_id JOIN projects p ON p.id = c.project_id WHERE c.id = r.target_id)
         WHEN 'collection' THEN (SELECT name FROM collections WHERE id = r.target_id)
         WHEN 'organization' THEN (SELECT name FROM organizations WHERE id = r.target_id)
         WHEN 'server' THEN (SELECT name FROM servers WHERE id = r.target_id)
         ELSE (SELECT username FROM users WHERE id = r.target_id) END AS target_label,
       CASE r.target_type
         WHEN 'project' THEN (SELECT '/project/' || slug FROM projects WHERE id = r.target_id)
         WHEN 'version' THEN (SELECT '/project/' || p.slug || '/version/' || v.id FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = r.target_id)
         WHEN 'comment' THEN (SELECT '/project/' || p.slug || '/comments#comment-' || c.id FROM comments c JOIN projects p ON p.id = c.project_id WHERE c.id = r.target_id)
         WHEN 'collection' THEN '/collection/' || r.target_id
         WHEN 'organization' THEN (SELECT '/organization/' || slug FROM organizations WHERE id = r.target_id)
         WHEN 'server' THEN (SELECT '/server/' || slug FROM servers WHERE id = r.target_id)
         ELSE (SELECT '/user/' || username FROM users WHERE id = r.target_id) END AS target_url
     FROM reports r JOIN users u ON u.id = r.reporter_id WHERE r.status = ? ORDER BY r.created_at DESC LIMIT 200`,
  )
    .bind(filter)
    .all<Record<string, unknown>>();
  const list: Report[] = rows.results.map((r) => ({
    id: r.id as string,
    targetType: r.target_type as Report['targetType'],
    targetId: r.target_id as string,
    targetLabel: (r.target_label as string) ?? '(deleted)',
    targetUrl: (r.target_url as string) ?? '/',
    reason: r.reason as string,
    details: r.details as string,
    status: r.status as Report['status'],
    reporter: { id: r.reporter_id as string, username: r.reporter_username as string, avatarUrl: r.reporter_avatar as string },
    createdAt: r.created_at as number,
    resolution: (r.resolution as string) ?? null,
  }));
  return json({ reports: list });
}

async function resolveReport(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  const body = await readJson(ctx.request);
  const status = oneOf(body, 'status', ['resolved', 'dismissed'] as const, true)!;
  const resolution = cleanText(str(body, 'resolution', { max: 500 }) ?? '');
  const res = await ctx.env.DB.prepare("UPDATE reports SET status = ?, resolution = ?, resolved_by = ?, resolved_at = ? WHERE id = ? AND status = 'open'")
    .bind(status, resolution || null, mod.id, Date.now(), ctx.params.id)
    .run();
  if (!res.meta.changes) throw notFound('Report not found or already closed.');
  await audit(ctx.env, mod.id, `report.${status}`, 'report', ctx.params.id, { resolution }).run();
  return json({ ok: true });
}

async function auditLog(ctx: Ctx): Promise<Response> {
  await requireModerator(ctx);
  const before = Number(ctx.url.searchParams.get('before') ?? '0') || Date.now() + 1;
  const rows = await ctx.env.DB.prepare(
    `SELECT a.*, u.username, u.avatar_url FROM audit_log a LEFT JOIN users u ON u.id = a.actor_id
     WHERE a.created_at < ? ORDER BY a.created_at DESC LIMIT 100`,
  )
    .bind(before)
    .all<Record<string, unknown>>();
  const entries: AuditEntry[] = rows.results.map((r) => ({
    id: r.id as string,
    actor: r.actor_id && r.username ? { id: r.actor_id as string, username: r.username as string, avatarUrl: r.avatar_url as string } : null,
    action: r.action as string,
    targetType: r.target_type as string,
    targetId: r.target_id as string,
    details: (() => {
      try {
        return JSON.parse(r.details as string) as Record<string, unknown>;
      } catch {
        return {};
      }
    })(),
    createdAt: r.created_at as number,
  }));
  return json({ entries });
}

// Files in review are still on draft releases, so moderators get a short-lived signed link instead.
async function fileLink(ctx: Ctx): Promise<Response> {
  await requireModerator(ctx);
  if (!isId(ctx.params.id)) throw notFound('File not found.');
  const f = await ctx.env.DB.prepare(
    `SELECT f.asset_id, p.id, p.repo_id, p.repo_full_name, p.installation_id FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id WHERE f.id = ?`,
  )
    .bind(ctx.params.id)
    .first<{ asset_id: number | null; id: string; repo_id: number; repo_full_name: string; installation_id: number | null }>();
  if (!f?.asset_id) throw notFound('File not found.');
  const { token, repo } = await projectRepo(ctx.env, f, { allowPrivate: true });
  const url = await assetDownloadUrl(token, repo, f.asset_id);
  if (!url) throw notFound('The file is gone from GitHub.');
  return json({ url });
}

export function moderationRoutes(r: Router): void {
  r.get('/api/mod/files/:id/link', fileLink);
  r.post('/api/reports', createReport);
  r.get('/api/mod/queue', queue);
  r.post('/api/mod/versions/:id/decision', decide);
  r.post('/api/mod/projects/:id/status', projectStatus);
  r.post('/api/mod/users/:id/ban', ban);
  r.get('/api/mod/users', lookupUser);
  r.get('/api/mod/reports', reports);
  r.post('/api/mod/reports/:id', resolveReport);
  r.get('/api/mod/audit', auditLog);
  r.post('/api/admin/users/:id/role', setRole);
}

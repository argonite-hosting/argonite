import { SITE } from '../../../shared/config';
import type { InstallationInfo, Invite, Me, ProjectSummary, RepoChoice } from '../../../shared/types';
import { cleanMultiline, cleanText, hasControlChars } from '../../../shared/validate';
import { PROJECT_SELECT, toSummary, type ProjectRow } from '../lib/db';
import { collectNotifications } from './notifications';
import { queueWrite, siteData } from '../lib/datastore';
import { gh, revokeGrant, userToken } from '../lib/github';
import { assertSameSite, audit, rateLimit } from '../lib/guard';
import { badRequest, json, readJson } from '../lib/http';
import { optionalStr, str } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { SESSION_COOKIE, cookie, currentUser, requireActiveUser, requireUser } from '../lib/session';

async function me(ctx: Ctx): Promise<Response> {
  const user = await currentUser(ctx);
  if (!user) return json({ user: null });
  const invites = await ctx.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM members m JOIN projects p ON p.id = m.project_id WHERE m.user_id = ?1 AND m.accepted = 0 AND p.status != 'removed')
          + (SELECT COUNT(*) FROM org_members om JOIN organizations o ON o.id = om.org_id WHERE om.user_id = ?1 AND om.accepted = 0 AND o.deleted_at IS NULL) AS n,
            (SELECT notifications_seen_at FROM users WHERE id = ?1) AS seen`,
  )
    .bind(user.id)
    .first<{ n: number; seen: number }>();
  const unread = (await collectNotifications(ctx.env, user.id, invites?.seen ?? 0, 60)).filter((n) => n.unread).length;
  const body: Me = {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    avatarUrl: user.avatarUrl,
    bio: user.bio,
    role: user.role,
    createdAt: user.createdAt,
    banned: user.banned,
    githubId: user.githubId,
    pendingInvites: invites?.n ?? 0,
    unreadNotifications: unread,
  };
  return json({ user: body });
}

async function updateMe(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request);
  const displayName = optionalStr(body, 'displayName', 64);
  const bio = optionalStr(body, 'bio', 600);
  if (displayName && hasControlChars(displayName)) throw badRequest('Display name contains invalid characters.', { displayName: 'Invalid characters.' });
  await ctx.env.DB.prepare(
    `UPDATE users SET
       display_name = CASE WHEN ?2 THEN ?3 ELSE display_name END,
       bio = CASE WHEN ?4 THEN ?5 ELSE bio END,
       updated_at = ?6
     WHERE id = ?1`,
  )
    .bind(
      user.id,
      displayName !== undefined ? 1 : 0,
      displayName ? cleanText(displayName) : null,
      bio !== undefined ? 1 : 0,
      bio ? cleanMultiline(bio).slice(0, 300) : null,
      Date.now(),
    )
    .run();
  return json({ ok: true });
}

// Accounts are anonymised rather than hard-deleted so audit history and moderation records stay intact.
async function deleteMe(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireUser(ctx);
  const body = await readJson(ctx.request);
  const confirm = str(body, 'confirm', { required: true, max: 64 });
  if (confirm!.toLowerCase() !== user.username.toLowerCase()) throw badRequest('Type your username to confirm.', { confirm: 'Does not match.' });

  try {
    await revokeGrant(ctx.env, await userToken(ctx.env, user.id));
  } catch {
    // Token may already be gone; the grant dies with the account either way.
  }
  const now = Date.now();
  const ghost = `deleted-${user.id.slice(-8)}`;
  // Stored files (public collections, profile links) are removed from the data repository too.
  const stored = await ctx.env.DB.prepare('SELECT id, path FROM collections WHERE owner_id = ? AND path IS NOT NULL').bind(user.id).all<{ id: string; path: string }>();
  for (const c of stored.results) await queueWrite(ctx.env, siteData(), c.path, 'collection', c.id, null, { purge: true });
  await queueWrite(ctx.env, siteData(), `profiles/${user.id}.json`, 'profile', user.id, null, { purge: true });
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM collections WHERE owner_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM api_tokens WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('UPDATE projects SET org_id = NULL WHERE org_id IN (SELECT id FROM organizations WHERE owner_id = ? AND deleted_at IS NULL)').bind(user.id),
    ctx.env.DB.prepare("UPDATE organizations SET deleted_at = ?, slug = 'deleted-' || id WHERE owner_id = ? AND deleted_at IS NULL").bind(now, user.id),
    ctx.env.DB.prepare('DELETE FROM org_members WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare("UPDATE servers SET status = 'removed', updated_at = ? WHERE owner_id = ?").bind(now, user.id),
  ]);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE projects SET status = 'removed', status_reason = 'Owner deleted their account', updated_at = ? WHERE owner_id = ?").bind(
      now,
      user.id,
    ),
    ctx.env.DB.prepare('DELETE FROM members WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM follows WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare('DELETE FROM github_tokens WHERE user_id = ?').bind(user.id),
    ctx.env.DB.prepare(
      `UPDATE users SET github_id = -abs(random() % 9007199254740991) - 1, username = ?2, username_lower = ?2, display_name = NULL, bio = NULL,
         avatar_url = '', installation_id = NULL, feed_token_hash = NULL, profile_commit = NULL, profile_path = NULL, profile_sha256 = NULL,
         deleted_at = ?3, updated_at = ?3 WHERE id = ?1`,
    ).bind(user.id, ghost, now),
    audit(ctx.env, user.id, 'account.delete', 'user', user.id),
  ]);
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
}

async function revokeSessions(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireUser(ctx);
  await ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id).run();
  return json({ ok: true }, 200, { 'Set-Cookie': cookie(SESSION_COOKIE, '', 0) });
}

async function myProjects(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const rows = await ctx.env.DB.prepare(
    `${PROJECT_SELECT} JOIN members m ON m.project_id = p.id AND m.user_id = ? AND m.accepted = 1
     WHERE p.status != 'removed' ORDER BY p.updated_at DESC LIMIT 200`,
  )
    .bind(user.id)
    .all<ProjectRow & { role?: string }>();
  const review = await ctx.env.DB.prepare(
    `SELECT v.project_id, COUNT(*) AS n FROM versions v JOIN members m ON m.project_id = v.project_id AND m.user_id = ? AND m.accepted = 1
     WHERE v.status IN ('scanning', 'review', 'uploading') GROUP BY v.project_id`,
  )
    .bind(user.id)
    .all<{ project_id: string; n: number }>();
  const pending = new Map(review.results.map((r) => [r.project_id, r.n]));
  return json({
    projects: rows.results.map((r) => ({ project: toSummary(r), status: r.status, ownerId: r.owner_id, pendingVersions: pending.get(r.id) ?? 0 })),
  });
}

async function myFollows(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const rows = await ctx.env.DB.prepare(
    `${PROJECT_SELECT} JOIN follows f ON f.project_id = p.id AND f.user_id = ? WHERE p.status IN ('active', 'delisted') ORDER BY f.created_at DESC LIMIT 200`,
  )
    .bind(user.id)
    .all<ProjectRow>();
  return json({ projects: rows.results.map(toSummary) satisfies ProjectSummary[] });
}

async function myInvites(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT p.*, u.username AS author_username, u.avatar_url AS author_avatar, NULL AS cats, NULL AS loaders_csv, NULL AS gvs, m.role AS invite_role
     FROM members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = p.owner_id
     WHERE m.user_id = ? AND m.accepted = 0 AND p.status != 'removed'`,
  )
    .bind(user.id)
    .all<ProjectRow & { invite_role: Invite['role'] }>();
  const invites: Invite[] = rows.results.map((r) => ({ project: toSummary(r), role: r.invite_role }));
  return json({ invites });
}

interface InstallationRepo {
  id: number;
  full_name: string;
  private: boolean;
  html_url: string;
  archived: boolean;
  permissions?: { push: boolean };
}

async function myGithub(ctx: Ctx): Promise<Response> {
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `gh:${user.id}`);
  const token = await userToken(ctx.env, user.id);
  const installUrl = `https://github.com/apps/${SITE.github.appSlug}/installations/new`;
  const list = await gh<{ installations: { id: number; app_slug: string; repository_selection: 'all' | 'selected'; account: { id: number } }[] }>(
    token,
    'GET',
    '/user/installations?per_page=100',
  );
  const mine = list.installations.filter((i) => i.app_slug === SITE.github.appSlug);
  const own = mine.find((i) => i.account.id === user.githubId);
  if (own?.id !== (user.installationId ?? undefined)) {
    await ctx.env.DB.prepare('UPDATE users SET installation_id = ? WHERE id = ?').bind(own?.id ?? null, user.id).run();
  }
  const repos: RepoChoice[] = [];
  for (const inst of mine.slice(0, 5)) {
    for (let page = 1; page <= 3; page++) {
      const data = await gh<{ repositories: InstallationRepo[] }>(token, 'GET', `/user/installations/${inst.id}/repositories?per_page=100&page=${page}`);
      for (const r of data.repositories) {
        if (!r.archived && r.permissions?.push) repos.push({ id: r.id, fullName: r.full_name, private: r.private, url: r.html_url });
      }
      if (data.repositories.length < 100) break;
    }
  }
  const info: InstallationInfo = {
    installed: mine.length > 0,
    installUrl,
    repos: repos.sort((a, b) => a.fullName.localeCompare(b.fullName)),
    canCreate: own?.repository_selection === 'all',
  };
  return json(info);
}

export function meRoutes(r: Router): void {
  r.get('/api/me', me);
  r.patch('/api/me', updateMe);
  r.delete('/api/me', deleteMe);
  r.post('/api/me/sessions/revoke', revokeSessions);
  r.get('/api/me/projects', myProjects);
  r.get('/api/me/follows', myFollows);
  r.get('/api/me/invites', myInvites);
  r.get('/api/me/github', myGithub);
}

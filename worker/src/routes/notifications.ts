// Notifications are worked out when you ask for them, from data that already exists (follows, versions,
// comments, invites, moderation history). Nothing is written per follower when something happens, so a
// popular project publishing a version costs the same as a quiet one.
import { SCOPE } from '../../../shared/permissions';
import type { Notification } from '../../../shared/types';
import { isId } from '../../../shared/validate';
import { requireActor } from '../lib/auth';
import { randomToken, sha256Hex } from '../lib/crypto';
import { assertSameSite } from '../lib/guard';
import { HttpError, json, notFound } from '../lib/http';
import type { Ctx, Router } from '../lib/router';
import { siteUrl } from '../lib/runtime';
import { requireActiveUser } from '../lib/session';
import type { Env } from '../env';
import { SITE } from '../../../shared/config';

const WINDOW_MS = 30 * 86_400_000;
const STATUS_ACTIONS: Record<string, string> = {
  'scan.clean': 'is live',
  'version.approve': 'was approved and is live',
  'version.restore': 'was restored',
  'scan.review': 'is waiting for a moderator',
  'scan.malicious': 'was rejected by the scanner',
  'scan.duplicate': 'was rejected as a duplicate',
  'version.reject': 'was rejected by a moderator',
  'version.revoke': 'was revoked by a moderator',
  'version.publish_failed': 'could not be published on GitHub yet',
  'version.integrity_failed': 'no longer matches its scanned file',
};

type Row = Record<string, string | number | null>;

export async function collectNotifications(env: Env, userId: string, seenAt: number, limit = 60): Promise<Notification[]> {
  const since = Date.now() - WINDOW_MS;
  const actions = Object.keys(STATUS_ACTIONS);
  const [versions, invites, orgInvites, comments, replies, messages, statuses] = await env.DB.batch([
    env.DB.prepare(
      `SELECT v.id, v.version_number, v.published_at AS at, p.slug, p.name FROM follows f
       JOIN versions v ON v.project_id = f.project_id AND v.status = 'live' AND v.published_at > f.created_at AND v.published_at > ?2
       JOIN projects p ON p.id = v.project_id AND p.status IN ('active', 'delisted')
       WHERE f.user_id = ?1 ORDER BY v.published_at DESC LIMIT 40`,
    ).bind(userId, since),
    env.DB.prepare(
      `SELECT p.id, p.slug, p.name, m.created_at AS at FROM members m JOIN projects p ON p.id = m.project_id
       WHERE m.user_id = ? AND m.accepted = 0 AND p.status != 'removed' LIMIT 20`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT o.id, o.slug, o.name, om.created_at AS at FROM org_members om JOIN organizations o ON o.id = om.org_id
       WHERE om.user_id = ? AND om.accepted = 0 AND o.deleted_at IS NULL LIMIT 20`,
    ).bind(userId),
    env.DB.prepare(
      `SELECT c.id, c.created_at AS at, p.slug, p.name, u.username FROM comments c
       JOIN members m ON m.project_id = c.project_id AND m.user_id = ?1 AND m.accepted = 1
       JOIN projects p ON p.id = c.project_id JOIN users u ON u.id = c.author_id
       WHERE c.author_id != ?1 AND c.deleted = 0 AND c.parent_id IS NULL AND c.created_at > ?2 ORDER BY c.created_at DESC LIMIT 30`,
    ).bind(userId, since),
    env.DB.prepare(
      `SELECT c.id, c.created_at AS at, p.slug, p.name, u.username FROM comments c
       JOIN comments parent ON parent.id = c.parent_id AND parent.author_id = ?1
       JOIN projects p ON p.id = c.project_id JOIN users u ON u.id = c.author_id
       WHERE c.author_id != ?1 AND c.deleted = 0 AND c.created_at > ?2 ORDER BY c.created_at DESC LIMIT 30`,
    ).bind(userId, since),
    env.DB.prepare(
      `SELECT mm.id, mm.created_at AS at, p.slug, p.name, p.id AS project_id FROM mod_messages mm
       JOIN members m ON m.project_id = mm.project_id AND m.user_id = ?1 AND m.accepted = 1
       JOIN projects p ON p.id = mm.project_id
       WHERE mm.author_id != ?1 AND mm.internal = 0 AND mm.created_at > ?2 ORDER BY mm.created_at DESC LIMIT 20`,
    ).bind(userId, since),
    env.DB.prepare(
      `SELECT a.id, a.action, a.created_at AS at, v.id AS version_id, v.version_number, p.slug, p.name FROM versions v
       JOIN audit_log a ON a.target_type = 'version' AND a.target_id = v.id
       JOIN projects p ON p.id = v.project_id
       WHERE v.author_id = ?1 AND v.created_at > ?2 AND a.created_at > ?2 AND a.action IN (SELECT value FROM json_each(?3))
       ORDER BY a.created_at DESC LIMIT 30`,
    ).bind(userId, since, JSON.stringify(actions)),
  ]);

  const out: Notification[] = [];
  const push = (n: Omit<Notification, 'unread'>) => out.push({ ...n, unread: n.createdAt > seenAt });
  for (const r of versions.results as Row[]) {
    push({ id: `v:${r.id}`, kind: 'version', params: { project: String(r.name), version: String(r.version_number) }, title: `${r.name} ${r.version_number}`, body: 'New version of a project you follow', url: `/project/${r.slug}/version/${r.id}`, createdAt: Number(r.at) });
  }
  for (const r of invites.results as Row[]) {
    push({ id: `i:${r.id}`, kind: 'invite', params: { project: String(r.name) }, title: `Invite to ${r.name}`, body: 'You were invited to join the project team', url: '/dashboard', createdAt: Number(r.at) });
  }
  for (const r of orgInvites.results as Row[]) {
    push({ id: `oi:${r.id}`, kind: 'org_invite', params: { org: String(r.name) }, title: `Invite to ${r.name}`, body: 'You were invited to join the organisation', url: '/dashboard', createdAt: Number(r.at) });
  }
  for (const r of comments.results as Row[]) {
    push({ id: `c:${r.id}`, kind: 'comment', params: { user: String(r.username), project: String(r.name) }, title: `${r.username} commented on ${r.name}`, body: 'New comment on your project', url: `/project/${r.slug}/comments`, createdAt: Number(r.at) });
  }
  for (const r of replies.results as Row[]) {
    push({ id: `r:${r.id}`, kind: 'reply', params: { user: String(r.username), project: String(r.name) }, title: `${r.username} replied to you`, body: `On ${r.name}`, url: `/project/${r.slug}/comments`, createdAt: Number(r.at) });
  }
  for (const r of messages.results as Row[]) {
    push({ id: `m:${r.id}`, kind: 'mod_message', params: { project: String(r.name) }, title: `Message from the moderators`, body: `About ${r.name}`, url: `/project/${r.slug}/settings?tab=moderation`, createdAt: Number(r.at) });
  }
  for (const r of statuses.results as Row[]) {
    push({
      id: `s:${r.id}`,
      kind: 'version_status',
      params: { project: String(r.name), version: String(r.version_number), action: String(r.action) },
      title: `${r.name} ${r.version_number} ${STATUS_ACTIONS[String(r.action)] ?? 'changed'}`,
      body: 'Update on your upload',
      url: `/project/${r.slug}/settings?tab=versions`,
      createdAt: Number(r.at),
    });
  }
  const seen = new Set<string>();
  return out
    .filter((n) => (seen.has(n.id) ? false : (seen.add(n.id), true)))
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, limit);
}

async function list(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx, SCOPE.NOTIFICATIONS_READ);
  const row = await ctx.env.DB.prepare('SELECT notifications_seen_at FROM users WHERE id = ?').bind(user.id).first<{ notifications_seen_at: number }>();
  const seenAt = row?.notifications_seen_at ?? 0;
  return json({ notifications: await collectNotifications(ctx.env, user.id, seenAt), seenAt });
}

async function markRead(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx);
  await ctx.env.DB.prepare('UPDATE users SET notifications_seen_at = ? WHERE id = ?').bind(Date.now(), user.id).run();
  return json({ ok: true });
}

// --- Feeds ----------------------------------------------------------------------------------------

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

interface FeedItem {
  id: string;
  title: string;
  url: string;
  updated: number;
  summary: string;
}

function atom(title: string, self: string, link: string, items: FeedItem[]): Response {
  const updated = new Date(items[0]?.updated ?? Date.now()).toISOString();
  const entries = items
    .map(
      (i) => `  <entry>
    <id>${xmlEscape(i.id)}</id>
    <title>${xmlEscape(i.title)}</title>
    <link href="${xmlEscape(i.url)}"/>
    <updated>${new Date(i.updated).toISOString()}</updated>
    <summary>${xmlEscape(i.summary.slice(0, 2000))}</summary>
  </entry>`,
    )
    .join('\n');
  const body = `<?xml version="1.0" encoding="utf-8"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <id>${xmlEscape(self)}</id>
  <title>${xmlEscape(title)}</title>
  <link rel="self" href="${xmlEscape(self)}"/>
  <link href="${xmlEscape(link)}"/>
  <updated>${updated}</updated>
${entries}
</feed>
`;
  return new Response(body, {
    headers: { 'Content-Type': 'application/atom+xml; charset=utf-8', 'Cache-Control': 'public, max-age=900', 'X-Content-Type-Options': 'nosniff' },
  });
}

async function projectFeed(ctx: Ctx): Promise<Response> {
  const key = (ctx.params.id ?? '').replace(/\.xml$/, '').toLowerCase();
  if (!/^[a-z0-9-]{1,48}$/.test(key)) throw notFound('Project not found.');
  const p = await ctx.env.DB.prepare(`SELECT id, slug, name FROM projects WHERE ${isId(key) ? 'id' : 'slug'} = ? AND status IN ('active', 'delisted')`)
    .bind(key)
    .first<{ id: string; slug: string; name: string }>();
  if (!p) throw notFound('Project not found.');
  const rows = await ctx.env.DB.prepare(
    "SELECT id, version_number, name, changelog, published_at FROM versions WHERE project_id = ? AND status = 'live' ORDER BY published_at DESC LIMIT 30",
  )
    .bind(p.id)
    .all<{ id: string; version_number: string; name: string; changelog: string; published_at: number }>();
  const site = siteUrl();
  return atom(
    `${p.name} on ${SITE.name}`,
    `${ctx.url.origin}/v1/projects/${p.slug}/feed.xml`,
    `${site}/project/${p.slug}`,
    rows.results.map((v) => ({
      id: `${site}/project/${p.slug}/version/${v.id}`,
      title: `${p.name} ${v.name || v.version_number}`,
      url: `${site}/project/${p.slug}/version/${v.id}`,
      updated: v.published_at,
      summary: v.changelog || `${p.name} ${v.version_number} is available.`,
    })),
  );
}

async function followFeed(ctx: Ctx): Promise<Response> {
  const token = (ctx.params.token ?? '').replace(/\.xml$/, '');
  if (!/^arf_[A-Za-z0-9_-]{32}$/.test(token)) throw notFound('Feed not found.');
  const user = await ctx.env.DB.prepare('SELECT id, username FROM users WHERE feed_token_hash = ? AND deleted_at IS NULL AND banned = 0')
    .bind(await sha256Hex(token))
    .first<{ id: string; username: string }>();
  if (!user) throw notFound('Feed not found.');
  const rows = await ctx.env.DB.prepare(
    `SELECT v.id, v.version_number, v.name AS vname, v.changelog, v.published_at, p.slug, p.name FROM follows f
     JOIN versions v ON v.project_id = f.project_id AND v.status = 'live'
     JOIN projects p ON p.id = v.project_id AND p.status IN ('active', 'delisted')
     WHERE f.user_id = ? ORDER BY v.published_at DESC LIMIT 50`,
  )
    .bind(user.id)
    .all<{ id: string; version_number: string; vname: string; changelog: string; published_at: number; slug: string; name: string }>();
  const site = siteUrl();
  const res = atom(
    `Projects ${user.username} follows on ${SITE.name}`,
    `${ctx.url.origin}/v1/feeds/${token}.xml`,
    `${site}/dashboard`,
    rows.results.map((v) => ({
      id: `${site}/project/${v.slug}/version/${v.id}`,
      title: `${v.name} ${v.vname || v.version_number}`,
      url: `${site}/project/${v.slug}/version/${v.id}`,
      updated: v.published_at,
      summary: v.changelog || `${v.name} ${v.version_number} is available.`,
    })),
  );
  res.headers.set('Cache-Control', 'private, max-age=600');
  return res;
}

async function rotateFeedToken(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  if (ctx.request.method === 'DELETE') {
    await ctx.env.DB.prepare('UPDATE users SET feed_token_hash = NULL WHERE id = ?').bind(user.id).run();
    return json({ ok: true });
  }
  const token = `arf_${randomToken(24)}`;
  if (token.length !== 36) throw new HttpError(500, 'internal', 'Could not create a feed link.');
  await ctx.env.DB.prepare('UPDATE users SET feed_token_hash = ? WHERE id = ?').bind(await sha256Hex(token), user.id).run();
  return json({ url: `${ctx.url.origin}/v1/feeds/${token}.xml` });
}

export function notificationRoutes(r: Router): void {
  r.get('/api/me/notifications', list);
  r.post('/api/me/notifications/read', markRead);
  r.get('/v1/projects/:id/feed.xml', projectFeed);
  r.get('/v1/feeds/:token', followFeed);
  r.post('/api/me/feed', rotateFeedToken);
  r.delete('/api/me/feed', rotateFeedToken);
}

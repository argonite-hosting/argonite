// Project comments. The text is stored as JSON pages in the project's own repository (branch
// argonite-data); D1 holds an index (who wrote what, where) and the hash of each committed page.
import { PERM, has } from '../../../shared/permissions';
import type { Comment, CommentPageFile, CommentPageRef } from '../../../shared/types';
import { cleanMultiline, isId } from '../../../shared/validate';
import { projectRepo } from '../lib/app';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { dataUrl, pending, projectData, queueWrite, readFile } from '../lib/datastore';
import { assertSameSite, audit, isStaff, projectAccess, rateLimit } from '../lib/guard';
import { HttpError, badRequest, clientIp, forbidden, json, notFound, readJson } from '../lib/http';
import { str } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { requireActiveUser, type SessionUser } from '../lib/session';
import type { Env } from '../env';
import { assertSafeLinks, extractLinks } from '../lib/linkcheck';

const PAGE_SIZE = 100;
const MAX_BODY = 2000;
const EDIT_WINDOW_MS = 24 * 3600 * 1000;
const MIN_ACCOUNT_AGE_MS = 7 * 86_400_000;
// Spam limits. Accounts younger than NEW_ACCOUNT_MS (on GitHub) get the stricter link limit.
const NEW_ACCOUNT_MS = 30 * 86_400_000;
const LINKS_NEW = 1;
const LINKS_MAX = 5;
const BURST = { count: 5, windowMs: 10 * 60_000 };
const PER_PROJECT_HOURLY = 10;
const WAVE_AUTHORS = 3;

interface PageRow {
  page: number;
  path: string;
  commit_sha: string | null;
  sha256: string | null;
  count: number;
  rev: number;
}

const pagePath = (page: number) => `comments/p${String(page).padStart(5, '0')}.json`;

async function loadPage(env: Env, repo: string, projectId: string, row: PageRow): Promise<CommentPageFile> {
  const text = await readFile(env, repo, row.path, row.commit_sha, row.sha256);
  if (text === null) {
    if (row.count > 0) throw new HttpError(503, 'data_unavailable', 'Comments could not be loaded from GitHub right now. Try again shortly.');
    return { v: 1, project: projectId, page: row.page, comments: [] };
  }
  const parsed = JSON.parse(text) as CommentPageFile;
  if (parsed.v !== 1 || parsed.project !== projectId || parsed.page !== row.page || !Array.isArray(parsed.comments)) {
    throw new HttpError(503, 'data_invalid', 'A comment page failed its integrity check.');
  }
  return parsed;
}

async function list(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const access = await projectAccess(ctx.env, ctx.params.id, null);
  if (access.status !== 'active' && access.status !== 'delisted') throw notFound('Project not found.');
  const mode = await ctx.env.DB.prepare('SELECT comments_mode FROM projects WHERE id = ?').bind(access.id).first<{ comments_mode: string }>();
  const rows = await ctx.env.DB.prepare('SELECT page, path, commit_sha, sha256, count, rev FROM comment_pages WHERE project_id = ? ORDER BY page DESC')
    .bind(access.id)
    .all<PageRow>();
  const pages: CommentPageRef[] = [];
  for (const r of rows.results) {
    const queued = await pending(ctx.env, access.repo_full_name, r.path);
    let pendingComments: Comment[] = [];
    if (queued?.content) {
      try {
        pendingComments = (JSON.parse(queued.content) as CommentPageFile).comments;
      } catch {
        pendingComments = [];
      }
    }
    pages.push({
      page: r.page,
      url: !queued && r.commit_sha ? dataUrl(access.repo_full_name, r.commit_sha, r.path) : null,
      sha256: !queued ? r.sha256 : null,
      count: r.count,
      pending: pendingComments,
    });
  }
  const total = rows.results.reduce((n, r) => n + r.count, 0);
  return json({ mode: mode?.comments_mode ?? 'open', total, pages });
}

async function guardWriter(ctx: Ctx): Promise<SessionUser> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  if (Date.now() - user.githubCreatedAt < MIN_ACCOUNT_AGE_MS) throw forbidden('New GitHub accounts can comment after their first week.');
  await rateLimit(ctx.env.RL_WRITE, `c:${user.id}`);
  return user;
}

// Lower-case letters and digits only, so trivial edits don't dodge the duplicate checks.
async function bodyHash(text: string): Promise<string> {
  return sha256Hex(text.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim());
}

function checkLinkCount(user: SessionUser, text: string): void {
  const max = Date.now() - user.githubCreatedAt < NEW_ACCOUNT_MS ? LINKS_NEW : LINKS_MAX;
  if (extractLinks(text).length > max) {
    throw badRequest(max === 1 ? 'New accounts can include one link per comment.' : `Comments can include up to ${max} links.`, { body: 'Too many links.' });
  }
}

// Bursts, floods on one project, repeats of your own comment, and the same text from several accounts.
async function checkSpam(ctx: Ctx, user: SessionUser, projectId: string, text: string, hash: string): Promise<void> {
  const now = Date.now();
  const [burst, project, repeat, wave] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND created_at > ?').bind(user.id, now - BURST.windowMs),
    ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND project_id = ? AND created_at > ?').bind(user.id, projectId, now - 3_600_000),
    ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND body_hash = ? AND created_at > ?').bind(user.id, hash, now - 86_400_000),
    ctx.env.DB.prepare('SELECT COUNT(DISTINCT author_id) AS n FROM comments WHERE body_hash = ? AND author_id != ? AND created_at > ?').bind(hash, user.id, now - 3_600_000),
  ]);
  const n = (r: D1Result) => (r.results[0] as { n: number } | undefined)?.n ?? 0;
  if (n(burst) >= BURST.count) throw new HttpError(429, 'rate_limited', 'You’re commenting very quickly. Wait a few minutes and try again.');
  if (n(project) >= PER_PROJECT_HOURLY) throw new HttpError(429, 'rate_limited', 'You’ve commented a lot on this project in the last hour. Try again later.');
  if (n(repeat) > 0) throw badRequest('You already posted this comment.', { body: 'Duplicate.' });
  // Short replies like "thanks!" are naturally repeated, so the wave check skips them.
  const substantial = text.length >= 30 || extractLinks(text).length > 0;
  if (substantial && n(wave) + 1 >= WAVE_AUTHORS) {
    await audit(ctx.env, user.id, 'comment.spam_blocked', 'project', projectId, { hash }).run();
    throw badRequest('This comment matches text other accounts just posted, so it was held back as possible spam.', { body: 'Looks like spam.' });
  }
}

function cleanBody(raw: unknown): string {
  if (typeof raw !== 'string') throw badRequest('Write a comment.', { body: 'Required.' });
  const body = cleanMultiline(raw).replace(/\n{3,}/g, '\n\n');
  if (!body.trim()) throw badRequest('Write a comment.', { body: 'Required.' });
  if (body.length > MAX_BODY) throw badRequest(`Comments can be at most ${MAX_BODY} characters.`, { body: 'Too long.' });
  return body;
}

// Read-modify-write of one page, guarded by a lock token so two writers can't overwrite each other.
async function writePage(
  ctx: Ctx,
  project: { id: string; repo_full_name: string; installation_id: number | null },
  page: number,
  change: (file: CommentPageFile) => void,
  extra: (lock: string) => D1PreparedStatement[],
  opts: { purge?: boolean; countDelta?: number } = {},
): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const row = await ctx.env.DB.prepare('SELECT page, path, commit_sha, sha256, count, rev FROM comment_pages WHERE project_id = ? AND page = ?')
      .bind(project.id, page)
      .first<PageRow>();
    if (!row) throw notFound('Comment page not found.');
    const file = await loadPage(ctx.env, project.repo_full_name, project.id, row);
    change(file);
    const content = JSON.stringify(file);
    const lock = randomToken(12);
    const target = projectData(project.repo_full_name, project.installation_id);
    const claim = ctx.env.DB.prepare('UPDATE comment_pages SET rev = rev + 1, lock = ?, count = count + ?, updated_at = ? WHERE project_id = ? AND page = ? AND rev = ?').bind(
      lock,
      opts.countDelta ?? 0,
      Date.now(),
      project.id,
      page,
      row.rev,
    );
    const results = await ctx.env.DB.batch([claim, ...extra(lock)]);
    if (!results[0].meta.changes) continue;
    await queueWrite(ctx.env, target, row.path, 'comments', `${project.id}:${page}`, content, { purge: opts.purge });
    return;
  }
  throw new HttpError(409, 'busy', 'Lots of people are commenting right now. Try again in a moment.');
}

async function projectForComments(ctx: Ctx, user: SessionUser) {
  const access = await projectAccess(ctx.env, ctx.params.id, user);
  if (access.status !== 'active' && access.status !== 'delisted') throw notFound('Project not found.');
  const row = await ctx.env.DB.prepare('SELECT comments_mode, installation_id FROM projects WHERE id = ?').bind(access.id).first<{ comments_mode: string; installation_id: number | null }>();
  let installationId = row?.installation_id ?? null;
  if (!installationId) installationId = (await projectRepo(ctx.env, access)).installationId;
  return { access, mode: row?.comments_mode ?? 'open', project: { id: access.id, repo_full_name: access.repo_full_name, installation_id: installationId } };
}

async function create(ctx: Ctx): Promise<Response> {
  const user = await guardWriter(ctx);
  const body = await readJson(ctx.request, 16_000);
  const text = cleanBody(body.body);
  checkLinkCount(user, text);
  await assertSafeLinks(ctx.env, 'body', text);
  const { access, mode, project } = await projectForComments(ctx, user);
  if (mode === 'off') throw forbidden('Comments are turned off for this project.');
  if (mode === 'members' && !access.role) throw forbidden('Only project members can comment here.');
  if (access.archived) throw forbidden('This project is archived.');
  const hash = await bodyHash(text);
  await checkSpam(ctx, user, access.id, text, hash);

  const recent = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM comments WHERE author_id = ? AND created_at > ?').bind(user.id, Date.now() - 86_400_000).first<{ n: number }>();
  if ((recent?.n ?? 0) >= 60) throw new HttpError(429, 'rate_limited', 'You have commented a lot today. Take a break and come back tomorrow.');

  let parentId: string | null = null;
  if (body.parent !== undefined && body.parent !== null) {
    const pid = str(body, 'parent', { max: 26 })!;
    const parent = isId(pid)
      ? await ctx.env.DB.prepare('SELECT id, parent_id, deleted FROM comments WHERE id = ? AND project_id = ?').bind(pid, access.id).first<{ id: string; parent_id: string | null; deleted: number }>()
      : null;
    if (!parent || parent.deleted) throw badRequest('That comment no longer exists.');
    // One level of replies keeps threads readable; replying to a reply joins its thread.
    parentId = parent.parent_id ?? parent.id;
  }

  const last = await ctx.env.DB.prepare('SELECT page, count FROM comment_pages WHERE project_id = ? ORDER BY page DESC LIMIT 1').bind(access.id).first<{ page: number; count: number }>();
  const page = last && last.count < PAGE_SIZE ? last.page : (last?.page ?? 0) + 1;
  const now = Date.now();
  if (!last || last.count >= PAGE_SIZE) {
    await ctx.env.DB.prepare('INSERT OR IGNORE INTO comment_pages (project_id, page, path, count, rev, updated_at) VALUES (?, ?, ?, 0, 0, ?)').bind(access.id, page, pagePath(page), now).run();
  }

  const id = newId();
  const comment: Comment = { id, parent: parentId, author: { id: user.id, username: user.username }, body: text, createdAt: now, editedAt: null, deleted: false };
  await writePage(
    ctx,
    project,
    page,
    (file) => {
      if (file.comments.length >= PAGE_SIZE + 20) throw new HttpError(409, 'busy', 'Try again in a moment.');
      file.comments.push(comment);
    },
    (lock) => [
      ctx.env.DB.prepare(
        `INSERT INTO comments (id, project_id, page, author_id, parent_id, created_at, body_hash)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?8 WHERE EXISTS (SELECT 1 FROM comment_pages WHERE project_id = ?2 AND page = ?3 AND lock = ?7)`,
      ).bind(id, access.id, page, user.id, parentId, now, lock, hash),
    ],
    { countDelta: 1 },
  );
  return json({ comment }, 201);
}

async function commentFor(ctx: Ctx, user: SessionUser) {
  if (!isId(ctx.params.id)) throw notFound('Comment not found.');
  const c = await ctx.env.DB.prepare('SELECT id, project_id, page, author_id, created_at, deleted FROM comments WHERE id = ?')
    .bind(ctx.params.id)
    .first<{ id: string; project_id: string; page: number; author_id: string; created_at: number; deleted: number }>();
  if (!c || c.deleted) throw notFound('Comment not found.');
  ctx.params.id = c.project_id;
  const target = await projectForComments(ctx, user);
  return { c, ...target };
}

async function edit(ctx: Ctx): Promise<Response> {
  const user = await guardWriter(ctx);
  const body = await readJson(ctx.request, 16_000);
  const text = cleanBody(body.body);
  checkLinkCount(user, text);
  await assertSafeLinks(ctx.env, 'body', text);
  const { c, project } = await commentFor(ctx, user);
  if (c.author_id !== user.id) throw forbidden('You can only edit your own comments.');
  if (Date.now() - c.created_at > EDIT_WINDOW_MS) throw forbidden('Comments can be edited for 24 hours after posting.');
  const now = Date.now();
  await writePage(
    ctx,
    project,
    c.page,
    (file) => {
      const target = file.comments.find((x) => x.id === c.id);
      if (!target || target.deleted) throw notFound('Comment not found.');
      target.body = text;
      target.editedAt = now;
    },
    (lock) => [
      ctx.env.DB.prepare('UPDATE comments SET edited_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM comment_pages WHERE project_id = ? AND page = ? AND lock = ?)').bind(
        now,
        c.id,
        c.project_id,
        c.page,
        lock,
      ),
    ],
    // Edits replace text, so the old wording is squashed out of the branch history too.
    { purge: true },
  );
  return json({ ok: true });
}

async function remove(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `c:${user.id}`);
  const { c, access, project } = await commentFor(ctx, user);
  const own = c.author_id === user.id;
  const moderator = has(access.perms, PERM.MODERATE_COMMENTS) || isStaff(user);
  if (!own && !moderator) throw forbidden('You can only delete your own comments.');
  await writePage(
    ctx,
    project,
    c.page,
    (file) => {
      const target = file.comments.find((x) => x.id === c.id);
      if (!target) return;
      target.body = '';
      target.deleted = true;
    },
    (lock) => [
      ctx.env.DB.prepare('UPDATE comments SET deleted = 1 WHERE id = ? AND EXISTS (SELECT 1 FROM comment_pages WHERE project_id = ? AND page = ? AND lock = ?)').bind(
        c.id,
        c.project_id,
        c.page,
        lock,
      ),
      ...(own ? [] : [audit(ctx.env, user.id, 'comment.delete', 'comment', c.id, { project: c.project_id })]),
    ],
    { purge: true },
  );
  return json({ ok: true });
}

export function commentRoutes(r: Router): void {
  r.get('/v1/projects/:id/comments', list);
  r.post('/api/projects/:id/comments', create);
  r.patch('/api/comments/:id', edit);
  r.delete('/api/comments/:id', remove);
}

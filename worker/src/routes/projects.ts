import { SITE } from '../../../shared/config';
import { ORG_PERM, PERM, PERM_ALL, PERM_DEFAULT_MEMBER, SCOPE, has } from '../../../shared/permissions';
import { CATEGORIES, COMMENT_MODES, LICENSES, PROJECT_TYPES, SIDES, typeInfo, type ProjectType } from '../../../shared/taxonomy';
import type { AutoPublishSettings } from '../../../shared/types';
import {
  cleanMultiline,
  cleanText,
  isId,
  validateHttpsUrl,
  validateName,
  validateSlug,
  validateSummary,
  validateUsername,
} from '../../../shared/validate';
import { bytesToB64, newId, sha256Hex } from '../lib/crypto';
import { assertSafeLinks } from '../lib/linkcheck';
import { loadProjectRow, loadVersions, toProject } from '../lib/db';
import { projectRepo, repoInstallationId } from '../lib/app';
import { requireActor } from '../lib/auth';
import { gh, repoPath, userToken, writableRepo, type GitHubRepo } from '../lib/github';
import { assertSameSite, audit, isStaff, projectAccess, rateLimit, requirePerm, verifyTurnstile } from '../lib/guard';
import { HttpError, badRequest, conflict, forbidden, json, notFound, readBytesLimited, readJson } from '../lib/http';
import { check, int, oneOf, optionalStr, sniffImage, str, strArray } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { currentUser, requireActiveUser, requireUser } from '../lib/session';

const PROJECT_TYPE_IDS = PROJECT_TYPES.map((t) => t.id) as ProjectType[];
const LICENSE_IDS = LICENSES.map((l) => l.id);
const MAX_PROJECTS_PER_USER = 100;
const MAX_NEW_PROJECTS_PER_DAY = 5;

function validCategories(type: ProjectType, list: string[] | undefined): string[] | undefined {
  if (!list) return undefined;
  const allowed = new Set(CATEGORIES.filter((c) => c.types.includes(type)).map((c) => c.id));
  const bad = list.find((c) => !allowed.has(c));
  if (bad) throw badRequest(`Category "${bad}" does not apply to this project type.`, { categories: 'Invalid category.' });
  return list;
}

async function create(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request);

  const name = cleanText(str(body, 'name', { required: true, max: 200 })!);
  const slug = str(body, 'slug', { required: true, max: 64 })!.trim().toLowerCase();
  const summary = cleanText(str(body, 'summary', { required: true, max: 400 })!);
  const type = oneOf(body, 'type', PROJECT_TYPE_IDS, true)!;
  const license = oneOf(body, 'license', LICENSE_IDS, true)!;
  const categories = validCategories(type, strArray(body, 'categories', { max: 5, itemMax: 32 })) ?? [];
  check(validateName(name), 'name');
  check(validateSlug(slug), 'slug');
  check(validateSummary(summary), 'summary');

  const repoSpec = body.repo as Record<string, unknown> | undefined;
  if (!repoSpec || typeof repoSpec !== 'object') throw badRequest('Choose a repository.', { repo: 'Required.' });
  const mode = oneOf(repoSpec, 'mode', ['create', 'existing'] as const, true)!;

  const counts = await ctx.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM projects WHERE owner_id = ?1 AND status != 'removed') AS total,
       (SELECT COUNT(*) FROM projects WHERE owner_id = ?1 AND created_at > ?2) AS today,
       (SELECT COUNT(*) FROM projects WHERE slug = ?3) AS taken`,
  )
    .bind(user.id, Date.now() - 86_400_000, slug)
    .first<{ total: number; today: number; taken: number }>();
  if (counts!.taken) throw conflict('That URL is already taken.');
  if (counts!.total >= MAX_PROJECTS_PER_USER) throw forbidden('You have reached the project limit.');
  if (counts!.today >= MAX_NEW_PROJECTS_PER_DAY) throw new HttpError(429, 'rate_limited', 'You can create a few projects per day. Try again tomorrow.');

  await verifyTurnstile(ctx.env, ctx.request, body.turnstileToken);
  const token = await userToken(ctx.env, user.id);

  let repo: GitHubRepo;
  if (mode === 'create') {
    const repoName = str(repoSpec, 'name', { required: true, max: 100 })!.trim();
    if (!/^[A-Za-z0-9._-]{1,100}$/.test(repoName) || repoName === '.' || repoName === '..' || repoName.toLowerCase().endsWith('.git')) {
      throw badRequest('Repository names can use letters, numbers, dots, dashes and underscores.', { repoName: 'Invalid name.' });
    }
    try {
      repo = await gh<GitHubRepo>(token, 'POST', '/user/repos', {
        name: repoName,
        description: summary.slice(0, 340),
        homepage: `${SITE.url}/project/${slug}`,
        private: false,
        auto_init: true,
        has_wiki: false,
      });
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) throw e;
      throw new HttpError(
        409,
        'repo_create_failed',
        `GitHub would not create the repository. It may already exist, or the ${SITE.name} app needs access to all repositories. You can create it yourself and pick it instead.`,
      );
    }
  } else {
    const repoId = int(repoSpec, 'id', { min: 1, max: Number.MAX_SAFE_INTEGER, required: true })!;
    repo = await writableRepo(token, repoId);
    try {
      await gh<unknown[]>(token, 'GET', `${repoPath(repo)}/commits?per_page=1`);
    } catch {
      throw badRequest('That repository is empty. Push at least one commit so releases can be tagged.', { repo: 'Empty repository.' });
    }
  }

  const inUse = await ctx.env.DB.prepare("SELECT id FROM projects WHERE repo_id = ? AND status != 'removed'").bind(repo.id).first();
  if (inUse) throw conflict('That repository is already linked to another project.');
  // Releases, images and comments are written by the app, so it has to be installed on the repo.
  const installationId = await repoInstallationId(ctx.env, repo.full_name);
  if (!installationId) {
    throw new HttpError(409, 'app_not_installed', `Install the ${SITE.name} GitHub App on ${repo.full_name} first, then try again.`);
  }

  const id = newId();
  const now = Date.now();
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO projects (id, slug, name, summary, type, status, owner_id, repo_id, repo_full_name, installation_id, license, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, slug, name, summary, type, user.id, repo.id, repo.full_name, installationId, license, now, now),
      ctx.env.DB.prepare("INSERT INTO members (project_id, user_id, role, permissions, accepted, created_at) VALUES (?, ?, 'owner', ?, 1, ?)").bind(id, user.id, PERM_ALL, now),
      ...categories.map((c) => ctx.env.DB.prepare('INSERT INTO project_categories (project_id, category) VALUES (?, ?)').bind(id, c)),
      audit(ctx.env, user.id, 'project.create', 'project', id, { slug, repo: repo.full_name }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) throw conflict('That URL is already taken.');
    throw e;
  }
  return json({ id, slug }, 201);
}

async function manage(ctx: Ctx): Promise<Response> {
  const user = await requireUser(ctx);
  const access = await projectAccess(ctx.env, ctx.params.id, user);
  if (!access.role && !isStaff(user)) throw notFound('Project not found.');
  const row = await loadProjectRow(ctx.env, access.id);
  const [project, versions] = await Promise.all([
    toProject(ctx.env, row!),
    loadVersions(ctx.env, {
      projectId: access.id,
      statuses: ['uploading', 'scanning', 'review', 'live', 'rejected', 'revoked', 'unavailable'],
      includeScan: true,
      staff: isStaff(user),
    }),
  ]);
  let autoPublish: AutoPublishSettings | null = null;
  try {
    autoPublish = row!.auto_publish ? (JSON.parse(row!.auto_publish) as AutoPublishSettings) : null;
  } catch {
    autoPublish = null;
  }
  return json({ project, versions, role: access.role, perms: isStaff(user) && !access.role ? 0 : access.perms, statusReason: row!.status_reason, autoPublish });
}

async function update(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx, SCOPE.PROJECTS_WRITE);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const access = await requirePerm(ctx.env, ctx.params.id, user, 0);
  const body = await readJson(ctx.request, 300_000);
  const need = (flag: number, what: string) => {
    if (!has(access.perms, flag)) throw forbidden(`Your role in this project does not allow changing ${what}.`);
  };
  const detailKeys = ['name', 'summary', 'slug', 'license', 'licenseUrl', 'sourceUrl', 'issuesUrl', 'wikiUrl', 'discordUrl', 'donationUrl', 'clientSide', 'serverSide', 'categories', 'archived'];
  if (detailKeys.some((k) => body[k] !== undefined)) need(PERM.EDIT_DETAILS, 'project details');
  if (body.description !== undefined) need(PERM.EDIT_BODY, 'the description');
  if (body.commentsMode !== undefined || body.autoPublish !== undefined) need(PERM.MANAGE_SETTINGS, 'publishing and comment settings');
  const sets: string[] = [];
  const binds: unknown[] = [];
  const set = (col: string, value: unknown) => {
    sets.push(`${col} = ?`);
    binds.push(value);
  };

  const name = str(body, 'name', { max: 200 });
  if (name !== undefined) {
    check(validateName(name), 'name');
    set('name', cleanText(name));
  }
  const summary = str(body, 'summary', { max: 400 });
  if (summary !== undefined) {
    check(validateSummary(summary), 'summary');
    set('summary', cleanText(summary));
  }
  const description = str(body, 'description', { max: SITE.limits.descriptionMaxChars });
  if (description !== undefined) {
    await assertSafeLinks(ctx.env, 'description', description);
    set('description', cleanMultiline(description));
  }
  const slug = str(body, 'slug', { max: 64 });
  if (slug !== undefined && slug !== access.slug) {
    if (access.role !== 'owner' && !has(access.perms, PERM_ALL)) throw forbidden('Only the owner can change the URL.');
    check(validateSlug(slug), 'slug');
    const taken = await ctx.env.DB.prepare('SELECT 1 FROM projects WHERE slug = ?').bind(slug).first();
    if (taken) throw conflict('That URL is already taken.');
    set('slug', slug);
  }
  const license = oneOf(body, 'license', LICENSE_IDS);
  if (license !== undefined) set('license', license);
  const linkFields: [string, string][] = [
    ['licenseUrl', 'license_url'],
    ['sourceUrl', 'source_url'],
    ['issuesUrl', 'issues_url'],
    ['wikiUrl', 'wiki_url'],
    ['discordUrl', 'discord_url'],
    ['donationUrl', 'donation_url'],
  ];
  for (const [key, col] of linkFields) {
    const v = optionalStr(body, key, 400);
    if (v === undefined) continue;
    if (v) {
      check(validateHttpsUrl(v), key);
      await assertSafeLinks(ctx.env, key, v);
    }
    set(col, v);
  }
  const clientSide = oneOf(body, 'clientSide', SIDES);
  if (clientSide) set('client_side', clientSide);
  const serverSide = oneOf(body, 'serverSide', SIDES);
  if (serverSide) set('server_side', serverSide);
  const categories = validCategories(access.type as ProjectType, strArray(body, 'categories', { max: 5, itemMax: 32 }));
  if (typeof body.archived === 'boolean') set('archived', body.archived ? 1 : 0);
  const commentsMode = oneOf(body, 'commentsMode', COMMENT_MODES);
  if (commentsMode) set('comments_mode', commentsMode);
  if (body.autoPublish !== undefined) {
    const settings = parseAutoPublish(body.autoPublish, access.type as ProjectType);
    set('auto_publish', settings ? JSON.stringify(settings) : null);
    set('auto_publish_by', settings ? user.id : null);
  }

  if (!sets.length && !categories) return json({ ok: true });
  set('updated_at', Date.now());
  const stmts = [ctx.env.DB.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, access.id)];
  if (categories) {
    stmts.push(ctx.env.DB.prepare('DELETE FROM project_categories WHERE project_id = ?').bind(access.id));
    for (const c of categories) stmts.push(ctx.env.DB.prepare('INSERT INTO project_categories (project_id, category) VALUES (?, ?)').bind(access.id, c));
  }
  await ctx.env.DB.batch(stmts);

  const after = await ctx.env.DB.prepare('SELECT license, license_url FROM projects WHERE id = ?').bind(access.id).first<{ license: string; license_url: string | null }>();
  if (after?.license === 'LicenseRef-Custom' && !after.license_url) {
    return json({ ok: true, warning: 'Add a link to your custom license so people know the terms.' });
  }
  return json({ ok: true });
}

async function remove(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.DELETE_PROJECT);
  const body = await readJson(ctx.request);
  if (str(body, 'confirm', { required: true, max: 64 }) !== access.slug) throw badRequest('Type the project URL to confirm.', { confirm: 'Does not match.' });
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE projects SET status = 'removed', status_reason = 'Deleted by owner', updated_at = ? WHERE id = ?").bind(Date.now(), access.id),
    audit(ctx.env, user.id, 'project.delete', 'project', access.id),
  ]);
  return json({ ok: true });
}

async function commitImage(ctx: Ctx, maxBytes: number, folder: string): Promise<{ path: string; commit: string; sha256: string; access: Awaited<ReturnType<typeof requirePerm>>; userId: string }> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_UPLOAD, `img:${user.id}`);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.EDIT_DETAILS);
  if (Number(ctx.request.headers.get('Content-Length') ?? '0') > maxBytes) throw new HttpError(413, 'too_large', `Images can be at most ${Math.round(maxBytes / 1024)} KB.`);
  const bytes = await readBytesLimited(ctx.request, maxBytes);
  const kind = sniffImage(bytes);
  if (!kind) throw badRequest('Upload a PNG, JPEG, GIF or WebP image.');
  const { token, repo } = await projectRepo(ctx.env, access);
  const path = `.argonite/${folder}${newId()}.${kind.ext}`;
  const label = folder === 'gallery/' ? 'gallery image' : folder === 'banner-' ? 'project banner' : 'project icon';
  const res = await gh<{ commit: { sha: string } }>(token, 'PUT', `${repoPath(repo)}/contents/${path}`, {
    message: `${SITE.name}: add ${label}`,
    content: bytesToB64(bytes),
  });
  return { path, commit: res.commit.sha, sha256: await sha256Hex(bytes), access, userId: user.id };
}

async function setIcon(ctx: Ctx): Promise<Response> {
  const { path, commit, sha256, access, userId } = await commitImage(ctx, SITE.limits.iconMaxBytes, 'icon-');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE projects SET icon_path = ?, icon_commit = ?, icon_sha256 = ?, updated_at = ? WHERE id = ?').bind(path, commit, sha256, Date.now(), access.id),
    audit(ctx.env, userId, 'project.icon', 'project', access.id),
  ]);
  return json({ ok: true });
}

async function clearIcon(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.EDIT_DETAILS);
  await ctx.env.DB.prepare('UPDATE projects SET icon_path = NULL, icon_commit = NULL, icon_sha256 = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), access.id).run();
  return json({ ok: true });
}

async function setBanner(ctx: Ctx): Promise<Response> {
  const { path, commit, sha256, access, userId } = await commitImage(ctx, SITE.limits.galleryMaxBytes, 'banner-');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE projects SET banner_path = ?, banner_commit = ?, banner_sha256 = ?, updated_at = ? WHERE id = ?').bind(path, commit, sha256, Date.now(), access.id),
    audit(ctx.env, userId, 'project.banner', 'project', access.id),
  ]);
  return json({ ok: true });
}

async function clearBanner(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.EDIT_DETAILS);
  await ctx.env.DB.prepare('UPDATE projects SET banner_path = NULL, banner_commit = NULL, banner_sha256 = NULL, updated_at = ? WHERE id = ?').bind(Date.now(), access.id).run();
  return json({ ok: true });
}

async function addGallery(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const target = await requirePerm(ctx.env, ctx.params.id, await requireActiveUser(ctx), PERM.EDIT_DETAILS);
  const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM gallery WHERE project_id = ?').bind(target.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= SITE.limits.galleryMaxImages) throw badRequest(`Galleries hold up to ${SITE.limits.galleryMaxImages} images.`);
  const titleRaw = ctx.url.searchParams.get('title');
  const title = titleRaw ? cleanText(titleRaw).slice(0, 80) || null : null;
  const { path, commit, sha256, access, userId } = await commitImage(ctx, SITE.limits.galleryMaxBytes, 'gallery/');
  const id = newId();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      'INSERT INTO gallery (id, project_id, path, commit_sha, sha256, title, position, created_at) VALUES (?, ?, ?, ?, ?, ?, (SELECT COALESCE(MAX(position), 0) + 1 FROM gallery WHERE project_id = ?), ?)',
    ).bind(id, access.id, path, commit, sha256, title, access.id, Date.now()),
    audit(ctx.env, userId, 'project.gallery.add', 'project', access.id, { image: id }),
  ]);
  return json({ id }, 201);
}

async function removeGallery(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.EDIT_DETAILS);
  await ctx.env.DB.prepare('DELETE FROM gallery WHERE id = ? AND project_id = ?').bind(ctx.params.gid, access.id).run();
  return json({ ok: true });
}

async function invite(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.MANAGE_INVITES);
  const body = await readJson(ctx.request);
  const username = str(body, 'username', { required: true, max: 39 })!.trim();
  // Nobody can hand out permissions they don't have themselves.
  const permissions = (int(body, 'permissions', { min: 0, max: PERM_ALL }) ?? PERM_DEFAULT_MEMBER) & access.perms;
  if (!validateUsername(username)) throw badRequest('Enter a GitHub username.', { username: 'Invalid username.' });
  const target = await ctx.env.DB.prepare('SELECT id, banned FROM users WHERE username_lower = ? AND deleted_at IS NULL')
    .bind(username.toLowerCase())
    .first<{ id: string; banned: number }>();
  if (!target) throw notFound(`${username} has not signed in to ${SITE.name} yet.`);
  if (target.banned) throw forbidden('That account is suspended.');
  const members = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM members WHERE project_id = ?').bind(access.id).first<{ n: number }>();
  if ((members?.n ?? 0) >= 25) throw badRequest('Projects can have up to 25 members.');
  const res = await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO members (project_id, user_id, role, permissions, accepted, invited_by, created_at) VALUES (?, ?, 'maintainer', ?, 0, ?, ?)",
  )
    .bind(access.id, target.id, permissions, user.id, Date.now())
    .run();
  if (!res.meta.changes) throw conflict('That user is already a member or has a pending invite.');
  await audit(ctx.env, user.id, 'project.member.invite', 'project', access.id, { user: target.id }).run();
  return json({ ok: true }, 201);
}

async function removeMember(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await projectAccess(ctx.env, ctx.params.id, user);
  const targetId = ctx.params.userId;
  const self = targetId === user.id;
  if (!self && !has(access.perms, PERM.REMOVE_MEMBER)) throw forbidden('Your role in this project does not allow removing members.');
  if (targetId === access.owner_id) throw badRequest('The owner cannot be removed.');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("DELETE FROM members WHERE project_id = ? AND user_id = ? AND role != 'owner'").bind(access.id, targetId),
    audit(ctx.env, user.id, self ? 'project.member.leave' : 'project.member.remove', 'project', access.id, { user: targetId }),
  ]);
  return json({ ok: true });
}

async function answerInvite(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const project = await projectAccess(ctx.env, ctx.params.id, user);
  const body = await readJson(ctx.request);
  const accept = body.accept === true;
  const stmt = accept
    ? ctx.env.DB.prepare('UPDATE members SET accepted = 1 WHERE project_id = ? AND user_id = ? AND accepted = 0')
    : ctx.env.DB.prepare('DELETE FROM members WHERE project_id = ? AND user_id = ? AND accepted = 0');
  const res = await stmt.bind(project.id, user.id).run();
  if (!res.meta.changes) throw notFound('Invite not found.');
  await audit(ctx.env, user.id, accept ? 'project.member.accept' : 'project.member.decline', 'project', project.id).run();
  return json({ ok: true });
}

async function follow(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const access = await projectAccess(ctx.env, ctx.params.id, await currentUser(ctx));
  if (access.status !== 'active' && access.status !== 'delisted') throw notFound('Project not found.');
  const on = ctx.request.method === 'PUT';
  const res = await (on
    ? ctx.env.DB.prepare('INSERT OR IGNORE INTO follows (user_id, project_id, created_at) VALUES (?, ?, ?)').bind(user.id, access.id, Date.now())
    : ctx.env.DB.prepare('DELETE FROM follows WHERE user_id = ? AND project_id = ?').bind(user.id, access.id)
  ).run();
  if (res.meta.changes) {
    await ctx.env.DB.prepare('UPDATE projects SET follows = MAX(0, follows + ?) WHERE id = ?').bind(on ? 1 : -1, access.id).run();
  }
  return json({ following: on });
}

async function followState(ctx: Ctx): Promise<Response> {
  const user = await currentUser(ctx);
  if (!user || !isId(ctx.params.id)) return json({ following: false, role: null, perms: 0 });
  const row = await ctx.env.DB.prepare('SELECT EXISTS(SELECT 1 FROM follows WHERE user_id = ?1 AND project_id = ?2) AS following').bind(user.id, ctx.params.id).first<{ following: number }>();
  let role: string | null = null;
  let perms = 0;
  try {
    const access = await projectAccess(ctx.env, ctx.params.id, user);
    role = access.role;
    perms = access.perms;
  } catch {
    // Not found or removed; the page handles that on its own.
  }
  return json({ following: row?.following === 1, role, perms });
}

function parseAutoPublish(raw: unknown, type: ProjectType): AutoPublishSettings | null {
  if (raw === null) return null;
  if (!raw || typeof raw !== 'object') throw badRequest('Invalid auto-publish settings.');
  const rec = raw as Record<string, unknown>;
  if (rec.enabled !== true) return null;
  const allowedLoaders = typeInfo(type)?.loaders ?? [];
  const loaders = strArray(rec, 'loaders', { max: 16, itemMax: 32, required: true })!;
  if (!loaders.length || loaders.some((l) => !allowedLoaders.includes(l))) throw badRequest('Pick the loaders new releases support.', { loaders: 'Invalid loader.' });
  const gameVersions = strArray(rec, 'gameVersions', { max: 300, itemMax: 40, required: true })!;
  if (!gameVersions.length) throw badRequest('Pick the game versions new releases support.', { gameVersions: 'Required.' });
  const pattern = (str(rec, 'assetPattern', { max: 100 }) ?? '').trim() || '*';
  if (!/^[A-Za-z0-9*._+-]{1,100}$/.test(pattern)) throw badRequest('The asset pattern can use letters, numbers, dots, dashes, plus signs and *.', { assetPattern: 'Invalid pattern.' });
  return { enabled: true, drafts: rec.drafts !== false, assetPattern: pattern, loaders, gameVersions };
}

async function editMember(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.EDIT_MEMBER);
  const body = await readJson(ctx.request);
  const permissions = int(body, 'permissions', { min: 0, max: PERM_ALL, required: true })!;
  if (ctx.params.userId === access.owner_id) throw badRequest('The owner always has every permission.');
  const current = await ctx.env.DB.prepare('SELECT permissions FROM members WHERE project_id = ? AND user_id = ?')
    .bind(access.id, ctx.params.userId)
    .first<{ permissions: number }>();
  if (!current) throw notFound('Member not found.');
  // Bits you don't hold yourself stay as they were.
  const next = (current.permissions & ~access.perms) | (permissions & access.perms);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE members SET permissions = ? WHERE project_id = ? AND user_id = ?').bind(next, access.id, ctx.params.userId),
    audit(ctx.env, user.id, 'project.member.permissions', 'project', access.id, { user: ctx.params.userId, permissions: next }),
  ]);
  return json({ ok: true, permissions: next });
}

// Moving a project into (or out of) an organisation needs the project owner and the right in the org.
async function moveToOrg(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const access = await projectAccess(ctx.env, ctx.params.id, user);
  if (access.owner_id !== user.id) throw forbidden('Only the project owner can move it between organisations.');
  const body = await readJson(ctx.request);
  const orgId = body.orgId === null ? null : str(body, 'orgId', { required: true, max: 26 })!;
  const checkOrg = async (id: string, flag: number, what: string) => {
    const m = await ctx.env.DB.prepare(
      `SELECT om.role, om.org_permissions FROM org_members om JOIN organizations o ON o.id = om.org_id
       WHERE om.org_id = ? AND om.user_id = ? AND om.accepted = 1 AND o.deleted_at IS NULL`,
    )
      .bind(id, user.id)
      .first<{ role: string; org_permissions: number }>();
    if (!m || (m.role !== 'owner' && !has(m.org_permissions, flag))) throw forbidden(`You can't ${what} that organisation.`);
  };
  if (orgId) {
    if (!isId(orgId)) throw badRequest('Invalid organisation.');
    await checkOrg(orgId, ORG_PERM.ADD_PROJECT, 'add projects to');
  }
  if (access.org_id) await checkOrg(access.org_id, ORG_PERM.REMOVE_PROJECT, 'take projects out of');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE projects SET org_id = ?, updated_at = ? WHERE id = ?').bind(orgId, Date.now(), access.id),
    audit(ctx.env, user.id, 'project.organization', 'project', access.id, { from: access.org_id, to: orgId }),
  ]);
  return json({ ok: true });
}


export function projectRoutes(r: Router): void {
  r.put('/api/projects/:id/banner', setBanner);
  r.delete('/api/projects/:id/banner', clearBanner);
  r.patch('/api/projects/:id/members/:userId', editMember);
  r.post('/api/projects/:id/organization', moveToOrg);
  r.post('/api/projects', create);
  r.get('/api/projects/:id', manage);
  r.patch('/api/projects/:id', update);
  r.delete('/api/projects/:id', remove);
  r.put('/api/projects/:id/icon', setIcon);
  r.delete('/api/projects/:id/icon', clearIcon);
  r.post('/api/projects/:id/gallery', addGallery);
  r.delete('/api/projects/:id/gallery/:gid', removeGallery);
  r.post('/api/projects/:id/members', invite);
  r.delete('/api/projects/:id/members/:userId', removeMember);
  r.post('/api/projects/:id/invite', answerInvite);
  r.put('/api/projects/:id/follow', follow);
  r.delete('/api/projects/:id/follow', follow);
  r.get('/api/projects/:id/viewer', followState);
}

import { SITE } from '../../../shared/config';
import { PERM, SCOPE } from '../../../shared/permissions';
import { CHANNELS, DEPENDENCY_KINDS, FILE_KINDS, typeInfo, type DependencyKind, type FileKind } from '../../../shared/taxonomy';
import { cleanMultiline, cleanText, fileExtension, isId, releaseTag, sanitizeFilename, validateGameVersion, validateVersionNumber } from '../../../shared/validate';
import { projectRepo } from '../lib/app';
import { requireActor } from '../lib/auth';
import { newId } from '../lib/crypto';
import { loadVersions, recomputeProject } from '../lib/db';
import { GitHubError, dispatchScan, gh, repoPath, type GitHubRelease } from '../lib/github';
import { audit, isStaff, rateLimit, requirePerm, verifyTurnstile, type ProjectAccess } from '../lib/guard';
import { HttpError, badRequest, conflict, forbidden, json, notFound, readJson } from '../lib/http';
import { check, int, oneOf, str, strArray } from '../lib/input';
import { goLive } from '../lib/publish';
import type { Ctx, Router } from '../lib/router';
import { assertSafeLinks } from '../lib/linkcheck';
import { githubUploads } from '../lib/runtime';
import type { Env } from '../env';
import { ensureGameVersions } from './cron';

export const MAX_FILES_PER_VERSION = 6;
const CODE_TYPES = new Set(['mod', 'plugin', 'modpack']);

export interface VersionMeta {
  name?: string;
  changelog?: string;
  channel?: (typeof CHANNELS)[number];
  loaders?: string[];
  gameVersions?: string[];
  dependencies?: { projectId: string; versionId: string | null; kind: DependencyKind }[];
  featured?: boolean;
}

export interface FileSpec {
  filename: string;
  size: number;
  kind: FileKind;
}

export async function parseMeta(env: Env, body: Record<string, unknown>, projectId: string, projectType: string, required: boolean): Promise<VersionMeta> {
  const meta: VersionMeta = {};
  const name = str(body, 'name', { max: 200 });
  if (name !== undefined) {
    const clean = cleanText(name);
    if (clean.length > 80) throw badRequest('Version name must be at most 80 characters.', { name: 'Too long.' });
    meta.name = clean;
  }
  const changelog = str(body, 'changelog', { max: SITE.limits.changelogMaxChars });
  if (changelog !== undefined) {
    await assertSafeLinks(env, 'changelog', changelog);
    meta.changelog = cleanMultiline(changelog);
  }
  meta.channel = oneOf(body, 'channel', CHANNELS, required);
  if (typeof body.featured === 'boolean') meta.featured = body.featured;

  const loaders = strArray(body, 'loaders', { max: 16, itemMax: 32, required });
  if (loaders) {
    const allowed = typeInfo(projectType)?.loaders ?? [];
    if (!loaders.length) throw badRequest('Pick at least one loader.', { loaders: 'Required.' });
    const bad = loaders.find((l) => !allowed.includes(l));
    if (bad) throw badRequest(`"${bad}" is not a valid loader for this project type.`, { loaders: 'Invalid loader.' });
    meta.loaders = loaders;
  }

  const gameVersions = strArray(body, 'gameVersions', { max: 300, itemMax: 40, required });
  if (gameVersions) {
    if (!gameVersions.length) throw badRequest('Pick at least one game version.', { gameVersions: 'Required.' });
    if (gameVersions.some((g) => !validateGameVersion(g))) throw badRequest('Invalid game version.', { gameVersions: 'Invalid value.' });
    await ensureGameVersions(env);
    const unknown = await env.DB.prepare('SELECT value FROM json_each(?) WHERE value NOT IN (SELECT id FROM game_versions)')
      .bind(JSON.stringify(gameVersions))
      .all<{ value: string }>();
    if (unknown.results.length) throw badRequest(`Unknown game version: ${unknown.results[0].value}`, { gameVersions: 'Unknown version.' });
    meta.gameVersions = gameVersions;
  }

  const rawDeps = body.dependencies;
  if (rawDeps !== undefined && rawDeps !== null) {
    if (!Array.isArray(rawDeps) || rawDeps.length > 30) throw badRequest('Dependencies must be a list of up to 30 entries.');
    const deps = rawDeps.map((d) => {
      if (!d || typeof d !== 'object') throw badRequest('Invalid dependency.');
      const rec = d as Record<string, unknown>;
      const pid = str(rec, 'projectId', { required: true, max: 26 })!;
      const vid = rec.versionId ? str(rec, 'versionId', { max: 26 })! : null;
      const kind = oneOf(rec, 'kind', DEPENDENCY_KINDS, true)!;
      if (!isId(pid) || (vid && !isId(vid))) throw badRequest('Invalid dependency id.');
      if (pid === projectId) throw badRequest('A project cannot depend on itself.');
      return { projectId: pid, versionId: vid, kind };
    });
    const unique = new Map(deps.map((d) => [d.projectId, d]));
    if (unique.size) {
      const found = await env.DB.prepare("SELECT id FROM projects WHERE id IN (SELECT value FROM json_each(?)) AND status IN ('active', 'delisted')")
        .bind(JSON.stringify([...unique.keys()]))
        .all<{ id: string }>();
      if (found.results.length !== unique.size) throw badRequest('One of the dependencies is not a published project.', { dependencies: 'Unknown project.' });
      const pinned = [...unique.values()].filter((d) => d.versionId);
      if (pinned.length) {
        const ok = await env.DB.prepare(
          "SELECT COUNT(*) AS n FROM versions v, json_each(?) j WHERE v.id = json_extract(j.value, '$.v') AND v.project_id = json_extract(j.value, '$.p') AND v.status = 'live'",
        )
          .bind(JSON.stringify(pinned.map((d) => ({ v: d.versionId, p: d.projectId }))))
          .first<{ n: number }>();
        if (ok?.n !== pinned.length) throw badRequest('A pinned dependency version does not belong to that project or is not live.', { dependencies: 'Invalid version.' });
      }
    }
    meta.dependencies = [...unique.values()];
  }
  return meta;
}

function extraExtensions(projectType: string, kind: FileKind): string[] {
  if (!CODE_TYPES.has(projectType)) return ['.zip'];
  if (kind === 'sources' || kind === 'javadoc' || kind === 'dev') return ['.jar'];
  if (kind === 'server' || kind === 'client') return ['.zip', '.mrpack'];
  return ['.jar', '.zip'];
}

// The first file is the main one. Legacy clients send a single filename/size pair instead of a list.
export function parseFiles(body: Record<string, unknown>, projectType: string): FileSpec[] {
  const info = typeInfo(projectType)!;
  const raw: unknown[] = Array.isArray(body.files) ? body.files : [{ filename: body.filename, size: body.size, kind: 'primary' }];
  if (!raw.length) throw badRequest('Add a file.', { file: 'Required.' });
  if (raw.length > MAX_FILES_PER_VERSION) throw badRequest(`A version can have up to ${MAX_FILES_PER_VERSION} files.`);
  const out: FileSpec[] = [];
  raw.forEach((item, i) => {
    if (!item || typeof item !== 'object') throw badRequest('Invalid file entry.');
    const rec = item as Record<string, unknown>;
    const kind: FileKind = i === 0 ? 'primary' : (oneOf(rec, 'kind', FILE_KINDS.filter((k) => k !== 'primary'), true) as FileKind);
    if (i > 0 && rec.kind === 'primary') throw badRequest('Only the first file can be the main file.');
    const allowed = kind === 'primary' ? info.extensions : extraExtensions(projectType, kind);
    const filename = sanitizeFilename(str(rec, 'filename', { required: true, max: 255 })!, allowed);
    if (!filename) throw badRequest(`${kind === 'primary' ? 'The main file' : 'That file'} must be a ${allowed.join(' or ')} file.`, { file: 'Wrong file type.' });
    const size = int(rec, 'size', { min: 22, max: SITE.limits.fileMaxBytes, required: true })!;
    out.push({ filename, size, kind });
  });
  const names = new Set(out.map((f) => f.filename.toLowerCase()));
  if (names.size !== out.length) throw badRequest('Each file in a version needs a different name.');
  return out;
}

export function metaStatements(env: Env, versionId: string, meta: VersionMeta): D1PreparedStatement[] {
  const db = env.DB;
  const out: D1PreparedStatement[] = [];
  if (meta.loaders) {
    out.push(db.prepare('DELETE FROM version_loaders WHERE version_id = ?').bind(versionId));
    out.push(db.prepare('INSERT INTO version_loaders (version_id, loader) SELECT ?, value FROM json_each(?)').bind(versionId, JSON.stringify(meta.loaders)));
  }
  if (meta.gameVersions) {
    out.push(db.prepare('DELETE FROM version_game_versions WHERE version_id = ?').bind(versionId));
    out.push(db.prepare('INSERT INTO version_game_versions (version_id, game_version) SELECT ?, value FROM json_each(?)').bind(versionId, JSON.stringify(meta.gameVersions)));
  }
  if (meta.dependencies) {
    out.push(db.prepare('DELETE FROM version_dependencies WHERE version_id = ?').bind(versionId));
    for (const d of meta.dependencies) {
      out.push(db.prepare('INSERT INTO version_dependencies (version_id, dep_project_id, dep_version_id, kind) VALUES (?, ?, ?, ?)').bind(versionId, d.projectId, d.versionId, d.kind));
    }
  }
  return out;
}

export async function uploadCaps(env: Env, userId: string, approvedUploads: number, projectId: string, versionNumber: string): Promise<void> {
  const stats = await env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM versions WHERE author_id = ?1 AND created_at > ?2) AS today,
       (SELECT COUNT(*) FROM versions WHERE author_id = ?1 AND status IN ('uploading', 'scanning')) AS pending,
       (SELECT COUNT(*) FROM versions WHERE project_id = ?3 AND version_number = ?4) AS dup`,
  )
    .bind(userId, Date.now() - 86_400_000, projectId, versionNumber)
    .first<{ today: number; pending: number; dup: number }>();
  if (stats!.dup) throw conflict('That version number already exists for this project.');
  const dailyCap = approvedUploads > 0 ? 40 : 5;
  if (stats!.today >= dailyCap) throw new HttpError(429, 'rate_limited', 'You have hit the daily upload limit. Try again tomorrow.');
  if (stats!.pending >= 5) throw new HttpError(429, 'rate_limited', 'Wait for your other uploads to finish scanning first.');
}

// One scan job per file. The version is decided once every file has a result.
export function scanJobStatements(env: Env, versionId: string, fileIds: string[]): { stmts: D1PreparedStatement[]; jobIds: string[] } {
  const now = Date.now();
  const jobIds = fileIds.map(() => newId());
  const stmts = fileIds.map((fid, i) =>
    env.DB.prepare("INSERT INTO scan_jobs (id, version_id, file_id, kind, status, created_at) VALUES (?, ?, ?, 'scan', 'queued', ?)").bind(jobIds[i], versionId, fid, now),
  );
  return { stmts, jobIds };
}

async function createVersion(ctx: Ctx): Promise<Response> {
  const actor = await requireActor(ctx, SCOPE.VERSIONS_WRITE);
  const user = actor.user;
  await rateLimit(ctx.env.RL_UPLOAD, `v:${user.id}`);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.UPLOAD_VERSION);
  if (access.repo_status !== 'ok') throw conflict('The linked GitHub repository is unavailable. Fix it before uploading.');
  const body = await readJson(ctx.request, 120_000);

  const versionNumber = str(body, 'versionNumber', { required: true, max: 64 })!.trim();
  check(validateVersionNumber(versionNumber), 'versionNumber');
  const meta = await parseMeta(ctx.env, body, access.id, access.type, true);
  const files = parseFiles(body, access.type);
  await uploadCaps(ctx.env, user.id, user.approvedUploads, access.id, versionNumber);
  if (actor.via === 'session') await verifyTurnstile(ctx.env, ctx.request, body.turnstileToken);

  const { token, repo } = await projectRepo(ctx.env, access);
  const tag = releaseTag(versionNumber);
  let release: GitHubRelease;
  try {
    release = await gh<GitHubRelease>(token, 'POST', `${repoPath(repo)}/releases`, {
      tag_name: tag,
      name: meta.name || versionNumber,
      body: meta.changelog ?? '',
      draft: true,
      prerelease: meta.channel !== 'release',
    });
  } catch (e) {
    if (e instanceof GitHubError && e.ghStatus === 422) throw conflict(`GitHub already has a release tagged ${tag} in ${repo.full_name}.`);
    throw e;
  }

  const id = newId();
  const now = Date.now();
  const fileRows = files.map((f, i) => ({ ...f, id: newId(now + i) }));
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO versions (id, project_id, version_number, name, changelog, channel, status, author_id, tag, release_id, upload_name, upload_size, featured, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'uploading', ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, access.id, versionNumber, meta.name || versionNumber, meta.changelog ?? '', meta.channel, user.id, tag, release.id, files[0].filename, files[0].size, meta.featured ? 1 : 0, actor.via === 'token' ? 'api' : 'upload', now),
      ...fileRows.map((f, i) =>
        ctx.env.DB.prepare('INSERT INTO files (id, version_id, kind, filename, size, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(f.id, id, f.kind, f.filename, f.size, i, now),
      ),
      ...metaStatements(ctx.env, id, meta),
      audit(ctx.env, user.id, 'version.create', 'version', id, { via: actor.via }),
    ]);
  } catch (e) {
    ctx.exec.waitUntil(gh(token, 'DELETE', `${repoPath(repo)}/releases/${release.id}`).catch(() => undefined));
    if (String(e).includes('UNIQUE')) throw conflict('That version number already exists for this project.');
    throw e;
  }
  return json(
    {
      id,
      files: fileRows.map((f) => ({ id: f.id, filename: f.filename, size: f.size, kind: f.kind })),
      // Kept for older clients that upload a single file.
      filename: files[0].filename,
      uploadSize: files[0].size,
    },
    201,
  );
}

interface FileUploadRow {
  file_id: string;
  asset_id: number | null;
  filename: string;
  size: number;
  version_id: string;
  project_id: string;
  author_id: string;
  status: string;
  release_id: number;
}

async function receiveFile(ctx: Ctx, row: FileUploadRow, access: ProjectAccess, userId: string): Promise<Response> {
  const declared = Number(ctx.request.headers.get('Content-Length') ?? '-1');
  if (declared !== row.size) throw badRequest('File size does not match what you declared. Start the upload again.');
  if (!ctx.request.body) throw badRequest('Missing file body.');

  const { token, repo } = await projectRepo(ctx.env, access);
  const base = repoPath(repo);
  const release = await gh<GitHubRelease>(token, 'GET', `${base}/releases/${row.release_id}`);
  if (!release.draft) throw conflict('The GitHub release was published outside of this upload. Delete this version and start again.');
  for (const stale of release.assets.filter((a) => a.name.toLowerCase() === row.filename.toLowerCase())) await gh(token, 'DELETE', `${base}/releases/assets/${stale.id}`);

  const uploadBase = release.upload_url.replace(/\{.*\}$/, '');
  if (!uploadBase.startsWith(githubUploads())) throw new HttpError(502, 'github_error', 'Unexpected upload endpoint from GitHub.');
  const ext = fileExtension(row.filename);
  const { readable, writable } = new FixedLengthStream(row.size);
  const pump = ctx.request.body.pipeTo(writable).catch(() => undefined);
  const res = await fetch(`${uploadBase}?name=${encodeURIComponent(row.filename)}`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': `${SITE.name}-API`,
      'Content-Type': ext === '.jar' ? 'application/java-archive' : 'application/zip',
    },
    body: readable,
  });
  await pump;
  if (!res.ok) {
    const detail = ((await res.json().catch(() => null)) as { message?: string } | null)?.message ?? res.status;
    throw new HttpError(502, 'upload_failed', `GitHub did not accept the file (${detail}). Try again.`);
  }
  const asset = (await res.json()) as { id: number; name: string; size: number; state: string };
  if (asset.size !== row.size || asset.state !== 'uploaded' || asset.name !== row.filename) {
    await gh(token, 'DELETE', `${base}/releases/assets/${asset.id}`).catch(() => undefined);
    throw new HttpError(502, 'upload_failed', 'The upload was cut short. Try again.');
  }

  await ctx.env.DB.prepare('UPDATE files SET asset_id = ? WHERE id = ? AND sha256 IS NULL').bind(asset.id, row.file_id).run();
  const remaining = await ctx.env.DB.prepare('SELECT id, asset_id FROM files WHERE version_id = ?').bind(row.version_id).all<{ id: string; asset_id: number | null }>();
  if (remaining.results.some((f) => f.asset_id === null)) {
    return json({ status: 'uploading', remaining: remaining.results.filter((f) => f.asset_id === null).length });
  }

  // Every file is up. Scan them; the release stays a draft until they pass.
  const { stmts, jobIds } = scanJobStatements(ctx.env, row.version_id, remaining.results.map((f) => f.id));
  const moved = await ctx.env.DB.prepare("UPDATE versions SET status = 'scanning', status_reason = NULL WHERE id = ? AND status = 'uploading'").bind(row.version_id).run();
  if (moved.meta.changes) {
    await ctx.env.DB.batch([...stmts, audit(ctx.env, userId, 'version.upload', 'version', row.version_id, { files: remaining.results.length })]);
    ctx.exec.waitUntil(Promise.all(jobIds.map((j) => dispatchScan(ctx.env, j).catch(() => false))));
  }
  return json({ status: 'scanning' });
}

async function uploadFile(ctx: Ctx): Promise<Response> {
  const actor = await requireActor(ctx, SCOPE.VERSIONS_WRITE);
  await rateLimit(ctx.env.RL_UPLOAD, `f:${actor.user.id}`);
  if (!isId(ctx.params.id)) throw notFound('File not found.');
  const row = await ctx.env.DB.prepare(
    `SELECT f.id AS file_id, f.asset_id, f.filename, f.size, v.id AS version_id, v.project_id, v.author_id, v.status, v.release_id
     FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id WHERE f.id = ? AND p.status != 'removed'`,
  )
    .bind(ctx.params.id)
    .first<FileUploadRow>();
  if (!row) throw notFound('File not found.');
  if (row.author_id !== actor.user.id) throw forbidden('Only the person who started this upload can send its files.');
  if (row.status !== 'uploading' || row.asset_id !== null) throw conflict('This file has already been uploaded.');
  const access = await requirePerm(ctx.env, row.project_id, actor.user, PERM.UPLOAD_VERSION);
  return receiveFile(ctx, row, access, actor.user.id);
}

// Older clients upload the main file to the version itself.
async function uploadPrimary(ctx: Ctx): Promise<Response> {
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  const f = await ctx.env.DB.prepare("SELECT id FROM files WHERE version_id = ? AND kind = 'primary'").bind(ctx.params.id).first<{ id: string }>();
  if (!f) throw notFound('Version not found.');
  return uploadFile({ ...ctx, params: { id: f.id } });
}

async function versionForMember(ctx: Ctx, flag: number, scope: number) {
  const actor = await requireActor(ctx, scope);
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  const v = await ctx.env.DB.prepare(
    `SELECT v.id, v.project_id, v.status, v.version_number, v.release_id, v.release_public, v.publish_pending, p.type
     FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = ? AND p.status != 'removed'`,
  )
    .bind(ctx.params.id)
    .first<{ id: string; project_id: string; status: string; version_number: string; release_id: number | null; release_public: number; publish_pending: number; type: string }>();
  if (!v) throw notFound('Version not found.');
  const access = await requirePerm(ctx.env, v.project_id, actor.user, flag);
  return { v, access, actor };
}

async function updateVersion(ctx: Ctx): Promise<Response> {
  const { v, actor } = await versionForMember(ctx, PERM.UPLOAD_VERSION, SCOPE.VERSIONS_WRITE);
  await rateLimit(ctx.env.RL_WRITE, `u:${actor.user.id}`);
  if (v.status === 'deleted') throw notFound('Version not found.');
  const body = await readJson(ctx.request, 120_000);
  const meta = await parseMeta(ctx.env, body, v.project_id, v.type, false);
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (meta.name !== undefined) {
    sets.push('name = ?');
    binds.push(meta.name || v.version_number);
  }
  if (meta.changelog !== undefined) {
    sets.push('changelog = ?');
    binds.push(meta.changelog);
  }
  if (meta.channel) {
    sets.push('channel = ?');
    binds.push(meta.channel);
  }
  if (meta.featured !== undefined) {
    if (meta.featured) {
      const n = await ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM versions WHERE project_id = ? AND featured = 1 AND id != ? AND status != 'deleted'")
        .bind(v.project_id, v.id)
        .first<{ n: number }>();
      if ((n?.n ?? 0) >= 5) throw badRequest('Up to 5 versions can be featured. Unfeature one first.');
    }
    sets.push('featured = ?');
    binds.push(meta.featured ? 1 : 0);
  }
  const stmts = [
    ...(sets.length ? [ctx.env.DB.prepare(`UPDATE versions SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, v.id)] : []),
    ...metaStatements(ctx.env, v.id, meta),
    ...(v.status === 'live' ? recomputeProject(ctx.env, v.project_id) : []),
    ctx.env.DB.prepare('UPDATE projects SET updated_at = ? WHERE id = ?').bind(Date.now(), v.project_id),
  ];
  await ctx.env.DB.batch(stmts);
  return json({ ok: true });
}

async function deleteVersion(ctx: Ctx): Promise<Response> {
  const { v, access, actor } = await versionForMember(ctx, PERM.DELETE_VERSION, SCOPE.VERSIONS_WRITE);
  if (v.status === 'deleted') return json({ ok: true });
  // A release that never went public is ours to clean up. Public releases belong to the author's repo.
  if (!v.release_public && v.release_id) {
    try {
      const { token, repo } = await projectRepo(ctx.env, access);
      await gh(token, 'DELETE', `${repoPath(repo)}/releases/${v.release_id}`);
    } catch {
      // A leftover draft release on GitHub is harmless; the version row is what matters.
    }
  }
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE versions SET status = 'deleted', status_reason = 'Deleted by a project member', featured = 0, publish_pending = 0 WHERE id = ?").bind(v.id),
    ctx.env.DB.prepare("UPDATE scan_jobs SET status = 'failed', error = 'version deleted' WHERE version_id = ? AND status IN ('queued', 'claimed')").bind(v.id),
    ...recomputeProject(ctx.env, v.project_id),
    audit(ctx.env, actor.user.id, 'version.delete', 'version', v.id),
  ]);
  return json({ ok: true });
}

async function retryPublish(ctx: Ctx): Promise<Response> {
  const { v, actor } = await versionForMember(ctx, PERM.UPLOAD_VERSION, SCOPE.VERSIONS_WRITE);
  if (v.publish_pending !== 1 || v.status !== 'unavailable') throw conflict('This version is not waiting to be published.');
  const outcome = await goLive(ctx.env, v.id, actor.user.id, 'version.publish_retry');
  return json({ status: outcome === 'live' ? 'live' : 'unavailable' });
}

async function versionStatus(ctx: Ctx): Promise<Response> {
  const { v, actor } = await versionForMember(ctx, 0, SCOPE.VERSIONS_WRITE);
  const [full] = await loadVersions(ctx.env, {
    ids: [v.id],
    statuses: ['uploading', 'scanning', 'review', 'live', 'rejected', 'revoked', 'unavailable'],
    includeScan: true,
    staff: isStaff(actor.user),
  });
  if (!full) throw notFound('Version not found.');
  return json({ version: full });
}

export function versionRoutes(r: Router): void {
  r.post('/api/projects/:id/versions', createVersion);
  r.put('/api/files/:id', uploadFile);
  r.put('/api/versions/:id/file', uploadPrimary);
  r.get('/api/versions/:id', versionStatus);
  r.patch('/api/versions/:id', updateVersion);
  r.delete('/api/versions/:id', deleteVersion);
  r.post('/api/versions/:id/publish', retryPublish);
}

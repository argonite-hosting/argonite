import { SITE } from '../../../shared/config';
import { CATEGORIES, LICENSES, LOADER_LABELS, PROJECT_TYPES, SORTS, type Sort } from '../../../shared/taxonomy';
import type { GameVersion, SearchResult, UserPublic } from '../../../shared/types';
import { isId, validateUsername } from '../../../shared/validate';
import { newId, sha256Hex } from '../lib/crypto';
import { PROJECT_SELECT, loadProjectRow, loadVersions, parseJson, toProject, toSummary, type ProjectRow } from '../lib/db';
import { downloadStatStatements } from './stats';
import { profileLinks } from './userdata';
import { dispatchScan } from '../lib/github';
import { rateLimit } from '../lib/guard';
import { HttpError, badRequest, clientIp, json, notFound, readJson } from '../lib/http';
import { listParam, pageParams } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { scanKey } from '../lib/runtime';
import { adminIds } from '../env';
import { blockedLinks } from '../lib/linkcheck';
import { ensureGameVersions } from './cron';

const PUBLIC_STATUSES = "('active', 'delisted')";

async function cached(ctx: Ctx, ttlSeconds: number, build: () => Promise<Response>): Promise<Response> {
  const cache = caches.default;
  const key = new Request(ctx.url.toString(), { method: 'GET' });
  const hit = await cache.match(key);
  if (hit) return hit;
  const res = await build();
  if (res.status === 200) {
    res.headers.set('Cache-Control', `public, max-age=${ttlSeconds}`);
    ctx.exec.waitUntil(cache.put(key, res.clone()));
  }
  return res;
}

async function readLimit(ctx: Ctx): Promise<void> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
}

export function ftsQuery(q: string): string | null {
  const tokens = (q.normalize('NFKC').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((t) => t.length <= 40).slice(0, 8);
  return tokens.length ? tokens.map((t) => `"${t}"*`).join(' ') : null;
}

async function search(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  return cached(ctx, 30, async () => {
    const p = ctx.url.searchParams;
    const fts = ftsQuery((p.get('q') ?? '').slice(0, 200));
    const type = p.get('type');
    if (type && !PROJECT_TYPES.some((t) => t.id === type)) throw badRequest('Unknown project type.');
    const requested = p.get('sort') as Sort | null;
    const sort: Sort = requested && SORTS.includes(requested) ? requested : fts ? 'relevance' : 'downloads';
    const { page, size, offset } = pageParams(ctx.url);

    const joinBinds: unknown[] = [];
    const binds: unknown[] = [];
    const where = ["p.status = 'active'"];
    let join = '';
    if (fts) {
      join = 'JOIN (SELECT rowid AS r, bm25(projects_fts, 10.0, 4.0, 1.0) AS score FROM projects_fts WHERE projects_fts MATCH ?) f ON f.r = p.pk';
      joinBinds.push(fts);
    }
    if (type) {
      where.push('p.type = ?');
      binds.push(type);
    }
    const loaders = listParam(ctx.url, 'loaders');
    if (loaders.length) {
      where.push('EXISTS (SELECT 1 FROM project_loaders x WHERE x.project_id = p.id AND x.loader IN (SELECT value FROM json_each(?)))');
      binds.push(JSON.stringify(loaders));
    }
    const versions = listParam(ctx.url, 'versions', 50);
    if (versions.length) {
      where.push('EXISTS (SELECT 1 FROM project_game_versions x WHERE x.project_id = p.id AND x.game_version IN (SELECT value FROM json_each(?)))');
      binds.push(JSON.stringify(versions));
    }
    const environment = p.get('environment');
    if (environment === 'client') where.push("p.client_side IN ('required', 'optional')");
    else if (environment === 'server') where.push("p.server_side IN ('required', 'optional')");
    if (p.get('openSource') === '1') where.push('p.source_url IS NOT NULL');
    if (p.get('hideArchived') === '1') where.push('p.archived = 0');
    for (const c of listParam(ctx.url, 'categories', 5)) {
      where.push('EXISTS (SELECT 1 FROM project_categories x WHERE x.project_id = p.id AND x.category = ?)');
      binds.push(c);
    }
    const order = {
      relevance: fts ? 'f.score ASC, p.downloads DESC' : 'p.downloads DESC',
      downloads: 'p.downloads DESC, p.updated_at DESC',
      follows: 'p.follows DESC, p.downloads DESC',
      updated: 'p.updated_at DESC',
      newest: 'p.published_at DESC',
    }[sort];
    const whereSql = where.join(' AND ');
    const [rows, count] = await ctx.env.DB.batch([
      ctx.env.DB.prepare(`${PROJECT_SELECT} ${join} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...joinBinds, ...binds, size, offset),
      ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM projects p ${join} WHERE ${whereSql}`).bind(...joinBinds, ...binds),
    ]);
    const body: SearchResult = {
      hits: (rows.results as ProjectRow[]).map(toSummary),
      total: (count.results[0] as { n: number }).n,
      page,
      pageSize: size,
    };
    return json(body);
  });
}

async function publicProjectRow(ctx: Ctx): Promise<ProjectRow> {
  const key = ctx.params.idOrSlug.toLowerCase();
  if (!/^[a-z0-9-]{1,48}$/.test(key) && !isId(key)) throw notFound('Project not found.');
  const row = await loadProjectRow(ctx.env, key);
  if (!row || (row.status !== 'active' && row.status !== 'delisted')) throw notFound('Project not found.');
  return row;
}

async function project(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  return cached(ctx, 30, async () => {
    const full = await toProject(ctx.env, await publicProjectRow(ctx));
    full.members = full.members.filter((m) => m.accepted);
    return json(full);
  });
}

async function projectVersions(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  return cached(ctx, 30, async () => {
    const row = await publicProjectRow(ctx);
    let list = await loadVersions(ctx.env, { projectId: row.id, statuses: ['live'] });
    const loaders = listParam(ctx.url, 'loaders');
    const versions = listParam(ctx.url, 'gameVersions', 50);
    if (loaders.length) list = list.filter((v) => v.loaders.some((l) => loaders.includes(l)));
    if (versions.length) list = list.filter((v) => v.gameVersions.some((g) => versions.includes(g)));
    return json({ versions: list.filter((v) => v.file) });
  });
}

async function version(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  return cached(ctx, 30, async () => {
    const [v] = await loadVersions(ctx.env, { ids: [ctx.params.id], statuses: ['live'] });
    if (!v?.file) throw notFound('Version not found.');
    const p = await ctx.env.DB.prepare(`SELECT slug, name, type FROM projects WHERE id = ? AND status IN ${PUBLIC_STATUSES}`)
      .bind(v.projectId)
      .first<{ slug: string; name: string; type: string }>();
    if (!p) throw notFound('Version not found.');
    return json({ version: v, project: p });
  });
}

const HASH_LEN = new Map([
  ['sha1', 40],
  ['sha256', 64],
  ['sha512', 128],
]);

async function lookupHashes(ctx: Ctx, algo: string, hashes: string[]) {
  const len = HASH_LEN.get(algo);
  if (!len) throw badRequest('Algorithm must be sha1, sha256 or sha512.');
  const clean = [...new Set(hashes.map((h) => h.toLowerCase()))].filter((h) => h.length === len && /^[0-9a-f]+$/.test(h));
  if (!clean.length) return new Map<string, string>();
  const rows = await ctx.env.DB.prepare(
    `SELECT f.${algo} AS hash, f.version_id FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id
     WHERE f.${algo} IN (SELECT value FROM json_each(?)) AND v.status = 'live' AND p.status IN ${PUBLIC_STATUSES}`,
  )
    .bind(JSON.stringify(clean))
    .all<{ hash: string; version_id: string }>();
  return new Map(rows.results.map((r) => [r.hash, r.version_id]));
}

async function fileByHash(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const map = await lookupHashes(ctx, ctx.params.algo, [ctx.params.hash]);
  const versionId = map.values().next().value;
  if (!versionId) throw notFound('No published file has that hash.');
  const [v] = await loadVersions(ctx.env, { ids: [versionId], statuses: ['live'] });
  return json({ version: v });
}

async function filesByHash(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const body = await readJson(ctx.request, 64_000);
  const algo = typeof body.algorithm === 'string' ? body.algorithm : '';
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h): h is string => typeof h === 'string').slice(0, 80) : [];
  const map = await lookupHashes(ctx, algo, hashes);
  const versions = await loadVersions(ctx.env, { ids: [...new Set(map.values())], statuses: ['live'] });
  const byId = new Map(versions.map((v) => [v.id, v]));
  const out: Record<string, unknown> = {};
  for (const [hash, id] of map) out[hash] = byId.get(id) ?? null;
  return json({ files: out });
}

async function user(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const name = ctx.params.username;
  if (!validateUsername(name)) throw notFound('User not found.');
  return cached(ctx, 60, async () => {
    const row = await ctx.env.DB.prepare(
      'SELECT id, username, display_name, avatar_url, bio, role, github_id, created_at, profile_commit, profile_path, profile_sha256 FROM users WHERE username_lower = ? AND deleted_at IS NULL',
    )
      .bind(name.toLowerCase())
      .first<{
        id: string;
        username: string;
        display_name: string | null;
        avatar_url: string;
        bio: string | null;
        role: UserPublic['role'];
        github_id: number;
        created_at: number;
        profile_commit: string | null;
        profile_path: string | null;
        profile_sha256: string | null;
      }>();
    if (!row) throw notFound('User not found.');
    const projects = await ctx.env.DB.prepare(
      `${PROJECT_SELECT} JOIN members m ON m.project_id = p.id AND m.user_id = ? AND m.accepted = 1 WHERE p.status = 'active' ORDER BY p.downloads DESC LIMIT 100`,
    )
      .bind(row.id)
      .all<ProjectRow>();
    const body: { user: UserPublic; projects: ReturnType<typeof toSummary>[]; links: { label: string; url: string }[] } = {
      user: {
        id: row.id,
        username: row.username,
        displayName: row.display_name,
        avatarUrl: row.avatar_url,
        bio: row.bio,
        role: adminIds(ctx.env).includes(row.github_id) ? 'admin' : row.role,
        createdAt: row.created_at,
      },
      projects: projects.results.map(toSummary),
      links: await profileLinks(ctx.env, row),
    };
    return json(body);
  });
}

function tags(ctx: Ctx): Promise<Response> {
  return cached(ctx, 3600, async () =>
    json({
      types: PROJECT_TYPES,
      loaders: Object.entries(LOADER_LABELS).map(([id, label]) => ({ id, label })),
      categories: CATEGORIES,
      licenses: LICENSES,
    }),
  );
}

async function gameVersions(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  return cached(ctx, 3600, async () => {
    await ensureGameVersions(ctx.env);
    const rows = await ctx.env.DB.prepare('SELECT id, type, released_at FROM game_versions ORDER BY released_at DESC').all<{
      id: string;
      type: GameVersion['type'];
      released_at: number;
    }>();
    return json({ gameVersions: rows.results.map((r): GameVersion => ({ id: r.id, type: r.type, releasedAt: r.released_at })) });
  });
}

function meta(ctx: Ctx): Promise<Response> {
  return cached(ctx, 300, async () =>
    json({
      name: SITE.name,
      url: SITE.url,
      scanPublicKey: scanKey(),
      signatureFormat: 'argonite-file-v2',
      limits: { fileMaxBytes: SITE.limits.fileMaxBytes },
    }),
  );
}

const DOWNLOAD_HOSTS = new Set(['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com']);

async function fetchAsset(url: string): Promise<Response> {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    const host = new URL(current).hostname;
    if (!DOWNLOAD_HOSTS.has(host)) throw new HttpError(502, 'bad_upstream', 'GitHub redirected somewhere unexpected.');
    const res = await fetch(current, { redirect: 'manual', headers: { 'User-Agent': `${SITE.name}-API`, Accept: 'application/octet-stream' } });
    if (res.status >= 300 && res.status < 400) {
      const loc = res.headers.get('Location');
      if (!loc) break;
      current = new URL(loc, current).toString();
      continue;
    }
    return res;
  }
  throw new HttpError(502, 'bad_upstream', 'Too many redirects from GitHub.');
}

interface DownloadRow {
  file_id: string;
  kind: string;
  version_id: string;
  status: string;
  tag: string;
  project_id: string;
  p_status: string;
  repo_full_name: string;
  repo_status: string;
  filename: string;
  size: number;
  sha256: string | null;
  sha512: string | null;
}

const DOWNLOAD_SELECT = `SELECT f.id AS file_id, f.kind, v.id AS version_id, v.status, v.tag, v.project_id, p.status AS p_status, p.repo_full_name, p.repo_status,
       f.filename, f.size, f.sha256, f.sha512
     FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id`;

async function serveFile(ctx: Ctx, row: DownloadRow | null, ip: string): Promise<Response> {
  if (!row || row.status !== 'live' || !row.sha256 || (row.p_status !== 'active' && row.p_status !== 'delisted')) throw notFound('File not found.');
  if (row.repo_status !== 'ok') throw new HttpError(410, 'unavailable', 'The author’s GitHub repository is no longer available.');

  const [owner, repo] = row.repo_full_name.split('/');
  const upstream = await fetchAsset(
    `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(row.tag)}/${encodeURIComponent(row.filename)}`,
  );
  if (!upstream.ok || !upstream.body) {
    ctx.exec.waitUntil(enqueueVerify(ctx, row.version_id));
    throw new HttpError(502, 'upstream_failed', 'GitHub could not serve this file right now.');
  }
  const length = upstream.headers.get('Content-Length');
  if (length && Number(length) !== row.size) {
    await upstream.body.cancel();
    ctx.exec.waitUntil(enqueueVerify(ctx, row.version_id));
    throw new HttpError(502, 'integrity', 'The file on GitHub no longer matches the scanned file. It has been flagged for review.');
  }

  const headers = new Headers({
    'Content-Type': 'application/octet-stream',
    'Content-Disposition': `attachment; filename="${row.filename.replace(/[^A-Za-z0-9._+-]/g, '_')}"`,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; sandbox",
    'X-Argonite-Sha256': row.sha256,
    'X-Argonite-Sha512': row.sha512 ?? '',
  });
  if (length) headers.set('Content-Length', length);
  if (ctx.request.method === 'HEAD') {
    await upstream.body.cancel();
    return new Response(null, { status: 200, headers });
  }
  // Only the main file counts as a download; sources and extras would inflate the numbers.
  if (row.kind === 'primary') ctx.exec.waitUntil(countDownload(ctx, row.version_id, row.project_id, ip));
  return new Response(upstream.body, { status: 200, headers });
}

async function download(ctx: Ctx): Promise<Response> {
  const ip = clientIp(ctx.request);
  await rateLimit(ctx.env.RL_DOWNLOAD, `d:${ip}`);
  if (!isId(ctx.params.id)) throw notFound('File not found.');
  const row = await ctx.env.DB.prepare(`${DOWNLOAD_SELECT} WHERE v.id = ? AND f.kind = 'primary'`).bind(ctx.params.id).first<DownloadRow>();
  return serveFile(ctx, row, ip);
}

async function downloadFile(ctx: Ctx): Promise<Response> {
  const ip = clientIp(ctx.request);
  await rateLimit(ctx.env.RL_DOWNLOAD, `d:${ip}`);
  if (!isId(ctx.params.fileId)) throw notFound('File not found.');
  const row = await ctx.env.DB.prepare(`${DOWNLOAD_SELECT} WHERE f.id = ?`).bind(ctx.params.fileId).first<DownloadRow>();
  // Extra files are only offered once every file in the version is fingerprinted.
  if (row && row.kind !== 'primary') {
    const unverified = await ctx.env.DB.prepare('SELECT 1 FROM files WHERE version_id = ? AND sha256 IS NULL').bind(row.version_id).first();
    if (unverified) throw notFound('File not found.');
  }
  return serveFile(ctx, row, ip);
}

async function countDownload(ctx: Ctx, versionId: string, projectId: string, ip: string): Promise<void> {
  const day = new Date().toISOString().slice(0, 10);
  const visitor = (await sha256Hex(`${ctx.env.VISITOR_SALT}:${day}:${ip}`)).slice(0, 32);
  const res = await ctx.env.DB.prepare('INSERT OR IGNORE INTO download_marks (day, visitor, version_id) VALUES (?, ?, ?)').bind(day, visitor, versionId).run();
  if (!res.meta.changes) return;
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE versions SET downloads = downloads + 1 WHERE id = ?').bind(versionId),
    ctx.env.DB.prepare('UPDATE projects SET downloads = downloads + 1 WHERE id = ?').bind(projectId),
    ...downloadStatStatements(ctx.env, ctx.request, projectId, versionId),
  ]);
}

export async function enqueueVerify(ctx: Pick<Ctx, 'env'>, versionId: string): Promise<void> {
  const recent = await ctx.env.DB.prepare(
    "SELECT 1 FROM scan_jobs WHERE version_id = ? AND kind = 'verify' AND (status IN ('queued', 'claimed') OR created_at > ?)",
  )
    .bind(versionId, Date.now() - 6 * 3600 * 1000)
    .first();
  if (recent) return;
  const files = await ctx.env.DB.prepare('SELECT id FROM files WHERE version_id = ? AND sha256 IS NOT NULL').bind(versionId).all<{ id: string }>();
  if (!files.results.length) return;
  const now = Date.now();
  const ids = files.results.map(() => newId());
  await ctx.env.DB.batch(
    files.results.map((f, i) =>
      ctx.env.DB.prepare("INSERT INTO scan_jobs (id, version_id, file_id, kind, status, created_at) VALUES (?, ?, ?, 'verify', 'queued', ?)").bind(ids[i], versionId, f.id, now),
    ),
  );
  await dispatchScan(ctx.env, ids[0]).catch(() => false);
}

async function integrityReport(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_WRITE, `integrity:${clientIp(ctx.request)}`);
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  const v = await ctx.env.DB.prepare("SELECT id FROM versions WHERE id = ? AND status = 'live'").bind(ctx.params.id).first<{ id: string }>();
  if (!v) throw notFound('Version not found.');
  await enqueueVerify(ctx, v.id);
  return json({ ok: true }, 202);
}

// Feeds the website's sitemap. Delisted projects stay reachable by link but are kept out of search.
const SITEMAP_PAGE = 10_000;

function sitemapIndex(ctx: Ctx): Promise<Response> {
  return cached(ctx, 900, async () => {
    const [projects, users] = await ctx.env.DB.batch([
      ctx.env.DB.prepare("SELECT COUNT(*) AS n FROM projects WHERE status = 'active'"),
      ctx.env.DB.prepare(
        "SELECT COUNT(DISTINCT m.user_id) AS n FROM members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = m.user_id WHERE m.accepted = 1 AND p.status = 'active' AND u.deleted_at IS NULL",
      ),
    ]);
    const pages = (r: D1Result) => Math.ceil(Number((r.results[0] as { n: number } | undefined)?.n ?? 0) / SITEMAP_PAGE);
    return json({ pageSize: SITEMAP_PAGE, projectPages: pages(projects), userPages: pages(users) });
  });
}

function sitemapPage(ctx: Ctx): number {
  const page = Number(ctx.url.searchParams.get('page') ?? '1');
  if (!Number.isInteger(page) || page < 1 || page > 1000) throw badRequest('page must be a whole number from 1 to 1000.');
  return page;
}

function sitemapProjects(ctx: Ctx): Promise<Response> {
  const page = sitemapPage(ctx);
  return cached(ctx, 900, async () => {
    const rows = await ctx.env.DB.prepare("SELECT slug, updated_at FROM projects WHERE status = 'active' ORDER BY created_at, id LIMIT ? OFFSET ?")
      .bind(SITEMAP_PAGE, (page - 1) * SITEMAP_PAGE)
      .all<{ slug: string; updated_at: number }>();
    return json({ items: rows.results.map((r) => ({ slug: r.slug, updatedAt: r.updated_at })) });
  });
}

function sitemapUsers(ctx: Ctx): Promise<Response> {
  const page = sitemapPage(ctx);
  return cached(ctx, 900, async () => {
    const rows = await ctx.env.DB.prepare(
      `SELECT u.username, MAX(p.updated_at) AS updated_at FROM members m JOIN projects p ON p.id = m.project_id JOIN users u ON u.id = m.user_id
       WHERE m.accepted = 1 AND p.status = 'active' AND u.deleted_at IS NULL GROUP BY u.id ORDER BY u.id LIMIT ? OFFSET ?`,
    )
      .bind(SITEMAP_PAGE, (page - 1) * SITEMAP_PAGE)
      .all<{ username: string; updated_at: number }>();
    return json({ items: rows.results.map((r) => ({ username: r.username, updatedAt: r.updated_at })) });
  });
}

// --- Bulk reads, update checks and dependency helpers for launchers and tools ----------------------

function idList(url: URL, key: string, max: number): string[] {
  return listParam(url, key, max).filter(isId);
}

async function bulkProjects(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const ids = idList(ctx.url, 'ids', 100);
  if (!ids.length) throw badRequest('Pass up to 100 project ids as ?ids=a,b,c');
  const rows = await ctx.env.DB.prepare(`${PROJECT_SELECT} WHERE p.id IN (SELECT value FROM json_each(?)) AND p.status IN ('active', 'delisted')`)
    .bind(JSON.stringify(ids))
    .all<ProjectRow>();
  return json({ projects: rows.results.map(toSummary) });
}

async function bulkVersions(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const ids = idList(ctx.url, 'ids', 80);
  if (!ids.length) throw badRequest('Pass up to 80 version ids as ?ids=a,b,c');
  const versions = await loadVersions(ctx.env, { ids, statuses: ['live'] });
  return json({ versions: versions.filter((v) => v.file) });
}

// Given hashes of installed files, the newest compatible version of each file's project. This is the
// call launchers make to check for updates.
async function latestForFiles(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const body = await readJson(ctx.request, 64_000);
  const algo = typeof body.algorithm === 'string' ? body.algorithm : '';
  const hashes = Array.isArray(body.hashes) ? body.hashes.filter((h): h is string => typeof h === 'string').slice(0, 100) : [];
  const loaders = Array.isArray(body.loaders) ? body.loaders.filter((l): l is string => typeof l === 'string' && l.length <= 32).slice(0, 10) : [];
  const gameVersions = Array.isArray(body.gameVersions) ? body.gameVersions.filter((g): g is string => typeof g === 'string' && g.length <= 40).slice(0, 50) : [];
  const channels = Array.isArray(body.channels) ? body.channels.filter((c): c is string => c === 'release' || c === 'beta' || c === 'alpha') : ['release', 'beta', 'alpha'];
  const found = await lookupHashes(ctx, algo, hashes);
  if (!found.size) return json({ files: {} });
  const projects = await ctx.env.DB.prepare('SELECT id, project_id FROM versions WHERE id IN (SELECT value FROM json_each(?))')
    .bind(JSON.stringify([...new Set(found.values())]))
    .all<{ id: string; project_id: string }>();
  const projectOf = new Map(projects.results.map((r) => [r.id, r.project_id]));
  const latest = new Map<string, string | null>();
  for (const projectId of new Set(projectOf.values())) {
    const row = await ctx.env.DB.prepare(
      `SELECT v.id FROM versions v WHERE v.project_id = ?1 AND v.status = 'live' AND v.channel IN (SELECT value FROM json_each(?4))
         AND (?2 = '[]' OR EXISTS (SELECT 1 FROM version_loaders l WHERE l.version_id = v.id AND l.loader IN (SELECT value FROM json_each(?2))))
         AND (?3 = '[]' OR EXISTS (SELECT 1 FROM version_game_versions g WHERE g.version_id = v.id AND g.game_version IN (SELECT value FROM json_each(?3))))
       ORDER BY v.published_at DESC LIMIT 1`,
    )
      .bind(projectId, JSON.stringify(loaders), JSON.stringify(gameVersions), JSON.stringify(channels.length ? channels : ['release']))
      .first<{ id: string }>();
    latest.set(projectId, row?.id ?? null);
  }
  const wanted = [...new Set([...latest.values()].filter((v): v is string => !!v))];
  const versions = wanted.length ? await loadVersions(ctx.env, { ids: wanted.slice(0, 80), statuses: ['live'] }) : [];
  const byId = new Map(versions.map((v) => [v.id, v]));
  const out: Record<string, unknown> = {};
  for (const [hash, versionId] of found) {
    const target = latest.get(projectOf.get(versionId) ?? '');
    out[hash] = target ? (byId.get(target) ?? null) : null;
  }
  return json({ files: out });
}

async function dependents(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const row = await publicProjectRow(ctx);
  const { size, offset, page } = pageParams(ctx.url, 50, 20);
  return cached(ctx, 120, async () => {
    const rows = await ctx.env.DB.prepare(
      `${PROJECT_SELECT} WHERE p.status = 'active' AND p.id IN (
         SELECT v.project_id FROM version_dependencies d JOIN versions v ON v.id = d.version_id AND v.status = 'live'
         WHERE d.dep_project_id = ? AND d.kind IN ('required', 'optional'))
       ORDER BY p.downloads DESC LIMIT ? OFFSET ?`,
    )
      .bind(row.id, size, offset)
      .all<ProjectRow>();
    return json({ projects: rows.results.map(toSummary), page, pageSize: size });
  });
}

// Every required dependency (and theirs, a few levels deep) resolved to a concrete live version that
// fits the chosen loader and game version. Each one is still downloaded and verified on its own.
async function resolveDependencies(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  const loader = ctx.url.searchParams.get('loader') ?? '';
  const gameVersion = ctx.url.searchParams.get('gameVersion') ?? '';
  if (loader.length > 32 || gameVersion.length > 40) throw badRequest('Invalid filter.');
  return cached(ctx, 60, async () => {
    const chosen = new Map<string, string>();
    const missing: { projectId: string; name: string; slug: string }[] = [];
    let frontier = [ctx.params.id];
    const seenProjects = new Set<string>();
    for (let depth = 0; depth < 4 && frontier.length && chosen.size < 25; depth++) {
      const deps = await ctx.env.DB.prepare(
        `SELECT d.dep_project_id, d.dep_version_id, p.name, p.slug FROM version_dependencies d JOIN projects p ON p.id = d.dep_project_id
         WHERE d.version_id IN (SELECT value FROM json_each(?)) AND d.kind = 'required' AND p.status IN ('active', 'delisted')`,
      )
        .bind(JSON.stringify(frontier))
        .all<{ dep_project_id: string; dep_version_id: string | null; name: string; slug: string }>();
      const next: string[] = [];
      for (const d of deps.results) {
        if (seenProjects.has(d.dep_project_id)) continue;
        seenProjects.add(d.dep_project_id);
        const pick = await ctx.env.DB.prepare(
          `SELECT v.id FROM versions v WHERE v.project_id = ?1 AND v.status = 'live' AND (?2 IS NULL OR v.id = ?2)
             AND (?3 = '' OR EXISTS (SELECT 1 FROM version_loaders l WHERE l.version_id = v.id AND l.loader = ?3))
             AND (?4 = '' OR EXISTS (SELECT 1 FROM version_game_versions g WHERE g.version_id = v.id AND g.game_version = ?4))
           ORDER BY v.channel = 'release' DESC, v.published_at DESC LIMIT 1`,
        )
          .bind(d.dep_project_id, d.dep_version_id, loader, gameVersion)
          .first<{ id: string }>();
        if (pick) {
          chosen.set(d.dep_project_id, pick.id);
          next.push(pick.id);
        } else {
          missing.push({ projectId: d.dep_project_id, name: d.name, slug: d.slug });
        }
      }
      frontier = next;
    }
    const versions = chosen.size ? await loadVersions(ctx.env, { ids: [...chosen.values()], statuses: ['live'] }) : [];
    const projectRows = chosen.size
      ? await ctx.env.DB.prepare(`${PROJECT_SELECT} WHERE p.id IN (SELECT value FROM json_each(?))`).bind(JSON.stringify([...chosen.keys()])).all<ProjectRow>()
      : { results: [] as ProjectRow[] };
    const projects = new Map(projectRows.results.map((r) => [r.id, toSummary(r)]));
    return json({
      dependencies: versions.filter((v) => v.file).map((v) => ({ project: projects.get(v.projectId) ?? null, version: v })),
      missing,
    });
  });
}

async function packContents(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  if (!isId(ctx.params.id)) throw notFound('Version not found.');
  return cached(ctx, 300, async () => {
    const row = await ctx.env.DB.prepare(
      `SELECT f.contents FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id
       WHERE v.id = ? AND f.kind = 'primary' AND v.status = 'live' AND p.status IN ('active', 'delisted') AND p.type = 'modpack'`,
    )
      .bind(ctx.params.id)
      .first<{ contents: string | null }>();
    if (!row) throw notFound('Version not found.');
    return json({ contents: parseJson(row.contents, null) });
  });
}

function badgeSvg(label: string, value: string): string {
  const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  const w = (t: string) => Math.round(t.length * 6.6 + 12);
  const lw = w(label);
  const vw = w(value);
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${lw + vw}" height="20" role="img" aria-label="${esc(label)}: ${esc(value)}"><title>${esc(label)}: ${esc(value)}</title><rect width="${lw}" height="20" rx="3" fill="#1b2233"/><rect x="${lw}" width="${vw}" height="20" rx="3" fill="#2563eb"/><rect x="${lw}" width="4" height="20" fill="#2563eb"/><g fill="#fff" font-family="Verdana,DejaVu Sans,sans-serif" font-size="11" text-anchor="middle"><text x="${lw / 2}" y="14">${esc(label)}</text><text x="${lw + vw / 2}" y="14">${esc(value)}</text></g></svg>`;
}

function compact(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0).replace(/\.0$/, '')}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
}

async function badge(ctx: Ctx): Promise<Response> {
  await readLimit(ctx);
  const kind = ctx.params.kind.replace(/\.svg$/, '');
  if (!['downloads', 'version', 'followers'].includes(kind)) throw notFound('Unknown badge.');
  return cached(ctx, 3600, async () => {
    const row = await publicProjectRow(ctx);
    let value = '';
    if (kind === 'downloads') value = compact(row.downloads);
    else if (kind === 'followers') value = compact(row.follows);
    else {
      const v = await ctx.env.DB.prepare("SELECT version_number FROM versions WHERE project_id = ? AND status = 'live' ORDER BY published_at DESC LIMIT 1")
        .bind(row.id)
        .first<{ version_number: string }>();
      value = v?.version_number ?? 'none';
    }
    const label = kind === 'downloads' ? SITE.name.toLowerCase() : kind;
    return new Response(badgeSvg(label, value.slice(0, 40)), {
      headers: {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });
}


// Organisations with something published and active server listings: small enough for one page each.
function sitemapExtras(ctx: Ctx): Promise<Response> {
  return cached(ctx, 900, async () => {
    const [orgs, servers] = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        "SELECT o.slug, MAX(p.updated_at) AS updated_at FROM organizations o JOIN projects p ON p.org_id = o.id AND p.status = 'active' WHERE o.deleted_at IS NULL GROUP BY o.id LIMIT ?",
      ).bind(SITEMAP_PAGE),
      ctx.env.DB.prepare("SELECT slug, updated_at FROM servers WHERE status = 'active' ORDER BY created_at LIMIT ?").bind(SITEMAP_PAGE),
    ]);
    return json({
      organizations: (orgs.results as { slug: string; updated_at: number }[]).map((r) => ({ slug: r.slug, updatedAt: r.updated_at })),
      servers: (servers.results as { slug: string; updated_at: number }[]).map((r) => ({ slug: r.slug, updatedAt: r.updated_at })),
    });
  });
}

// Sites and URLs found on a malware or phishing list after content linking to them was published.
// The site disables those links when it renders descriptions, comments and profile links.
async function blockedLinkList(ctx: Ctx): Promise<Response> {
  return cached(ctx, 600, async () => json(await blockedLinks(ctx.env)));
}

export function publicRoutes(r: Router): void {
  r.get('/v1/blocked-links', blockedLinkList);
  r.get('/v1/sitemap/extras', sitemapExtras);
  r.get('/v1/projects', bulkProjects);
  r.get('/v1/versions', bulkVersions);
  r.post('/v1/files/update', latestForFiles);
  r.get('/v1/projects/:idOrSlug/dependents', dependents);
  r.get('/v1/versions/:id/resolve', resolveDependencies);
  r.get('/v1/versions/:id/contents', packContents);
  r.get('/v1/badge/:idOrSlug/:kind', badge);
  r.get('/v1/download/file/:fileId', downloadFile);
  r.get('/v1/sitemap', sitemapIndex);
  r.get('/v1/sitemap/projects', sitemapProjects);
  r.get('/v1/sitemap/users', sitemapUsers);
  r.get('/v1/meta', meta);
  r.get('/v1/tags', tags);
  r.get('/v1/tags/game-versions', gameVersions);
  r.get('/v1/search', search);
  r.get('/v1/projects/:idOrSlug', project);
  r.get('/v1/projects/:idOrSlug/versions', projectVersions);
  r.get('/v1/versions/:id', version);
  r.post('/v1/versions/:id/integrity', integrityReport);
  r.get('/v1/files/:algo/:hash', fileByHash);
  r.post('/v1/files', filesByHash);
  r.get('/v1/users/:username', user);
  r.get('/v1/download/:id', download);
}

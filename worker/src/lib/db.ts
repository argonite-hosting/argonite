import { sortGameVersionsDesc } from '../../../shared/gameversions';
import type { Channel, CommentMode, DependencyKind, FileKind, ProjectStatus, ProjectType, Side, VersionStatus } from '../../../shared/taxonomy';
import { summariesOf, type SummaryRow } from './sandbox';
import type { Dependency, FileInfo, Finding, GalleryImage, Member, OrgRef, Project, NativeFile, ProjectSummary, ScanSummary, Version } from '../../../shared/types';
import { PROJECT_ID_ALPHABET, normalizeProjectId } from '../../../shared/validate';
import type { Env } from '../env';
import { rawUrl } from './github';
import { apiUrl } from './runtime';

export interface ProjectRow {
  pk: number;
  id: string;
  public_id: string | null;
  slug: string;
  name: string;
  summary: string;
  description: string;
  type: ProjectType;
  status: ProjectStatus;
  status_reason: string | null;
  owner_id: string;
  repo_id: number;
  repo_full_name: string;
  repo_status: Project['repo']['status'];
  icon_path: string | null;
  icon_commit: string | null;
  icon_sha256: string | null;
  license: string;
  license_url: string | null;
  source_url: string | null;
  issues_url: string | null;
  wiki_url: string | null;
  discord_url: string | null;
  donation_url: string | null;
  client_side: Side;
  server_side: Side;
  downloads: number;
  follows: number;
  created_at: number;
  updated_at: number;
  published_at: number | null;
  org_id: string | null;
  archived: number;
  banner_path: string | null;
  banner_commit: string | null;
  banner_sha256: string | null;
  installation_id: number | null;
  auto_publish: string | null;
  auto_publish_by: string | null;
  comments_mode: CommentMode;
  views: number;
  org_slug: string | null;
  org_name: string | null;
  org_login: string | null;
  author_username: string;
  author_avatar: string;
  cats: string | null;
  loaders_csv: string | null;
  gvs: string | null;
}

export const PROJECT_SELECT = `
SELECT p.*, u.username AS author_username, u.avatar_url AS author_avatar, o.slug AS org_slug, o.name AS org_name, o.github_login AS org_login,
  (SELECT group_concat(category, ',') FROM project_categories WHERE project_id = p.id) AS cats,
  (SELECT group_concat(loader, ',') FROM project_loaders WHERE project_id = p.id) AS loaders_csv,
  (SELECT group_concat(game_version, ',') FROM project_game_versions WHERE project_id = p.id) AS gvs
FROM projects p JOIN users u ON u.id = p.owner_id LEFT JOIN organizations o ON o.id = p.org_id AND o.deleted_at IS NULL`;

export function orgAvatar(login: string | null): string | null {
  return login ? `https://github.com/${encodeURIComponent(login)}.png?size=96` : null;
}

function orgRef(row: Pick<ProjectRow, 'org_id' | 'org_slug' | 'org_name' | 'org_login'>): OrgRef | null {
  return row.org_id && row.org_slug && row.org_name ? { id: row.org_id, slug: row.org_slug, name: row.org_name, avatarUrl: orgAvatar(row.org_login) } : null;
}

const csv = (s: string | null) => (s ? s.split(',').filter(Boolean) : []);

// Images from the author's repository, pinned to a commit and carrying the SHA-256 recorded when they were
// stored. The site checks that hash before showing the image; one without a hash isn't served yet.
export function hashedRawUrl(repo: string, commit: string | null, path: string | null, sha256: string | null): string | null {
  return commit && path && sha256 ? `${rawUrl(repo, commit, path)}#sha256=${sha256}` : null;
}

export function iconUrl(row: Pick<ProjectRow, 'repo_full_name' | 'icon_commit' | 'icon_path' | 'icon_sha256'>): string | null {
  return hashedRawUrl(row.repo_full_name, row.icon_commit, row.icon_path, row.icon_sha256);
}

export function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    publicId: row.public_id,
    slug: row.slug,
    name: row.name,
    summary: row.summary,
    type: row.type,
    iconUrl: iconUrl(row),
    downloads: row.downloads,
    follows: row.follows,
    categories: csv(row.cats),
    loaders: csv(row.loaders_csv),
    gameVersions: sortGameVersionsDesc(csv(row.gvs)),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    author: { id: row.owner_id, username: row.author_username, avatarUrl: row.author_avatar },
    org: orgRef(row),
    archived: row.archived === 1,
  };
}

// Ids and slugs never overlap (validateSlug rejects id-shaped slugs), so the shape decides which column to use.
// The internal id of the project a reference names: its internal id, its current URL, its permanent
// public ID, or failing those a URL it used to have (until another project takes that URL). The two
// parameters are the lower-cased reference and the public ID it could be ('' when it can't be one).
export function projectRef(key: string, publicId: string): string {
  return `(SELECT ref.id FROM (
      SELECT id, 0 AS rank FROM projects WHERE id = ${key}
      UNION ALL SELECT id, 1 FROM projects WHERE slug = ${key}
      UNION ALL SELECT id, 2 FROM projects WHERE public_id = ${publicId}
      UNION ALL SELECT project_id, 3 FROM slug_history WHERE slug = ${key}
    ) ref ORDER BY ref.rank LIMIT 1)`;
}

export function projectRefBinds(reference: string): [string, string] {
  return [reference.trim().toLowerCase().slice(0, 64), normalizeProjectId(reference) ?? ''];
}

export async function loadProjectRow(env: Env, reference: string): Promise<ProjectRow | null> {
  return env.DB.prepare(`${PROJECT_SELECT} WHERE p.id = ${projectRef('?1', '?2')} LIMIT 1`)
    .bind(...projectRefBinds(reference))
    .first<ProjectRow>();
}

// A new permanent public ID that no project uses as its ID or URL. Retried by the caller if an insert
// still races another one; the database's unique index and triggers have the last word.
export async function newProjectId(env: Env): Promise<string> {
  for (let attempt = 0; attempt < 20; attempt++) {
    // 252 is the largest multiple of 36 below 256, so every character is equally likely.
    const id = [...crypto.getRandomValues(new Uint8Array(32))].filter((b) => b < 252).slice(0, 8).map((b) => PROJECT_ID_ALPHABET[b % 36]).join('');
    if (id.length !== 8) continue;
    const taken = await env.DB.prepare('SELECT 1 FROM projects WHERE public_id = ?1 OR slug = ?1 LIMIT 1').bind(id).first();
    if (!taken) return id;
  }
  throw new Error('could not find a free project id');
}

// Statements that free deleted projects' URLs for anyone to take. Each URL moves to a placeholder
// nobody can type and is remembered, so a moderator restoring the project can hand it back if it's free.
export function releaseSlugs(env: Env, column: 'id' | 'owner_id', value: string): D1PreparedStatement[] {
  const now = Date.now();
  return [
    env.DB.prepare(`INSERT OR REPLACE INTO slug_history (slug, project_id, created_at) SELECT slug, id, ? FROM projects WHERE ${column} = ? AND slug NOT LIKE '~%'`).bind(now, value),
    env.DB.prepare(`UPDATE projects SET slug = '~' || id WHERE ${column} = ? AND slug NOT LIKE '~%'`).bind(value),
  ];
}

// Gives a restored project its last URL back when no other project has taken it since, or a new one.
export function restoreSlug(env: Env, projectId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare(
      `UPDATE projects SET slug = COALESCE(
         (SELECT h.slug FROM slug_history h WHERE h.project_id = ?1 AND NOT EXISTS (SELECT 1 FROM projects x WHERE x.slug = h.slug) ORDER BY h.created_at DESC LIMIT 1),
         'project-' || COALESCE(public_id, id))
       WHERE id = ?1 AND slug LIKE '~%'`,
    ).bind(projectId),
    env.DB.prepare('DELETE FROM slug_history WHERE slug = (SELECT slug FROM projects WHERE id = ?)').bind(projectId),
  ];
}

// Drops this data centre's cached copies of a project's public API answers, so a change shows at once
// (other data centres catch up within the 30-second cache time).
export async function purgeProjectCache(env: Env, projectId: string, names: (string | undefined)[]): Promise<void> {
  const row = await env.DB.prepare('SELECT slug, public_id FROM projects WHERE id = ?').bind(projectId).first<{ slug: string; public_id: string | null }>();
  const keys = new Set([projectId, row?.slug, row?.public_id, ...names].filter((k): k is string => !!k));
  const base = apiUrl();
  await Promise.all(
    [...keys].flatMap((k) => [`${base}/v1/projects/${k}`, `${base}/v1/projects/${k}/versions`].map((u) => caches.default.delete(new Request(u)).catch(() => false))),
  );
}

// Gives an ID to any project still without one (projects from before IDs, or an unlucky draw in the migration).
export async function assignMissingProjectIds(env: Env): Promise<void> {
  const rows = await env.DB.prepare('SELECT id FROM projects WHERE public_id IS NULL LIMIT 200').all<{ id: string }>();
  for (const r of rows.results) {
    try {
      await env.DB.prepare('UPDATE projects SET public_id = ? WHERE id = ? AND public_id IS NULL').bind(await newProjectId(env), r.id).run();
    } catch {
      // Raced another assignment; the next run tries again.
    }
  }
}

export async function toProject(env: Env, row: ProjectRow): Promise<Project> {
  const [members, gallery] = await env.DB.batch([
    env.DB.prepare(
      `SELECT m.role, m.accepted, m.permissions, u.id, u.username, u.avatar_url FROM members m JOIN users u ON u.id = m.user_id
       WHERE m.project_id = ? AND u.deleted_at IS NULL ORDER BY m.role = 'owner' DESC, m.created_at`,
    ).bind(row.id),
    env.DB.prepare('SELECT id, path, commit_sha, sha256, title FROM gallery WHERE project_id = ? AND sha256 IS NOT NULL ORDER BY position, created_at').bind(row.id),
  ]);
  return {
    ...toSummary(row),
    description: row.description,
    status: row.status,
    license: row.license,
    links: {
      source: row.source_url,
      issues: row.issues_url,
      wiki: row.wiki_url,
      discord: row.discord_url,
      donation: row.donation_url,
      license: row.license_url,
    },
    clientSide: row.client_side,
    serverSide: row.server_side,
    repo: {
      id: row.repo_id,
      fullName: row.repo_full_name,
      url: `https://github.com/${row.repo_full_name}`,
      status: row.repo_status,
    },
    members: (members.results as { role: Member['role']; accepted: number; permissions: number; id: string; username: string; avatar_url: string }[]).map((m) => ({
      role: m.role,
      accepted: m.accepted === 1,
      permissions: m.permissions,
      user: { id: m.id, username: m.username, avatarUrl: m.avatar_url },
    })),
    gallery: (gallery.results as { id: string; path: string; commit_sha: string; sha256: string; title: string | null }[]).map(
      (g): GalleryImage => ({ id: g.id, title: g.title, url: hashedRawUrl(row.repo_full_name, g.commit_sha, g.path, g.sha256)! }),
    ),
    publishedAt: row.published_at,
    bannerUrl: hashedRawUrl(row.repo_full_name, row.banner_commit, row.banner_path, row.banner_sha256),
    commentsMode: row.comments_mode,
    views: row.views,
  };
}

interface VersionRow {
  id: string;
  project_id: string;
  version_number: string;
  name: string;
  changelog: string;
  channel: Channel;
  status: VersionStatus;
  status_reason: string | null;
  review_detail: string | null;
  tag: string;
  release_id: number | null;
  downloads: number;
  created_at: number;
  published_at: number | null;
  featured: number;
  publish_pending: number;
  author_id: string;
  author_username: string;
  author_avatar: string;
  repo_full_name: string;
  repo_id: number;
}

export interface FileRow {
  id: string;
  version_id: string;
  kind: FileKind;
  asset_id: number | null;
  filename: string;
  size: number;
  sha1: string | null;
  sha256: string | null;
  sha512: string | null;
  signature: string | null;
  scanned_at: number | null;
  verdict: 'clean' | 'suspicious' | 'malicious' | null;
  findings: string | null;
  capabilities: string | null;
  engines: string | null;
  natives: string | null;
  hosts: string | null;
  position: number;
}

const VERSION_SELECT = `
SELECT v.*, u.username AS author_username, u.avatar_url AS author_avatar, p.repo_full_name, p.repo_id
FROM versions v
JOIN users u ON u.id = v.author_id
JOIN projects p ON p.id = v.project_id`;

export function parseJson<T>(s: string | null, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export interface VersionQuery {
  projectId?: string;
  ids?: string[];
  statuses: VersionStatus[];
  includeScan?: boolean;
  // Moderators see which engine or rule made each finding; everyone else gets plain wording.
  staff?: boolean;
  limit?: number;
}

// How a finding is shown to anyone but moderators: no scanner, rule or feed names, which would only
// help someone tune their malware against our checks.
export function publicFinding(f: Finding): Finding {
  const plain = (rule: string, detail: string): Finding => ({ ...f, rule, detail });
  if (/^clamav/.test(f.rule)) return plain('malware.known', 'Matches known malware');
  if (/^yara\./.test(f.rule)) return plain('malware.pattern', 'Matches a known malware pattern');
  if (/^reputation\./.test(f.rule)) return plain('malware.reputation', 'This exact file is known to be malicious');
  if (/^ioc\./.test(f.rule)) return plain('malware.indicator', 'Contains a known sign of malware');
  if (f.rule === 'link.malicious_url') return plain(f.rule, f.detail.replace(/listed on \S+ as serving malware/i, 'known to serve malware'));
  return f;
}

function fileInfo(f: FileRow, repoId: number, releaseId: number): FileInfo | null {
  if (!f.sha256 || !f.sha1 || !f.sha512 || !f.signature || f.asset_id === null || f.scanned_at === null) return null;
  return {
    id: f.id,
    kind: f.kind,
    filename: f.filename,
    size: f.size,
    sha1: f.sha1,
    sha256: f.sha256,
    sha512: f.sha512,
    signature: f.signature,
    repoId,
    releaseId,
    assetId: f.asset_id,
    scannedAt: f.scanned_at,
    // Files scanned before natives were listed only carry the native_code tag.
    nativeFiles: f.natives !== null ? parseJson<NativeFile[]>(f.natives, []).length : parseJson<string[]>(f.capabilities, []).includes('native_code') ? 1 : 0,
  };
}

function scanOf(f: FileRow, staff: boolean): ScanSummary {
  const findings = parseJson<Finding[]>(f.findings, []);
  return {
    verdict: f.verdict,
    // Authors see their files' verdicts, natives and links, but not which checks fired: that would let
    // someone tune malware against them. Moderators see everything.
    findings: staff ? findings : [],
    capabilities: staff ? parseJson<string[]>(f.capabilities, []) : [],
    engines: staff ? parseJson<string[]>(f.engines, []) : [],
    scannedAt: f.scanned_at,
    natives: parseJson<NativeFile[]>(f.natives, []),
    hosts: parseJson<string[]>(f.hosts, []),
  };
}

export async function loadVersions(env: Env, q: VersionQuery): Promise<Version[]> {
  const where: string[] = [];
  const binds: unknown[] = [];
  if (q.projectId) {
    where.push('v.project_id = ?');
    binds.push(q.projectId);
  }
  if (q.ids) {
    if (!q.ids.length) return [];
    // D1 caps bound parameters at 100 per statement.
    if (q.ids.length > 80) throw new Error('loadVersions: too many ids');
    where.push(`v.id IN (${q.ids.map(() => '?').join(',')})`);
    binds.push(...q.ids);
  }
  where.push(`v.status IN (${q.statuses.map(() => '?').join(',')})`);
  binds.push(...q.statuses);
  const limit = Math.min(q.limit ?? 500, 1000);
  const whereSql = where.join(' AND ');
  const rows = (
    await env.DB.prepare(`${VERSION_SELECT} WHERE ${whereSql} ORDER BY COALESCE(v.published_at, v.created_at) DESC LIMIT ${limit}`)
      .bind(...binds)
      .all<VersionRow>()
  ).results;
  if (!rows.length) return [];
  const scope = `SELECT v.id FROM versions v WHERE ${whereSql}`;
  const [loaders, gvs, deps, files] = await env.DB.batch([
    env.DB.prepare(`SELECT version_id, loader FROM version_loaders WHERE version_id IN (${scope})`).bind(...binds),
    env.DB.prepare(`SELECT version_id, game_version FROM version_game_versions WHERE version_id IN (${scope})`).bind(...binds),
    env.DB.prepare(
      `SELECT d.version_id, d.dep_project_id, d.dep_version_id, d.kind, p.slug, p.name, dv.version_number
       FROM version_dependencies d
       JOIN projects p ON p.id = d.dep_project_id
       LEFT JOIN versions dv ON dv.id = d.dep_version_id
       WHERE d.version_id IN (${scope})`,
    ).bind(...binds),
    env.DB.prepare(
      `SELECT id, version_id, kind, asset_id, filename, size, sha1, sha256, sha512, signature, scanned_at, verdict, findings, capabilities, engines, natives, hosts, position
       FROM files WHERE version_id IN (${scope}) ORDER BY kind = 'primary' DESC, position, created_at`,
    ).bind(...binds),
  ]);
  const sandboxRows = q.includeScan
    ? (
        await env.DB.prepare(`SELECT version_id, file_id, os, status, outcome, summary, findings, error, finished_at, created_at FROM sandbox_runs WHERE version_id IN (${scope})`)
          .bind(...binds)
          .all<SummaryRow & { version_id: string; file_id: string }>()
      ).results
    : [];
  const group = <T extends { version_id: string }>(list: T[]) => {
    const m = new Map<string, T[]>();
    for (const item of list) m.set(item.version_id, [...(m.get(item.version_id) ?? []), item]);
    return m;
  };
  const lMap = group(loaders.results as { version_id: string; loader: string }[]);
  const gMap = group(gvs.results as { version_id: string; game_version: string }[]);
  const fMap = group(files.results as FileRow[]);
  const dMap = group(
    deps.results as {
      version_id: string;
      dep_project_id: string;
      dep_version_id: string | null;
      kind: DependencyKind;
      slug: string;
      name: string;
      version_number: string | null;
    }[],
  );

  return rows.map((r): Version => {
    const fileRows = fMap.get(r.id) ?? [];
    const verified = r.release_id ? fileRows.map((f) => fileInfo(f, r.repo_id, r.release_id!)).filter((f): f is FileInfo => !!f) : [];
    const primary = verified.find((f) => f.kind === 'primary') ?? null;
    const primaryRow = fileRows.find((f) => f.kind === 'primary');
    return {
      id: r.id,
      projectId: r.project_id,
      versionNumber: r.version_number,
      name: r.name,
      changelog: r.changelog,
      channel: r.channel,
      status: r.status,
      statusReason: r.status_reason,
      ...(q.staff ? { reviewDetail: r.review_detail } : {}),
      loaders: (lMap.get(r.id) ?? []).map((x) => x.loader),
      gameVersions: sortGameVersionsDesc((gMap.get(r.id) ?? []).map((x) => x.game_version)),
      dependencies: (dMap.get(r.id) ?? []).map(
        (d): Dependency => ({
          projectId: d.dep_project_id,
          projectSlug: d.slug,
          projectName: d.name,
          versionId: d.dep_version_id,
          versionNumber: d.version_number,
          kind: d.kind,
        }),
      ),
      downloads: r.downloads,
      createdAt: r.created_at,
      publishedAt: r.published_at,
      author: { id: r.author_id, username: r.author_username, avatarUrl: r.author_avatar },
      featured: r.featured === 1,
      file: primary,
      files: primary ? verified : [],
      releaseUrl: r.release_id ? `https://github.com/${r.repo_full_name}/releases/tag/${encodeURIComponent(r.tag)}` : null,
      ...(q.includeScan
        ? {
            scan: primaryRow ? scanOf(primaryRow, q.staff === true) : { verdict: null, findings: [], capabilities: [], engines: [], scannedAt: null, natives: [], hosts: [] },
            scans: Object.fromEntries(fileRows.map((f) => [f.id, { ...scanOf(f, q.staff === true), filename: f.filename, kind: f.kind, uploaded: f.asset_id !== null }])),
            publishPending: r.publish_pending === 1,
            sandbox: summariesOf(sandboxRows.filter((x) => x.version_id === r.id && x.file_id === primaryRow?.id), q.staff === true),
          }
        : {}),
    };
  });
}

// Project-level loaders and game versions are the union over live versions, so search filters stay honest.
export function recomputeProject(env: Env, projectId: string): D1PreparedStatement[] {
  return [
    env.DB.prepare('DELETE FROM project_loaders WHERE project_id = ?').bind(projectId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO project_loaders (project_id, loader)
       SELECT DISTINCT ?1, vl.loader FROM version_loaders vl JOIN versions v ON v.id = vl.version_id
       WHERE v.project_id = ?1 AND v.status = 'live'`,
    ).bind(projectId),
    env.DB.prepare('DELETE FROM project_game_versions WHERE project_id = ?').bind(projectId),
    env.DB.prepare(
      `INSERT OR IGNORE INTO project_game_versions (project_id, game_version)
       SELECT DISTINCT ?1, vg.game_version FROM version_game_versions vg JOIN versions v ON v.id = vg.version_id
       WHERE v.project_id = ?1 AND v.status = 'live'`,
    ).bind(projectId),
  ];
}

export function goLiveStatements(env: Env, versionId: string, projectId: string, authorId: string): D1PreparedStatement[] {
  const now = Date.now();
  return [
    env.DB.prepare("UPDATE versions SET status = 'live', status_reason = NULL, published_at = COALESCE(published_at, ?2) WHERE id = ?1").bind(
      versionId,
      now,
    ),
    env.DB.prepare(
      `UPDATE projects SET updated_at = ?2,
         status = CASE WHEN status = 'draft' THEN 'active' ELSE status END,
         published_at = COALESCE(published_at, ?2)
       WHERE id = ?1`,
    ).bind(projectId, now),
    env.DB.prepare('UPDATE users SET approved_uploads = approved_uploads + 1 WHERE id = ?').bind(authorId),
    ...recomputeProject(env, projectId),
  ];
}

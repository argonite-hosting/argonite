// Publishing straight from GitHub releases. With auto-publish on, a release in the linked repository
// becomes a version here: its files are scanned like any upload, and if it was created as a draft it
// stays a draft on GitHub until the scan (and any review) passes.
import { SITE } from '../../../shared/config';
import { PERM, has } from '../../../shared/permissions';
import { typeInfo, type FileKind } from '../../../shared/taxonomy';
import type { AutoPublishSettings } from '../../../shared/types';
import { cleanMultiline, cleanText, sanitizeFilename, validateVersionNumber } from '../../../shared/validate';
import type { Env } from '../env';
import { projectRepo } from './app';
import { newId } from './crypto';
import { dispatchScan, gh, repoPath, type GitHubRelease } from './github';
import { audit, projectAccess } from './guard';
import { userFromRow, type UserRow } from './session';
import { metaStatements, scanJobStatements, uploadCaps, MAX_FILES_PER_VERSION } from '../routes/versions';
import { ensureGameVersions } from '../routes/cron';

interface AutoProject {
  id: string;
  type: string;
  repo_id: number;
  repo_full_name: string;
  installation_id: number | null;
  auto_publish: string;
  auto_publish_by: string | null;
}

const MAX_WATCH_CHECKS = 30;

function settingsOf(p: AutoProject): AutoPublishSettings | null {
  try {
    const s = JSON.parse(p.auto_publish) as AutoPublishSettings;
    return s.enabled ? s : null;
  } catch {
    return null;
  }
}

function globToRegex(glob: string): RegExp {
  return new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`, 'i');
}

function kindFor(name: string): FileKind {
  const n = name.toLowerCase();
  if (/-sources\.jar$/.test(n)) return 'sources';
  if (/-javadoc\.jar$/.test(n)) return 'javadoc';
  if (/-(dev|deobf)\.jar$/.test(n)) return 'dev';
  if (/server/.test(n) && /\.(zip|mrpack)$/.test(n)) return 'server';
  return 'other';
}

export function versionFromTag(tag: string): string | null {
  const v = tag.replace(/^v(?=\d)/i, '').slice(0, 64);
  return validateVersionNumber(v) ? null : v;
}

async function projectForRepo(env: Env, repoId: number): Promise<AutoProject | null> {
  return env.DB.prepare(
    "SELECT id, type, repo_id, repo_full_name, installation_id, auto_publish, auto_publish_by FROM projects WHERE repo_id = ? AND status IN ('draft', 'active') AND auto_publish IS NOT NULL AND repo_status = 'ok'",
  )
    .bind(repoId)
    .first<AutoProject>();
}

async function importRelease(env: Env, project: AutoProject, release: GitHubRelease, isPublic: boolean): Promise<void> {
  const settings = settingsOf(project);
  if (!settings) return;
  const already = await env.DB.prepare('SELECT 1 FROM versions WHERE release_id = ?').bind(release.id).first();
  if (already) return;
  const skip = (why: string) => audit(env, null, 'autopublish.skipped', 'project', project.id, { release: release.id, tag: release.tag_name, why }).run();

  const versionNumber = versionFromTag(release.tag_name);
  if (!versionNumber) return void (await skip('tag is not a usable version number'));
  const authorRow = project.auto_publish_by
    ? await env.DB.prepare('SELECT * FROM users WHERE id = ? AND deleted_at IS NULL').bind(project.auto_publish_by).first<UserRow>()
    : null;
  if (!authorRow) return void (await skip('the member who turned on auto-publish is gone'));
  const author = userFromRow(authorRow, env);
  const access = await projectAccess(env, project.id, author);
  if (author.banned || !has(access.perms, PERM.UPLOAD_VERSION)) return void (await skip('that member can no longer upload versions'));

  const info = typeInfo(project.type)!;
  const pattern = globToRegex(settings.assetPattern || '*');
  const ready = release.assets.filter((a) => a.state === 'uploaded' && pattern.test(a.name) && a.size > 21 && a.size <= SITE.limits.fileMaxBytes);
  const primary = ready.find((a) => info.extensions.some((e) => a.name.toLowerCase().endsWith(e)) && kindFor(a.name) === 'other');
  if (!primary) return void (await skip(`no ${info.extensions.join('/')} asset matched ${settings.assetPattern}`));
  const extras = ready.filter((a) => a.id !== primary.id && /\.(jar|zip|mrpack)$/i.test(a.name)).slice(0, MAX_FILES_PER_VERSION - 1);
  const files = [primary, ...extras].map((a, i) => ({ asset: a, kind: (i === 0 ? 'primary' : kindFor(a.name)) as FileKind }));
  if (files.some((f) => sanitizeFilename(f.asset.name, ['.jar', '.zip', '.mrpack']) !== f.asset.name)) return void (await skip('an asset name has characters GitHub would rewrite'));

  try {
    await uploadCaps(env, author.id, author.approvedUploads, project.id, versionNumber);
  } catch (e) {
    return void (await skip(e instanceof Error ? e.message : 'upload limit'));
  }
  await ensureGameVersions(env);
  const known = await env.DB.prepare('SELECT value FROM json_each(?) WHERE value IN (SELECT id FROM game_versions)').bind(JSON.stringify(settings.gameVersions)).all<{ value: string }>();
  const gameVersions = known.results.map((r) => r.value);
  if (!gameVersions.length) return void (await skip('none of the configured game versions exist'));

  const channel = release.prerelease ? (/alpha/i.test(release.tag_name) ? 'alpha' : 'beta') : 'release';
  const id = newId();
  const now = Date.now();
  const rows = files.map((f, i) => ({ ...f, id: newId(now + i) }));
  const { stmts, jobIds } = scanJobStatements(env, id, rows.map((r) => r.id));
  try {
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO versions (id, project_id, version_number, name, changelog, channel, status, author_id, tag, release_id, upload_name, upload_size, release_public, source, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'scanning', ?, ?, ?, ?, ?, ?, 'github', ?)`,
      ).bind(
        id,
        project.id,
        versionNumber,
        cleanText(release.name || versionNumber).slice(0, 80) || versionNumber,
        cleanMultiline(release.body ?? '').slice(0, SITE.limits.changelogMaxChars),
        channel,
        author.id,
        release.tag_name,
        release.id,
        primary.name,
        primary.size,
        isPublic ? 1 : 0,
        now,
      ),
      ...rows.map((r, i) =>
        env.DB.prepare('INSERT INTO files (id, version_id, kind, asset_id, filename, size, position, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(r.id, id, r.kind, r.asset.id, r.asset.name, r.asset.size, i, now),
      ),
      ...metaStatements(env, id, { loaders: settings.loaders.filter((l) => info.loaders.includes(l)), gameVersions }),
      ...stmts,
      audit(env, author.id, 'version.autopublish', 'version', id, { release: release.id, files: rows.length }),
    ]);
  } catch (e) {
    if (String(e).includes('UNIQUE')) return;
    throw e;
  }
  await Promise.all(jobIds.map((j) => dispatchScan(env, j).catch(() => false)));
}

export async function onReleaseEvent(env: Env, action: string, repoId: number, release: GitHubRelease): Promise<void> {
  if (action === 'published' || (action === 'edited' && !release.draft)) {
    // Ours (or one we imported from a draft) just went public; remember that.
    const mine = await env.DB.prepare('UPDATE versions SET release_public = 1 WHERE release_id = ? AND release_public = 0').bind(release.id).run();
    await env.DB.prepare('DELETE FROM release_watch WHERE release_id = ?').bind(release.id).run();
    if (mine.meta.changes || action !== 'published') return;
    const project = await projectForRepo(env, repoId);
    if (project) await importRelease(env, project, release, true);
    return;
  }
  if (action === 'created' && release.draft) {
    const project = await projectForRepo(env, repoId);
    const settings = project ? settingsOf(project) : null;
    if (!project || !settings?.drafts) return;
    await env.DB.prepare('INSERT OR IGNORE INTO release_watch (release_id, project_id, created_at) VALUES (?, ?, ?)').bind(release.id, project.id, Date.now()).run();
  }
}

// Called from the cron: draft releases get imported once their assets stop changing.
export async function checkWatchedReleases(env: Env, max = 20): Promise<void> {
  const watched = await env.DB.prepare('SELECT release_id, project_id, seen_assets, checks FROM release_watch ORDER BY created_at LIMIT ?')
    .bind(max)
    .all<{ release_id: number; project_id: string; seen_assets: string | null; checks: number }>();
  for (const w of watched.results) {
    const drop = () => env.DB.prepare('DELETE FROM release_watch WHERE release_id = ?').bind(w.release_id).run();
    try {
      const ours = await env.DB.prepare('SELECT 1 FROM versions WHERE release_id = ?').bind(w.release_id).first();
      const project = await env.DB.prepare(
        "SELECT id, type, repo_id, repo_full_name, installation_id, auto_publish, auto_publish_by FROM projects WHERE id = ? AND auto_publish IS NOT NULL AND status IN ('draft', 'active')",
      )
        .bind(w.project_id)
        .first<AutoProject>();
      if (ours || !project || w.checks >= MAX_WATCH_CHECKS) {
        await drop();
        continue;
      }
      const { token, repo } = await projectRepo(env, project);
      let release: GitHubRelease;
      try {
        release = await gh<GitHubRelease>(token, 'GET', `${repoPath(repo)}/releases/${w.release_id}`);
      } catch {
        await drop();
        continue;
      }
      const fingerprint = JSON.stringify(release.assets.map((a) => [a.id, a.size, a.state]).sort());
      const settled = release.assets.length > 0 && release.assets.every((a) => a.state === 'uploaded') && fingerprint === w.seen_assets;
      if (!release.draft || settled) {
        await drop();
        await importRelease(env, project, release, !release.draft);
      } else {
        await env.DB.prepare('UPDATE release_watch SET seen_assets = ?, checks = checks + 1 WHERE release_id = ?').bind(fingerprint, w.release_id).run();
      }
    } catch {
      await env.DB.prepare('UPDATE release_watch SET checks = checks + 1 WHERE release_id = ?').bind(w.release_id).run();
    }
  }
}

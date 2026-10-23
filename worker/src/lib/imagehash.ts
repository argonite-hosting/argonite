// Records the SHA-256 of project images (icon, banner, gallery) that were committed before hashes were
// kept. Until an image has a hash it isn't shown, so this runs every ten minutes in small batches.
import { SITE } from '../../../shared/config';
import type { Env } from '../env';
import { sha256Hex } from './crypto';
import { rawUrl } from './github';
import { sniffImage } from './input';

const BATCH = 25;

async function hashRaw(repo: string, commit: string, path: string, maxBytes: number): Promise<string | null> {
  try {
    const res = await fetch(rawUrl(repo, commit, path));
    if (!res.ok) return null;
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (!bytes.length || bytes.length > maxBytes || !sniffImage(bytes)) return null;
    return sha256Hex(bytes);
  } catch {
    return null;
  }
}

export async function hashStoredImages(env: Env): Promise<void> {
  const projects = await env.DB.prepare(
    `SELECT id, repo_full_name, icon_path, icon_commit, icon_sha256, banner_path, banner_commit, banner_sha256 FROM projects
     WHERE status != 'removed' AND ((icon_commit IS NOT NULL AND icon_sha256 IS NULL) OR (banner_commit IS NOT NULL AND banner_sha256 IS NULL)) ORDER BY random() LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string; repo_full_name: string; icon_path: string | null; icon_commit: string | null; icon_sha256: string | null; banner_path: string | null; banner_commit: string | null; banner_sha256: string | null }>();
  for (const p of projects.results) {
    if (p.icon_commit && p.icon_path && !p.icon_sha256) {
      const sha = await hashRaw(p.repo_full_name, p.icon_commit, p.icon_path, SITE.limits.iconMaxBytes);
      if (sha) await env.DB.prepare('UPDATE projects SET icon_sha256 = ? WHERE id = ? AND icon_commit = ?').bind(sha, p.id, p.icon_commit).run();
    }
    if (p.banner_commit && p.banner_path && !p.banner_sha256) {
      const sha = await hashRaw(p.repo_full_name, p.banner_commit, p.banner_path, SITE.limits.galleryMaxBytes);
      if (sha) await env.DB.prepare('UPDATE projects SET banner_sha256 = ? WHERE id = ? AND banner_commit = ?').bind(sha, p.id, p.banner_commit).run();
    }
  }
  const images = await env.DB.prepare(
    `SELECT g.id, g.path, g.commit_sha, p.repo_full_name FROM gallery g JOIN projects p ON p.id = g.project_id
     WHERE g.sha256 IS NULL AND p.status != 'removed' ORDER BY random() LIMIT ?`,
  )
    .bind(BATCH)
    .all<{ id: string; path: string; commit_sha: string; repo_full_name: string }>();
  for (const g of images.results) {
    const sha = await hashRaw(g.repo_full_name, g.commit_sha, g.path, SITE.limits.galleryMaxBytes);
    if (sha) await env.DB.prepare('UPDATE gallery SET sha256 = ? WHERE id = ?').bind(sha, g.id).run();
  }
}

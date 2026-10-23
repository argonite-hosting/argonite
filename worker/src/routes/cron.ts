import type { Env } from '../env';
import { appConfigured, projectRepo } from '../lib/app';
import { checkWatchedReleases } from '../lib/autopublish';
import { flushOutbox } from '../lib/datastore';
import { hashStoredImages } from '../lib/imagehash';
import { refreshLinkChecks } from '../lib/linkcheck';
import { moveUnlistedOffGitHub } from './userdata';
import { audit } from '../lib/guard';
import { dispatchScan, gh, repoPath } from '../lib/github';
import { goLive } from '../lib/publish';
import { sweepSandbox } from './sandbox';
import { MAX_ATTEMPTS } from './scanner';
import { pingDue } from './servers';

const MANIFEST = 'https://piston-meta.mojang.com/mc/game/version_manifest_v2.json';
let gameVersionsReady = false;

export async function refreshGameVersions(env: Env): Promise<void> {
  const res = await fetch(MANIFEST, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`manifest ${res.status}`);
  const data = (await res.json()) as { versions: { id: string; type: string; releaseTime: string }[] };
  const list = data.versions
    .filter((v) => (v.type === 'release' || v.type === 'snapshot') && /^[A-Za-z0-9][A-Za-z0-9._+ -]{0,39}$/.test(v.id))
    .map((v) => ({ id: v.id, type: v.type, t: Date.parse(v.releaseTime) || 0 }));
  if (!list.length) return;
  await env.DB.prepare(
    `INSERT INTO game_versions (id, type, released_at)
     SELECT json_extract(value, '$.id'), json_extract(value, '$.type'), json_extract(value, '$.t') FROM json_each(?)
     WHERE true
     ON CONFLICT(id) DO UPDATE SET type = excluded.type, released_at = excluded.released_at`,
  )
    .bind(JSON.stringify(list))
    .run();
  gameVersionsReady = true;
}

export async function ensureGameVersions(env: Env): Promise<void> {
  if (gameVersionsReady) return;
  const row = await env.DB.prepare('SELECT COUNT(*) AS n FROM game_versions').first<{ n: number }>();
  if ((row?.n ?? 0) > 0) {
    gameVersionsReady = true;
    return;
  }
  await refreshGameVersions(env);
}

async function sweepScans(env: Env): Promise<void> {
  const now = Date.now();
  const exhausted = await env.DB.prepare(
    "SELECT id, version_id, kind FROM scan_jobs WHERE status = 'claimed' AND claimed_at < ? AND attempts >= ?",
  )
    .bind(now - 30 * 60 * 1000, MAX_ATTEMPTS)
    .all<{ id: string; version_id: string; kind: string }>();
  for (const job of exhausted.results) {
    await env.DB.batch([
      env.DB.prepare("UPDATE scan_jobs SET status = 'failed', error = 'timed out', finished_at = ? WHERE id = ?").bind(now, job.id),
      env.DB.prepare(
        "UPDATE versions SET status = 'review', status_reason = 'Automatic scan timed out; a moderator will check it.' WHERE id = ? AND status = 'scanning'",
      ).bind(job.version_id),
      audit(env, null, 'scan.timeout', 'version', job.version_id, { job: job.id }),
    ]);
  }
  const waiting = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM scan_jobs WHERE (status = 'queued' AND created_at < ?) OR (status = 'claimed' AND claimed_at < ?)",
  )
    .bind(now - 5 * 60 * 1000, now - 30 * 60 * 1000)
    .first<{ n: number }>();
  if ((waiting?.n ?? 0) > 0) await dispatchScan(env).catch(() => false);
}

async function sweepAbandonedUploads(env: Env): Promise<void> {
  const cutoff = Date.now() - 3 * 3600 * 1000;
  const stale = await env.DB.prepare(
    `SELECT v.id, v.release_id, p.id AS project_id, p.repo_id, p.repo_full_name, p.installation_id FROM versions v JOIN projects p ON p.id = v.project_id
     WHERE v.status = 'uploading' AND v.created_at < ? LIMIT 20`,
  )
    .bind(cutoff)
    .all<{ id: string; release_id: number | null; project_id: string; repo_id: number; repo_full_name: string; installation_id: number | null }>();
  for (const v of stale.results) {
    if (v.release_id) {
      try {
        const { token, repo } = await projectRepo(env, { id: v.project_id, repo_id: v.repo_id, repo_full_name: v.repo_full_name, installation_id: v.installation_id });
        await gh(token, 'DELETE', `${repoPath(repo)}/releases/${v.release_id}`);
      } catch {
        // Best effort; a leftover draft release on GitHub hurts nobody.
      }
    }
    await env.DB.prepare("DELETE FROM versions WHERE id = ? AND status = 'uploading'").bind(v.id).run();
  }
}

// Versions that passed but whose GitHub release couldn't be published (GitHub hiccup, app briefly
// uninstalled). Retried quietly until it works.
async function retryPublishing(env: Env): Promise<void> {
  const waiting = await env.DB.prepare("SELECT id FROM versions WHERE publish_pending = 1 AND status = 'unavailable' LIMIT 10").all<{ id: string }>();
  for (const v of waiting.results) {
    await goLive(env, v.id, null, 'version.publish_retry').catch(() => undefined);
  }
}

async function housekeeping(env: Env): Promise<void> {
  const now = Date.now();
  const day = (offset: number) => new Date(now - offset * 86_400_000).toISOString().slice(0, 10);
  await env.DB.batch([
    env.DB.prepare('DELETE FROM view_marks WHERE day < ?').bind(day(3)),
    env.DB.prepare('DELETE FROM app_tokens WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM release_watch WHERE created_at < ?').bind(now - 2 * 86_400_000),
    env.DB.prepare('DELETE FROM api_tokens WHERE expires_at IS NOT NULL AND expires_at < ?').bind(now - 30 * 86_400_000),
    env.DB.prepare('DELETE FROM version_stats_daily WHERE day < ?').bind(day(731)),
    env.DB.prepare('DELETE FROM project_stats_daily WHERE day < ?').bind(day(731)),
    env.DB.prepare('DELETE FROM sessions WHERE expires_at < ?').bind(now),
    env.DB.prepare('DELETE FROM download_marks WHERE day < ?').bind(new Date(now - 3 * 86_400_000).toISOString().slice(0, 10)),
    env.DB.prepare('DELETE FROM webhook_deliveries WHERE received_at < ?').bind(now - 7 * 86_400_000),
    env.DB.prepare("DELETE FROM scan_jobs WHERE status IN ('done', 'failed') AND finished_at < ?").bind(now - 30 * 86_400_000),
    // Full reports are kept for a while for moderators; the findings and summary stay with the version.
    env.DB.prepare('UPDATE sandbox_runs SET report = NULL WHERE report IS NOT NULL AND finished_at < ?').bind(now - 90 * 86_400_000),
  ]);
}

export async function runCron(cron: string, env: Env, scheduledTime = Date.now()): Promise<void> {
  if (cron === '17 4 * * *') {
    await refreshGameVersions(env);
    await housekeeping(env);
    return;
  }
  // Every two minutes: commit queued writes to GitHub and pick up draft releases from CI.
  const app = appConfigured(env);
  if (app) {
    await moveUnlistedOffGitHub(env).catch((e) => console.error(JSON.stringify({ cron: 'unlisted', error: String(e) })));
    await flushOutbox(env).catch((e) => console.error(JSON.stringify({ cron: 'outbox', error: String(e) })));
    await checkWatchedReleases(env).catch((e) => console.error(JSON.stringify({ cron: 'releases', error: String(e) })));
  }
  if (new Date(scheduledTime).getUTCMinutes() % 10 >= 2) return;
  await sweepScans(env);
  await sweepSandbox(env).catch((e) => console.error(JSON.stringify({ cron: 'sandbox', error: String(e) })));
  await sweepAbandonedUploads(env);
  await hashStoredImages(env).catch((e) => console.error(JSON.stringify({ cron: 'images', error: String(e) })));
  await refreshLinkChecks(env).catch((e) => console.error(JSON.stringify({ cron: 'links', error: String(e) })));
  if (app) await retryPublishing(env);
  await pingDue(env).catch((e) => console.error(JSON.stringify({ cron: 'servers', error: String(e) })));
}

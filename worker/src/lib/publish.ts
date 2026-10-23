// Taking a version live. Its GitHub release has been a draft the whole time; it's published here,
// right before the version goes live, so nothing is downloadable anywhere until it has passed.
import type { Env } from '../env';
import { projectRepo, publishRelease } from './app';
import { goLiveStatements } from './db';
import { audit } from './guard';

interface PublishRow {
  id: string;
  project_id: string;
  author_id: string;
  channel: string;
  release_id: number | null;
  release_public: number;
  repo_id: number;
  repo_full_name: string;
  installation_id: number | null;
}

export type PublishOutcome = 'live' | 'pending';

export async function goLive(env: Env, versionId: string, actorId: string | null, action: string): Promise<PublishOutcome> {
  const v = await env.DB.prepare(
    `SELECT v.id, v.project_id, v.author_id, v.channel, v.release_id, v.release_public, p.repo_id, p.repo_full_name, p.installation_id
     FROM versions v JOIN projects p ON p.id = v.project_id WHERE v.id = ?`,
  )
    .bind(versionId)
    .first<PublishRow>();
  if (!v) return 'pending';

  if (!v.release_public && v.release_id) {
    try {
      const { token, repo } = await projectRepo(env, { id: v.project_id, repo_id: v.repo_id, repo_full_name: v.repo_full_name, installation_id: v.installation_id });
      await publishRelease(token, repo, v.release_id, v.channel === 'release');
    } catch (e) {
      const reason = `Passed every check, but the GitHub release could not be published yet (${e instanceof Error ? e.message : 'unknown error'}). It will be retried automatically.`;
      await env.DB.batch([
        env.DB.prepare("UPDATE versions SET status = 'unavailable', status_reason = ?, publish_pending = 1 WHERE id = ?").bind(reason.slice(0, 500), v.id),
        audit(env, actorId, 'version.publish_failed', 'version', v.id, { via: action }),
      ]);
      return 'pending';
    }
  }
  await env.DB.batch([
    env.DB.prepare('UPDATE versions SET release_public = 1, publish_pending = 0 WHERE id = ?').bind(v.id),
    ...goLiveStatements(env, v.id, v.project_id, v.author_id),
    audit(env, actorId, action, 'version', v.id),
  ]);
  return 'live';
}

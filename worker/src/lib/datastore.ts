// User content that lives in GitHub instead of on Cloudflare.
//
// Writes go into data_outbox first and the cron commits them in batches: every pending file for one
// repository becomes a single commit, so a burst of activity costs a handful of API calls and stays far
// below GitHub's content-creation limits. D1 keeps only the commit and SHA-256 of what was committed;
// anything read back from GitHub is used only if its bytes still hash to that value.
import { SITE } from '../../../shared/config';
import type { Env } from '../env';
import { dataRepoToken, installationToken } from './app';
import { sha256Hex } from './crypto';
import { GitHubError, gh } from './github';
import { rawBase } from './runtime';

export const DATA_BRANCH = 'argonite-data';
export type DataKind = 'comments' | 'collection' | 'profile';

export interface DataTarget {
  repo: string;
  branch: string;
  installationId: number | null;
}

export function projectData(repoFullName: string, installationId: number | null): DataTarget {
  return { repo: repoFullName, branch: DATA_BRANCH, installationId };
}

export function siteData(): DataTarget {
  return { repo: SITE.github.dataRepo, branch: 'main', installationId: null };
}

export function dataUrl(repo: string, commit: string, path: string): string {
  return `${rawBase()}/${repo}/${commit}/${path}`;
}

export async function queueWrite(
  env: Env,
  target: DataTarget,
  path: string,
  kind: DataKind,
  refId: string,
  content: string | null,
  opts: { purge?: boolean } = {},
): Promise<string | null> {
  const sha = content === null ? null : await sha256Hex(content);
  await env.DB.prepare(
    `INSERT INTO data_outbox (repo, path, branch, kind, ref_id, content, sha256, installation_id, purge, updated_at)
     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
     ON CONFLICT(repo, path) DO UPDATE SET content = ?6, sha256 = ?7, installation_id = COALESCE(?8, installation_id),
       purge = MAX(purge, ?9), updated_at = ?10, attempts = 0, last_error = NULL`,
  )
    .bind(target.repo, path, target.branch, kind, refId, content, sha, target.installationId, opts.purge ? 1 : 0, Date.now())
    .run();
  return sha;
}

export async function pending(env: Env, repo: string, path: string): Promise<{ content: string | null } | null> {
  return env.DB.prepare('SELECT content FROM data_outbox WHERE repo = ? AND path = ?').bind(repo, path).first<{ content: string | null }>();
}

// The newest version of a stored file: a pending write if there is one, otherwise the committed copy,
// fetched from GitHub and checked against the hash we recorded when we committed it.
export async function readFile(env: Env, repo: string, path: string, commit: string | null, sha256: string | null): Promise<string | null> {
  const queued = await pending(env, repo, path);
  if (queued) return queued.content;
  if (!commit || !sha256) return null;
  const res = await fetch(dataUrl(repo, commit, path), { cf: { cacheTtl: 86_400, cacheEverything: true } });
  if (!res.ok) return null;
  const text = await res.text();
  return (await sha256Hex(text)) === sha256 ? text : null;
}

interface OutboxRow {
  repo: string;
  path: string;
  branch: string;
  kind: DataKind;
  ref_id: string;
  content: string | null;
  sha256: string | null;
  installation_id: number | null;
  purge: number;
  updated_at: number;
  attempts: number;
}

async function tokenFor(env: Env, rows: OutboxRow[]): Promise<string> {
  if (rows[0].repo === SITE.github.dataRepo) return (await dataRepoToken(env)).token;
  const id = rows.find((r) => r.installation_id)?.installation_id;
  if (!id) throw new Error('no installation for this repository');
  return installationToken(env, id);
}

function repoApi(repo: string): string {
  const [owner, name] = repo.split('/');
  return `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
}

// One commit for every pending file in a repository branch.
async function commitBatch(env: Env, rows: OutboxRow[]): Promise<string> {
  const { repo, branch } = rows[0];
  const token = await tokenFor(env, rows);
  const base = repoApi(repo);
  let head: string | null = null;
  try {
    head = (await gh<{ object: { sha: string } }>(token, 'GET', `${base}/git/ref/heads/${branch}`)).object.sha;
  } catch (e) {
    if (!(e instanceof GitHubError && e.ghStatus === 404)) throw e;
  }
  const baseTree = head ? (await gh<{ tree: { sha: string } }>(token, 'GET', `${base}/git/commits/${head}`)).tree.sha : null;
  const tree = await gh<{ sha: string }>(token, 'POST', `${base}/git/trees`, {
    ...(baseTree ? { base_tree: baseTree } : {}),
    tree: rows.map((r) => (r.content === null ? { path: r.path, mode: '100644', type: 'blob', sha: null } : { path: r.path, mode: '100644', type: 'blob', content: r.content })),
  });
  const message = `${SITE.name}: update ${rows.length === 1 ? rows[0].path : `${rows.length} files`}`;
  let commit = await gh<{ sha: string }>(token, 'POST', `${base}/git/commits`, { message, tree: tree.sha, parents: head ? [head] : [] });
  if (rows.some((r) => r.purge)) {
    // Something was removed by a moderator or its author. Replace the branch with a single commit of
    // the current files so the removed text doesn't linger in the branch history.
    commit = await gh<{ sha: string }>(token, 'POST', `${base}/git/commits`, { message: `${SITE.name}: data snapshot`, tree: tree.sha, parents: [] });
  }
  if (head) {
    await gh(token, 'PATCH', `${base}/git/refs/heads/${branch}`, { sha: commit.sha, force: rows.some((r) => r.purge) });
  } else {
    await gh(token, 'POST', `${base}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.sha });
  }
  return commit.sha;
}

function indexUpdate(env: Env, row: OutboxRow, commit: string): D1PreparedStatement | null {
  if (row.kind === 'comments') {
    const [projectId, page] = row.ref_id.split(':');
    return env.DB.prepare('UPDATE comment_pages SET commit_sha = ?, sha256 = ? WHERE project_id = ? AND page = ?').bind(commit, row.sha256, projectId, Number(page));
  }
  if (row.kind === 'collection') {
    return row.content === null
      ? null
      : env.DB.prepare('UPDATE collections SET commit_sha = ?, sha256 = ?, path = ? WHERE id = ?').bind(commit, row.sha256, row.path, row.ref_id);
  }
  if (row.kind === 'profile') {
    return env.DB.prepare('UPDATE users SET profile_commit = ?, profile_sha256 = ?, profile_path = ? WHERE id = ?').bind(
      row.content === null ? null : commit,
      row.sha256,
      row.content === null ? null : row.path,
      row.ref_id,
    );
  }
  return null;
}

export async function flushOutbox(env: Env, maxRepos = 15): Promise<void> {
  const rows = (
    await env.DB.prepare('SELECT * FROM data_outbox WHERE attempts < 8 ORDER BY updated_at LIMIT 500').all<OutboxRow>()
  ).results;
  const groups = new Map<string, OutboxRow[]>();
  for (const r of rows) {
    const key = `${r.repo}#${r.branch}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  for (const group of [...groups.values()].slice(0, maxRepos)) {
    try {
      const commit = await commitBatch(env, group);
      const stmts: D1PreparedStatement[] = [];
      for (const r of group) {
        const idx = indexUpdate(env, r, commit);
        // Only clear rows nobody rewrote while we were committing; newer writes go out next run.
        stmts.push(env.DB.prepare('DELETE FROM data_outbox WHERE repo = ? AND path = ? AND updated_at = ?').bind(r.repo, r.path, r.updated_at));
        if (idx) stmts.push(idx);
      }
      await env.DB.batch(stmts);
    } catch (e) {
      const msg = (e instanceof Error ? e.message : String(e)).slice(0, 300);
      await env.DB.batch(
        group.map((r) => env.DB.prepare('UPDATE data_outbox SET attempts = attempts + 1, last_error = ? WHERE repo = ? AND path = ?').bind(msg, r.repo, r.path)),
      );
    }
  }
}

// The test machines claim a run and report back here. They prove they're our workflow on GitHub's own
// machines with a GitHub Actions identity token, so there's no shared secret on them to steal.
import { SITE } from '../../../shared/config';
import { isId } from '../../../shared/validate';
import type { Env } from '../env';
import { assetDownloadUrl, projectRepo } from '../lib/app';
import { randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { parseJson } from '../lib/db';
import { audit } from '../lib/guard';
import { HttpError, badRequest, json, readTextLimited } from '../lib/http';
import { type ActionsClaims, verifyActionsToken } from '../lib/oidc';
import type { Ctx, Router } from '../lib/router';
import { MAX_DISPATCHES, MAX_RUN_ATTEMPTS, type RunRow, SANDBOX_OSES, type SandboxOs, TESTABLE_TYPES, cleanReport, dispatchRun, judge, sandboxEnabled, startRuns, summaryOf, workflowFor } from '../lib/sandbox';
import { assertSameSite } from '../lib/guard';
import { requireModerator } from '../lib/session';
import { decideVersion } from './scanner';

const CLAIM_TIMEOUT_MS = 120 * 60 * 1000;
const START_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_REPORT_BYTES = 1_048_576;

async function identify(ctx: Ctx): Promise<{ claims: ActionsClaims; os: SandboxOs; ghRun: string }> {
  const header = ctx.request.headers.get('Authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const claims = token ? await verifyActionsToken(token, SITE.apiUrl) : null;
  if (!claims) throw new HttpError(401, 'unauthorized', 'Missing or invalid identity token.');
  // Pinned to the account's numeric id as well as its name, so a re-registered name can't pass.
  const os = SANDBOX_OSES.find((o) => claims.workflow_ref === workflowFor(o));
  if (
    !os ||
    !SITE.sandbox.systems.includes(os) ||
    claims.repository !== SITE.sandbox.repo ||
    String(claims.repository_owner_id) !== String(SITE.sandbox.ownerId) ||
    claims.ref !== 'refs/heads/main' ||
    claims.event_name !== 'repository_dispatch' ||
    claims.runner_environment !== 'github-hosted'
  ) {
    throw new HttpError(403, 'forbidden', 'This workflow may not run tests.');
  }
  return { claims, os, ghRun: `${claims.run_id}.${claims.run_attempt}` };
}

async function readBody(ctx: Ctx): Promise<Record<string, unknown>> {
  const text = await readTextLimited(ctx.request, MAX_REPORT_BYTES);
  try {
    const body = JSON.parse(text) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch {
    throw badRequest('Malformed JSON.');
  }
}

interface RunContext {
  version_status: string;
  project_id: string;
  project_type: string;
  repo_id: number;
  repo_full_name: string;
  installation_id: number | null;
  release_public: number;
  tag: string;
  asset_id: number | null;
  filename: string;
  size: number;
  sha256: string | null;
  hosts: string | null;
  loaders: string | null;
  game_versions: string | null;
}

function runContext(env: Env, run: Pick<RunRow, 'version_id' | 'file_id'>): Promise<RunContext | null> {
  return env.DB.prepare(
    `SELECT v.status AS version_status, p.id AS project_id, p.type AS project_type, p.repo_id, p.repo_full_name, p.installation_id, v.release_public, v.tag,
            f.asset_id, f.filename, f.size, f.sha256, f.hosts,
            (SELECT group_concat(loader, ',') FROM version_loaders WHERE version_id = v.id) AS loaders,
            (SELECT group_concat(game_version, ',') FROM version_game_versions WHERE version_id = v.id) AS game_versions
     FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id WHERE f.id = ? AND v.id = ?`,
  )
    .bind(run.file_id, run.version_id)
    .first<RunContext>();
}

async function finishRun(env: Env, run: Pick<RunRow, 'id' | 'version_id'>, error: string): Promise<void> {
  await env.DB.prepare("UPDATE sandbox_runs SET status = 'failed', error = ?, claim_hash = NULL, finished_at = ? WHERE id = ?").bind(error.slice(0, 300), Date.now(), run.id).run();
  await decideWhenSettled(env, run.version_id);
}

// Tests no longer hold a version back; this only finishes versions uploaded while they still did.
async function decideWhenSettled(env: Env, versionId: string): Promise<void> {
  await decideVersion(env, versionId);
}

async function claim(ctx: Ctx): Promise<Response> {
  const { os, ghRun } = await identify(ctx);
  const body = await readBody(ctx);
  const runId = typeof body.run === 'string' && isId(body.run) ? body.run : '';
  const nonce = typeof body.nonce === 'string' && body.nonce.length <= 100 ? body.nonce : '';
  const token = randomToken(32);
  const now = Date.now();
  const run = await ctx.env.DB.prepare(
    `UPDATE sandbox_runs SET status = 'claimed', claimed_at = ?1, attempts = attempts + 1, claim_hash = ?2, gh_run = ?3
     WHERE id = ?4 AND os = ?5 AND status = 'queued' AND attempts < ?6 AND nonce_hash = ?7 RETURNING *`,
  )
    .bind(now, await sha256Hex(token), ghRun, runId, os, MAX_RUN_ATTEMPTS, await sha256Hex(nonce))
    .first<RunRow>();
  if (!run) return json({ run: null });

  const c = await runContext(ctx.env, run);
  if (!c || c.version_status === 'deleted' || !c.sha256 || c.asset_id === null) {
    await finishRun(ctx.env, run, 'version no longer waiting for tests');
    return json({ run: null });
  }
  let url: string | null = null;
  try {
    const { token: repoToken, repo } = await projectRepo(ctx.env, { id: c.project_id, repo_id: c.repo_id, repo_full_name: c.repo_full_name, installation_id: c.installation_id }, { allowPrivate: true });
    url = await assetDownloadUrl(repoToken, repo, c.asset_id);
  } catch {
    url = null;
  }
  if (!url && c.release_public) {
    const [owner, repo] = c.repo_full_name.split('/');
    url = `https://github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/releases/download/${encodeURIComponent(c.tag)}/${encodeURIComponent(c.filename)}`;
  }
  if (!url) {
    await ctx.env.DB.prepare("UPDATE sandbox_runs SET status = 'queued', claim_hash = NULL, error = 'could not get a download link' WHERE id = ?").bind(run.id).run();
    return json({ run: null });
  }
  return json({
    run: {
      id: run.id,
      os,
      claimToken: token,
      versionId: run.version_id,
      projectType: c.project_type,
      loaders: (c.loaders ?? '').split(',').filter(Boolean),
      gameVersions: (c.game_versions ?? '').split(',').filter(Boolean),
      file: { name: c.filename, size: c.size, sha256: c.sha256, url },
    },
  });
}

// The run this request is about, which must be claimed by the same workflow run holding the token it was given.
async function claimedRun(ctx: Ctx): Promise<{ run: RunRow; os: SandboxOs; body: Record<string, unknown> }> {
  const { os, ghRun } = await identify(ctx);
  const body = await readBody(ctx);
  const runId = typeof body.run === 'string' && isId(body.run) ? body.run : '';
  const claimToken = typeof body.claimToken === 'string' ? body.claimToken : '';
  const run = await ctx.env.DB.prepare("SELECT * FROM sandbox_runs WHERE id = ? AND status = 'claimed'").bind(runId).first<RunRow>();
  if (!run || run.os !== os || run.gh_run !== ghRun || !run.claim_hash || !safeEqual(run.claim_hash, await sha256Hex(claimToken))) {
    throw new HttpError(409, 'stale_run', 'This run is not claimed by you.');
  }
  return { run, os, body };
}

const CURSEFORGE_CDN = new Set(['edge.forgecdn.net', 'mediafilez.forgecdn.net']);
const CURSEFORGE_FOLDERS: Record<number, string> = { 6: 'mods', 12: 'resourcepacks', 6552: 'shaderpacks' };

// CurseForge downloads need an API key, which stays here: the machine sends the pack's file ids and gets
// back names, links, hashes and which side each file is for.
async function curseforgeFiles(ctx: Ctx): Promise<Response> {
  const { body } = await claimedRun(ctx);
  const ids = [...new Set((Array.isArray(body.files) ? body.files : []).filter((x): x is number => Number.isSafeInteger(x) && (x as number) > 0))].slice(0, 600);
  if (!ctx.env.CURSEFORGE_API_KEY || !ids.length) return json({ files: {} });
  const cf = async <T>(path: string, payload: unknown): Promise<T[]> => {
    const res = await fetch(`https://api.curseforge.com${path}`, {
      method: 'POST',
      headers: { 'x-api-key': ctx.env.CURSEFORGE_API_KEY!, Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) throw new HttpError(502, 'upstream_failed', `CurseForge answered ${res.status}.`);
    return ((await res.json()) as { data?: T[] }).data ?? [];
  };
  type CfFile = { id: number; modId: number; fileName: string; downloadUrl: string | null; fileLength: number; hashes?: { value: string; algo: number }[]; gameVersions?: string[] };
  const files: CfFile[] = [];
  for (let i = 0; i < ids.length; i += 200) files.push(...(await cf<CfFile>('/v1/mods/files', { fileIds: ids.slice(i, i + 200) })));
  const modIds = [...new Set(files.map((f) => f.modId))];
  const classes = new Map<number, number>();
  for (let i = 0; i < modIds.length; i += 200) for (const m of await cf<{ id: number; classId: number }>('/v1/mods', { modIds: modIds.slice(i, i + 200) })) classes.set(m.id, m.classId);
  const out: Record<string, unknown> = {};
  for (const f of files) {
    let url: string | null = null;
    try {
      url = f.downloadUrl && CURSEFORGE_CDN.has(new URL(f.downloadUrl).hostname) && f.downloadUrl.startsWith('https://') ? f.downloadUrl : null;
    } catch {
      url = null;
    }
    const versions = f.gameVersions ?? [];
    out[String(f.id)] = {
      name: String(f.fileName).slice(0, 200),
      url,
      sha1: f.hashes?.find((h) => h.algo === 1)?.value ?? null,
      size: f.fileLength,
      folder: CURSEFORGE_FOLDERS[classes.get(f.modId) ?? 6] ?? 'mods',
      client: !versions.includes('Server') || versions.includes('Client'),
      server: !versions.includes('Client') || versions.includes('Server'),
    };
  }
  return json({ files: out });
}

async function result(ctx: Ctx): Promise<Response> {
  const { run, os, body } = await claimedRun(ctx);
  const report = cleanReport(body.report);
  const now = Date.now();
  // Only the Linux run is required, so only it gets a second try; the others' errors are simply ignored.
  if (report.outcome === 'error' && os === 'linux' && run.attempts < MAX_RUN_ATTEMPTS) {
    await ctx.env.DB.prepare("UPDATE sandbox_runs SET status = 'queued', claim_hash = NULL, error = ? WHERE id = ?").bind((report.error ?? 'error').slice(0, 300), run.id).run();
    await dispatchRun(ctx.env, run);
    return json({ ok: true, retry: true });
  }
  const c = await runContext(ctx.env, run);
  const findings = judge(os, report, parseJson<string[]>(c?.hosts ?? null, []));
  const stored = JSON.stringify(report);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE sandbox_runs SET status = 'done', outcome = ?, findings = ?, summary = ?, report = ?, error = ?, claim_hash = NULL, finished_at = ? WHERE id = ? AND status = 'claimed'`,
    ).bind(
      report.outcome,
      JSON.stringify(findings),
      JSON.stringify(summaryOf(os, report)),
      stored.length <= 400_000 ? stored : JSON.stringify({ ...report, log: report.log.slice(-2000) }),
      report.outcome === 'tested' ? null : report.error,
      now,
      run.id,
    ),
    audit(ctx.env, null, 'sandbox.result', 'version', run.version_id, { run: run.id, os, outcome: report.outcome, findings: findings.filter((f) => f.severity === 'high' || f.severity === 'critical').length }),
  ]);
  await decideWhenSettled(ctx.env, run.version_id);
  return json({ ok: true });
}

// Every ten minutes: start runs GitHub never picked up, retry runs that went quiet, give up on the rest.
export async function sweepSandbox(env: Env): Promise<void> {
  const now = Date.now();
  const settle = new Set<string>();
  // Open runs are given up only when tests are switched off or their version was deleted.
  const switchedOff = sandboxEnabled(env) ? 0 : 1;
  const abandoned = await env.DB.prepare(
    `SELECT id, version_id FROM sandbox_runs WHERE status IN ('queued', 'claimed')
       AND (?1 = 1 OR version_id IN (SELECT id FROM versions WHERE status = 'deleted'))`,
  )
    .bind(switchedOff)
    .all<{ id: string; version_id: string }>();
  for (const r of abandoned.results) {
    await env.DB.prepare("UPDATE sandbox_runs SET status = 'failed', error = ?, claim_hash = NULL, finished_at = ? WHERE id = ?")
      .bind(sandboxEnabled(env) ? 'version no longer waiting for tests' : 'behaviour tests are switched off', now, r.id)
      .run();
    settle.add(r.version_id);
  }
  if (sandboxEnabled(env)) {
    const quiet = await env.DB.prepare("SELECT * FROM sandbox_runs WHERE status = 'claimed' AND claimed_at < ? LIMIT 50").bind(now - CLAIM_TIMEOUT_MS).all<RunRow>();
    for (const r of quiet.results) {
      if (r.attempts < MAX_RUN_ATTEMPTS) {
        await env.DB.prepare("UPDATE sandbox_runs SET status = 'queued', claim_hash = NULL, error = 'timed out' WHERE id = ? AND status = 'claimed'").bind(r.id).run();
        await dispatchRun(env, r);
      } else {
        await env.DB.prepare("UPDATE sandbox_runs SET status = 'failed', error = 'timed out', claim_hash = NULL, finished_at = ? WHERE id = ?").bind(now, r.id).run();
        settle.add(r.version_id);
      }
    }
    const waiting = await env.DB.prepare("SELECT * FROM sandbox_runs WHERE status = 'queued' AND (dispatched_at IS NULL OR dispatched_at < ?) LIMIT 50")
      .bind(now - START_TIMEOUT_MS)
      .all<RunRow>();
    for (const r of waiting.results) {
      if (r.dispatches < MAX_DISPATCHES) {
        await dispatchRun(env, r);
      } else {
        await env.DB.prepare("UPDATE sandbox_runs SET status = 'failed', error = 'the test machine never started', finished_at = ? WHERE id = ?").bind(now, r.id).run();
        settle.add(r.version_id);
      }
    }
  }
  for (const versionId of settle) await decideWhenSettled(env, versionId).catch((e) => console.error(JSON.stringify({ cron: 'sandbox', error: String(e) })));
}

// A moderator asks for the version's main file to be run on some or all of the test machines.
async function requestTests(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  if (!isId(ctx.params.id)) throw badRequest('Invalid version.');
  if (!sandboxEnabled(ctx.env)) throw new HttpError(409, 'sandbox_off', 'Behaviour tests are not set up on this site.');
  const body = await readBody(ctx);
  const wanted = [...new Set(Array.isArray(body.systems) ? body.systems : [])].filter((x): x is SandboxOs => SANDBOX_OSES.includes(x as SandboxOs) && SITE.sandbox.systems.includes(x as SandboxOs));
  if (!wanted.length) throw badRequest('Pick at least one system.');
  const v = await ctx.env.DB.prepare(
    `SELECT v.id, v.status, p.type, f.id AS file_id, f.sha256 FROM versions v JOIN projects p ON p.id = v.project_id
     LEFT JOIN files f ON f.version_id = v.id AND f.kind = 'primary' WHERE v.id = ?`,
  )
    .bind(ctx.params.id)
    .first<{ id: string; status: string; type: string; file_id: string | null; sha256: string | null }>();
  if (!v || v.status === 'deleted') throw new HttpError(404, 'not_found', 'Version not found.');
  if (!TESTABLE_TYPES.has(v.type)) throw new HttpError(409, 'not_testable', 'Only mods, plugins and modpacks can be tested.');
  if (!v.file_id || !v.sha256) throw new HttpError(409, 'not_scanned', 'The file hasn’t finished its scan yet.');
  const busy = await ctx.env.DB.prepare("SELECT os FROM sandbox_runs WHERE version_id = ? AND status IN ('queued', 'claimed')").bind(v.id).all<{ os: SandboxOs }>();
  const running = new Set(busy.results.map((r) => r.os));
  const systems = wanted.filter((os) => !running.has(os));
  if (!systems.length) throw new HttpError(409, 'already_running', 'Those tests are already running.');
  await startRuns(ctx.env, v.id, v.file_id, systems);
  await audit(ctx.env, mod.id, 'sandbox.requested', 'version', v.id, { systems }).run();
  return json({ started: systems });
}

export function sandboxRoutes(r: Router): void {
  r.post('/api/mod/versions/:id/sandbox', requestTests);
  r.post('/internal/sandbox/claim', claim);
  r.post('/internal/sandbox/result', result);
  r.post('/internal/sandbox/curseforge', curseforgeFiles);
}

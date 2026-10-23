import { SITE } from '../../../shared/config';
import { verifyFileRecord } from '../../../shared/signing';
import type { Finding, NativeFile, PackContents } from '../../../shared/types';
import { isId } from '../../../shared/validate';
import { assetDownloadUrl, projectRepo } from '../lib/app';
import { hmacHex, randomToken, safeEqual, sha256Hex } from '../lib/crypto';
import { parseJson, recomputeProject } from '../lib/db';
import { audit } from '../lib/guard';
import { HttpError, badRequest, json, readTextLimited } from '../lib/http';
import { goLive } from '../lib/publish';
import type { Ctx, Router } from '../lib/router';
import { scanKey } from '../lib/runtime';

const MAX_SKEW_MS = 5 * 60 * 1000;
const STALE_CLAIM_MS = 30 * 60 * 1000;
export const MAX_ATTEMPTS = 3;
const SEVERITIES = new Set(['info', 'low', 'medium', 'high', 'critical']);
// Network access and plain encryption are everywhere in honest mods, so they're recorded but never force a review on their own.
const RISKY_CAPABILITIES = new Set(['process_exec', 'native_code', 'dynamic_classloading', 'instrumentation', 'credential_access', 'jar_writing', 'session_token', 'class_transformer', 'patches_loader', 'outside_game_dir']);
const MAX_CONTENTS_BYTES = 400_000;

async function authenticate(ctx: Ctx): Promise<Record<string, unknown>> {
  const ts = Number(ctx.request.headers.get('X-Argonite-Timestamp') ?? '0');
  const sig = ctx.request.headers.get('X-Argonite-Signature') ?? '';
  if (!ctx.env.SCANNER_HMAC_SECRET || !Number.isFinite(ts) || Math.abs(Date.now() - ts * 1000) > MAX_SKEW_MS) {
    throw new HttpError(401, 'unauthorized', 'Stale or missing scanner timestamp.');
  }
  const text = await readTextLimited(ctx.request, 4_194_304);
  const expected = await hmacHex(ctx.env.SCANNER_HMAC_SECRET, `${ts}.${text}`);
  if (!safeEqual(sig, expected)) throw new HttpError(401, 'unauthorized', 'Bad scanner signature.');
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw badRequest('Malformed JSON.');
  }
}

interface JobRow {
  id: string;
  version_id: string;
  file_id: string | null;
  kind: 'scan' | 'verify';
  status: string;
  attempts: number;
  claim_hash: string | null;
}

interface JobContext {
  file_id: string;
  file_kind: string;
  version_id: string;
  version_status: string;
  tag: string;
  release_id: number;
  release_public: number;
  author_id: string;
  project_id: string;
  project_type: string;
  repo_id: number;
  repo_full_name: string;
  installation_id: number | null;
  asset_id: number;
  filename: string;
  size: number;
  sha1: string | null;
  sha256: string | null;
  sha512: string | null;
  approved_uploads: number;
  github_created_at: number;
  loaders: string | null;
  game_versions: string | null;
}

async function jobContext(ctx: Ctx, job: Pick<JobRow, 'version_id' | 'file_id'>): Promise<JobContext | null> {
  return ctx.env.DB.prepare(
    `SELECT f.id AS file_id, f.kind AS file_kind, v.id AS version_id, v.status AS version_status, v.tag, v.release_id, v.release_public, v.author_id,
            p.id AS project_id, p.type AS project_type, p.repo_id, p.repo_full_name, p.installation_id,
            f.asset_id, f.filename, f.size, f.sha1, f.sha256, f.sha512, u.approved_uploads, u.github_created_at,
            (SELECT group_concat(loader, ',') FROM version_loaders WHERE version_id = v.id) AS loaders,
            (SELECT group_concat(game_version, ',') FROM version_game_versions WHERE version_id = v.id) AS game_versions
     FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id JOIN users u ON u.id = v.author_id
     WHERE f.id = COALESCE(?2, (SELECT id FROM files WHERE version_id = ?1 AND kind = 'primary')) AND v.id = ?1`,
  )
    .bind(job.version_id, job.file_id)
    .first<JobContext>();
}

async function claim(ctx: Ctx): Promise<Response> {
  const body = await authenticate(ctx);
  const jobId = typeof body.jobId === 'string' && isId(body.jobId) ? body.jobId : null;
  const token = randomToken(32);
  const now = Date.now();
  const pick = jobId
    ? 'id = ?3'
    : "id = (SELECT id FROM scan_jobs WHERE (status = 'queued' OR (status = 'claimed' AND claimed_at < ?4)) AND attempts < ?5 ORDER BY created_at LIMIT 1)";
  const job = await ctx.env.DB.prepare(
    `UPDATE scan_jobs SET status = 'claimed', claimed_at = ?1, attempts = attempts + 1, claim_hash = ?2
     WHERE ${pick} AND (status = 'queued' OR (status = 'claimed' AND claimed_at < ?4)) AND attempts < ?5
     RETURNING id, version_id, file_id, kind, status, attempts, claim_hash`,
  )
    .bind(now, await sha256Hex(token), jobId ?? '', now - STALE_CLAIM_MS, MAX_ATTEMPTS)
    .first<JobRow>();
  if (!job) return json({ job: null });

  const c = await jobContext(ctx, job);
  if (!c || c.version_status === 'deleted' || c.asset_id === null) {
    await ctx.env.DB.prepare("UPDATE scan_jobs SET status = 'failed', error = 'file gone', finished_at = ? WHERE id = ?").bind(now, job.id).run();
    return json({ job: null, skipped: job.id });
  }

  // Draft releases aren't public, so hand the scanner a short-lived signed link to just this asset.
  let downloadUrl: string | null = null;
  try {
    const { token: repoToken, repo } = await projectRepo(
      ctx.env,
      { id: c.project_id, repo_id: c.repo_id, repo_full_name: c.repo_full_name, installation_id: c.installation_id },
      { allowPrivate: true },
    );
    downloadUrl = await assetDownloadUrl(repoToken, repo, c.asset_id);
  } catch {
    downloadUrl = null;
  }
  if (!downloadUrl && !c.release_public) {
    await ctx.env.DB.prepare("UPDATE scan_jobs SET status = 'queued', claim_hash = NULL, error = 'could not get a download link' WHERE id = ?").bind(job.id).run();
    return json({ job: null, skipped: job.id });
  }

  return json({
    job: {
      id: job.id,
      kind: job.kind,
      claimToken: token,
      fileId: c.file_id,
      fileKind: c.file_kind,
      versionId: c.version_id,
      projectId: c.project_id,
      projectType: c.project_type,
      repoId: c.repo_id,
      repoFullName: c.repo_full_name,
      releaseId: c.release_id,
      assetId: c.asset_id,
      tag: c.tag,
      filename: c.filename,
      size: c.size,
      downloadUrl,
      declared: { loaders: (c.loaders ?? '').split(',').filter(Boolean), gameVersions: (c.game_versions ?? '').split(',').filter(Boolean) },
      expected: job.kind === 'verify' ? { sha1: c.sha1, sha256: c.sha256, sha512: c.sha512 } : null,
    },
  });
}

// Lets the scanner skip re-scanning files that are already published here (modpacks reuse them a lot).
async function known(ctx: Ctx): Promise<Response> {
  const body = await authenticate(ctx);
  const list = Array.isArray(body.sha512) ? body.sha512.filter((h): h is string => typeof h === 'string' && /^[0-9a-f]{128}$/.test(h)).slice(0, 2000) : [];
  if (!list.length) return json({ files: {} });
  const out: Record<string, { slug: string; name: string; type: string; verdict: string }> = {};
  for (let i = 0; i < list.length; i += 400) {
    const rows = await ctx.env.DB.prepare(
      `SELECT f.sha512, f.verdict, p.slug, p.name, p.type FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id
       WHERE f.sha512 IN (SELECT value FROM json_each(?)) AND v.status = 'live' AND p.status IN ('active', 'delisted')`,
    )
      .bind(JSON.stringify(list.slice(i, i + 400)))
      .all<{ sha512: string; verdict: string; slug: string; name: string; type: string }>();
    for (const r of rows.results) out[r.sha512] = { slug: r.slug, name: r.name, type: r.type, verdict: r.verdict };
  }
  return json({ files: out });
}

function hex(value: unknown, len: number, field: string): string {
  if (typeof value !== 'string' || value.length !== len || !/^[0-9a-f]+$/.test(value)) throw badRequest(`Invalid ${field}.`);
  return value;
}

function cleanFindings(value: unknown): Finding[] {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 300).flatMap((f): Finding[] => {
    if (!f || typeof f !== 'object') return [];
    const r = f as Record<string, unknown>;
    const severity = typeof r.severity === 'string' && SEVERITIES.has(r.severity) ? (r.severity as Finding['severity']) : 'info';
    return [
      {
        rule: String(r.rule ?? 'unknown').slice(0, 80),
        severity,
        detail: String(r.detail ?? '').slice(0, 500),
        ...(r.path ? { path: String(r.path).slice(0, 300) } : {}),
        ...(typeof r.sha256 === 'string' && /^[0-9a-f]{64}$/.test(r.sha256) ? { sha256: r.sha256 } : {}),
      },
    ];
  });
}

function cleanList(value: unknown, max = 50): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((v): v is string => typeof v === 'string').map((v) => v.slice(0, 64)))].slice(0, max) : [];
}

function cleanContents(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const c = value as Partial<PackContents>;
  if (!Array.isArray(c.entries)) return null;
  const text = JSON.stringify({
    minecraft: typeof c.minecraft === 'string' ? c.minecraft.slice(0, 40) : null,
    loaders: c.loaders && typeof c.loaders === 'object' ? Object.fromEntries(Object.entries(c.loaders).slice(0, 8).map(([k, v]) => [k.slice(0, 32), String(v).slice(0, 40)])) : {},
    entries: c.entries.slice(0, 3000).map((e) => ({
      path: String(e.path ?? '').slice(0, 300),
      size: Number(e.size) || 0,
      env: e.env && typeof e.env === 'object' ? { client: String(e.env.client ?? '').slice(0, 12), server: String(e.env.server ?? '').slice(0, 12) } : null,
      source: ['argonite', 'external', 'curseforge', 'bundled'].includes(String(e.source)) ? e.source : 'external',
      host: e.host ? String(e.host).slice(0, 100) : null,
      project: e.project && typeof e.project === 'object' ? { slug: String(e.project.slug).slice(0, 48), name: String(e.project.name).slice(0, 64), type: String(e.project.type).slice(0, 16) } : null,
      verdict: ['clean', 'suspicious', 'malicious', 'unscanned'].includes(String(e.verdict)) ? e.verdict : 'unscanned',
    })),
    truncated: c.truncated === true || c.entries.length > 3000,
  });
  return text.length <= MAX_CONTENTS_BYTES ? text : null;
}

const NATIVE_PLATFORMS = new Set(['windows', 'linux', 'macos', 'unknown']);

function cleanNatives(raw: unknown): NativeFile[] {
  if (!Array.isArray(raw)) return [];
  return raw.slice(0, 200).flatMap((n): NativeFile[] => {
    const e = (n ?? {}) as Record<string, unknown>;
    if (typeof e.path !== 'string' || typeof e.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(e.sha256)) return [];
    return [{ path: e.path.slice(0, 300), sha256: e.sha256, size: Number(e.size) || 0, platform: (NATIVE_PLATFORMS.has(String(e.platform)) ? e.platform : 'unknown') as NativeFile['platform'] }];
  });
}

const HOST = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

function cleanLinks(meta: { links?: unknown; links_complete?: unknown }): { links: string[]; complete: boolean } {
  const raw = Array.isArray(meta.links) ? meta.links : [];
  const links = [...new Set(raw.filter((u): u is string => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length <= 2000))].slice(0, 5000);
  return { links, complete: meta.links_complete === true && links.length === raw.length };
}

function cleanHosts(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return [...new Set(raw.filter((h): h is string => typeof h === 'string' && h.length <= 253 && HOST.test(h)))].slice(0, 2000);
}

interface PrevFile {
  kind: string;
  findings: string | null;
  natives: string | null;
  links: string | null;
  capabilities: string | null;
}

// The files of the project's most recent live version: what was last approved or passed.
async function previousLive(ctx: Ctx, projectId: string, versionId: string): Promise<PrevFile[]> {
  const rows = await ctx.env.DB.prepare(
    `SELECT f.kind, f.findings, f.natives, f.links, f.capabilities FROM files f WHERE f.version_id = (
       SELECT id FROM versions WHERE project_id = ? AND status = 'live' AND id != ? ORDER BY published_at DESC LIMIT 1)`,
  )
    .bind(projectId, versionId)
    .all<PrevFile>();
  return rows.results;
}

interface LinkList {
  links: string[];
  complete: boolean;
}

// Links (exact URLs) the version has that the last live version didn't. A new path on a shared host
// such as GitHub can point at someone else's file, so links are compared whole, not by website.
function linkChanges(prev: PrevFile[], current: LinkList[]): string[] {
  if (current.some((l) => !l.complete)) return ['Has more links than can be compared between versions; a moderator should look at them'];
  const now = [...new Set(current.flatMap((l) => l.links))];
  // No earlier live version, or one scanned before links were kept: this version becomes the baseline.
  if (!now.length || !prev.length || prev.every((r) => r.links === null)) return [];
  const before = new Set(prev.flatMap((r) => parseJson<LinkList | null>(r.links, null)?.links ?? []));
  const added = now.filter((u) => !before.has(u)).sort();
  if (!added.length) return [];
  const shown = added.slice(0, 5).map((u) => (u.length > 120 ? `${u.slice(0, 117)}...` : u));
  return [`New links since the last version: ${shown.join(', ')}${added.length > 5 ? ` and ${added.length - 5} more` : ''}`];
}

// Natives that weren't in the last live version, or whose bytes changed. Matched by exact bytes:
// a native can't be inspected like bytecode, so any change gets a human look.
function nativeChanges(prev: PrevFile[], current: NativeFile[]): string[] {
  if (!current.length) return [];
  const before = new Map<string, string>();
  for (const row of prev) for (const n of parseJson<NativeFile[]>(row.natives, [])) before.set(n.path.split('!/').pop()!, n.sha256);
  const known = new Set(before.values());
  const notes: string[] = [];
  for (const n of current) {
    if (known.has(n.sha256)) continue;
    notes.push(before.has(n.path.split('!/').pop()!) ? `Native library changed since the last version: ${n.path}` : `New native library: ${n.path}`);
  }
  return notes.length > 5 ? [...notes.slice(0, 5), `and ${notes.length - 5} more native files`] : notes;
}

// Findings that are never accepted just because an earlier version had them too.
const NEVER_CARRIED = /^(link\.|reputation\.|ioc\.|clamav|yara\.|file\.disguised_executable)/;

// A finding is identified by the kind of file, its rule and where it sits inside the file. Only the path
// inside the innermost jar counts, with version numbers ignored, since both change between releases.
// Findings about credentials, the session token, persistence, exfiltration and loader patching also
// carry the hash of the class they were found in, and only carry over if that class is byte-identical.
function findingKey(kind: string, f: Finding): string {
  const where = (f.path ?? '').split('!/').pop()!.toLowerCase().replace(/\d+(?:[._-]\d+)*/g, '#');
  return `${kind}|${f.rule}|${where}|${f.sha256 ?? ''}`;
}

// High findings a moderator (or an earlier carried-over version) already accepted for this project.
function acceptedFindings(prev: PrevFile[]): Set<string> {
  return new Set(
    prev.flatMap((r) =>
      parseJson<Finding[]>(r.findings, [])
        .filter((f) => f.severity === 'high' && !NEVER_CARRIED.test(f.rule))
        .map((f) => findingKey(r.kind, f)),
    ),
  );
}

// The version is decided once every file has a fingerprint: any malicious file rejects it, any reason
// to look closer sends it to review, otherwise it goes live (and its GitHub release gets published).
async function decideVersion(ctx: Ctx, versionId: string): Promise<string> {
  const files = await ctx.env.DB.prepare('SELECT id, kind, filename, sha256, verdict, findings, capabilities, natives, links FROM files WHERE version_id = ?')
    .bind(versionId)
    .all<{ id: string; kind: string; filename: string; sha256: string | null; verdict: string | null; findings: string | null; capabilities: string | null; natives: string | null; links: string | null }>();
  if (files.results.some((f) => !f.sha256)) return 'scanning';
  const v = await ctx.env.DB.prepare(
    `SELECT v.id, v.status, v.project_id, v.author_id, u.approved_uploads, u.github_created_at
     FROM versions v JOIN users u ON u.id = v.author_id WHERE v.id = ?`,
  )
    .bind(versionId)
    .first<{ id: string; status: string; project_id: string; author_id: string; approved_uploads: number; github_created_at: number }>();
  if (!v || v.status !== 'scanning') return v?.status ?? 'deleted';

  const all = files.results.map((f) => ({ ...f, list: parseJson<Finding[]>(f.findings, []) }));
  const bad = all.find((f) => f.verdict === 'malicious');
  if (bad) {
    const top = bad.list.find((x) => x.severity === 'critical') ?? bad.list[0];
    const reason = top?.rule.startsWith('policy.') ? top.detail : `The scanner detected malware in ${bad.filename}.`;
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE versions SET status = 'rejected', status_reason = ? WHERE id = ? AND status = 'scanning'").bind(reason.slice(0, 500), v.id),
      audit(ctx.env, null, 'scan.malicious', 'version', v.id, { file: bad.id, findings: bad.list.slice(0, 10) }),
    ]);
    return 'rejected';
  }

  const prevFiles = await previousLive(ctx, v.project_id, v.id);
  const reasons: string[] = [
    ...nativeChanges(prevFiles, all.flatMap((f) => parseJson<NativeFile[]>(f.natives, []))),
    ...linkChanges(prevFiles, all.map((f) => parseJson<LinkList>(f.links, { links: [], complete: true }))),
  ];
  // Once a moderator approves a version, the same findings in later versions don't need another look,
  // as long as nothing around them changed. Natives and websites are compared above.
  const accepted = acceptedFindings(prevFiles);
  for (const f of all.filter((x) => x.verdict === 'suspicious')) {
    const fresh = f.list.filter((x) => (x.severity === 'high' || x.severity === 'critical') && (NEVER_CARRIED.test(x.rule) || !accepted.has(findingKey(f.kind, x))));
    if (!fresh.length) continue;
    reasons.push(`Flagged by the scanner: ${fresh[0].detail}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ''}${f.kind === 'primary' ? '' : ` (${f.filename})`}`);
  }
  if (v.approved_uploads < SITE.review.firstUploadsNeedReview) reasons.push('First upload from this account');
  if (Date.now() - v.github_created_at < SITE.review.minGithubAccountAgeDays * 86_400_000) reasons.push('New GitHub account');
  const capabilities = [...new Set(all.flatMap((f) => parseJson<string[]>(f.capabilities, [])))];
  const risky = capabilities.filter((cap) => RISKY_CAPABILITIES.has(cap));
  if (prevFiles.length) {
    // Compared against every file of the last live version, not only its main file.
    const before = new Set(prevFiles.flatMap((r) => parseJson<string[]>(r.capabilities, [])));
    const added = risky.filter((cap) => !before.has(cap));
    if (added.length) reasons.push(`New sensitive behaviour since the last version: ${added.join(', ')}`);
  } else if (risky.length && v.approved_uploads > 0) {
    reasons.push(`Sensitive behaviour: ${risky.join(', ')}`);
  }
  if (reasons.length) {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare("UPDATE versions SET status = 'review', status_reason = ? WHERE id = ? AND status = 'scanning'").bind(reasons.join('. ').slice(0, 500), v.id),
      audit(ctx.env, null, 'scan.review', 'version', v.id, { reasons }),
    ]);
    return 'review';
  }
  // Two files can finish at the same moment; only one of them gets to publish.
  const lock = await ctx.env.DB.prepare("UPDATE versions SET publish_pending = 2 WHERE id = ? AND status = 'scanning' AND publish_pending = 0").bind(v.id).run();
  if (!lock.meta.changes) return 'scanning';
  return (await goLive(ctx.env, v.id, null, 'scan.clean')) === 'live' ? 'live' : 'unavailable';
}

async function result(ctx: Ctx): Promise<Response> {
  const body = await authenticate(ctx);
  const jobId = typeof body.jobId === 'string' && isId(body.jobId) ? body.jobId : '';
  const claimToken = typeof body.claimToken === 'string' ? body.claimToken : '';
  const job = await ctx.env.DB.prepare("SELECT * FROM scan_jobs WHERE id = ? AND status = 'claimed'").bind(jobId).first<JobRow>();
  if (!job || !job.claim_hash || !safeEqual(job.claim_hash, await sha256Hex(claimToken))) throw new HttpError(409, 'stale_job', 'Job is not claimed by you.');
  const now = Date.now();
  const finish = (status: 'done' | 'failed' | 'queued', error: string | null = null) =>
    ctx.env.DB.prepare('UPDATE scan_jobs SET status = ?, error = ?, finished_at = ?, claim_hash = NULL WHERE id = ?').bind(status, error, now, job.id);

  const c = await jobContext(ctx, job);
  if (!c) {
    await finish('failed', 'file gone').run();
    return json({ ok: true });
  }

  if (typeof body.error === 'string') {
    const error = body.error.slice(0, 500);
    if (job.attempts < MAX_ATTEMPTS) {
      await finish('queued', error).run();
    } else {
      await ctx.env.DB.batch([
        finish('failed', error),
        ...(job.kind === 'scan' && c.version_status === 'scanning'
          ? [ctx.env.DB.prepare("UPDATE versions SET status = 'review', status_reason = 'Automatic scan could not finish; a moderator will check it.' WHERE id = ?").bind(c.version_id)]
          : []),
        audit(ctx.env, null, 'scan.failed', 'version', c.version_id, { job: job.id, error }),
      ]);
    }
    return json({ ok: true });
  }

  const r = (body.result ?? {}) as Record<string, unknown>;

  if (job.kind === 'verify') {
    const missing = r.missing === true;
    const sha256 = missing ? null : hex(r.sha256, 64, 'sha256');
    const intact = !missing && sha256 === c.sha256 && r.size === c.size;
    await ctx.env.DB.batch([
      finish('done'),
      ...(!intact && (c.version_status === 'live' || c.version_status === 'review')
        ? [
            ctx.env.DB.prepare("UPDATE versions SET status = 'unavailable', status_reason = ? WHERE id = ?").bind(
              missing ? `${c.filename} was removed from GitHub.` : `${c.filename} on GitHub no longer matches the scanned file.`,
              c.version_id,
            ),
            audit(ctx.env, null, 'version.integrity_failed', 'version', c.version_id, { file: c.file_id, expected: c.sha256, got: sha256, missing }),
          ]
        : []),
    ]);
    if (!intact) await ctx.env.DB.batch(recomputeProject(ctx.env, c.project_id));
    return json({ ok: true, intact });
  }

  const sha1 = hex(r.sha1, 40, 'sha1');
  const sha256 = hex(r.sha256, 64, 'sha256');
  const sha512 = hex(r.sha512, 128, 'sha512');
  const size = typeof r.size === 'number' ? r.size : -1;
  const signature = typeof r.signature === 'string' && r.signature.length <= 200 ? r.signature : '';
  const verdict = r.verdict === 'clean' || r.verdict === 'suspicious' || r.verdict === 'malicious' ? r.verdict : null;
  if (!verdict) throw badRequest('Invalid verdict.');
  if (size !== c.size) throw badRequest('Scanned size does not match the uploaded asset.');

  const record = {
    fileId: c.file_id,
    versionId: c.version_id,
    projectId: c.project_id,
    repoId: c.repo_id,
    releaseId: c.release_id,
    assetId: c.asset_id,
    filename: c.filename,
    size,
    sha1,
    sha256,
    sha512,
  };
  if (!(await verifyFileRecord(scanKey(), record, signature))) {
    await ctx.env.DB.batch([finish('failed', 'bad signature'), audit(ctx.env, null, 'scan.bad_signature', 'version', c.version_id, { job: job.id })]);
    throw new HttpError(400, 'bad_signature', 'Signature does not verify against the published key.');
  }

  if (c.version_status !== 'scanning' || c.sha256) {
    await finish('done', 'file no longer awaiting scan').run();
    return json({ ok: true });
  }

  const findings = cleanFindings(r.findings);
  const capabilities = cleanList(r.capabilities);
  const engines = cleanList(r.engines, 20);
  const natives = cleanNatives((r.metadata as { natives?: unknown } | undefined)?.natives);
  const hosts = cleanHosts((r.metadata as { hosts?: unknown } | undefined)?.hosts);
  const links = cleanLinks((r.metadata as { links?: unknown; links_complete?: unknown } | undefined) ?? {});
  const { natives: _natives, hosts: _hosts, links: _links, links_complete: _complete, ...restMeta } = (r.metadata ?? {}) as Record<string, unknown>;
  const rawMeta = JSON.stringify(restMeta);
  const metadata = rawMeta.length <= 32_000 ? rawMeta : JSON.stringify({ truncated: true });
  const contents = c.project_type === 'modpack' && c.file_kind === 'primary' ? cleanContents(r.contents) : null;

  const duplicate = await ctx.env.DB.prepare(
    `SELECT p.name, p.slug FROM files f JOIN versions v ON v.id = f.version_id JOIN projects p ON p.id = v.project_id
     WHERE f.sha512 = ? AND f.id != ? LIMIT 1`,
  )
    .bind(sha512, c.file_id)
    .first<{ name: string; slug: string }>();
  if (duplicate) {
    await ctx.env.DB.batch([
      finish('done'),
      ctx.env.DB.prepare('UPDATE files SET scanned_at = ?, verdict = ?, findings = ?, capabilities = ?, engines = ? WHERE id = ?').bind(
        now,
        verdict,
        JSON.stringify(findings),
        JSON.stringify(capabilities),
        JSON.stringify(engines),
        c.file_id,
      ),
      ctx.env.DB.prepare("UPDATE versions SET status = 'rejected', status_reason = ? WHERE id = ? AND status = 'scanning'").bind(
        `${c.filename} is already published on ${SITE.name} (${duplicate.name}).`,
        c.version_id,
      ),
      audit(ctx.env, null, 'scan.duplicate', 'version', c.version_id, { of: duplicate.slug, file: c.file_id }),
    ]);
    return json({ ok: true, status: 'rejected' });
  }

  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `UPDATE files SET sha1 = ?, sha256 = ?, sha512 = ?, signature = ?, scanned_at = ?, verdict = ?, findings = ?, capabilities = ?, engines = ?, metadata = ?, contents = ?, natives = ?, hosts = ?, links = ?
       WHERE id = ? AND sha256 IS NULL`,
    ).bind(sha1, sha256, sha512, signature, now, verdict, JSON.stringify(findings), JSON.stringify(capabilities), JSON.stringify(engines), metadata, contents, JSON.stringify(natives), JSON.stringify(hosts), JSON.stringify(links), c.file_id),
    finish('done'),
  ]);
  const status = await decideVersion(ctx, c.version_id);
  return json({ ok: true, status });
}

export function scannerRoutes(r: Router): void {
  r.post('/internal/scan/claim', claim);
  r.post('/internal/scan/known', known);
  r.post('/internal/scan/result', result);
}

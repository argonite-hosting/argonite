// Behaviour tests. After the static scan passes, the version's main file is run in real Minecraft on
// fresh GitHub-hosted Linux, Windows and macOS machines (a separate GitHub account, no secrets) with
// the network cut off and bait files planted. What it touched decides whether it needs a human look.
//
// Linux runs the game in a container and watches it from outside, so its results are trusted both
// ways. On Windows and macOS the game runs on the machine itself, so a mod could hide from the
// watchers there: those results only ever add reasons, and a missing or failed run is ignored.
import { SITE } from '../../../shared/config';
import type { Finding, SandboxSummary } from '../../../shared/types';
import type { Env } from '../env';
import { newId, randomToken, sha256Hex } from './crypto';
import { parseJson } from './db';
import { ghHeaders } from './github';
import { githubApi } from './runtime';

export type SandboxOs = 'linux' | 'windows' | 'macos';
export const SANDBOX_OSES: SandboxOs[] = ['linux', 'windows', 'macos'];
const TESTED_TYPES = new Set(['mod', 'plugin', 'modpack']);
export const MAX_RUN_ATTEMPTS = 2;
export const MAX_DISPATCHES = 4;

export interface RunRow {
  id: string;
  version_id: string;
  file_id: string;
  os: SandboxOs;
  status: 'queued' | 'claimed' | 'done' | 'failed';
  attempts: number;
  dispatches: number;
  nonce_hash: string | null;
  claim_hash: string | null;
  gh_run: string | null;
  outcome: 'tested' | 'unsupported' | 'error' | null;
  findings: string | null;
  summary: string | null;
  error: string | null;
}

export function sandboxEnabled(env: Env): boolean {
  return Boolean(env.SANDBOX_DISPATCH_TOKEN && SITE.sandbox?.repo && SITE.sandbox.systems?.length);
}

export function workflowFor(os: SandboxOs): string {
  return `${SITE.sandbox.repo}/.github/workflows/${os}.yml@refs/heads/main`;
}

export async function dispatchRun(env: Env, run: Pick<RunRow, 'id' | 'os'>): Promise<boolean> {
  if (!env.SANDBOX_DISPATCH_TOKEN) return false;
  const [owner, repo] = SITE.sandbox.repo.split('/');
  // A fresh one-time secret per dispatch: only the machine GitHub starts for it can claim the run, even
  // though run ids show up in the public workflow logs.
  const nonce = randomToken(24);
  await env.DB.prepare('UPDATE sandbox_runs SET dispatches = dispatches + 1, dispatched_at = ?, nonce_hash = ? WHERE id = ?').bind(Date.now(), await sha256Hex(nonce), run.id).run();
  try {
    const res = await fetch(`${githubApi()}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/dispatches`, {
      method: 'POST',
      headers: ghHeaders(env.SANDBOX_DISPATCH_TOKEN, { 'Content-Type': 'application/json' }),
      body: JSON.stringify({ event_type: `sandbox-${run.os}`, client_payload: { run: run.id, nonce } }),
    });
    return res.status === 204;
  } catch {
    return false;
  }
}

// ---- What the machines send back -------------------------------------------------------------

export interface SandboxReport {
  outcome: 'tested' | 'unsupported' | 'error';
  error: string | null;
  env: { gameVersion: string | null; loader: string | null; java: string | null; deps: { name: string; source: string; sha256: string }[] };
  server: { started: boolean; crashed: boolean; loaded: boolean | null };
  client: { started: boolean; joined: boolean; crashed: boolean; loaded: boolean | null };
  dns: string[];
  connections: { host: string | null; ip: string; port: number; proto: string; sni: string | null; http: string | null }[];
  processes: { exe: string; args: string }[];
  bait: { bait: string; path: string; op: string; exe: string | null }[];
  leaks: { bait: string; where: string }[];
  modified: string[];
  persistence: { where: string; detail: string }[];
  writtenOutside: string[];
  depHosts: string[];
  log: string;
}

const str = (v: unknown, max: number): string => (typeof v === 'string' ? v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').slice(0, max) : '');
const optStr = (v: unknown, max: number): string | null => (typeof v === 'string' && v ? str(v, max) : null);
const bool = (v: unknown): boolean => v === true;
const optBool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);
const rec = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
function list<T>(v: unknown, max: number, map: (x: unknown) => T | null): T[] {
  if (!Array.isArray(v)) return [];
  const out: T[] = [];
  for (const x of v.slice(0, max * 2)) {
    const m = map(x);
    if (m !== null) out.push(m);
    if (out.length >= max) break;
  }
  return out;
}
const HOST = /^[a-z0-9](?:[a-z0-9_-]{0,62}\.)*[a-z0-9_-]{1,63}\.?$/;
const host = (v: unknown): string | null => {
  const h = str(v, 253).toLowerCase().replace(/\.$/, '');
  return h && HOST.test(h) ? h : null;
};

export function cleanReport(raw: unknown): SandboxReport {
  const r = rec(raw);
  const env = rec(r.env);
  const server = rec(r.server);
  const client = rec(r.client);
  const outcome = r.outcome === 'tested' || r.outcome === 'unsupported' ? r.outcome : 'error';
  return {
    outcome,
    error: optStr(r.error, 500),
    env: {
      gameVersion: optStr(env.gameVersion, 40),
      loader: optStr(env.loader, 32),
      java: optStr(env.java, 20),
      deps: list(env.deps, 40, (d) => {
        const x = rec(d);
        return { name: str(x.name, 100), source: str(x.source, 20), sha256: /^[0-9a-f]{64}$/.test(str(x.sha256, 64)) ? str(x.sha256, 64) : '' };
      }),
    },
    server: { started: bool(server.started), crashed: bool(server.crashed), loaded: optBool(server.loaded) },
    client: { started: bool(client.started), joined: bool(client.joined), crashed: bool(client.crashed), loaded: optBool(client.loaded) },
    dns: list(r.dns, 300, host),
    connections: list(r.connections, 300, (c) => {
      const x = rec(c);
      const port = typeof x.port === 'number' && Number.isInteger(x.port) && x.port >= 0 && x.port < 65536 ? x.port : -1;
      const ip = str(x.ip, 45);
      if (port < 0 || !/^[0-9a-f.:]+$/i.test(ip)) return null;
      return { host: host(x.host), ip, port, proto: x.proto === 'udp' ? 'udp' : 'tcp', sni: host(x.sni), http: host(x.http) };
    }),
    processes: list(r.processes, 100, (p) => {
      const x = rec(p);
      const exe = str(x.exe, 300);
      return exe ? { exe, args: str(x.args, 300) } : null;
    }),
    bait: list(r.bait, 100, (b) => {
      const x = rec(b);
      const bait = str(x.bait, 40);
      return bait ? { bait, path: str(x.path, 300), op: ['read', 'write', 'delete'].includes(str(x.op, 10)) ? str(x.op, 10) : 'read', exe: optStr(x.exe, 300) } : null;
    }),
    leaks: list(r.leaks, 50, (l) => {
      const x = rec(l);
      const bait = str(x.bait, 40);
      return bait ? { bait, where: str(x.where, 300) } : null;
    }),
    modified: list(r.modified, 100, (p) => str(p, 300) || null),
    persistence: list(r.persistence, 50, (p) => {
      const x = rec(p);
      const where = str(x.where, 300);
      return where ? { where, detail: str(x.detail, 300) } : null;
    }),
    writtenOutside: list(r.writtenOutside, 100, (p) => str(p, 300) || null),
    depHosts: list(r.depHosts, 2000, host),
    log: str(r.log, 30_000),
  };
}

// ---- Judging -------------------------------------------------------------------------------

// Websites the game, the loaders and the test itself talk to on their own.
const EXPECTED_SITES = ['minecraft.net', 'mojang.com', 'minecraftservices.com', 'minecraft-services.net', 'fabricmc.net', 'quiltmc.org', 'neoforged.net', 'minecraftforge.net', 'papermc.io', 'bstats.org', 'localhost'];

const BAIT: Record<string, [string, 'critical' | 'high']> = {
  discord: ['Discord login data', 'critical'],
  browser: ['saved browser passwords and cookies', 'critical'],
  ssh: ['SSH keys', 'critical'],
  cloud: ['cloud service credentials', 'critical'],
  git: ['saved Git credentials', 'critical'],
  wallet: ['crypto wallet files', 'critical'],
  telegram: ['a Telegram session', 'critical'],
  session: ['the Minecraft session token', 'critical'],
  launcher: ['Minecraft launcher account files', 'high'],
};

// The registrable part of a host name, roughly: api.example.co.uk -> example.co.uk.
export function siteOf(h: string): string {
  const labels = h.toLowerCase().split('.').filter(Boolean);
  if (labels.length <= 2) return labels.join('.');
  const take = labels[labels.length - 1].length === 2 && labels[labels.length - 2].length <= 3 ? 3 : 2;
  return labels.slice(-take).join('.');
}

const OS_NAME: Record<SandboxOs, string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS' };
const fold = (s: string) => s.toLowerCase().replace(/\d+(?:[._-]\d+)*/g, '#');

// Turns the evidence into findings. `fileHosts` are the websites the static scan found in the file;
// a website the mod contacts that appears nowhere in it was built or hidden at runtime.
export function judge(os: SandboxOs, r: SandboxReport, fileHosts: string[]): Finding[] {
  const on = ` (${OS_NAME[os]} test)`;
  const out: Finding[] = [];
  const add = (rule: string, severity: Finding['severity'], detail: string, path?: string) => out.push({ rule, severity, detail: `${detail}${on}`, ...(path ? { path } : {}) });

  const seenLeak = new Set<string>();
  for (const l of r.leaks) {
    if (seenLeak.has(l.bait)) continue;
    seenLeak.add(l.bait);
    add('sandbox.exfiltration', 'critical', `Sent ${(BAIT[l.bait] ?? ['planted bait data'])[0]} over the network to ${l.where}`, l.bait);
  }
  const seenBait = new Set<string>();
  for (const b of r.bait) {
    const key = `${b.bait}|${b.op}`;
    if (seenBait.has(key)) continue;
    seenBait.add(key);
    const [what, severity] = BAIT[b.bait] ?? ['a planted bait file', 'critical'];
    const verb = b.op === 'read' ? 'Read' : b.op === 'delete' ? 'Deleted' : 'Changed';
    add('sandbox.bait', b.op === 'read' ? severity : 'critical', `${verb} ${what}: ${b.path}`, `${b.bait}|${b.op}`);
  }
  for (const p of r.modified.slice(0, 10)) add('sandbox.modified', 'critical', `Changed or deleted an existing file: ${p}`, fold(p));
  for (const p of r.persistence.slice(0, 10)) add('sandbox.persistence', 'critical', `Set itself up to run again later: ${p.where}${p.detail ? ` (${p.detail})` : ''}`, fold(p.where));

  const seenExe = new Set<string>();
  for (const p of r.processes) {
    const exe = p.exe.split(/[\\/]/).pop()!.toLowerCase();
    if (seenExe.has(exe)) continue;
    seenExe.add(exe);
    add('sandbox.process', 'high', `Started a program: ${p.exe}${p.args ? ` ${p.args}` : ''}`.slice(0, 400), exe);
  }

  const known = new Set([...fileHosts, ...r.depHosts].map(siteOf));
  const expected = (h: string) => EXPECTED_SITES.some((s) => h === s || h.endsWith(`.${s}`)) || known.has(siteOf(h));
  const names = new Set<string>(r.dns);
  for (const c of r.connections) for (const h of [c.host, c.sni, c.http]) if (h) names.add(h);
  const hidden = [...names].filter((h) => !expected(h)).sort();
  for (const h of hidden.slice(0, 15)) add('sandbox.hidden_host', 'high', `Contacted ${h}, which isn't written anywhere in the file`, siteOf(h));
  if (hidden.length > 15) add('sandbox.hidden_host', 'high', `Contacted ${hidden.length - 15} more websites that aren't written in the file`, 'more');
  const direct = r.connections.filter((c) => !c.host && !c.sni && !c.http);
  if (os === 'linux') {
    for (const c of direct.slice(0, 5)) add('sandbox.direct_ip', 'high', `Connected straight to an IP address: ${c.ip}:${c.port}/${c.proto}`, `${c.ip}:${c.port}`);
  } else if (direct.length) {
    add('sandbox.direct_ip', 'medium', `Connected to ${direct.length} address${direct.length === 1 ? '' : 'es'} with no known name, e.g. ${direct[0].ip}:${direct[0].port}`);
  }
  if (r.writtenOutside.length) {
    add('sandbox.outside', 'high', `Wrote files outside the game folder: ${r.writtenOutside.slice(0, 5).join(', ')}${r.writtenOutside.length > 5 ? ` and ${r.writtenOutside.length - 5} more` : ''}`, fold(r.writtenOutside[0]));
  }
  if (r.outcome === 'tested' && (r.server.crashed || r.client.crashed)) add('sandbox.crashed', 'info', `The game stopped with an error during the test`);
  if (r.outcome === 'tested' && r.server.loaded === false && r.client.loaded === false) add('sandbox.not_loaded', 'info', `The game started but didn't load this file`);
  return out;
}

export function summaryOf(os: SandboxOs, r: SandboxReport): SandboxSummary {
  return {
    os,
    outcome: r.outcome,
    note: r.outcome === 'tested' ? null : r.error,
    gameVersion: r.env.gameVersion,
    loader: r.env.loader,
    server: r.server.started,
    client: r.client.started,
    joined: r.client.joined,
    dependencies: r.env.deps.length,
    findings: [],
    finishedAt: null,
  };
}

// ---- Deciding --------------------------------------------------------------------------------

export type SandboxStage = { state: 'off' } | { state: 'pending' } | { state: 'done'; malicious: string | null; reasons: string[] };

function carryKey(os: string, f: Finding): string {
  return `${os}|${f.rule}|${f.path ?? ''}`;
}

// Called while deciding a version. Starts the tests the first time, waits while they run, and then
// turns their findings into a rejection, review reasons, or nothing.
export async function sandboxStage(env: Env, versionId: string, projectType: string, primaryFileId: string | null, previousVersionId: string | null): Promise<SandboxStage> {
  if (!sandboxEnabled(env) || !TESTED_TYPES.has(projectType) || !primaryFileId) return { state: 'off' };
  const rows = (await env.DB.prepare('SELECT * FROM sandbox_runs WHERE version_id = ? AND file_id = ?').bind(versionId, primaryFileId).all<RunRow>()).results;
  if (!rows.length) {
    const now = Date.now();
    const created = SITE.sandbox.systems.filter((os) => SANDBOX_OSES.includes(os)).map((os) => ({ id: newId(), os }));
    await env.DB.batch(
      created.map((r) =>
        env.DB.prepare("INSERT INTO sandbox_runs (id, version_id, file_id, os, status, created_at) VALUES (?, ?, ?, ?, 'queued', ?)").bind(r.id, versionId, primaryFileId, r.os, now),
      ),
    );
    for (const r of created) await dispatchRun(env, r);
    return { state: 'pending' };
  }
  if (rows.some((r) => r.status === 'queued' || r.status === 'claimed')) return { state: 'pending' };

  const accepted = new Set<string>();
  if (previousVersionId) {
    const prev = await env.DB.prepare("SELECT os, findings FROM sandbox_runs WHERE version_id = ? AND status = 'done'").bind(previousVersionId).all<{ os: string; findings: string | null }>();
    for (const p of prev.results) for (const f of parseJson<Finding[]>(p.findings, [])) if (f.severity === 'high') accepted.add(carryKey(p.os, f));
  }
  const reasons: string[] = [];
  for (const r of rows) {
    const findings = parseJson<Finding[]>(r.findings, []);
    const critical = findings.find((f) => f.severity === 'critical');
    if (critical) return { state: 'done', malicious: `The behaviour test caught it: ${critical.detail}`, reasons: [] };
    const fresh = findings.filter((f) => f.severity === 'high' && !accepted.has(carryKey(r.os, f)));
    if (fresh.length) reasons.push(`Behaviour test: ${fresh[0].detail}${fresh.length > 1 ? ` (and ${fresh.length - 1} more)` : ''}`);
    // Only the trusted Linux run is required; a failed run there means nobody has watched it run yet.
    if (r.os === 'linux' && (r.status === 'failed' || r.outcome === 'error')) reasons.push(`The Linux behaviour test couldn't finish${r.error ? `: ${r.error.slice(0, 120)}` : ''}`);
  }
  return { state: 'done', malicious: null, reasons };
}

export type SummaryRow = Pick<RunRow, 'os' | 'status' | 'outcome' | 'summary' | 'findings'> & { finished_at: number | null };

export function summariesOf(rows: SummaryRow[]): SandboxSummary[] {
  return rows
    .map((r) => {
      const base = parseJson<SandboxSummary | null>(r.summary, null);
      const os = r.os as SandboxOs;
      const outcome: SandboxSummary['outcome'] = r.status === 'queued' || r.status === 'claimed' ? 'running' : r.status === 'failed' ? 'error' : (r.outcome ?? 'error');
      return {
        os,
        outcome,
        note: base?.note ?? (r.status === 'failed' ? 'The test machine didn’t finish.' : null),
        gameVersion: base?.gameVersion ?? null,
        loader: base?.loader ?? null,
        server: base?.server ?? false,
        client: base?.client ?? false,
        joined: base?.joined ?? false,
        dependencies: base?.dependencies ?? 0,
        findings: parseJson<Finding[]>(r.findings, []),
        finishedAt: r.finished_at,
      };
    })
    .sort((a, b) => SANDBOX_OSES.indexOf(a.os) - SANDBOX_OSES.indexOf(b.os));
}

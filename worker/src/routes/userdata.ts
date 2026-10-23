// Collections and profile links. Public collections and profile links are stored as JSON in the site's
// public data repository on GitHub; unlisted and private collections never leave D1. D1 keeps the commit
// and hash of each stored file, and a file is only used if it still matches.
import { SITE } from '../../../shared/config';
import type { CollectionDetail, CollectionFile, CollectionSummary, ProfileFile, ProjectSummary } from '../../../shared/types';
import { cleanText, isId, validateHttpsUrl, validateUsername } from '../../../shared/validate';
import { appConfigured } from '../lib/app';
import { newId } from '../lib/crypto';
import { queueWrite, readFile, siteData } from '../lib/datastore';
import { PROJECT_SELECT, toSummary, type ProjectRow } from '../lib/db';
import { assertSameSite, rateLimit } from '../lib/guard';
import { HttpError, badRequest, clientIp, forbidden, json, notFound, readJson } from '../lib/http';
import { oneOf, str } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { currentUser, requireActiveUser, type SessionUser } from '../lib/session';
import type { Env } from '../env';

const MAX_COLLECTIONS = 50;
const MAX_ITEMS = 500;
const VISIBILITY = ['public', 'unlisted', 'private'] as const;

interface CollectionRow {
  id: string;
  owner_id: string;
  name: string;
  summary: string;
  visibility: Visibility;
  item_count: number;
  path: string | null;
  commit_sha: string | null;
  sha256: string | null;
  private_items: string | null;
  created_at: number;
  updated_at: number;
  username: string;
  avatar_url: string;
}

type Visibility = (typeof VISIBILITY)[number];

// Only public collections are written to the public data repository.
const onGitHub = (visibility: Visibility) => visibility === 'public';

function requireDataRepo(env: Env): void {
  if (!appConfigured(env)) throw new HttpError(503, 'unavailable', 'Collections and profile links are not set up on this server yet.');
}

const collectionPath = (row: Pick<CollectionRow, 'owner_id' | 'id'>) => `collections/${row.owner_id}/${row.id}.json`;
const profilePath = (userId: string) => `profiles/${userId}.json`;

function summary(r: CollectionRow): CollectionSummary {
  return {
    id: r.id,
    name: r.name,
    summary: r.summary,
    visibility: r.visibility,
    itemCount: r.item_count,
    owner: { id: r.owner_id, username: r.username, avatarUrl: r.avatar_url },
    updatedAt: r.updated_at,
  };
}

async function loadRow(env: Env, id: string): Promise<CollectionRow | null> {
  if (!isId(id)) return null;
  return env.DB.prepare('SELECT c.*, u.username, u.avatar_url FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.id = ? AND u.deleted_at IS NULL')
    .bind(id)
    .first<CollectionRow>();
}

async function itemsOf(env: Env, row: CollectionRow): Promise<string[]> {
  // Unlisted collections saved before they moved to D1 still read from GitHub until the cron moves them.
  if (!onGitHub(row.visibility) && (row.private_items !== null || !row.path)) {
    try {
      const list = JSON.parse(row.private_items ?? '[]') as unknown;
      return Array.isArray(list) ? list.filter((x): x is string => typeof x === 'string' && isId(x)) : [];
    } catch {
      return [];
    }
  }
  const text = await readFile(env, SITE.github.dataRepo, collectionPath(row), row.commit_sha, row.sha256);
  if (text === null) {
    if (row.item_count === 0) return [];
    throw new HttpError(503, 'data_unavailable', 'This collection could not be loaded from GitHub right now.');
  }
  const file = JSON.parse(text) as CollectionFile;
  if (file.v !== 1 || file.id !== row.id || file.owner !== row.owner_id || !Array.isArray(file.items)) {
    throw new HttpError(503, 'data_invalid', 'This collection failed its integrity check.');
  }
  return file.items.filter((x) => typeof x === 'string' && isId(x)).slice(0, MAX_ITEMS);
}

async function summaries(env: Env, ids: string[]): Promise<ProjectSummary[]> {
  if (!ids.length) return [];
  const rows = await env.DB.prepare(`${PROJECT_SELECT} WHERE p.id IN (SELECT value FROM json_each(?)) AND p.status = 'active'`)
    .bind(JSON.stringify(ids))
    .all<ProjectRow>();
  const byId = new Map(rows.results.map((r) => [r.id, toSummary(r)]));
  return ids.flatMap((id) => (byId.has(id) ? [byId.get(id)!] : []));
}

function canView(row: CollectionRow, user: SessionUser | null): boolean {
  return row.visibility !== 'private' || row.owner_id === user?.id;
}

async function getCollection(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const user = await currentUser(ctx);
  const row = await loadRow(ctx.env, ctx.params.id);
  if (!row || !canView(row, user)) throw notFound('Collection not found.');
  const items = await itemsOf(ctx.env, row);
  const detail: CollectionDetail = {
    ...summary(row),
    source: onGitHub(row.visibility) && row.commit_sha && row.sha256 ? { url: `https://github.com/${SITE.github.dataRepo}/blob/${row.commit_sha}/${collectionPath(row)}`, sha256: row.sha256 } : null,
    items,
    projects: await summaries(ctx.env, items),
  };
  return json(detail);
}

async function userCollections(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const name = ctx.params.username;
  if (!validateUsername(name)) throw notFound('User not found.');
  const viewer = await currentUser(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT c.*, u.username, u.avatar_url FROM collections c JOIN users u ON u.id = c.owner_id
     WHERE u.username_lower = ? AND u.deleted_at IS NULL AND (c.visibility = 'public' OR c.owner_id = ?) ORDER BY c.updated_at DESC LIMIT 100`,
  )
    .bind(name.toLowerCase(), viewer?.id ?? '')
    .all<CollectionRow>();
  return json({ collections: rows.results.map(summary) });
}

async function myCollections(ctx: Ctx): Promise<Response> {
  const user = await requireActiveUser(ctx);
  const rows = await ctx.env.DB.prepare('SELECT c.*, u.username, u.avatar_url FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.owner_id = ? ORDER BY c.updated_at DESC')
    .bind(user.id)
    .all<CollectionRow>();
  const projectId = ctx.url.searchParams.get('project');
  const contains: Record<string, boolean> = {};
  if (projectId && isId(projectId)) {
    for (const r of rows.results.slice(0, 25)) {
      try {
        contains[r.id] = (await itemsOf(ctx.env, r)).includes(projectId);
      } catch {
        contains[r.id] = false;
      }
    }
  }
  return json({ collections: rows.results.map(summary), contains });
}

function cleanName(raw: unknown): string {
  const name = cleanText(typeof raw === 'string' ? raw : '');
  if (name.length < 2 || name.length > 64) throw badRequest('Name must be 2-64 characters.', { name: 'Invalid name.' });
  return name;
}

// Writes the collection's items where they belong for its visibility and updates the index row.
async function store(env: Env, row: Pick<CollectionRow, 'id' | 'owner_id' | 'name' | 'summary' | 'visibility' | 'path'>, items: string[]): Promise<D1PreparedStatement[]> {
  const path = collectionPath(row);
  if (!onGitHub(row.visibility)) {
    if (row.path) await queueWrite(env, siteData(), path, 'collection', row.id, null, { purge: true });
    return [env.DB.prepare('UPDATE collections SET private_items = ?, item_count = ?, path = NULL, commit_sha = NULL, sha256 = NULL WHERE id = ?').bind(JSON.stringify(items), items.length, row.id)];
  }
  const file: CollectionFile = { v: 1, id: row.id, owner: row.owner_id, name: row.name, summary: row.summary, items };
  await queueWrite(env, siteData(), path, 'collection', row.id, JSON.stringify(file));
  return [env.DB.prepare('UPDATE collections SET private_items = NULL, item_count = ?, path = ? WHERE id = ?').bind(items.length, path, row.id)];
}

async function create(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request);
  const name = cleanName(body.name);
  const summaryText = cleanText(str(body, 'summary', { max: 300 }) ?? '').slice(0, 200);
  const visibility = oneOf(body, 'visibility', VISIBILITY) ?? 'private';
  if (onGitHub(visibility)) requireDataRepo(ctx.env);
  const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM collections WHERE owner_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_COLLECTIONS) throw badRequest(`You can have up to ${MAX_COLLECTIONS} collections.`);
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.prepare('INSERT INTO collections (id, owner_id, name, summary, visibility, private_items, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, user.id, name, summaryText, visibility, onGitHub(visibility) ? null : '[]', now, now)
    .run();
  if (onGitHub(visibility)) await ctx.env.DB.batch(await store(ctx.env, { id, owner_id: user.id, name, summary: summaryText, visibility, path: null }, []));
  return json({ id }, 201);
}

async function ownRow(ctx: Ctx, user: SessionUser): Promise<CollectionRow> {
  const row = await loadRow(ctx.env, ctx.params.id);
  if (!row) throw notFound('Collection not found.');
  if (row.owner_id !== user.id) throw forbidden('That collection belongs to someone else.');
  return row;
}

async function update(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const row = await ownRow(ctx, user);
  const body = await readJson(ctx.request, 64_000);
  const next = { ...row };
  if (body.name !== undefined) next.name = cleanName(body.name);
  if (body.summary !== undefined) next.summary = cleanText(str(body, 'summary', { max: 300 }) ?? '').slice(0, 200);
  const visibility = oneOf(body, 'visibility', VISIBILITY);
  if (visibility) next.visibility = visibility;
  if (onGitHub(next.visibility)) requireDataRepo(ctx.env);

  let items = await itemsOf(ctx.env, row);
  if (Array.isArray(body.items)) {
    items = [...new Set(body.items.filter((x): x is string => typeof x === 'string' && isId(x)))].slice(0, MAX_ITEMS);
  }
  if (typeof body.add === 'string' && isId(body.add) && !items.includes(body.add)) {
    if (items.length >= MAX_ITEMS) throw badRequest(`Collections hold up to ${MAX_ITEMS} projects.`);
    const exists = await ctx.env.DB.prepare("SELECT 1 FROM projects WHERE id = ? AND status = 'active'").bind(body.add).first();
    if (!exists) throw notFound('Project not found.');
    items = [body.add, ...items];
  }
  if (typeof body.remove === 'string') items = items.filter((x) => x !== body.remove);

  const stmts = [
    ctx.env.DB.prepare('UPDATE collections SET name = ?, summary = ?, visibility = ?, updated_at = ? WHERE id = ?').bind(next.name, next.summary, next.visibility, Date.now(), row.id),
    ...(await store(ctx.env, next, items)),
  ];
  await ctx.env.DB.batch(stmts);
  return json({ ok: true, itemCount: items.length });
}

async function remove(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const row = await ownRow(ctx, user);
  if (row.path) await queueWrite(ctx.env, siteData(), row.path, 'collection', row.id, null, { purge: true });
  await ctx.env.DB.prepare('DELETE FROM collections WHERE id = ?').bind(row.id).run();
  return json({ ok: true });
}

// Moves unlisted collections that were stored on GitHub into D1 and purges them from the repository.
export async function moveUnlistedOffGitHub(env: Env, max = 20): Promise<void> {
  const rows = await env.DB.prepare(
    "SELECT c.*, u.username, u.avatar_url FROM collections c JOIN users u ON u.id = c.owner_id WHERE c.visibility = 'unlisted' AND c.path IS NOT NULL LIMIT ?",
  )
    .bind(max)
    .all<CollectionRow>();
  for (const row of rows.results) {
    let items: string[];
    try {
      items = await itemsOf(env, { ...row, private_items: null });
    } catch {
      continue;
    }
    await env.DB.batch(await store(env, row, items));
  }
}

// --- Profile links --------------------------------------------------------------------------------

export async function profileLinks(env: Env, row: { id: string; profile_commit: string | null; profile_path: string | null; profile_sha256: string | null }): Promise<ProfileFile['links']> {
  try {
    const text = await readFile(env, SITE.github.dataRepo, row.profile_path ?? profilePath(row.id), row.profile_commit, row.profile_sha256);
    if (!text) return [];
    const file = JSON.parse(text) as ProfileFile;
    if (file.v !== 1 || file.user !== row.id || !Array.isArray(file.links)) return [];
    return file.links.filter((l) => typeof l?.label === 'string' && typeof l?.url === 'string' && !validateHttpsUrl(l.url)).slice(0, 6);
  } catch {
    return [];
  }
}

async function updateProfile(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  requireDataRepo(ctx.env);
  const body = await readJson(ctx.request, 16_000);
  if (!Array.isArray(body.links) || body.links.length > 6) throw badRequest('Add up to 6 links.');
  const links = body.links.map((l, i) => {
    const rec = (l ?? {}) as Record<string, unknown>;
    const label = cleanText(typeof rec.label === 'string' ? rec.label : '').slice(0, 32);
    const url = typeof rec.url === 'string' ? rec.url.trim() : '';
    if (!label) throw badRequest('Each link needs a label.', { [`links.${i}`]: 'Label required.' });
    const err = validateHttpsUrl(url);
    if (err || !url) throw badRequest(err ?? 'Each link needs a URL.', { [`links.${i}`]: err ?? 'URL required.' });
    return { label, url };
  });
  const file: ProfileFile = { v: 1, user: user.id, links };
  await queueWrite(ctx.env, siteData(), profilePath(user.id), 'profile', user.id, links.length ? JSON.stringify(file) : null, { purge: true });
  if (!links.length) await ctx.env.DB.prepare('UPDATE users SET profile_commit = NULL, profile_path = NULL, profile_sha256 = NULL WHERE id = ?').bind(user.id).run();
  return json({ ok: true });
}

export function userDataRoutes(r: Router): void {
  r.get('/v1/collections/:id', getCollection);
  r.get('/api/collections/:id', getCollection);
  r.get('/v1/users/:username/collections', userCollections);
  r.get('/api/me/collections', myCollections);
  r.post('/api/collections', create);
  r.patch('/api/collections/:id', update);
  r.delete('/api/collections/:id', remove);
  r.put('/api/me/profile', updateProfile);
}

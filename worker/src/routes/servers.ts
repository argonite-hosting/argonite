// Minecraft server listings with a live status check.
import { SERVER_REGIONS, SERVER_TAGS } from '../../../shared/taxonomy';
import type { ServerListing } from '../../../shared/types';
import { cleanMultiline, cleanText, isId, validateHttpsUrl, validateName, validateSlug, validateSummary } from '../../../shared/validate';
import { newId } from '../lib/crypto';
import { PROJECT_SELECT, orgAvatar, toSummary, type ProjectRow } from '../lib/db';
import { assertSameSite, audit, isStaff, rateLimit } from '../lib/guard';
import { HttpError, badRequest, clientIp, conflict, forbidden, json, notFound, readJson } from '../lib/http';
import { check, int, oneOf, optionalStr, pageParams, str, strArray } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { assertSafeLinks } from '../lib/linkcheck';
import { pingJava, validHost } from '../lib/serverping';
import { requireActiveUser, requireModerator } from '../lib/session';
import type { Env } from '../env';

const MAX_SERVERS_PER_USER = 5;
const PING_EVERY_MS = 10 * 60 * 1000;

interface ServerRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  description: string;
  owner_id: string;
  org_id: string | null;
  host: string;
  port: number;
  edition: 'java' | 'bedrock';
  region: string;
  modpack_id: string | null;
  website_url: string | null;
  discord_url: string | null;
  tags: string;
  status: 'active' | 'delisted' | 'removed';
  favicon: string | null;
  online: number;
  players_online: number | null;
  players_max: number | null;
  game_version: string | null;
  motd: string | null;
  pings: number;
  pings_ok: number;
  last_ping_at: number | null;
  created_at: number;
  updated_at: number;
  username: string;
  avatar_url: string;
  org_slug: string | null;
  org_name: string | null;
  org_login: string | null;
}

const SELECT = `SELECT s.*, u.username, u.avatar_url, o.slug AS org_slug, o.name AS org_name, o.github_login AS org_login
FROM servers s JOIN users u ON u.id = s.owner_id LEFT JOIN organizations o ON o.id = s.org_id AND o.deleted_at IS NULL`;

// Hostnames only point at public servers; literal private or reserved addresses are refused outright.

async function toListing(env: Env, r: ServerRow, modpack?: ProjectRow | null): Promise<ServerListing> {
  let pack = modpack;
  if (pack === undefined && r.modpack_id) {
    pack = await env.DB.prepare(`${PROJECT_SELECT} WHERE p.id = ? AND p.status = 'active'`).bind(r.modpack_id).first<ProjectRow>();
  }
  return {
    id: r.id,
    slug: r.slug,
    name: r.name,
    summary: r.summary,
    description: r.description,
    address: r.port === (r.edition === 'bedrock' ? 19132 : 25565) ? r.host : `${r.host}:${r.port}`,
    edition: r.edition,
    region: r.region,
    tags: JSON.parse(r.tags) as string[],
    favicon: r.favicon,
    online: r.online === 1,
    playersOnline: r.players_online,
    playersMax: r.players_max,
    gameVersion: r.game_version,
    motd: r.motd,
    uptime: r.pings >= 3 ? Math.round((r.pings_ok / r.pings) * 1000) / 10 : null,
    lastPingAt: r.last_ping_at,
    modpack: pack ? toSummary(pack) : null,
    links: { website: r.website_url, discord: r.discord_url },
    owner: { id: r.owner_id, username: r.username, avatarUrl: r.avatar_url },
    org: r.org_id && r.org_slug && r.org_name ? { id: r.org_id, slug: r.org_slug, name: r.org_name, avatarUrl: orgAvatar(r.org_login) } : null,
    status: r.status,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

async function list(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const p = ctx.url.searchParams;
  const where = ["s.status = 'active'"];
  const binds: unknown[] = [];
  const q = cleanText(p.get('q') ?? '').slice(0, 60).toLowerCase();
  if (q) {
    where.push("(lower(s.name) LIKE ? ESCAPE '\\' OR lower(s.summary) LIKE ? ESCAPE '\\')");
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    binds.push(like, like);
  }
  const region = p.get('region');
  if (region && SERVER_REGIONS.some((r) => r.id === region)) {
    where.push('s.region = ?');
    binds.push(region);
  }
  const edition = p.get('edition');
  if (edition === 'java' || edition === 'bedrock') {
    where.push('s.edition = ?');
    binds.push(edition);
  }
  const tag = p.get('tag');
  if (tag && SERVER_TAGS.some((t) => t.id === tag)) {
    where.push('EXISTS (SELECT 1 FROM json_each(s.tags) WHERE value = ?)');
    binds.push(tag);
  }
  if (p.get('online') === '1') where.push('s.online = 1');
  const order = p.get('sort') === 'newest' ? 's.created_at DESC' : 's.online DESC, s.players_online DESC, s.created_at DESC';
  const { page, size, offset } = pageParams(ctx.url, 50, 20);
  const whereSql = where.join(' AND ');
  const [rows, count] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`${SELECT} WHERE ${whereSql} ORDER BY ${order} LIMIT ? OFFSET ?`).bind(...binds, size, offset),
    ctx.env.DB.prepare(`SELECT COUNT(*) AS n FROM servers s WHERE ${whereSql}`).bind(...binds),
  ]);
  const servers = await Promise.all((rows.results as ServerRow[]).map((r) => toListing(ctx.env, { ...r, description: '' }, null)));
  return json({ servers, total: (count.results[0] as { n: number }).n, page, pageSize: size });
}

async function byKey(env: Env, key: string): Promise<ServerRow | null> {
  const k = key.toLowerCase();
  return env.DB.prepare(`${SELECT} WHERE s.${isId(k) ? 'id' : 'slug'} = ?`).bind(k).first<ServerRow>();
}

async function view(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const r = await byKey(ctx.env, ctx.params.slug);
  if (!r || r.status === 'removed') throw notFound('Server not found.');
  return json(await toListing(ctx.env, r));
}

interface ServerInput {
  name: string;
  slug: string;
  summary: string;
  description: string;
  host: string;
  port: number;
  edition: 'java' | 'bedrock';
  region: string;
  tags: string[];
  modpackId: string | null;
  websiteUrl: string | null;
  discordUrl: string | null;
}

async function parseInput(env: Env, body: Record<string, unknown>, partial: boolean): Promise<Partial<ServerInput>> {
  const out: Partial<ServerInput> = {};
  const name = str(body, 'name', { required: !partial, max: 200 });
  if (name !== undefined) {
    check(validateName(name), 'name');
    out.name = cleanText(name);
  }
  const slug = str(body, 'slug', { required: !partial, max: 64 });
  if (slug !== undefined) {
    out.slug = slug.trim().toLowerCase();
    check(validateSlug(out.slug), 'slug');
  }
  const summary = str(body, 'summary', { required: !partial, max: 400 });
  if (summary !== undefined) {
    check(validateSummary(summary), 'summary');
    out.summary = cleanText(summary);
  }
  const description = str(body, 'description', { max: 10_000 });
  if (description !== undefined) {
    await assertSafeLinks(env, 'description', description);
    out.description = cleanMultiline(description);
  }
  const host = str(body, 'host', { required: !partial, max: 253 });
  if (host !== undefined) {
    check(validHost(host), 'host');
    out.host = host.trim().toLowerCase().replace(/\.$/, '');
    await assertSafeLinks(env, 'host', `https://${out.host}`);
  }
  out.edition = oneOf(body, 'edition', ['java', 'bedrock'] as const, !partial);
  const port = int(body, 'port', { min: 1, max: 65535 });
  if (port !== undefined) {
    if (port < 1024 && port !== 25565 && port !== 19132) throw badRequest('Use a port from 1024 to 65535.', { port: 'Invalid port.' });
    out.port = port;
  } else if (!partial) {
    out.port = out.edition === 'bedrock' ? 19132 : 25565;
  }
  const region = oneOf(body, 'region', SERVER_REGIONS.map((r) => r.id));
  if (region) out.region = region;
  const tags = strArray(body, 'tags', { max: 5, itemMax: 32 });
  if (tags) {
    if (tags.some((t) => !SERVER_TAGS.some((x) => x.id === t))) throw badRequest('Unknown tag.', { tags: 'Invalid tag.' });
    out.tags = tags;
  }
  if (body.modpackId !== undefined) {
    const id = body.modpackId === null ? null : str(body, 'modpackId', { max: 26 })!;
    if (id) {
      const pack = isId(id) ? await env.DB.prepare("SELECT 1 FROM projects WHERE id = ? AND type = 'modpack' AND status = 'active'").bind(id).first() : null;
      if (!pack) throw badRequest('Pick a published modpack.', { modpackId: 'Unknown modpack.' });
    }
    out.modpackId = id;
  }
  for (const [key, field] of [
    ['websiteUrl', 'websiteUrl'],
    ['discordUrl', 'discordUrl'],
  ] as const) {
    const v = optionalStr(body, key, 400);
    if (v === undefined) continue;
    if (v) {
      check(validateHttpsUrl(v), key);
      await assertSafeLinks(env, key, v);
    }
    out[field] = v;
  }
  return out;
}

async function create(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request, 32_000);
  const input = (await parseInput(ctx.env, body, false)) as ServerInput;
  const counts = await ctx.env.DB.prepare(
    "SELECT (SELECT COUNT(*) FROM servers WHERE owner_id = ?1 AND status != 'removed') AS mine, (SELECT COUNT(*) FROM servers WHERE slug = ?2) AS taken",
  )
    .bind(user.id, input.slug)
    .first<{ mine: number; taken: number }>();
  if (counts!.taken) throw conflict('That URL is already taken.');
  if (counts!.mine >= MAX_SERVERS_PER_USER) throw forbidden(`You can list up to ${MAX_SERVERS_PER_USER} servers.`);
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `INSERT INTO servers (id, slug, name, summary, description, owner_id, host, port, edition, region, tags, modpack_id, website_url, discord_url, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      input.slug,
      input.name,
      input.summary,
      input.description ?? '',
      user.id,
      input.host,
      input.port,
      input.edition,
      input.region ?? 'global',
      JSON.stringify(input.tags ?? []),
      input.modpackId ?? null,
      input.websiteUrl ?? null,
      input.discordUrl ?? null,
      now,
      now,
    ),
    audit(ctx.env, user.id, 'server.create', 'server', id, { host: input.host }),
  ]);
  ctx.exec.waitUntil(pingOne(ctx.env, id).catch(() => undefined));
  return json({ id, slug: input.slug }, 201);
}

async function owned(ctx: Ctx) {
  const user = await requireActiveUser(ctx);
  const r = await byKey(ctx.env, ctx.params.slug);
  if (!r || r.status === 'removed') throw notFound('Server not found.');
  if (r.owner_id !== user.id && !isStaff(user)) {
    const orgOk = r.org_id
      ? await ctx.env.DB.prepare("SELECT 1 FROM org_members WHERE org_id = ? AND user_id = ? AND accepted = 1 AND role = 'owner'").bind(r.org_id, user.id).first()
      : null;
    if (!orgOk) throw forbidden('That server listing belongs to someone else.');
  }
  return { user, r };
}

async function update(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const { user, r } = await owned(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request, 32_000);
  const input = await parseInput(ctx.env, body, true);
  const cols: [keyof ServerInput, string][] = [
    ['name', 'name'],
    ['summary', 'summary'],
    ['description', 'description'],
    ['host', 'host'],
    ['port', 'port'],
    ['edition', 'edition'],
    ['region', 'region'],
    ['modpackId', 'modpack_id'],
    ['websiteUrl', 'website_url'],
    ['discordUrl', 'discord_url'],
  ];
  const sets: string[] = [];
  const binds: unknown[] = [];
  for (const [key, col] of cols) {
    if (input[key] === undefined) continue;
    sets.push(`${col} = ?`);
    binds.push(input[key]);
  }
  if (input.tags) {
    sets.push('tags = ?');
    binds.push(JSON.stringify(input.tags));
  }
  if (input.slug && input.slug !== r.slug) {
    const taken = await ctx.env.DB.prepare('SELECT 1 FROM servers WHERE slug = ?').bind(input.slug).first();
    if (taken) throw conflict('That URL is already taken.');
    sets.push('slug = ?');
    binds.push(input.slug);
  }
  if (!sets.length) return json({ ok: true });
  sets.push('updated_at = ?');
  binds.push(Date.now());
  await ctx.env.DB.prepare(`UPDATE servers SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, r.id).run();
  if (input.host || input.port) ctx.exec.waitUntil(pingOne(ctx.env, r.id).catch(() => undefined));
  return json({ ok: true });
}

async function remove(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const { user, r } = await owned(ctx);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare("UPDATE servers SET status = 'removed', updated_at = ? WHERE id = ?").bind(Date.now(), r.id),
    audit(ctx.env, user.id, 'server.delete', 'server', r.id),
  ]);
  return json({ ok: true });
}

async function refresh(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const { user, r } = await owned(ctx);
  await rateLimit(ctx.env.RL_UPLOAD, `ping:${user.id}`);
  if (r.last_ping_at && Date.now() - r.last_ping_at < 60_000) throw new HttpError(429, 'rate_limited', 'Checked less than a minute ago.');
  await pingOne(ctx.env, r.id);
  const fresh = await byKey(ctx.env, r.id);
  return json(await toListing(ctx.env, fresh!));
}

async function moderate(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const mod = await requireModerator(ctx);
  const body = await readJson(ctx.request);
  const status = oneOf(body, 'status', ['active', 'delisted', 'removed'] as const, true)!;
  const reason = cleanText(str(body, 'reason', { max: 500 }) ?? '');
  const r = await byKey(ctx.env, ctx.params.slug);
  if (!r) throw notFound('Server not found.');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE servers SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?').bind(status, reason || null, Date.now(), r.id),
    audit(ctx.env, mod.id, `server.${status}`, 'server', r.id, { reason }),
  ]);
  return json({ ok: true });
}

async function mine(ctx: Ctx): Promise<Response> {
  const user = await requireActiveUser(ctx);
  const rows = await ctx.env.DB.prepare(`${SELECT} WHERE s.owner_id = ? AND s.status != 'removed' ORDER BY s.created_at DESC`).bind(user.id).all<ServerRow>();
  return json({ servers: await Promise.all(rows.results.map((r) => toListing(ctx.env, r, null))) });
}

export async function pingOne(env: Env, id: string): Promise<void> {
  const r = await env.DB.prepare('SELECT id, host, port, edition FROM servers WHERE id = ?').bind(id).first<{ id: string; host: string; port: number; edition: string }>();
  if (!r) return;
  // Workers can only open TCP sockets, so Bedrock (UDP) servers are listed without a live status.
  const result = r.edition === 'java' ? await pingJava(r.host, r.port) : null;
  const now = Date.now();
  if (!result) {
    await env.DB.prepare('UPDATE servers SET last_ping_at = ? WHERE id = ?').bind(now, r.id).run();
    return;
  }
  await env.DB.prepare(
    `UPDATE servers SET online = ?, players_online = ?, players_max = ?, game_version = COALESCE(?, game_version), motd = COALESCE(?, motd),
       favicon = COALESCE(?, favicon), pings = pings + 1, pings_ok = pings_ok + ?, last_ping_at = ?, last_online_at = CASE WHEN ? THEN ? ELSE last_online_at END
     WHERE id = ?`,
  )
    .bind(
      result.online ? 1 : 0,
      result.playersOnline,
      result.playersMax,
      result.version,
      result.motd,
      result.favicon,
      result.online ? 1 : 0,
      now,
      result.online ? 1 : 0,
      now,
      r.id,
    )
    .run();
}

export async function pingDue(env: Env, max = 25): Promise<void> {
  const due = await env.DB.prepare("SELECT id FROM servers WHERE status = 'active' AND (last_ping_at IS NULL OR last_ping_at < ?) ORDER BY last_ping_at LIMIT ?")
    .bind(Date.now() - PING_EVERY_MS, max)
    .all<{ id: string }>();
  for (const s of due.results) await pingOne(env, s.id).catch(() => undefined);
}

export function serverRoutes(r: Router): void {
  r.get('/v1/servers', list);
  r.get('/v1/servers/:slug', view);
  r.get('/api/me/servers', mine);
  r.post('/api/servers', create);
  r.patch('/api/servers/:slug', update);
  r.delete('/api/servers/:slug', remove);
  r.post('/api/servers/:slug/ping', refresh);
  r.post('/api/mod/servers/:slug/status', moderate);
}


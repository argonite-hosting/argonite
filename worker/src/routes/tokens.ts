// Personal access tokens for CI. The token is shown once; only its SHA-256 is stored.
import { SCOPE_ALL } from '../../../shared/permissions';
import type { ApiTokenInfo } from '../../../shared/types';
import { cleanText, isId } from '../../../shared/validate';
import { requireActor } from '../lib/auth';
import { newId, randomToken, sha256Hex } from '../lib/crypto';
import { audit, rateLimit } from '../lib/guard';
import { badRequest, json, notFound, readJson } from '../lib/http';
import { int } from '../lib/input';
import type { Ctx, Router } from '../lib/router';

const MAX_TOKENS = 20;

async function list(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx);
  const rows = await ctx.env.DB.prepare('SELECT id, name, prefix, scopes, created_at, last_used_at, expires_at FROM api_tokens WHERE user_id = ? ORDER BY created_at DESC')
    .bind(user.id)
    .all<{ id: string; name: string; prefix: string; scopes: number; created_at: number; last_used_at: number | null; expires_at: number | null }>();
  const tokens: ApiTokenInfo[] = rows.results.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.created_at,
    lastUsedAt: r.last_used_at,
    expiresAt: r.expires_at,
  }));
  return json({ tokens });
}

async function create(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request);
  const name = cleanText(typeof body.name === 'string' ? body.name : '').slice(0, 64);
  if (name.length < 2) throw badRequest('Give the token a name you will recognise.', { name: 'Required.' });
  const scopes = int(body, 'scopes', { min: 1, max: SCOPE_ALL, required: true })!;
  const days = int(body, 'expiresInDays', { min: 1, max: 366 });
  const count = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE user_id = ?').bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= MAX_TOKENS) throw badRequest(`You can have up to ${MAX_TOKENS} tokens. Delete one you no longer use.`);
  const token = `arg_${randomToken(32)}`;
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, scopes, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      user.id,
      name,
      await sha256Hex(token),
      token.slice(0, 10),
      scopes & SCOPE_ALL,
      now,
      days ? now + days * 86_400_000 : null,
    ),
    audit(ctx.env, user.id, 'token.create', 'user', user.id, { token: id, scopes }),
  ]);
  return json({ id, token }, 201);
}

async function remove(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx);
  if (!isId(ctx.params.id)) throw notFound('Token not found.');
  const res = await ctx.env.DB.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').bind(ctx.params.id, user.id).run();
  if (!res.meta.changes) throw notFound('Token not found.');
  await audit(ctx.env, user.id, 'token.delete', 'user', user.id, { token: ctx.params.id }).run();
  return json({ ok: true });
}

export function tokenRoutes(r: Router): void {
  r.get('/api/me/tokens', list);
  r.post('/api/me/tokens', create);
  r.delete('/api/me/tokens/:id', remove);
}

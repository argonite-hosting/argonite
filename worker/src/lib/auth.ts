// Who is making a write request: a signed-in browser (cookie + same-site checks) or a personal
// access token sent as "Authorization: Bearer arg_...". Tokens never ride on cookies, so they can't be
// used for cross-site requests, and each one only unlocks the scopes it was created with.
import { SCOPE_ALL, has } from '../../../shared/permissions';
import { sha256Hex } from './crypto';
import { assertSameSite } from './guard';
import { forbidden, unauthorized } from './http';
import type { Ctx } from './router';
import { requireActiveUser, userFromRow, type SessionUser, type UserRow } from './session';

export const TOKEN_PATTERN = /^arg_[A-Za-z0-9_-]{43}$/;
const TOUCH_MS = 3600 * 1000;

export interface Actor {
  user: SessionUser;
  via: 'session' | 'token';
  scopes: number;
}

const cache = new WeakMap<Request, Promise<Actor>>();

export function bearer(request: Request): string | null {
  const auth = request.headers.get('Authorization');
  if (!auth) return null;
  const m = /^Bearer\s+(\S+)$/.exec(auth);
  return m ? m[1] : '';
}

async function fromToken(ctx: Ctx, token: string): Promise<Actor> {
  if (!TOKEN_PATTERN.test(token)) throw unauthorized('Invalid API token.');
  const row = await ctx.env.DB.prepare(
    `SELECT t.id AS t_id, t.scopes AS t_scopes, t.expires_at AS t_expires, t.last_used_at AS t_used, u.* FROM api_tokens t
     JOIN users u ON u.id = t.user_id WHERE t.token_hash = ? AND u.deleted_at IS NULL`,
  )
    .bind(await sha256Hex(token))
    .first<UserRow & { t_id: string; t_scopes: number; t_expires: number | null; t_used: number | null }>();
  if (!row) throw unauthorized('Invalid API token.');
  const now = Date.now();
  if (row.t_expires && row.t_expires < now) throw unauthorized('This API token has expired.');
  const user = userFromRow(row, ctx.env);
  if (user.banned) throw forbidden('Your account is suspended.');
  if (!row.t_used || now - row.t_used > TOUCH_MS) {
    ctx.exec.waitUntil(ctx.env.DB.prepare('UPDATE api_tokens SET last_used_at = ? WHERE id = ?').bind(now, row.t_id).run());
  }
  return { user, via: 'token', scopes: row.t_scopes };
}

// scope: the token scope this endpoint needs. Endpoints that pass no scope are browser-only.
export function requireActor(ctx: Ctx, scope?: number): Promise<Actor> {
  let pending = cache.get(ctx.request);
  if (!pending) {
    const token = bearer(ctx.request);
    pending =
      token !== null
        ? fromToken(ctx, token)
        : (async () => {
            assertSameSite(ctx);
            return { user: await requireActiveUser(ctx), via: 'session' as const, scopes: SCOPE_ALL };
          })();
    cache.set(ctx.request, pending);
  }
  return pending.then((actor) => {
    if (actor.via === 'token') {
      if (scope === undefined) throw forbidden('This action needs a signed-in browser session.');
      if (!has(actor.scopes, scope)) throw forbidden('This API token does not have the scope for that.');
    }
    return actor;
  });
}

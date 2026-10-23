// A private thread between a project's team and the moderators, for review questions and takedown
// notices. Moderators can also leave internal notes the team never sees.
import type { ModMessage } from '../../../shared/types';
import { cleanMultiline } from '../../../shared/validate';
import { newId } from '../lib/crypto';
import { assertSameSite, audit, isStaff, projectAccess, rateLimit } from '../lib/guard';
import { badRequest, json, notFound, readJson } from '../lib/http';
import type { Ctx, Router } from '../lib/router';
import { requireActiveUser, requireUser } from '../lib/session';

async function access(ctx: Ctx, write: boolean) {
  const user = write ? await requireActiveUser(ctx) : await requireUser(ctx);
  const project = await projectAccess(ctx.env, ctx.params.id, user);
  const staff = isStaff(user);
  if (!project.role && !staff) throw notFound('Project not found.');
  return { user, project, staff };
}

async function list(ctx: Ctx): Promise<Response> {
  const { project, staff } = await access(ctx, false);
  const rows = await ctx.env.DB.prepare(
    `SELECT m.id, m.body, m.internal, m.created_at, u.id AS uid, u.username, u.avatar_url, u.role FROM mod_messages m JOIN users u ON u.id = m.author_id
     WHERE m.project_id = ? AND (m.internal = 0 OR ?) ORDER BY m.created_at LIMIT 300`,
  )
    .bind(project.id, staff ? 1 : 0)
    .all<{ id: string; body: string; internal: number; created_at: number; uid: string; username: string; avatar_url: string; role: string }>();
  const messages: ModMessage[] = rows.results.map((r) => ({
    id: r.id,
    author: { id: r.uid, username: r.username, avatarUrl: r.avatar_url },
    staff: r.role === 'moderator' || r.role === 'admin',
    body: r.body,
    internal: r.internal === 1,
    createdAt: r.created_at,
  }));
  return json({ messages });
}

async function post(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const { user, project, staff } = await access(ctx, true);
  await rateLimit(ctx.env.RL_WRITE, `msg:${user.id}`);
  const body = await readJson(ctx.request, 16_000);
  const text = cleanMultiline(typeof body.body === 'string' ? body.body : '');
  if (!text) throw badRequest('Write a message.', { body: 'Required.' });
  if (text.length > 4000) throw badRequest('Messages can be at most 4000 characters.', { body: 'Too long.' });
  const internal = staff && body.internal === true;
  const id = newId();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO mod_messages (id, project_id, author_id, body, internal, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(id, project.id, user.id, text, internal ? 1 : 0, Date.now()),
    ...(staff ? [audit(ctx.env, user.id, internal ? 'project.note' : 'project.message', 'project', project.id)] : []),
  ]);
  return json({ id }, 201);
}

export function messageRoutes(r: Router): void {
  r.get('/api/projects/:id/messages', list);
  r.post('/api/projects/:id/messages', post);
}

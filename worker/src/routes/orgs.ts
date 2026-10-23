// Organisations: shared ownership of projects. Members get project permissions from their
// organisation row for every project the organisation owns, plus organisation-level permissions.
import { ORG_PERM, ORG_PERM_ALL, PERM_ALL, PERM_DEFAULT_MEMBER, has } from '../../../shared/permissions';
import type { Organization } from '../../../shared/types';
import { cleanText, isId, validateName, validateSlug, validateUsername } from '../../../shared/validate';
import { newId } from '../lib/crypto';
import { PROJECT_SELECT, orgAvatar, toSummary, type ProjectRow } from '../lib/db';
import { gh, userToken } from '../lib/github';
import { assertSameSite, audit, rateLimit } from '../lib/guard';
import { badRequest, clientIp, conflict, forbidden, json, notFound, readJson } from '../lib/http';
import { check, int, str } from '../lib/input';
import type { Ctx, Router } from '../lib/router';
import { requireActiveUser, type SessionUser } from '../lib/session';
import type { Env } from '../env';

const MAX_ORGS_PER_USER = 10;
const MAX_MEMBERS = 50;

interface OrgRow {
  id: string;
  slug: string;
  name: string;
  summary: string;
  github_login: string | null;
  owner_id: string;
  created_at: number;
}

async function orgBy(env: Env, key: string): Promise<OrgRow | null> {
  const k = key.toLowerCase();
  return env.DB.prepare(`SELECT id, slug, name, summary, github_login, owner_id, created_at FROM organizations WHERE ${isId(k) ? 'id' : 'slug'} = ? AND deleted_at IS NULL`)
    .bind(k)
    .first<OrgRow>();
}

async function orgAccess(env: Env, key: string, user: SessionUser): Promise<{ org: OrgRow; role: 'owner' | 'member' | null; orgPerms: number; projectPerms: number }> {
  const org = await orgBy(env, key);
  if (!org) throw notFound('Organisation not found.');
  const m = await env.DB.prepare('SELECT role, permissions, org_permissions FROM org_members WHERE org_id = ? AND user_id = ? AND accepted = 1')
    .bind(org.id, user.id)
    .first<{ role: 'owner' | 'member'; permissions: number; org_permissions: number }>();
  const role = m?.role ?? null;
  return {
    org,
    role,
    orgPerms: role === 'owner' ? ORG_PERM_ALL : (m?.org_permissions ?? 0),
    projectPerms: role === 'owner' ? PERM_ALL : (m?.permissions ?? 0),
  };
}

async function requireOrgPerm(env: Env, key: string, user: SessionUser, flag: number) {
  const a = await orgAccess(env, key, user);
  if (!a.role) throw forbidden('You are not a member of this organisation.');
  if (!has(a.orgPerms, flag)) throw forbidden('Your role in this organisation does not allow that.');
  return a;
}

async function view(ctx: Ctx): Promise<Response> {
  await rateLimit(ctx.env.RL_READ, `r:${clientIp(ctx.request)}`);
  const org = await orgBy(ctx.env, ctx.params.slug);
  if (!org) throw notFound('Organisation not found.');
  const [members, projects] = await ctx.env.DB.batch([
    ctx.env.DB.prepare(
      `SELECT om.role, om.accepted, om.permissions, om.org_permissions, u.id, u.username, u.avatar_url FROM org_members om JOIN users u ON u.id = om.user_id
       WHERE om.org_id = ? AND om.accepted = 1 AND u.deleted_at IS NULL ORDER BY om.role = 'owner' DESC, om.created_at`,
    ).bind(org.id),
    ctx.env.DB.prepare(`${PROJECT_SELECT} WHERE p.org_id = ? AND p.status = 'active' ORDER BY p.downloads DESC LIMIT 200`).bind(org.id),
  ]);
  const body: Organization = {
    id: org.id,
    slug: org.slug,
    name: org.name,
    summary: org.summary,
    avatarUrl: orgAvatar(org.github_login),
    githubLogin: org.github_login,
    createdAt: org.created_at,
    members: (members.results as { role: 'owner' | 'member'; accepted: number; permissions: number; org_permissions: number; id: string; username: string; avatar_url: string }[]).map((m) => ({
      user: { id: m.id, username: m.username, avatarUrl: m.avatar_url },
      role: m.role,
      accepted: m.accepted === 1,
      permissions: m.permissions,
      orgPermissions: m.org_permissions,
    })),
    projects: (projects.results as ProjectRow[]).map(toSummary),
  };
  return json(body);
}

// Linking a GitHub organisation (for its avatar and a verified look) needs you to be an admin there.
async function verifyGithubOrg(env: Env, user: SessionUser, login: string): Promise<void> {
  if (!validateUsername(login)) throw badRequest('Enter a GitHub organisation name.', { githubLogin: 'Invalid name.' });
  try {
    const m = await gh<{ state: string; role: string }>(await userToken(env, user.id), 'GET', `/user/memberships/orgs/${encodeURIComponent(login)}`);
    if (m.state !== 'active' || m.role !== 'admin') throw new Error('not admin');
  } catch {
    throw forbidden(`Couldn't confirm you're an admin of ${login} on GitHub.`);
  }
}

async function create(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const body = await readJson(ctx.request);
  const name = cleanText(str(body, 'name', { required: true, max: 200 })!);
  const slug = str(body, 'slug', { required: true, max: 64 })!.trim().toLowerCase();
  const summary = cleanText(str(body, 'summary', { max: 400 }) ?? '').slice(0, 200);
  check(validateName(name), 'name');
  check(validateSlug(slug), 'slug');
  const githubLogin = (str(body, 'githubLogin', { max: 39 }) ?? '').trim() || null;
  if (githubLogin) await verifyGithubOrg(ctx.env, user, githubLogin);
  const counts = await ctx.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM organizations WHERE owner_id = ?1 AND deleted_at IS NULL) AS mine, (SELECT COUNT(*) FROM organizations WHERE slug = ?2) AS taken`,
  )
    .bind(user.id, slug)
    .first<{ mine: number; taken: number }>();
  if (counts!.taken) throw conflict('That URL is already taken.');
  if (counts!.mine >= MAX_ORGS_PER_USER) throw forbidden(`You can own up to ${MAX_ORGS_PER_USER} organisations.`);
  const id = newId();
  const now = Date.now();
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('INSERT INTO organizations (id, slug, name, summary, github_login, owner_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      slug,
      name,
      summary,
      githubLogin,
      user.id,
      now,
      now,
    ),
    ctx.env.DB.prepare("INSERT INTO org_members (org_id, user_id, role, permissions, org_permissions, accepted, created_at) VALUES (?, ?, 'owner', ?, ?, 1, ?)").bind(
      id,
      user.id,
      PERM_ALL,
      ORG_PERM_ALL,
      now,
    ),
    audit(ctx.env, user.id, 'org.create', 'organization', id, { slug }),
  ]);
  return json({ id, slug }, 201);
}

async function update(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const { org } = await requireOrgPerm(ctx.env, ctx.params.slug, user, ORG_PERM.EDIT_DETAILS);
  const body = await readJson(ctx.request);
  const name = body.name !== undefined ? cleanText(str(body, 'name', { max: 200 })!) : org.name;
  check(validateName(name), 'name');
  const summary = body.summary !== undefined ? cleanText(str(body, 'summary', { max: 400 }) ?? '').slice(0, 200) : org.summary;
  let githubLogin = org.github_login;
  if (body.githubLogin !== undefined) {
    githubLogin = (str(body, 'githubLogin', { max: 39 }) ?? '').trim() || null;
    if (githubLogin && githubLogin !== org.github_login) await verifyGithubOrg(ctx.env, user, githubLogin);
  }
  await ctx.env.DB.prepare('UPDATE organizations SET name = ?, summary = ?, github_login = ?, updated_at = ? WHERE id = ?').bind(name, summary, githubLogin, Date.now(), org.id).run();
  return json({ ok: true });
}

async function remove(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const { org } = await requireOrgPerm(ctx.env, ctx.params.slug, user, ORG_PERM.DELETE_ORG);
  const body = await readJson(ctx.request);
  if (str(body, 'confirm', { required: true, max: 64 }) !== org.slug) throw badRequest('Type the organisation URL to confirm.', { confirm: 'Does not match.' });
  // Projects go back to their individual owners.
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE projects SET org_id = NULL WHERE org_id = ?').bind(org.id),
    ctx.env.DB.prepare('DELETE FROM org_members WHERE org_id = ?').bind(org.id),
    ctx.env.DB.prepare('UPDATE organizations SET deleted_at = ?, slug = ? WHERE id = ?').bind(Date.now(), `deleted-${org.id}`, org.id),
    audit(ctx.env, user.id, 'org.delete', 'organization', org.id),
  ]);
  return json({ ok: true });
}

async function invite(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  await rateLimit(ctx.env.RL_WRITE, `u:${user.id}`);
  const { org, orgPerms, projectPerms } = await requireOrgPerm(ctx.env, ctx.params.slug, user, ORG_PERM.MANAGE_INVITES);
  const body = await readJson(ctx.request);
  const username = str(body, 'username', { required: true, max: 39 })!.trim();
  if (!validateUsername(username)) throw badRequest('Enter a GitHub username.', { username: 'Invalid username.' });
  const permissions = (int(body, 'permissions', { min: 0, max: PERM_ALL }) ?? PERM_DEFAULT_MEMBER) & projectPerms;
  const orgPermissions = (int(body, 'orgPermissions', { min: 0, max: ORG_PERM_ALL }) ?? 0) & orgPerms;
  const target = await ctx.env.DB.prepare('SELECT id, banned FROM users WHERE username_lower = ? AND deleted_at IS NULL').bind(username.toLowerCase()).first<{ id: string; banned: number }>();
  if (!target) throw notFound(`${username} has not signed in yet.`);
  if (target.banned) throw forbidden('That account is suspended.');
  const n = await ctx.env.DB.prepare('SELECT COUNT(*) AS n FROM org_members WHERE org_id = ?').bind(org.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_MEMBERS) throw badRequest(`Organisations can have up to ${MAX_MEMBERS} members.`);
  const res = await ctx.env.DB.prepare(
    "INSERT OR IGNORE INTO org_members (org_id, user_id, role, permissions, org_permissions, accepted, invited_by, created_at) VALUES (?, ?, 'member', ?, ?, 0, ?, ?)",
  )
    .bind(org.id, target.id, permissions, orgPermissions, user.id, Date.now())
    .run();
  if (!res.meta.changes) throw conflict('That user is already a member or has a pending invite.');
  await audit(ctx.env, user.id, 'org.member.invite', 'organization', org.id, { user: target.id }).run();
  return json({ ok: true }, 201);
}

async function answer(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const org = await orgBy(ctx.env, ctx.params.slug);
  if (!org) throw notFound('Organisation not found.');
  const body = await readJson(ctx.request);
  const accept = body.accept === true;
  const res = await (accept
    ? ctx.env.DB.prepare('UPDATE org_members SET accepted = 1 WHERE org_id = ? AND user_id = ? AND accepted = 0')
    : ctx.env.DB.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ? AND accepted = 0')
  )
    .bind(org.id, user.id)
    .run();
  if (!res.meta.changes) throw notFound('Invite not found.');
  return json({ ok: true });
}

async function editMember(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const { org, orgPerms, projectPerms } = await requireOrgPerm(ctx.env, ctx.params.slug, user, ORG_PERM.EDIT_MEMBER);
  if (ctx.params.userId === org.owner_id) throw badRequest('The owner always has every permission.');
  const body = await readJson(ctx.request);
  const current = await ctx.env.DB.prepare('SELECT permissions, org_permissions FROM org_members WHERE org_id = ? AND user_id = ?')
    .bind(org.id, ctx.params.userId)
    .first<{ permissions: number; org_permissions: number }>();
  if (!current) throw notFound('Member not found.');
  const wantedProject = int(body, 'permissions', { min: 0, max: PERM_ALL }) ?? current.permissions;
  const permissions = (current.permissions & ~projectPerms) | (wantedProject & projectPerms);
  const wantedOrg = int(body, 'orgPermissions', { min: 0, max: ORG_PERM_ALL }) ?? current.org_permissions;
  const orgPermissions = (current.org_permissions & ~orgPerms) | (wantedOrg & orgPerms);
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE org_members SET permissions = ?, org_permissions = ? WHERE org_id = ? AND user_id = ?').bind(permissions, orgPermissions, org.id, ctx.params.userId),
    audit(ctx.env, user.id, 'org.member.permissions', 'organization', org.id, { user: ctx.params.userId }),
  ]);
  return json({ ok: true });
}

async function removeMember(ctx: Ctx): Promise<Response> {
  assertSameSite(ctx);
  const user = await requireActiveUser(ctx);
  const self = ctx.params.userId === user.id;
  const { org, orgPerms, role } = await orgAccess(ctx.env, ctx.params.slug, user);
  if (!self && (!role || !has(orgPerms, ORG_PERM.REMOVE_MEMBER))) throw forbidden('Your role in this organisation does not allow removing members.');
  if (ctx.params.userId === org.owner_id) throw badRequest('The owner cannot leave or be removed. Delete the organisation instead.');
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('DELETE FROM org_members WHERE org_id = ? AND user_id = ?').bind(org.id, ctx.params.userId),
    audit(ctx.env, user.id, self ? 'org.member.leave' : 'org.member.remove', 'organization', org.id, { user: ctx.params.userId }),
  ]);
  return json({ ok: true });
}

async function mine(ctx: Ctx): Promise<Response> {
  const user = await requireActiveUser(ctx);
  const rows = await ctx.env.DB.prepare(
    `SELECT o.id, o.slug, o.name, o.github_login, om.role, om.accepted, om.org_permissions FROM org_members om JOIN organizations o ON o.id = om.org_id
     WHERE om.user_id = ? AND o.deleted_at IS NULL ORDER BY o.name`,
  )
    .bind(user.id)
    .all<{ id: string; slug: string; name: string; github_login: string | null; role: string; accepted: number; org_permissions: number }>();
  return json({
    organizations: rows.results.map((r) => ({
      id: r.id,
      slug: r.slug,
      name: r.name,
      avatarUrl: orgAvatar(r.github_login),
      role: r.role,
      accepted: r.accepted === 1,
      orgPermissions: r.role === 'owner' ? ORG_PERM_ALL : r.org_permissions,
    })),
  });
}

export function orgRoutes(r: Router): void {
  r.get('/v1/organizations/:slug', view);
  r.get('/api/me/organizations', mine);
  r.post('/api/organizations', create);
  r.patch('/api/organizations/:slug', update);
  r.delete('/api/organizations/:slug', remove);
  r.post('/api/organizations/:slug/members', invite);
  r.post('/api/organizations/:slug/invite', answer);
  r.patch('/api/organizations/:slug/members/:userId', editMember);
  r.delete('/api/organizations/:slug/members/:userId', removeMember);
}

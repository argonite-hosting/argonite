// Project analytics. Views and downloads are counted once per visitor per day (the visitor is a salted,
// daily-rotating hash of the IP, never the IP itself) and rolled straight into daily totals, so the
// tables grow by one row per project per day rather than one per event.
import { PERM } from '../../../shared/permissions';
import type { ProjectStats } from '../../../shared/types';
import { isId } from '../../../shared/validate';
import { requireActor } from '../lib/auth';
import { sha256Hex } from '../lib/crypto';
import { rateLimit, requirePerm } from '../lib/guard';
import { badRequest, clientIp, json, notFound } from '../lib/http';
import type { Ctx, Router } from '../lib/router';
import type { Env } from '../env';

const BOT = /bot|crawl|spider|slurp|headless|preview|fetch|monitor|curl|wget|python|java\/|go-http/i;

export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

export async function visitorId(env: Env, ip: string, day: string): Promise<string> {
  return (await sha256Hex(`${env.VISITOR_SALT}:${day}:${ip}`)).slice(0, 32);
}

function country(request: Request): string {
  const c = (request as Request & { cf?: { country?: string } }).cf?.country;
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'T1' ? c : 'XX';
}

export function downloadStatStatements(env: Env, request: Request, projectId: string, versionId: string): D1PreparedStatement[] {
  const day = today();
  return [
    env.DB.prepare(
      'INSERT INTO project_stats_daily (project_id, day, downloads) VALUES (?, ?, 1) ON CONFLICT(project_id, day) DO UPDATE SET downloads = downloads + 1',
    ).bind(projectId, day),
    env.DB.prepare(
      'INSERT INTO version_stats_daily (version_id, day, downloads) VALUES (?, ?, 1) ON CONFLICT(version_id, day) DO UPDATE SET downloads = downloads + 1',
    ).bind(versionId, day),
    env.DB.prepare(
      'INSERT INTO project_stats_country (project_id, month, country, downloads) VALUES (?, ?, ?, 1) ON CONFLICT(project_id, month, country) DO UPDATE SET downloads = downloads + 1',
    ).bind(projectId, day.slice(0, 7), country(request)),
  ];
}

async function view(ctx: Ctx): Promise<Response> {
  const ip = clientIp(ctx.request);
  await rateLimit(ctx.env.RL_READ, `view:${ip}`);
  if (!isId(ctx.params.id)) throw notFound('Project not found.');
  if (BOT.test(ctx.request.headers.get('User-Agent') ?? '')) return json({ ok: true });
  const p = await ctx.env.DB.prepare("SELECT id FROM projects WHERE id = ? AND status IN ('active', 'delisted')").bind(ctx.params.id).first<{ id: string }>();
  if (!p) throw notFound('Project not found.');
  const day = today();
  const fresh = await ctx.env.DB.prepare('INSERT OR IGNORE INTO view_marks (day, visitor, project_id) VALUES (?, ?, ?)').bind(day, await visitorId(ctx.env, ip, day), p.id).run();
  if (fresh.meta.changes) {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE projects SET views = views + 1 WHERE id = ?').bind(p.id),
      ctx.env.DB.prepare('INSERT INTO project_stats_daily (project_id, day, views) VALUES (?, ?, 1) ON CONFLICT(project_id, day) DO UPDATE SET views = views + 1').bind(p.id, day),
      ctx.env.DB.prepare(
        'INSERT INTO project_stats_country (project_id, month, country, views) VALUES (?, ?, ?, 1) ON CONFLICT(project_id, month, country) DO UPDATE SET views = views + 1',
      ).bind(p.id, day.slice(0, 7), country(ctx.request)),
    ]);
  }
  return json({ ok: true });
}

async function stats(ctx: Ctx): Promise<Response> {
  const { user } = await requireActor(ctx);
  const access = await requirePerm(ctx.env, ctx.params.id, user, PERM.VIEW_ANALYTICS);
  const days = Number(ctx.url.searchParams.get('days') ?? '30');
  if (![7, 30, 90, 365].includes(days)) throw badRequest('Pick 7, 30, 90 or 365 days.');
  const from = new Date(Date.now() - (days - 1) * 86_400_000).toISOString().slice(0, 10);
  const [daily, versions, countries] = await ctx.env.DB.batch([
    ctx.env.DB.prepare('SELECT day, views, downloads FROM project_stats_daily WHERE project_id = ? AND day >= ? ORDER BY day').bind(access.id, from),
    ctx.env.DB.prepare(
      `SELECT v.id, v.version_number, SUM(s.downloads) AS downloads FROM version_stats_daily s JOIN versions v ON v.id = s.version_id
       WHERE v.project_id = ? AND s.day >= ? GROUP BY v.id ORDER BY downloads DESC LIMIT 20`,
    ).bind(access.id, from),
    ctx.env.DB.prepare(
      `SELECT country, SUM(views) AS views, SUM(downloads) AS downloads FROM project_stats_country
       WHERE project_id = ? AND month >= ? GROUP BY country ORDER BY downloads DESC, views DESC LIMIT 20`,
    ).bind(access.id, from.slice(0, 7)),
  ]);
  const byDay = new Map((daily.results as { day: string; views: number; downloads: number }[]).map((r) => [r.day, r]));
  const series: ProjectStats['days'] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10);
    const r = byDay.get(day);
    series.push({ day, views: r?.views ?? 0, downloads: r?.downloads ?? 0 });
  }
  const body: ProjectStats = {
    days: series,
    versions: (versions.results as { id: string; version_number: string; downloads: number }[]).map((v) => ({ id: v.id, versionNumber: v.version_number, downloads: v.downloads })),
    countries: countries.results as ProjectStats['countries'],
    totals: series.reduce((t, d) => ({ views: t.views + d.views, downloads: t.downloads + d.downloads }), { views: 0, downloads: 0 }),
  };
  return json(body);
}

export function statsRoutes(r: Router): void {
  r.post('/v1/projects/:id/view', view);
  r.get('/api/projects/:id/stats', stats);
}

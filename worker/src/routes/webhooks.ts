import { onReleaseEvent } from '../lib/autopublish';
import { hmacHex, safeEqual } from '../lib/crypto';
import type { GitHubRelease } from '../lib/github';
import { recomputeProject } from '../lib/db';
import { audit } from '../lib/guard';
import { HttpError, json, readTextLimited } from '../lib/http';
import type { Ctx, Router } from '../lib/router';

interface Payload {
  action?: string;
  sender?: { id: number };
  installation?: { id: number; account?: { id: number } };
  repository?: { id: number; full_name: string; private: boolean; owner: { id: number } };
  release?: GitHubRelease;
  changes?: { tag_name?: { from: string }; owner?: { from: { user?: { id: number }; organization?: { id: number } } } };
}

async function github(ctx: Ctx): Promise<Response> {
  const text = await readTextLimited(ctx.request, 2_097_152);
  const sig = ctx.request.headers.get('X-Hub-Signature-256') ?? '';
  if (!ctx.env.GITHUB_WEBHOOK_SECRET || !safeEqual(sig, `sha256=${await hmacHex(ctx.env.GITHUB_WEBHOOK_SECRET, text)}`)) {
    throw new HttpError(401, 'unauthorized', 'Bad signature.');
  }
  const delivery = ctx.request.headers.get('X-GitHub-Delivery') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(delivery)) throw new HttpError(400, 'bad_request', 'Missing delivery id.');
  const fresh = await ctx.env.DB.prepare('INSERT OR IGNORE INTO webhook_deliveries (id, received_at) VALUES (?, ?)').bind(delivery, Date.now()).run();
  if (!fresh.meta.changes) return json({ ok: true, duplicate: true });

  const event = ctx.request.headers.get('X-GitHub-Event') ?? '';
  let p: Payload;
  try {
    p = JSON.parse(text) as Payload;
  } catch {
    throw new HttpError(400, 'bad_request', 'Malformed payload.');
  }
  const db = ctx.env.DB;

  switch (event) {
    case 'installation': {
      const accountId = p.installation?.account?.id;
      if (!accountId) break;
      if (p.action === 'created' || p.action === 'unsuspend') {
        await db.prepare('UPDATE users SET installation_id = ? WHERE github_id = ?').bind(p.installation!.id, accountId).run();
      } else if (p.action === 'deleted' || p.action === 'suspend') {
        await db.prepare('UPDATE users SET installation_id = NULL WHERE github_id = ? AND installation_id = ?').bind(accountId, p.installation!.id).run();
      }
      break;
    }
    case 'github_app_authorization': {
      if (p.action === 'revoked' && p.sender?.id) {
        const user = await db.prepare('SELECT id FROM users WHERE github_id = ?').bind(p.sender.id).first<{ id: string }>();
        if (user) {
          await db.batch([
            db.prepare('DELETE FROM github_tokens WHERE user_id = ?').bind(user.id),
            db.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
          ]);
        }
      }
      break;
    }
    case 'repository': {
      const repo = p.repository;
      if (!repo) break;
      const projects = await db.prepare("SELECT id FROM projects WHERE repo_id = ? AND status != 'removed'").bind(repo.id).all<{ id: string }>();
      if (!projects.results.length) break;
      const stmts: D1PreparedStatement[] = [];
      const update = (status: string) => db.prepare('UPDATE projects SET repo_full_name = ?, repo_status = ? WHERE repo_id = ?').bind(repo.full_name, status, repo.id);
      switch (p.action) {
        case 'renamed':
          stmts.push(db.prepare('UPDATE projects SET repo_full_name = ? WHERE repo_id = ?').bind(repo.full_name, repo.id));
          break;
        case 'transferred':
          // The new owner controls the files now. Downloads stay blocked until a moderator or the original owner sorts it out.
          stmts.push(update('transferred'));
          break;
        case 'deleted':
          stmts.push(update('deleted'));
          break;
        case 'privatized':
          stmts.push(update('private'));
          break;
        case 'publicized':
          stmts.push(db.prepare("UPDATE projects SET repo_full_name = ?, repo_status = 'ok' WHERE repo_id = ? AND repo_status = 'private'").bind(repo.full_name, repo.id));
          break;
        default:
          break;
      }
      if (stmts.length) {
        for (const proj of projects.results) stmts.push(audit(ctx.env, null, `repo.${p.action}`, 'project', proj.id, { repo: repo.full_name }));
        await db.batch(stmts);
      }
      break;
    }
    case 'release': {
      const release = p.release;
      if (!release) break;
      if (p.repository && ['published', 'created', 'edited'].includes(p.action ?? '')) {
        // GitHub gives webhooks ten seconds; the import runs after we answer.
        ctx.exec.waitUntil(onReleaseEvent(ctx.env, p.action!, p.repository.id, release).catch((e) => console.error(JSON.stringify({ webhook: 'release', error: String(e) }))));
      }
      const affected = await db.prepare("SELECT id, project_id FROM versions WHERE release_id = ? AND status NOT IN ('deleted', 'uploading')")
        .bind(release.id)
        .all<{ id: string; project_id: string }>();
      if (!affected.results.length) break;
      const stmts: D1PreparedStatement[] = [];
      if (p.action === 'deleted' || p.action === 'unpublished') {
        for (const v of affected.results) {
          stmts.push(
            db.prepare("UPDATE versions SET status = 'unavailable', status_reason = ? WHERE id = ? AND status IN ('live', 'review', 'scanning')").bind(
              p.action === 'deleted' ? 'The GitHub release was deleted.' : 'The GitHub release was unpublished.',
              v.id,
            ),
            audit(ctx.env, null, `release.${p.action}`, 'version', v.id),
            ...recomputeProject(ctx.env, v.project_id),
          );
        }
      } else if (p.action === 'edited' && p.changes?.tag_name) {
        for (const v of affected.results) {
          stmts.push(
            db.prepare('UPDATE versions SET tag = ? WHERE id = ?').bind(release.tag_name, v.id),
            audit(ctx.env, null, 'release.retagged', 'version', v.id, { from: p.changes.tag_name.from, to: release.tag_name }),
          );
        }
      }
      if (stmts.length) await db.batch(stmts);
      break;
    }
    default:
      break;
  }
  return json({ ok: true });
}

export function webhookRoutes(r: Router): void {
  r.post('/webhooks/github', github);
}

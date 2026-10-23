import { SITE } from '../../shared/config';
import type { Env } from './env';
import { HttpError, applyCors, errorResponse, json, notFound, preflight, withBaseHeaders } from './lib/http';
import { Router } from './lib/router';
import { authRoutes } from './routes/auth';
import { commentRoutes } from './routes/comments';
import { messageRoutes } from './routes/messages';
import { notificationRoutes } from './routes/notifications';
import { orgRoutes } from './routes/orgs';
import { serverRoutes } from './routes/servers';
import { statsRoutes } from './routes/stats';
import { tokenRoutes } from './routes/tokens';
import { userDataRoutes } from './routes/userdata';
import { runCron } from './routes/cron';
import { meRoutes } from './routes/me';
import { moderationRoutes } from './routes/moderation';
import { projectRoutes } from './routes/projects';
import { publicRoutes } from './routes/public';
import { sandboxRoutes } from './routes/sandbox';
import { scannerRoutes } from './routes/scanner';
import { versionRoutes } from './routes/versions';
import { webhookRoutes } from './routes/webhooks';

const router = new Router();
router.get('/', () => json({ name: `${SITE.name} API`, docs: `${SITE.url}/api-docs` }));
router.get('/robots.txt', () => new Response('User-agent: *\nDisallow: /\n', { headers: { 'Content-Type': 'text/plain' } }));
authRoutes(router);
meRoutes(router);
projectRoutes(router);
versionRoutes(router);
moderationRoutes(router);
publicRoutes(router);
scannerRoutes(router);
sandboxRoutes(router);
webhookRoutes(router);
commentRoutes(router);
messageRoutes(router);
notificationRoutes(router);
orgRoutes(router);
serverRoutes(router);
statsRoutes(router);
tokenRoutes(router);
userDataRoutes(router);

function corsMode(path: string): 'site' | 'public' | 'none' {
  if (path.startsWith('/v1/')) return 'public';
  if (path.startsWith('/api/') || path === '/auth/logout') return 'site';
  return 'none';
}

export default {
  async fetch(request: Request, env: Env, exec: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    const mode = corsMode(url.pathname);
    if (request.method === 'OPTIONS') return mode === 'none' ? new Response(null, { status: 405 }) : preflight(request, mode);

    let response: Response;
    try {
      const match = router.match(request.method, url.pathname);
      if (!match) throw notFound();
      if (match === 'method') throw new HttpError(405, 'method_not_allowed', 'Method not allowed.');
      response = await match.handler({ request, env, exec, url, params: match.params });
    } catch (err) {
      if (err instanceof HttpError) {
        response = errorResponse(err);
      } else {
        console.error(JSON.stringify({ path: url.pathname, error: err instanceof Error ? err.message : String(err) }));
        response = errorResponse(new HttpError(500, 'internal', 'Something went wrong on our side. Try again in a moment.'));
      }
    }
    if (mode === 'none') {
      const headers = withBaseHeaders(new Headers(response.headers));
      return new Response(response.body, { status: response.status, headers });
    }
    return applyCors(request, response, mode);
  },

  async scheduled(controller: ScheduledController, env: Env, exec: ExecutionContext): Promise<void> {
    exec.waitUntil(runCron(controller.cron, env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

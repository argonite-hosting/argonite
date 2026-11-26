/**
 * Signing in to the Argonite Mod phone app. The app starts the normal GitHub sign-in in the phone's
 * browser with a PKCE challenge of its own. Instead of a cookie, the browser ends on a page that asks
 * the person to confirm, then hands the app a two-minute, single-use code. Only the app holding the
 * matching verifier can trade that code for a session, and only moderators and admins get one.
 */
import { SITE } from '../../../shared/config';

export const APP_CHALLENGE = /^[A-Za-z0-9_-]{43}$/;
export const APP_VERIFIER = /^[A-Za-z0-9._~-]{43,128}$/;
export const APP_CODE = /^[A-Za-z0-9_-]{43}$/;
export const APP_REDIRECT = 'argonitemod://signed-in';
export const APP_HANDOFF_TTL_MS = 2 * 60 * 1000;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

function page(title: string, body: string): Response {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="referrer" content="no-referrer"><title>${esc(title)}</title><style>
body{margin:0;min-height:100vh;display:grid;place-items:center;background:#0f1214;color:#e8eef0;font:16px/1.5 system-ui,sans-serif}
main{max-width:22rem;padding:2rem 1.5rem;text-align:center}h1{font-size:1.35rem;margin:0 0 .75rem}p{color:#a9b6bb;margin:0 0 1.25rem}
a.btn{display:block;padding:.9rem 1rem;border-radius:.75rem;background:#5ee0b0;color:#062018;font-weight:700;text-decoration:none}
small{display:block;margin-top:1.25rem;color:#7d8b90}</style></head><body><main>${body}</main></body></html>`;
  return new Response(html, {
    status: 200,
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
      'Referrer-Policy': 'no-referrer',
      'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

export function handoffPage(username: string, code: string): Response {
  return page(
    `Sign in to ${SITE.name} Mod`,
    `<h1>Continue as @${esc(username)}?</h1>
<p>This signs the ${esc(SITE.name)} Mod app on this phone in to your moderator account.</p>
<a class="btn" href="${APP_REDIRECT}?code=${esc(code)}">Open ${esc(SITE.name)} Mod</a>
<small>Only continue if you just started signing in from the app. The link works once and expires in two minutes.</small>`,
  );
}

export function refusalPage(message: string): Response {
  return page(`${SITE.name} Mod`, `<h1>Can’t sign in to the app</h1><p>${esc(message)}</p><small>You can close this tab.</small>`);
}

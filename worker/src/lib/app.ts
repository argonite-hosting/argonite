// GitHub App auth. The app signs a short JWT with its private key and trades it for an installation
// token, which acts as the app itself. Repository work (releases, images, comments) uses these, so it
// doesn't depend on whoever happens to be signed in.
import { SITE } from '../../../shared/config';
import type { Env } from '../env';
import { b64ToBytes, bytesToB64url, open, seal } from './crypto';
import { GitHubError, gh, ghHeaders, githubMessage, repoPath, type GitHubRepo } from './github';
import { HttpError } from './http';
import { githubApi, githubAppId } from './runtime';

const TOKEN_SKEW_MS = 5 * 60 * 1000;
let appKey: { pem: string; key: Promise<CryptoKey> } | null = null;

function derLength(n: number): number[] {
  if (n < 0x80) return [n];
  const bytes: number[] = [];
  while (n > 0) {
    bytes.unshift(n & 0xff);
    n >>= 8;
  }
  return [0x80 | bytes.length, ...bytes];
}

// GitHub hands out PKCS#1 keys and WebCrypto only imports PKCS#8, so wrap it in a PrivateKeyInfo.
export function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array<ArrayBuffer> {
  const rsaAlgorithm = [0x30, 0x0d, 0x06, 0x09, 0x2a, 0x86, 0x48, 0x86, 0xf7, 0x0d, 0x01, 0x01, 0x01, 0x05, 0x00];
  const inner = [0x02, 0x01, 0x00, ...rsaAlgorithm, 0x04, ...derLength(pkcs1.length)];
  const head = [0x30, ...derLength(inner.length + pkcs1.length), ...inner];
  const out = new Uint8Array(head.length + pkcs1.length);
  out.set(head, 0);
  out.set(pkcs1, head.length);
  return out;
}

function importAppKey(pem: string): Promise<CryptoKey> {
  const text = pem.replace(/\\n/g, '\n').trim();
  const der = b64ToBytes(text.replace(/-----[^-]+-----/g, '').replace(/\s+/g, ''));
  const pkcs8 = text.includes('BEGIN RSA PRIVATE KEY') ? pkcs1ToPkcs8(der) : der;
  return crypto.subtle.importKey('pkcs8', pkcs8, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
}

export function appConfigured(env: Env): boolean {
  return !!env.GITHUB_APP_PRIVATE_KEY && !!githubAppId();
}

async function appJwt(env: Env): Promise<string> {
  if (!appConfigured(env)) throw new HttpError(500, 'misconfigured', 'The GitHub App is not configured on the server yet.');
  if (!appKey || appKey.pem !== env.GITHUB_APP_PRIVATE_KEY) appKey = { pem: env.GITHUB_APP_PRIVATE_KEY!, key: importAppKey(env.GITHUB_APP_PRIVATE_KEY!) };
  const now = Math.floor(Date.now() / 1000);
  const enc = new TextEncoder();
  const part = (o: object) => bytesToB64url(enc.encode(JSON.stringify(o)));
  const unsigned = `${part({ alg: 'RS256', typ: 'JWT' })}.${part({ iat: now - 60, exp: now + 540, iss: String(githubAppId()) })}`;
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await appKey.key, enc.encode(unsigned));
  return `${unsigned}.${bytesToB64url(new Uint8Array(sig))}`;
}

export async function installationToken(env: Env, installationId: number): Promise<string> {
  const now = Date.now();
  const row = await env.DB.prepare('SELECT token, expires_at FROM app_tokens WHERE installation_id = ?').bind(installationId).first<{ token: string; expires_at: number }>();
  if (row && row.expires_at - TOKEN_SKEW_MS > now) {
    const token = await open(env.TOKEN_ENCRYPTION_KEY, row.token, `app-token:${installationId}`);
    if (token) return token;
  }
  const minted = await gh<{ token: string; expires_at: string }>(await appJwt(env), 'POST', `/app/installations/${installationId}/access_tokens`, {});
  const expires = Date.parse(minted.expires_at) || now + 50 * 60 * 1000;
  await env.DB.prepare(
    'INSERT INTO app_tokens (installation_id, token, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(installation_id) DO UPDATE SET token = ?2, expires_at = ?3',
  )
    .bind(installationId, await seal(env.TOKEN_ENCRYPTION_KEY, minted.token, `app-token:${installationId}`), expires)
    .run();
  return minted.token;
}

export async function forgetInstallation(env: Env, installationId: number): Promise<void> {
  await env.DB.prepare('DELETE FROM app_tokens WHERE installation_id = ?').bind(installationId).run();
}

export async function repoInstallationId(env: Env, fullName: string): Promise<number | null> {
  const [owner, name] = fullName.split('/');
  try {
    const inst = await gh<{ id: number }>(await appJwt(env), 'GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/installation`);
    return inst.id;
  } catch (e) {
    if (e instanceof GitHubError && e.ghStatus === 404) return null;
    throw e;
  }
}

export interface RepoAccess {
  token: string;
  repo: GitHubRepo;
  installationId: number;
}

export interface ProjectRepoRef {
  id: string;
  repo_id: number;
  repo_full_name: string;
  installation_id?: number | null;
}

const notInstalled = (fullName: string) =>
  new HttpError(409, 'app_not_installed', `The ${SITE.name} GitHub App isn't installed on ${fullName}. Install it on that repository and try again.`);

// An installation token for the project's repository and a freshly resolved copy of the repo.
// The repo is looked up by numeric id every time, so renames and transfers can't redirect us.
export async function projectRepo(env: Env, project: ProjectRepoRef, opts: { allowPrivate?: boolean } = {}): Promise<RepoAccess> {
  let installationId = project.installation_id ?? null;
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!installationId) {
      installationId = await repoInstallationId(env, project.repo_full_name);
      if (!installationId) throw notInstalled(project.repo_full_name);
      await env.DB.prepare('UPDATE projects SET installation_id = ? WHERE id = ?').bind(installationId, project.id).run();
    }
    let token: string;
    let repo: GitHubRepo;
    try {
      token = await installationToken(env, installationId);
      repo = await gh<GitHubRepo>(token, 'GET', `/repositories/${project.repo_id}`);
    } catch (e) {
      // The installation may have been removed or replaced; look it up again once.
      if (attempt === 0 && e instanceof GitHubError && [401, 403, 404].includes(e.ghStatus)) {
        await env.DB.prepare('UPDATE projects SET installation_id = NULL WHERE id = ?').bind(project.id).run();
        await forgetInstallation(env, installationId);
        installationId = null;
        continue;
      }
      if (e instanceof GitHubError && e.ghStatus === 404) throw notInstalled(project.repo_full_name);
      throw e;
    }
    if (repo.id !== project.repo_id) throw new HttpError(409, 'repo_changed', 'The linked repository changed. Relink it in project settings.');
    if (repo.private && !opts.allowPrivate) throw new HttpError(409, 'repo_private', 'The linked repository is private. Make it public so downloads work.');
    if (repo.archived || repo.disabled) throw new HttpError(409, 'repo_archived', 'The linked repository is archived.');
    if (repo.full_name !== project.repo_full_name) {
      await env.DB.prepare('UPDATE projects SET repo_full_name = ? WHERE id = ?').bind(repo.full_name, project.id).run();
    }
    return { token, repo, installationId };
  }
  throw notInstalled(project.repo_full_name);
}

// Argonite's own data repository (collections, profile links), configured in config/site.json.
export async function dataRepoToken(env: Env): Promise<{ token: string; installationId: number }> {
  const id = await repoInstallationId(env, SITE.github.dataRepo);
  if (!id) throw notInstalled(SITE.github.dataRepo);
  return { token: await installationToken(env, id), installationId: id };
}

// A signed, short-lived download link for a release asset. Works on draft releases too, which is how
// the scanner reads files before anything is public.
export async function assetDownloadUrl(token: string, repo: Pick<GitHubRepo, 'full_name'>, assetId: number): Promise<string | null> {
  const res = await fetch(`${githubApi()}${repoPath(repo)}/releases/assets/${assetId}`, {
    headers: ghHeaders(token, { Accept: 'application/octet-stream' }),
    redirect: 'manual',
  });
  if (res.status === 404) return null;
  const location = res.headers.get('Location');
  if (res.status >= 300 && res.status < 400 && location) return location;
  throw new GitHubError(res.ok ? 502 : res.status, githubMessage(res.status, 'GitHub did not return a download link for the asset'));
}

export async function publishRelease(token: string, repo: Pick<GitHubRepo, 'full_name'>, releaseId: number, latest: boolean): Promise<void> {
  await gh(token, 'PATCH', `${repoPath(repo)}/releases/${releaseId}`, { draft: false, make_latest: latest ? 'true' : 'false' });
}

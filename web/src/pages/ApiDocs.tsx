import { CopyField } from '../components/ui';
import { API_URL, SCAN_PUBLIC_KEY, SITE } from '../config';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';

function endpoints(): [string, string, string][] {
  return [
    ['GET', '/v1/search', t('Search projects. Query: q, type, loaders, versions, categories (comma separated), environment (client or server), openSource=1, hideArchived=1, sort (relevance, downloads, follows, updated, newest), page, limit (max 50).')],
    ['GET', '/v1/projects?ids=a,b', t('Several projects at once (up to 100 ids).')],
    ['GET', '/v1/projects/{id|slug}', t('A project with members, gallery and links.')],
    ['GET', '/v1/projects/{id|slug}/versions', t('Live versions. Optional filters: loaders, gameVersions.')],
    ['GET', '/v1/projects/{id|slug}/dependents', t('Projects whose live versions depend on this one.')],
    ['GET', '/v1/projects/{id|slug}/feed.xml', t('Atom feed of new versions.')],
    ['GET', '/v1/versions?ids=a,b', t('Several versions at once (up to 80 ids).')],
    ['GET', '/v1/versions/{id}', t('One version, including every file’s hashes and the scanner signature.')],
    ['GET', '/v1/versions/{id}/resolve', t('Required dependencies resolved to live versions. Query: loader, gameVersion.')],
    ['GET', '/v1/versions/{id}/contents', t('For modpacks: every file the pack installs, where it comes from and its scan result.')],
    ['GET', '/v1/files/{sha1|sha256|sha512}/{hash}', t('Find the version a file belongs to.')],
    ['POST', '/v1/files', t('Bulk lookup. Body: {"algorithm":"sha512","hashes":[…]} (up to 80).')],
    ['POST', '/v1/files/update', t('Update check. Body: {"algorithm","hashes","loaders","gameVersions","channels"}. Returns the newest compatible version for each installed file.')],
    ['GET', '/v1/users/{username}', t('A user profile, links and published projects.')],
    ['GET', '/v1/users/{username}/collections', t('A user’s public collections.')],
    ['GET', '/v1/collections/{id}', t('A public or unlisted collection.')],
    ['GET', '/v1/organizations/{slug}', t('An organisation, its members and projects.')],
    ['GET', '/v1/servers', t('Server listings. Query: q, edition, region, tag, online=1, sort, page.')],
    ['GET', '/v1/servers/{slug}', t('One server with its latest status.')],
    ['GET', '/v1/badge/{slug}/{downloads|version|followers}.svg', t('An SVG badge for READMEs.')],
    ['GET', '/v1/tags', t('Project types, loaders, categories and licenses.')],
    ['GET', '/v1/tags/game-versions', t('Known Minecraft releases and snapshots.')],
    ['GET', '/v1/meta', t('Site name, signature format and the scanner public key.')],
    ['GET', '/v1/download/{versionId}', t('The main file’s bytes, proxied from the author’s GitHub release. Always verify before use.')],
    ['GET', '/v1/download/file/{fileId}', t('Any file of a version by its id.')],
  ];
}

const CANONICAL = `argonite-file-v2
file:{file.id}
version:{versionId}
project:{projectId}
repo:{file.repoId}
release:{file.releaseId}
asset:{file.assetId}
name:{file.filename}
size:{file.size}
sha1:{file.sha1}
sha256:{file.sha256}
sha512:{file.sha512}`;

const PUBLISH = `# 1. Describe the version and its files
curl -X POST ${'$'}API/api/projects/PROJECT_ID/versions \\
  -H "Authorization: Bearer $ARGONITE_TOKEN" \\
  -H "Content-Type: application/json" \\
  -d '{"versionNumber":"1.2.0","channel":"release",
       "loaders":["fabric"],"gameVersions":["1.21.4"],
       "changelog":"Fixed a crash",
       "files":[{"filename":"mymod-1.2.0.jar","size":123456},
                {"filename":"mymod-1.2.0-sources.jar","size":45678,"kind":"sources"}]}'

# 2. Upload each file to the id it was given (Content-Length must match)
curl -X PUT ${'$'}API/api/files/FILE_ID \\
  -H "Authorization: Bearer $ARGONITE_TOKEN" \\
  --data-binary @build/libs/mymod-1.2.0.jar

# 3. Poll until it leaves "scanning"
curl ${'$'}API/api/versions/VERSION_ID -H "Authorization: Bearer $ARGONITE_TOKEN"`;

export default function ApiDocs() {
  useHead(t('Public API'), t('JSON API for {site}: search, signed file fingerprints for launchers, update checks and publishing from CI.', { site: SITE.name }));
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('Public API')}</h1>
          <p class="page-sub">{t('JSON, no key required for reading. Rate limited per IP.')}</p>
        </div>
      </div>
      <div class="stack-lg">
        <section class="card card-pad stack">
          <h2 class="form-section-title">{t('Base URL')}</h2>
          <CopyField value={API_URL} label={t('Base URL')} />
        </section>
        <section class="card">
          <div class="table-wrap">
            <table class="table api-table">
              <thead>
                <tr>
                  <th>{t('Method')}</th>
                  <th>{t('Path')}</th>
                  <th>{t('Description')}</th>
                </tr>
              </thead>
              <tbody>
                {endpoints().map(([m, p, d]) => (
                  <tr key={p + m}>
                    <td>
                      <span class={`badge ${m === 'GET' ? 'badge-accent' : 'badge-warning'}`}>{m}</span>
                    </td>
                    <td class="mono">{p}</td>
                    <td>{d}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
        <section class="card card-pad prose">
          <h2>{t('Verifying files')}</h2>
          <p>{t('Every file in a version’s files list carries sha1, sha256, sha512 and an Ed25519 signature (base64). The signature covers this exact UTF-8 string, lines joined with a newline:')}</p>
          <pre>
            <code>{CANONICAL}</code>
          </pre>
          <p>{t('Verify it with the raw 32-byte public key below (base64), then hash the downloaded bytes and compare. Reject the file if either check fails.')}</p>
        </section>
        <section class="card card-pad stack">
          <h2 class="form-section-title">{t('Scanner public key')}</h2>
          {SCAN_PUBLIC_KEY ? <CopyField value={SCAN_PUBLIC_KEY} label={t('Public key')} /> : <p class="muted">{t('Not configured yet.')}</p>}
        </section>
        <section class="card card-pad prose" id="publishing">
          <h2>{t('Publishing from CI')}</h2>
          <p>{t('The easiest route needs no token at all: turn on auto-publish in your project’s Publishing settings and create a GitHub release (a draft is best). We import it, scan it, and publish the release once it passes.')}</p>
          <p>
            {t('To push builds yourself, create a token with the versions scope in')} <Link href="/settings?tab=tokens">{t('Settings → API tokens')}</Link>{' '}
            {t('and store it as a CI secret. Then:')}
          </p>
          <pre>
            <code>{PUBLISH.replace(/\$API/g, API_URL)}</code>
          </pre>
          <p>{t('Files go to a draft release in your repository and are published on GitHub only after every file passes the scan. Up to 6 files per version; extra file kinds are sources, javadoc, dev, server, client and other.')}</p>
        </section>
      </div>
    </div>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { PROJECT_TYPES } from '../../../shared/taxonomy';
import type { ProjectSummary, SearchResult, Version } from '../../../shared/types';
import { openPalette } from '../components/CommandPalette';
import { Icon } from '../components/Icon';
import { ProjectRow, ProjectRowSkeleton } from '../components/ProjectCard';
import { useAsync } from '../components/ui';
import { SITE } from '../config';
import { loginUrl, pub } from '../lib/api';
import { signatureValid } from '../lib/download';
import { bytes, date, number } from '../lib/format';
import { useHead } from '../lib/head';
import { Link, navigate } from '../lib/router';
import { useSession } from '../lib/store';
import { TYPE_ICON } from '../lib/typeIcons';
import { t } from '../lib/i18n';

interface Readout {
  project: ProjectSummary;
  version: Version;
}

async function latestVerified(): Promise<Readout | null> {
  const newest = await pub<SearchResult>('/v1/search?sort=updated&limit=5');
  for (const p of newest.hits) {
    const { versions } = await pub<{ versions: Version[] }>(`/v1/projects/${p.slug}/versions`);
    const v = versions.find((x) => x.file);
    if (v) return { project: p, version: v };
  }
  return null;
}

function short(hash: string): string {
  return `${hash.slice(0, 12)}…${hash.slice(-8)}`;
}

function VerifiedReadout() {
  const { data, loading } = useAsync(latestVerified, []);
  const [sig, setSig] = useState<boolean | null>(null);
  useEffect(() => {
    if (data) signatureValid(data.version).then(setSig);
  }, [data?.version.id]);

  return (
    <aside class="readout" aria-label={t('Latest verified file')}>
      <div class="readout-bar">
        <span>{t('Latest verified file')}</span>
        {data && <span class={`readout-status${sig === false ? ' is-bad' : ''}`}>{sig === null ? t('checking') : sig ? t('verified') : t('mismatch')}</span>}
      </div>
      {loading ? (
        <div class="readout-body">
          <span class="readout-line readout-muted">{t('loading…')}</span>
        </div>
      ) : !data ? (
        <div class="readout-body">
          <span class="readout-line readout-muted">{t('No files published yet. The first upload shows up here once it passes its scan.')}</span>
        </div>
      ) : (
        <div class="readout-body">
          <Link href={`/project/${data.project.slug}/version/${data.version.id}`} class="readout-file">
            {data.version.file!.filename}
          </Link>
          <span class="readout-line readout-muted">
            {data.project.name} · {bytes(data.version.file!.size)} · {t('scanned {date}', { date: date(data.version.file!.scannedAt) })}
          </span>
          <dl class="readout-grid">
            <dt>sha256</dt>
            <dd>{short(data.version.file!.sha256)}</dd>
            <dt>sha512</dt>
            <dd>{short(data.version.file!.sha512)}</dd>
            <dt>{t('signature')}</dt>
            <dd>
              ed25519{' '}
              <span class={sig ? 'readout-ok' : sig === false ? 'readout-bad' : 'readout-muted'}>{sig === null ? '…' : sig ? `✓ ${t('valid')}` : `✗ ${t('invalid')}`}</span>
            </dd>
            <dt>{t('source')}</dt>
            <dd>
              {data.version.releaseUrl ? (
                <a href={data.version.releaseUrl} target="_blank" rel="noopener noreferrer">
                  {t('github release')}
                </a>
              ) : (
                t('github release')
              )}
            </dd>
          </dl>
          <p class="readout-note">{t('Checked just now by your browser against our scanner’s public key.')}</p>
        </div>
      )}
    </aside>
  );
}

function List({ title, sort, href }: { title: string; sort: string; href: string }) {
  const { data, loading, error } = useAsync(() => pub<SearchResult>(`/v1/search?sort=${sort}&limit=6`), [sort]);
  if (error || (!loading && !data?.hits.length)) return null;
  return (
    <section class="home-list">
      <div class="home-list-head">
        <h2>{title}</h2>
        <Link href={href} class="text-link">
          {t('See all')}
        </Link>
      </div>
      <ol class="row-list">
        {loading ? Array.from({ length: 5 }, (_, i) => <ProjectRowSkeleton key={i} />) : data!.hits.map((p) => <ProjectRow key={p.id} p={p} />)}
      </ol>
    </section>
  );
}

const pipeline = () => [
  { title: t('Upload'), body: t('The author publishes to a release in their own GitHub repository. We never host the file.') },
  { title: t('Scan'), body: t('Every file, and every jar packed inside it, is scanned for malware before it goes live.') },
  { title: t('Sign'), body: t('Passing files get SHA-256 and SHA-512 fingerprints, signed with a key only the scanner holds.') },
  { title: t('Verify'), body: t('Your browser re-checks the signature and both hashes before saving. A mismatch blocks the download.') },
];

export default function Home() {
  useHead('');
  const { user } = useSession();
  const [q, setQ] = useState('');
  const total = useAsync(() => pub<SearchResult>('/v1/search?limit=1'), []);

  return (
    <>
      <section class="home-hero">
        <div class="container home-hero-grid">
          <div class="home-hero-main">
            <h1>{t('Minecraft mods you can actually trust.')}</h1>
            <p class="home-lede">
              {t('{site} scans every upload and checks every download against a signed fingerprint, so the file that reaches your mods folder is the exact one that was reviewed.', { site: SITE.name })}
            </p>
            <form
              class="home-search"
              role="search"
              onSubmit={(e) => {
                e.preventDefault();
                navigate(`/browse${q.trim() ? `?q=${encodeURIComponent(q.trim())}` : ''}`);
              }}
            >
              <Icon name="search" />
              <input
                type="search"
                placeholder={total.data?.total ? t('Search {n} projects', { n: number(total.data.total) }) : t('Search projects')}
                aria-label={t('Search projects')}
                value={q}
                maxLength={200}
                onInput={(e) => setQ(e.currentTarget.value)}
              />
              <button type="submit" class="btn btn-primary">
                {t('Search')}
              </button>
            </form>
            <nav class="type-strip" aria-label={t('Browse by type')}>
              {PROJECT_TYPES.map((pt) => (
                <Link key={pt.id} href={`/${pt.path}`} class="type-chip">
                  <Icon name={TYPE_ICON[pt.id]} />
                  {t(pt.plural)}
                </Link>
              ))}
            </nav>
            <p class="home-hint">
              {t('Tip: press')} <kbd>/</kbd> {t('anywhere to search, or')}{' '}
              <button type="button" class="text-link" onClick={openPalette}>
                {t('open the command palette')}
              </button>
              .
            </p>
          </div>
          <VerifiedReadout />
        </div>
      </section>

      <div class="container home-lists">
        <List title={t('Most downloaded')} sort="downloads" href="/browse?sort=downloads" />
        <List title={t('Recently updated')} sort="updated" href="/browse?sort=updated" />
      </div>

      <section class="band" aria-labelledby="pipeline-title">
        <div class="container">
          <div class="band-head">
            <h2 id="pipeline-title">{t('Four checks between an upload and your game')}</h2>
            <Link href="/how-it-works" class="band-link">
              {t('How verification works')} <Icon name="chevronRight" />
            </Link>
          </div>
          <ol class="pipeline">
            {pipeline().map((s) => (
              <li key={s.title}>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      <section class="container creators">
        <div>
          <h2>{t('Publishing here costs you nothing')}</h2>
          <p>
            {t('Your files stay in a GitHub repository you own. {site} handles the listing, the scan and the signed fingerprint, and sends players to your release.', { site: SITE.name })}
          </p>
        </div>
        <div class="creators-actions">
          {user ? (
            <Link href="/new" class="btn btn-primary">
              <Icon name="plus" /> {t('Create a project')}
            </Link>
          ) : (
            <a href={loginUrl('/new')} class="btn btn-primary">
              <Icon name="github" /> {t('Sign in with GitHub')}
            </a>
          )}
          <Link href="/legal/rules" class="text-link">
            {t('Read the content rules')}
          </Link>
        </div>
      </section>
    </>
  );
}


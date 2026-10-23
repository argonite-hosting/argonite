// What a modpack installs: every file from its index, where it comes from, and what the scanner found.
import { useMemo, useState } from 'preact/hooks';
import { loaderLabel } from '../../../shared/taxonomy';
import type { PackContents as Contents, PackEntry, Version } from '../../../shared/types';
import { pub } from '../lib/api';
import { bytes } from '../lib/format';
import { t, tn } from '../lib/i18n';
import { Link } from '../lib/router';
import { Icon } from './Icon';
import { Empty, Spinner, useAsync } from './ui';
import { Select } from './Select';

function SourceBadge({ e }: { e: PackEntry }) {
  if (e.source === 'argonite') return <span class="badge badge-success">{t('Verified here')}</span>;
  if (e.source === 'bundled') return <span class="badge">{t('Included in the pack')}</span>;
  if (e.source === 'curseforge') return <span class="badge">CurseForge</span>;
  return <span class="badge">{e.host ?? t('External')}</span>;
}

function VerdictIcon({ verdict }: { verdict: PackEntry['verdict'] }) {
  if (verdict === 'clean') return <Icon name="shieldCheck" class="text-success" aria-label={t('Scanned, nothing found')} />;
  if (verdict === 'unscanned') return <Icon name="info" class="muted" aria-label={t('Not scanned')} />;
  return <Icon name="shieldAlert" class="text-danger" aria-label={t('Flagged by the scanner')} />;
}

export function PackContents({ version }: { version: Version | undefined }) {
  const [query, setQuery] = useState('');
  const [side, setSide] = useState<'' | 'client' | 'server'>('');
  const { data, loading, error } = useAsync(
    () => (version ? pub<{ contents: Contents | null }>(`/v1/versions/${version.id}/contents`) : Promise.resolve({ contents: null })),
    [version?.id],
  );
  const contents = data?.contents ?? null;
  const shown = useMemo(() => {
    if (!contents) return [];
    const q = query.trim().toLowerCase();
    return contents.entries.filter((e) => {
      if (q && !e.path.toLowerCase().includes(q) && !e.project?.name.toLowerCase().includes(q)) return false;
      if (side && e.env && e.env[side] === 'unsupported') return false;
      return true;
    });
  }, [contents, query, side]);

  if (!version) return <Empty icon="layers" title={t('No published version yet')} />;
  if (loading) {
    return (
      <div class="page-loading">
        <Spinner />
      </div>
    );
  }
  if (error || !contents) return <Empty icon="layers" title={t('Contents are not available for this version')} />;

  const verified = contents.entries.filter((e) => e.source === 'argonite').length;
  return (
    <section class="card card-pad stack">
      <div class="pack-summary">
        <div>
          <h2 class="section-title">{t('What this pack installs')}</h2>
          <p class="muted">
            {tn(contents.entries.length, '{n} file', '{n} files')}
            {contents.minecraft && ` · Minecraft ${contents.minecraft}`}
            {Object.entries(contents.loaders).map(([l, v]) => ` · ${loaderLabel(l)} ${v}`)}
          </p>
        </div>
        <p class="field-hint">
          <Icon name="shieldCheck" /> {t('Every file was downloaded, matched against the pack’s hashes and scanned before this version went live.')}{' '}
          {verified > 0 && t('{n} are also published and verified here.', { n: verified })}
        </p>
      </div>
      <div class="version-filters">
        <input class="input" type="search" placeholder={t('Filter files')} value={query} onInput={(e) => setQuery(e.currentTarget.value)} aria-label={t('Filter files')} />
        <Select class="select" value={side} onChange={(v) => setSide(v as typeof side)} aria-label={t('Filter by side')}>
          <option value="">{t('Client and server')}</option>
          <option value="client">{t('Client')}</option>
          <option value="server">{t('Server')}</option>
        </Select>
      </div>
      {shown.length ? (
        <ul class="pack-list">
          {shown.map((e) => (
            <li key={e.path} class="pack-row">
              <VerdictIcon verdict={e.verdict} />
              <span class="pack-name">
                {e.project ? <Link href={`/project/${e.project.slug}`}>{e.project.name}</Link> : <span class="mono">{e.path.split('/').pop()}</span>}
                <span class="field-hint mono">{e.path}</span>
              </span>
              <span class="pack-meta">
                <SourceBadge e={e} />
                {e.env?.client === 'unsupported' && <span class="badge">{t('Server only')}</span>}
                {e.env?.server === 'unsupported' && <span class="badge">{t('Client only')}</span>}
                {(e.env?.client === 'optional' || e.env?.server === 'optional') && <span class="badge">{t('Optional')}</span>}
                {e.size > 0 && <span class="muted">{bytes(e.size)}</span>}
              </span>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="filter" title={t('No files match')} />
      )}
    </section>
  );
}

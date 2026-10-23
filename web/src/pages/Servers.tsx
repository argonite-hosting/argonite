import { useEffect, useState } from 'preact/hooks';
import { SERVER_REGIONS, SERVER_TAGS } from '../../../shared/taxonomy';
import type { ServerListing } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { CopyField, Empty, PageLoading, Pagination, useAsync } from '../components/ui';
import { pub } from '../lib/api';
import { count } from '../lib/format';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, setQuery, useLocation } from '../lib/router';
import { useSession } from '../lib/store';

export function ServerFavicon({ s, size = 56 }: { s: Pick<ServerListing, 'favicon' | 'name'>; size?: number }) {
  return s.favicon ? (
    <img class="server-favicon" src={s.favicon} alt="" width={size} height={size} />
  ) : (
    <span class="server-favicon server-favicon-empty" style={{ width: `${size}px`, height: `${size}px` }} aria-hidden="true">
      <Icon name="server" />
    </span>
  );
}

export function PlayerCount({ s }: { s: ServerListing }) {
  if (s.edition === 'bedrock') return <span class="muted">{t('Bedrock · status not checked')}</span>;
  if (!s.lastPingAt) return <span class="muted">{t('Checking…')}</span>;
  return s.online ? (
    <span class="server-online">
      <span class="status-dot is-online" aria-hidden="true" />
      {s.playersOnline !== null ? t('{n} online', { n: count(s.playersOnline) }) : t('Online')}
      {s.playersMax ? <span class="muted"> / {count(s.playersMax)}</span> : null}
    </span>
  ) : (
    <span class="muted">
      <span class="status-dot" aria-hidden="true" /> {t('Offline')}
    </span>
  );
}

export default function Servers() {
  const loc = useLocation();
  const { user } = useSession();
  const q = loc.query.get('q') ?? '';
  const region = loc.query.get('region') ?? '';
  const edition = loc.query.get('edition') ?? '';
  const tag = loc.query.get('tag') ?? '';
  const online = loc.query.get('online') === '1';
  const sort = loc.query.get('sort') ?? '';
  const page = Number(loc.query.get('page') ?? '1') || 1;
  const [draft, setDraft] = useState(q);
  useEffect(() => setDraft(q), [q]);
  useHead(t('Minecraft servers'), t('Find Minecraft servers with live player counts, then grab the modpack they run with verified downloads.'));
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (region) params.set('region', region);
  if (edition) params.set('edition', edition);
  if (tag) params.set('tag', tag);
  if (online) params.set('online', '1');
  if (sort) params.set('sort', sort);
  params.set('page', String(page));
  const { data, loading } = useAsync(() => pub<{ servers: ServerListing[]; total: number; pageSize: number }>(`/v1/servers?${params}`), [params.toString()]);
  return (
    <div class="container page">
      <div class="page-head">
        <div>
          <h1>{t('Servers')}</h1>
          <p class="page-sub">{t('Live status is checked every few minutes. Modded servers link to their modpack, verified like everything else here.')}</p>
        </div>
        {user && (
          <Link href="/servers/new" class="btn btn-primary">
            <Icon name="plus" /> {t('List your server')}
          </Link>
        )}
      </div>
      <form
        class="server-filters"
        onSubmit={(e) => {
          e.preventDefault();
          setQuery({ q: draft.trim() || null, page: null });
        }}
      >
        <input class="input" type="search" value={draft} placeholder={t('Search servers')} aria-label={t('Search servers')} onInput={(e) => setDraft(e.currentTarget.value)} />
        <select class="select" value={edition} aria-label={t('Edition')} onChange={(e) => setQuery({ edition: e.currentTarget.value || null, page: null })}>
          <option value="">{t('Java and Bedrock')}</option>
          <option value="java">Java</option>
          <option value="bedrock">Bedrock</option>
        </select>
        <select class="select" value={region} aria-label={t('Region')} onChange={(e) => setQuery({ region: e.currentTarget.value || null, page: null })}>
          <option value="">{t('Any region')}</option>
          {SERVER_REGIONS.map((r) => (
            <option key={r.id} value={r.id}>
              {t(r.label)}
            </option>
          ))}
        </select>
        <select class="select" value={sort} aria-label={t('Sort')} onChange={(e) => setQuery({ sort: e.currentTarget.value || null, page: null })}>
          <option value="">{t('Most players')}</option>
          <option value="newest">{t('Newest')}</option>
        </select>
        <label class="check">
          <input type="checkbox" checked={online} onChange={(e) => setQuery({ online: e.currentTarget.checked ? '1' : null, page: null })} />
          <span>{t('Online now')}</span>
        </label>
      </form>
      <div class="chips server-tags">
        {SERVER_TAGS.map((tg) => (
          <button key={tg.id} type="button" class="chip" aria-pressed={tag === tg.id} onClick={() => setQuery({ tag: tag === tg.id ? null : tg.id, page: null })}>
            {t(tg.label)}
          </button>
        ))}
      </div>
      {loading && !data ? (
        <PageLoading />
      ) : data?.servers.length ? (
        <>
          <ul class="server-list">
            {data.servers.map((s) => (
              <li key={s.id} class="card server-card">
                <Link href={`/server/${s.slug}`} class="server-card-main">
                  <ServerFavicon s={s} />
                  <span class="server-card-text">
                    <strong>{s.name}</strong>
                    <span class="muted">{s.summary}</span>
                    <span class="chips">
                      <span class="chip chip-muted">{s.edition === 'java' ? 'Java' : 'Bedrock'}</span>
                      {s.region !== 'global' && <span class="chip chip-muted">{t(SERVER_REGIONS.find((r) => r.id === s.region)?.label ?? s.region)}</span>}
                      {s.tags.slice(0, 3).map((tg) => (
                        <span key={tg} class="chip chip-muted">
                          {t(SERVER_TAGS.find((x) => x.id === tg)?.label ?? tg)}
                        </span>
                      ))}
                      {s.gameVersion && <span class="chip chip-muted">{s.gameVersion}</span>}
                    </span>
                  </span>
                </Link>
                <div class="server-card-side">
                  <PlayerCount s={s} />
                  <CopyField value={s.address} label={t('Server address')} />
                </div>
              </li>
            ))}
          </ul>
          <Pagination page={page} pages={Math.ceil(data.total / data.pageSize)} onPage={(p) => setQuery({ page: p === 1 ? null : String(p) }, false)} />
        </>
      ) : (
        <Empty icon="server" title={t('No servers match')} />
      )}
    </div>
  );
}

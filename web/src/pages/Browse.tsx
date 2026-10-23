import { useEffect, useMemo, useState } from 'preact/hooks';
import { LOADER_LABELS, PROJECT_TYPES, categoriesFor, categoryLabel, loaderLabel, typeByPath, typeInfo, type ProjectType } from '../../../shared/taxonomy';
import type { SearchResult } from '../../../shared/types';
import { useGameVersions } from '../components/GameVersionPicker';
import { Icon } from '../components/Icon';
import { ProjectCard, ProjectCardSkeleton } from '../components/ProjectCard';
import { Empty, Pagination, useAsync } from '../components/ui';
import { pub } from '../lib/api';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { setQuery, useLocation } from '../lib/router';

const PAGE_SIZE = 20;
const FLAG_KEYS = ['environment', 'openSource', 'hideArchived'] as const;

function sortLabels(): Record<string, string> {
  return {
    relevance: t('Relevance'),
    downloads: t('Downloads'),
    follows: t('Followers'),
    updated: t('Recently updated'),
    newest: t('Newest'),
  };
}

function list(q: URLSearchParams, key: string): string[] {
  return (q.get(key) ?? '').split(',').filter(Boolean);
}

function toggleIn(q: URLSearchParams, key: string, value: string): void {
  const cur = list(q, key);
  const next = cur.includes(value) ? cur.filter((v) => v !== value) : [...cur, value];
  setQuery({ [key]: next.join(','), page: null });
}

const clearAll = (fixedType: boolean) => ({ loaders: null, categories: null, versions: null, environment: null, openSource: null, hideArchived: null, type: fixedType ? undefined : null, page: null });

function VersionFilter({ selected }: { selected: string[] }) {
  const { data } = useGameVersions();
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [snapshots, setSnapshots] = useState(() => selected.some((id) => data?.find((v) => v.id === id)?.type === 'snapshot'));
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const pool = (data ?? []).filter((v) => snapshots || v.type === 'release' || selected.includes(v.id));
    const filtered = pool.filter((v) => !needle || v.id.toLowerCase().includes(needle));
    return all || needle ? filtered.slice(0, 250) : filtered.slice(0, 12);
  }, [data, q, all, snapshots, selected]);
  const loc = useLocation();
  return (
    <div class="filter-group">
      <h3 class="panel-title">{t('Game version')}</h3>
      <div class="input-icon filter-search">
        <Icon name="search" />
        <input class="input" type="search" placeholder={t('Filter versions')} value={q} aria-label={t('Filter game versions')} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      <label class="check filter-toggle">
        <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.currentTarget.checked)} />
        {t('Include snapshots')}
      </label>
      <div class={`filter-scroll${all || q ? ' is-expanded' : ''}`}>
        {shown.map((v) => (
          <label key={v.id} class="check">
            <input type="checkbox" checked={selected.includes(v.id)} onChange={() => toggleIn(loc.query, 'versions', v.id)} />
            {v.id}
            {v.type === 'snapshot' && <span class="count">{t('snapshot')}</span>}
          </label>
        ))}
      </div>
      {!q && shown.length >= 12 && (
        <button type="button" class="btn btn-ghost btn-sm filter-more" onClick={() => setAll((a) => !a)}>
          {all ? t('Show fewer') : t('Show all versions')}
        </button>
      )}
    </div>
  );
}

function Filters({ type, fixedType }: { type: ProjectType | undefined; fixedType: boolean }) {
  const loc = useLocation();
  const q = loc.query;
  const loaders = type ? typeInfo(type)!.loaders : Object.keys(LOADER_LABELS);
  const selectedLoaders = list(q, 'loaders');
  const selectedCats = list(q, 'categories');
  const environment = q.get('environment') ?? '';
  const active = selectedLoaders.length + selectedCats.length + list(q, 'versions').length + (!fixedType && type ? 1 : 0) + FLAG_KEYS.filter((k) => q.get(k)).length;
  return (
    <div class="filters">
      {active > 0 && (
        <button type="button" class="btn btn-sm btn-block" onClick={() => setQuery(clearAll(fixedType))}>
          <Icon name="x" /> {t('Clear filters')}
        </button>
      )}
      {!fixedType && (
        <div class="filter-group">
          <h3 class="panel-title">{t('Type')}</h3>
          {PROJECT_TYPES.map((pt) => (
            <label key={pt.id} class="check">
              <input type="radio" name="type" checked={type === pt.id} onChange={() => setQuery({ type: type === pt.id ? null : pt.id, loaders: null, categories: null, page: null })} />
              {t(pt.plural)}
            </label>
          ))}
          {type && (
            <button type="button" class="btn btn-ghost btn-sm filter-more" onClick={() => setQuery({ type: null, loaders: null, categories: null, page: null })}>
              {t('Any type')}
            </button>
          )}
        </div>
      )}
      {loaders.length > 1 && (
        <div class="filter-group">
          <h3 class="panel-title">{type === 'plugin' ? t('Platform') : t('Loader')}</h3>
          {loaders.map((l) => (
            <label key={l} class="check">
              <input type="checkbox" checked={selectedLoaders.includes(l)} onChange={() => toggleIn(q, 'loaders', l)} />
              {loaderLabel(l)}
            </label>
          ))}
        </div>
      )}
      <VersionFilter selected={list(q, 'versions')} />
      {(!type || type === 'mod' || type === 'modpack') && (
        <div class="filter-group">
          <h3 class="panel-title">{t('Runs on')}</h3>
          {[
            ['', t('Client or server')],
            ['client', t('Client')],
            ['server', t('Server')],
          ].map(([id, label]) => (
            <label key={id} class="check">
              <input type="radio" name="environment" checked={environment === id} onChange={() => setQuery({ environment: id || null, page: null })} />
              {label}
            </label>
          ))}
        </div>
      )}
      <div class="filter-group">
        <h3 class="panel-title">{t('Categories')}</h3>
        {categoriesFor(type).map((c) => (
          <label key={c.id} class="check">
            <input type="checkbox" checked={selectedCats.includes(c.id)} onChange={() => toggleIn(q, 'categories', c.id)} />
            {t(c.label)}
          </label>
        ))}
      </div>
      <div class="filter-group">
        <h3 class="panel-title">{t('More')}</h3>
        <label class="check">
          <input type="checkbox" checked={q.get('openSource') === '1'} onChange={(e) => setQuery({ openSource: e.currentTarget.checked ? '1' : null, page: null })} />
          {t('Open source only')}
        </label>
        <label class="check">
          <input type="checkbox" checked={q.get('hideArchived') === '1'} onChange={(e) => setQuery({ hideArchived: e.currentTarget.checked ? '1' : null, page: null })} />
          {t('Hide archived projects')}
        </label>
      </div>
    </div>
  );
}

function ActiveFilters({ fixedType }: { fixedType: boolean }) {
  const loc = useLocation();
  const q = loc.query;
  const chips: { key: string; label: string; clear: () => void }[] = [];
  if (q.get('q')) chips.push({ key: 'q', label: `“${q.get('q')}”`, clear: () => setQuery({ q: null, page: null }) });
  const type = q.get('type');
  if (!fixedType && type && typeInfo(type)) chips.push({ key: 'type', label: t(typeInfo(type)!.plural), clear: () => setQuery({ type: null, loaders: null, categories: null, page: null }) });
  for (const l of list(q, 'loaders')) chips.push({ key: `l-${l}`, label: loaderLabel(l), clear: () => toggleIn(q, 'loaders', l) });
  for (const v of list(q, 'versions')) chips.push({ key: `v-${v}`, label: v, clear: () => toggleIn(q, 'versions', v) });
  for (const c of list(q, 'categories')) chips.push({ key: `c-${c}`, label: t(categoryLabel(c)), clear: () => toggleIn(q, 'categories', c) });
  const env = q.get('environment');
  if (env === 'client' || env === 'server') chips.push({ key: 'env', label: env === 'client' ? t('Client') : t('Server'), clear: () => setQuery({ environment: null, page: null }) });
  if (q.get('openSource')) chips.push({ key: 'os', label: t('Open source only'), clear: () => setQuery({ openSource: null, page: null }) });
  if (q.get('hideArchived')) chips.push({ key: 'ha', label: t('Hide archived projects'), clear: () => setQuery({ hideArchived: null, page: null }) });
  if (!chips.length) return null;
  return (
    <div class="active-filters">
      {chips.map((c) => (
        <button key={c.key} type="button" class="chip" aria-pressed="true" onClick={c.clear} aria-label={t('Remove filter {name}', { name: c.label })}>
          {c.label}
          <Icon name="x" />
        </button>
      ))}
      {chips.length > 1 && (
        <button type="button" class="text-link active-clear" onClick={() => setQuery({ ...clearAll(fixedType), q: null })}>
          {t('Clear all')}
        </button>
      )}
    </div>
  );
}

export default function Browse() {
  const loc = useLocation();
  const fixed = typeByPath(loc.path.slice(1));
  const type = (fixed?.id ?? (typeInfo(loc.query.get('type') ?? '')?.id as ProjectType | undefined)) || undefined;
  const title = fixed ? t(fixed.plural) : type ? t(typeInfo(type)!.plural) : t('Browse');
  useHead(title, fixed ? t('Find {things} for Minecraft, scanned for malware and verified on every download.', { things: t(fixed.plural).toLowerCase() }) : undefined);

  const qParam = loc.query.get('q') ?? '';
  const [text, setText] = useState(qParam);
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setText(qParam), [qParam]);
  useEffect(() => {
    if (text === qParam) return;
    const timer = setTimeout(() => setQuery({ q: text.trim() || null, page: null }), 300);
    return () => clearTimeout(timer);
  }, [text]);

  const page = Math.max(1, Number(loc.query.get('page') ?? '1') || 1);
  const sort = loc.query.get('sort') ?? (qParam ? 'relevance' : 'downloads');
  const params = new URLSearchParams();
  if (qParam) params.set('q', qParam);
  if (type) params.set('type', type);
  for (const key of ['loaders', 'versions', 'categories', ...FLAG_KEYS]) if (loc.query.get(key)) params.set(key, loc.query.get(key)!);
  params.set('sort', sort);
  params.set('page', String(page));
  params.set('limit', String(PAGE_SIZE));
  const key = params.toString();
  const { data, loading, error, reload } = useAsync(() => pub<SearchResult>(`/v1/search?${key}`), [key]);
  const pages = data ? Math.min(500, Math.ceil(data.total / PAGE_SIZE)) : 0;

  return (
    <div class="container page">
      <div class="page-head">
        <div>
          <h1>{title}</h1>
          <p class="page-sub">{data ? tn(data.total, '{n} project', '{n} projects') : ' '}</p>
        </div>
      </div>
      <div class="browse-layout">
        <aside class={`browse-filters${drawer ? ' is-open' : ''}`} aria-label={t('Filters')}>
          <div class="browse-filters-head">
            <h2>{t('Filters')}</h2>
            <button type="button" class="btn btn-ghost btn-icon" onClick={() => setDrawer(false)} aria-label={t('Close filters')}>
              <Icon name="x" />
            </button>
          </div>
          <Filters type={type} fixedType={!!fixed} />
        </aside>
        {drawer && <div class="browse-scrim" onClick={() => setDrawer(false)} />}
        <section class="browse-results">
          <div class="browse-toolbar">
            <div class="input-icon browse-search">
              <Icon name="search" />
              <input class="input" type="search" placeholder={t('Search {things}', { things: title.toLowerCase() })} aria-label={t('Search')} value={text} maxLength={200} onInput={(e) => setText(e.currentTarget.value)} />
            </div>
            <button type="button" class="btn browse-filter-btn" onClick={() => setDrawer(true)}>
              <Icon name="filter" /> {t('Filters')}
            </button>
            <label class="sort-select">
              <span class="sr-only">{t('Sort by')}</span>
              <select class="select" value={sort} onChange={(e) => setQuery({ sort: e.currentTarget.value, page: null })}>
                {Object.entries(sortLabels())
                  .filter(([k]) => k !== 'relevance' || qParam)
                  .map(([k, v]) => (
                    <option key={k} value={k}>
                      {v}
                    </option>
                  ))}
              </select>
            </label>
          </div>
          <ActiveFilters fixedType={!!fixed} />
          {error ? (
            <Empty icon="alert" title={t('Search is unavailable')}>
              <p>{error.message}</p>
              <button type="button" class="btn" onClick={reload}>
                {t('Try again')}
              </button>
            </Empty>
          ) : loading && !data ? (
            <div class="result-list">
              {Array.from({ length: 6 }, (_, i) => (
                <ProjectCardSkeleton key={i} />
              ))}
            </div>
          ) : data && data.hits.length ? (
            <>
              <div class={`result-list${loading ? ' is-stale' : ''}`}>
                {data.hits.map((p) => (
                  <ProjectCard key={p.id} p={p} showType={!type} />
                ))}
              </div>
              <Pagination
                page={page}
                pages={pages}
                onPage={(p) => {
                  setQuery({ page: p > 1 ? String(p) : null }, false);
                  window.scrollTo({ top: 0 });
                }}
              />
            </>
          ) : (
            <Empty icon="search" title={t('No projects found')}>
              <p>{t('Try a different search or remove a few filters.')}</p>
            </Empty>
          )}
        </section>
      </div>
    </div>
  );
}

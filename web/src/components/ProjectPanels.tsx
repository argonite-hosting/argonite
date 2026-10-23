// Project settings panels that are new with teams, analytics, auto-publish and moderator threads.
import { useState } from 'preact/hooks';
import { PERM, PERM_LABELS, has, type PermName } from '../../../shared/permissions';
import { COMMENT_MODES, loaderLabel, typeInfo, type CommentMode } from '../../../shared/taxonomy';
import type { AutoPublishSettings, ModMessage, Project, ProjectStats } from '../../../shared/types';
import { api } from '../lib/api';
import { ago, date, number } from '../lib/format';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';
import { errorToast, toast, useSession } from '../lib/store';
import { BarList, LineChart } from './Charts';
import { GameVersionPicker } from './GameVersionPicker';
import { Icon } from './Icon';
import { Alert, Avatar, Empty, Field, Spinner, useAsync } from './ui';

export function PermissionPicker({
  labels,
  flags,
  value,
  editable,
  onChange,
}: {
  labels: Record<string, string>;
  flags: Record<string, number>;
  value: number;
  editable: number;
  onChange: (v: number) => void;
}) {
  return (
    <div class="perm-grid">
      {Object.entries(flags).map(([name, bit]) => (
        <label key={name} class="check">
          <input type="checkbox" checked={has(value, bit)} disabled={!has(editable, bit)} onChange={(e) => onChange(e.currentTarget.checked ? value | bit : value & ~bit)} />
          <span>{t(labels[name])}</span>
        </label>
      ))}
    </div>
  );
}

export function ProjectPermissionPicker(props: { value: number; editable: number; onChange: (v: number) => void }) {
  return <PermissionPicker labels={PERM_LABELS as Record<PermName, string>} flags={PERM} {...props} />;
}

export function Analytics({ project }: { project: Project }) {
  const [days, setDays] = useState(30);
  const { data, loading, error } = useAsync(() => api<ProjectStats>('GET', `/api/projects/${project.id}/stats?days=${days}`), [project.id, days]);
  const regions = (() => {
    try {
      return new Intl.DisplayNames(undefined, { type: 'region' });
    } catch {
      return null;
    }
  })();
  return (
    <div class="stack">
      <div class="row-actions">
        <div class="segmented" role="group" aria-label={t('Time range')}>
          {[7, 30, 90, 365].map((d) => (
            <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>
              {d === 365 ? t('1 year') : t('{n} days', { n: d })}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <div class="page-loading">
          <Spinner />
        </div>
      ) : error || !data ? (
        <Alert kind="danger">{error?.message ?? t('Could not load analytics.')}</Alert>
      ) : (
        <>
          <div class="stat-tiles">
            <div class="stat-tile">
              <span class="aside-label">{t('Views')}</span>
              <strong>{number(data.totals.views)}</strong>
            </div>
            <div class="stat-tile">
              <span class="aside-label">{t('Downloads')}</span>
              <strong>{number(data.totals.downloads)}</strong>
            </div>
            <div class="stat-tile">
              <span class="aside-label">{t('All-time downloads')}</span>
              <strong>{number(project.downloads)}</strong>
            </div>
          </div>
          <section class="card card-pad stack">
            <LineChart title={t('Downloads per day')} points={data.days.map((d) => ({ day: d.day, value: d.downloads }))} />
            <LineChart title={t('Page views per day')} points={data.days.map((d) => ({ day: d.day, value: d.views }))} />
          </section>
          <div class="grid-2">
            <section class="card card-pad">
              <BarList title={t('Downloads by version')} empty={t('No downloads in this period.')} rows={data.versions.map((v) => ({ label: v.versionNumber, value: v.downloads }))} />
            </section>
            <section class="card card-pad">
              <BarList
                title={t('Top countries')}
                empty={t('No visits in this period.')}
                rows={data.countries.map((c) => ({ label: c.country === 'XX' ? t('Unknown') : (regions?.of(c.country) ?? c.country), value: c.downloads + c.views }))}
              />
            </section>
          </div>
          <p class="field-hint">{t('Each visitor counts once per day. Visitors are identified by a salted hash that changes daily, never by IP address.')}</p>
        </>
      )}
    </div>
  );
}

export function Publishing({ project, settings, perms, reload }: { project: Project; settings: AutoPublishSettings | null; perms: number; reload: () => void }) {
  const info = typeInfo(project.type)!;
  const [enabled, setEnabled] = useState(!!settings?.enabled);
  const [drafts, setDrafts] = useState(settings?.drafts ?? true);
  const [pattern, setPattern] = useState(settings?.assetPattern ?? '*');
  const [loaders, setLoaders] = useState<string[]>(settings?.loaders ?? (info.loaders.length === 1 ? info.loaders : []));
  const [gvs, setGvs] = useState<string[]>(settings?.gameVersions ?? []);
  const [mode, setMode] = useState<CommentMode>(project.commentsMode);
  const [busy, setBusy] = useState(false);
  const can = has(perms, PERM.MANAGE_SETTINGS);

  const save = async (body: Record<string, unknown>) => {
    setBusy(true);
    try {
      await api('PATCH', `/api/projects/${project.id}`, body);
      toast('success', t('Saved'));
      reload();
    } catch (e) {
      errorToast(e, t('Could not save'));
    } finally {
      setBusy(false);
    }
  };

  if (!can) return <Alert kind="info">{t('Your role in this project doesn’t include publishing and comment settings.')}</Alert>;
  return (
    <div class="stack">
      <section class="card card-pad stack">
        <h3>{t('Publish from GitHub releases')}</h3>
        <p class="muted">
          {t('Create a release in {repo} (by hand or from CI) and it becomes a version here automatically. Its files are scanned like any upload.', { repo: project.repo.fullName })}
        </p>
        <label class="check">
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.currentTarget.checked)} />
          <span>{t('Turn on auto-publish')}</span>
        </label>
        {enabled && (
          <>
            <label class="check">
              <input type="checkbox" checked={drafts} onChange={(e) => setDrafts(e.currentTarget.checked)} />
              <span>
                {t('Pick up draft releases')}
                <span class="field-hint">{t('Recommended. Create the release as a draft; we publish it on GitHub only after the scan passes, so nobody can grab an unscanned file.')}</span>
              </span>
            </label>
            <Field label={t('Files to include')} hint={t('A file name pattern. * matches anything, for example *.jar or mymod-*.jar.')}>
              {(id, d) => <input id={id} class="input mono-ish" value={pattern} maxLength={100} aria-describedby={d} onInput={(e) => setPattern(e.currentTarget.value.trim())} />}
            </Field>
            {info.loaders.length > 1 && (
              <div class="field">
                <span class="field-label">{project.type === 'plugin' ? t('Platforms') : t('Loaders')}</span>
                <div class="chips">
                  {info.loaders.map((l) => (
                    <button key={l} type="button" class="chip" aria-pressed={loaders.includes(l)} onClick={() => setLoaders((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))}>
                      {loaderLabel(l)}
                    </button>
                  ))}
                </div>
              </div>
            )}
            <Field label={t('Minecraft versions')} hint={t('Applied to every release. Edit a version afterwards if one differs.')}>
              {(id) => <GameVersionPicker id={id} selected={gvs} onChange={setGvs} />}
            </Field>
            <Alert kind="info">
              {t('The version number comes from the release tag (a leading v is dropped), the name and changelog from the release title and notes, and pre-releases become beta versions (alpha if the tag says alpha).')}
            </Alert>
          </>
        )}
        <div class="form-foot">
          <button
            type="button"
            class="btn btn-primary"
            disabled={busy || (enabled && (!loaders.length || !gvs.length))}
            onClick={() => save({ autoPublish: enabled ? { enabled: true, drafts, assetPattern: pattern || '*', loaders, gameVersions: gvs } : null })}
          >
            {busy && <Spinner />} {t('Save publishing settings')}
          </button>
        </div>
      </section>

      <section class="card card-pad stack">
        <h3>{t('Publish from CI with an API token')}</h3>
        <p class="muted">{t('Prefer to push builds yourself? Create a token with the versions scope and call the upload API from your build.')}</p>
        <div class="row-actions">
          <Link href="/settings?tab=tokens" class="btn">
            <Icon name="key" /> {t('Manage API tokens')}
          </Link>
          <Link href="/api-docs#publishing" class="btn btn-ghost">
            {t('API guide')}
          </Link>
        </div>
      </section>

      <section class="card card-pad stack">
        <h3>{t('Comments')}</h3>
        <div class="segmented" role="group" aria-label={t('Who can comment')}>
          {COMMENT_MODES.map((m) => (
            <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}>
              {m === 'open' ? t('Everyone') : m === 'members' ? t('Team only') : t('Off')}
            </button>
          ))}
        </div>
        <p class="field-hint">{t('Comments are stored in your repository on a separate argonite-data branch. Members with the moderate comments permission can remove any comment.')}</p>
        <div class="form-foot">
          <button type="button" class="btn btn-primary" disabled={busy || mode === project.commentsMode} onClick={() => save({ commentsMode: mode })}>
            {t('Save comment settings')}
          </button>
        </div>
      </section>
    </div>
  );
}

export function ModThread({ project }: { project: Project }) {
  const { user } = useSession();
  const { data, loading, reload } = useAsync(() => api<{ messages: ModMessage[] }>('GET', `/api/projects/${project.id}/messages`), [project.id]);
  const [text, setText] = useState('');
  const [internal, setInternal] = useState(false);
  const [busy, setBusy] = useState(false);
  const staff = user?.role === 'moderator' || user?.role === 'admin';
  const send = async (e: Event) => {
    e.preventDefault();
    if (!text.trim()) return;
    setBusy(true);
    try {
      await api('POST', `/api/projects/${project.id}/messages`, { body: text.trim(), internal });
      setText('');
      reload();
    } catch (err) {
      errorToast(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack">
      <Alert kind="info">{t('A private conversation between your team and the moderators. Use it for review questions or to respond to a takedown.')}</Alert>
      {loading && !data ? (
        <div class="page-loading">
          <Spinner />
        </div>
      ) : data?.messages.length ? (
        <ul class="thread card">
          {data.messages.map((m) => (
            <li key={m.id} class={`thread-msg${m.staff ? ' is-staff' : ''}${m.internal ? ' is-internal' : ''}`}>
              <Avatar src={m.author.avatarUrl} name={m.author.username} size="sm" />
              <div>
                <div class="comment-head">
                  <strong>{m.author.username}</strong>
                  {m.staff && <span class="badge badge-accent">{t('Moderator')}</span>}
                  {m.internal && <span class="badge badge-warning">{t('Internal note')}</span>}
                  <time class="muted" title={date(m.createdAt)}>
                    {ago(m.createdAt)}
                  </time>
                </div>
                <p class="comment-text">{m.body}</p>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <Empty icon="message" title={t('No messages yet')} />
      )}
      <form class="card card-pad stack-sm" onSubmit={send}>
        <textarea class="textarea" rows={4} maxLength={4000} value={text} placeholder={t('Write a message')} aria-label={t('Write a message')} onInput={(e) => setText(e.currentTarget.value)} />
        <div class="row-actions row-between">
          {staff ? (
            <label class="check">
              <input type="checkbox" checked={internal} onChange={(e) => setInternal(e.currentTarget.checked)} />
              <span>{t('Internal note (moderators only)')}</span>
            </label>
          ) : (
            <span />
          )}
          <button type="submit" class="btn btn-primary" disabled={busy || !text.trim()}>
            {busy && <Spinner />} {t('Send')}
          </button>
        </div>
      </form>
    </div>
  );
}


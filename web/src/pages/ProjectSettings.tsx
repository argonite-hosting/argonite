import { useState } from 'preact/hooks';
import { PERM, PERM_DEFAULT_MEMBER, has } from '../../../shared/permissions';
import { CHANNELS, FILE_KIND_LABELS, LICENSES, SIDES, categoriesFor, loaderLabel, typeInfo, type Channel } from '../../../shared/taxonomy';
import type { AutoPublishSettings, Project, Version } from '../../../shared/types';
import { validateHttpsUrl, validateName, validateSlug, validateSummary } from '../../../shared/validate';
import { DependencyPicker, type DepDraft } from '../components/DependencyPicker';
import { GameVersionPicker } from '../components/GameVersionPicker';
import { Icon } from '../components/Icon';
import { MarkdownEditor } from '../components/Markdown';
import { Analytics, ModThread, ProjectPermissionPicker, Publishing } from '../components/ProjectPanels';
import { RequireAuth } from '../components/RequireAuth';
import { Alert, Avatar, ChannelBadge, Empty, Field, Modal, PageLoading, ProjectIcon, Spinner, StatusBadge, NativeList, Tabs, useAsync, VerifiedImg } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api, upload } from '../lib/api';
import { date } from '../lib/format';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { Link, navigate, setQuery, useLocation } from '../lib/router';
import { errorToast, isStaff, toast, useSession } from '../lib/store';

interface Manage {
  project: Project;
  versions: Version[];
  role: 'owner' | 'maintainer' | 'org' | null;
  perms: number;
  statusReason: string | null;
  autoPublish: AutoPublishSettings | null;
}

type Save = (body: Record<string, unknown>) => Promise<boolean>;

function useSaver(projectId: string, reload: () => void): [Save, boolean, Record<string, string>] {
  const [busy, setBusy] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const save: Save = async (body) => {
    setBusy(true);
    setErrors({});
    try {
      const r = await api<{ warning?: string }>('PATCH', `/api/projects/${projectId}`, body);
      toast(r.warning ? 'info' : 'success', t('Saved'), r.warning);
      reload();
      return true;
    } catch (e) {
      if (e instanceof ApiError) setErrors(e.fields);
      errorToast(e, t('Could not save'));
      return false;
    } finally {
      setBusy(false);
    }
  };
  return [save, busy, errors];
}

function NoAccess({ what }: { what: string }) {
  return <Alert kind="info">{t('Your role in this project doesn’t allow changing {what}.', { what })}</Alert>;
}

function General({ m, reload }: { m: Manage; reload: () => void }) {
  const p = m.project;
  const [save, busy, errors] = useSaver(p.id, reload);
  const [name, setName] = useState(p.name);
  const [summary, setSummary] = useState(p.summary);
  const [slug, setSlug] = useState(p.slug);
  const [categories, setCategories] = useState(p.categories);
  const [license, setLicense] = useState(p.license);
  const [licenseUrl, setLicenseUrl] = useState(p.links.license ?? '');
  const [clientSide, setClientSide] = useState(p.clientSide);
  const [serverSide, setServerSide] = useState(p.serverSide);
  const [local, setLocal] = useState<Record<string, string>>({});
  if (!has(m.perms, PERM.EDIT_DETAILS)) return <NoAccess what={t('project details')} />;
  const owner = m.role === 'owner';
  const submit = async (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    const checks: [string, string | null][] = [
      ['name', validateName(name)],
      ['summary', validateSummary(summary)],
      ['slug', slug !== p.slug ? validateSlug(slug) : null],
      ['licenseUrl', validateHttpsUrl(licenseUrl)],
    ];
    for (const [k, v] of checks) if (v) errs[k] = v;
    if (license === 'LicenseRef-Custom' && !licenseUrl) errs.licenseUrl = t('Link to your license text.');
    setLocal(errs);
    if (Object.keys(errs).length) return;
    const ok = await save({ name, summary, categories, license, licenseUrl: licenseUrl || null, clientSide, serverSide, ...(slug !== p.slug ? { slug } : {}) });
    if (ok && slug !== p.slug) navigate(`/project/${slug}/settings`, { replace: true });
  };
  const err = { ...errors, ...local };
  const sideLabel: Record<string, string> = { required: t('Required'), optional: t('Optional'), unsupported: t('Not needed'), unknown: t('Unknown') };
  return (
    <div class="stack">
      <form class="stack" onSubmit={submit} noValidate>
        <section class="card card-pad stack">
          <Field label={t('Name')} error={err.name}>
            {(id, d) => <input id={id} class="input" value={name} maxLength={64} aria-describedby={d} onInput={(e) => setName(e.currentTarget.value)} />}
          </Field>
          <Field label={t('Summary')} hint={`${summary.length}/200`} error={err.summary}>
            {(id, d) => <textarea id={id} class="textarea" rows={2} maxLength={200} value={summary} aria-describedby={d} onInput={(e) => setSummary(e.currentTarget.value)} />}
          </Field>
          <Field label="URL" hint={owner ? t('Changing this breaks old links.') : t('Only the owner can change this.')} error={err.slug}>
            {(id, d) => (
              <div class="input-group">
                <span class="input-prefix">{SITE.domain}/project/</span>
                <input id={id} class="input" value={slug} maxLength={48} disabled={!owner} aria-describedby={d} onInput={(e) => setSlug(e.currentTarget.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))} />
              </div>
            )}
          </Field>
          <div class="field">
            <span class="field-label">
              {t('Categories')} <span class="optional">{t('Up to 5')}</span>
            </span>
            <div class="chips">
              {categoriesFor(p.type).map((c) => (
                <button
                  key={c.id}
                  type="button"
                  class="chip"
                  aria-pressed={categories.includes(c.id)}
                  disabled={!categories.includes(c.id) && categories.length >= 5}
                  onClick={() => setCategories((cur) => (cur.includes(c.id) ? cur.filter((x) => x !== c.id) : [...cur, c.id]))}
                >
                  {t(c.label)}
                </button>
              ))}
            </div>
          </div>
          <div class="form-row">
            <Field label={t('License')}>
              {(id) => (
                <select id={id} class="select" value={license} onChange={(e) => setLicense(e.currentTarget.value)}>
                  {LICENSES.map((l) => (
                    <option key={l.id} value={l.id}>
                      {t(l.label)}
                    </option>
                  ))}
                </select>
              )}
            </Field>
            <Field label={t('License link')} optional={license !== 'LicenseRef-Custom'} error={err.licenseUrl}>
              {(id, d) => <input id={id} class="input" type="url" value={licenseUrl} placeholder="https://" aria-describedby={d} onInput={(e) => setLicenseUrl(e.currentTarget.value.trim())} />}
            </Field>
          </div>
          {(p.type === 'mod' || p.type === 'modpack') && (
            <div class="form-row">
              <Field label={t('Client side')}>
                {(id) => (
                  <select id={id} class="select" value={clientSide} onChange={(e) => setClientSide(e.currentTarget.value as typeof clientSide)}>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {sideLabel[s]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
              <Field label={t('Server side')}>
                {(id) => (
                  <select id={id} class="select" value={serverSide} onChange={(e) => setServerSide(e.currentTarget.value as typeof serverSide)}>
                    {SIDES.map((s) => (
                      <option key={s} value={s}>
                        {sideLabel[s]}
                      </option>
                    ))}
                  </select>
                )}
              </Field>
            </div>
          )}
        </section>
        <div class="form-foot">
          <button type="submit" class="btn btn-primary" disabled={busy}>
            {busy && <Spinner />} {t('Save changes')}
          </button>
        </div>
      </form>
      <section class="card card-pad stack">
        <h3>{p.archived ? t('This project is archived') : t('Archive this project')}</h3>
        <p class="muted">
          {p.archived
            ? t('The page shows that you’ve stopped working on it. Files still download and verify.')
            : t('Let players know you’ve stopped working on it. Files keep downloading and verifying, and you can unarchive any time.')}
        </p>
        <div>
          <button type="button" class="btn" disabled={busy} onClick={() => save({ archived: !p.archived })}>
            <Icon name={p.archived ? 'refresh' : 'package'} /> {p.archived ? t('Unarchive') : t('Archive')}
          </button>
        </div>
      </section>
    </div>
  );
}

function Description({ m, reload }: { m: Manage; reload: () => void }) {
  const [save, busy] = useSaver(m.project.id, reload);
  const [text, setText] = useState(m.project.description);
  if (!has(m.perms, PERM.EDIT_BODY)) return <NoAccess what={t('the description')} />;
  return (
    <form
      class="stack"
      onSubmit={(e) => {
        e.preventDefault();
        void save({ description: text });
      }}
    >
      <section class="card card-pad">
        <Field label={t('Description')} hint={t('Markdown. Images must use https links.')}>
          {(id, d) => <MarkdownEditor id={id} describedBy={d} value={text} onInput={setText} maxLength={SITE.limits.descriptionMaxChars} rows={20} />}
        </Field>
      </section>
      <div class="form-foot">
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy && <Spinner />} {t('Save description')}
        </button>
      </div>
    </form>
  );
}

const LINK_FIELDS = [
  ['sourceUrl', 'source', 'Source code'],
  ['issuesUrl', 'issues', 'Issue tracker'],
  ['wikiUrl', 'wiki', 'Wiki'],
  ['discordUrl', 'discord', 'Discord invite'],
  ['donationUrl', 'donation', 'Donation page'],
] as const;

function Links({ m, reload }: { m: Manage; reload: () => void }) {
  const [save, busy, errors] = useSaver(m.project.id, reload);
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(LINK_FIELDS.map(([k, l]) => [k, m.project.links[l] ?? ''])));
  const [local, setLocal] = useState<Record<string, string>>({});
  if (!has(m.perms, PERM.EDIT_DETAILS)) return <NoAccess what={t('links')} />;
  const submit = (e: Event) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    for (const [k] of LINK_FIELDS) {
      const v = validateHttpsUrl(values[k]);
      if (v) errs[k] = v;
    }
    setLocal(errs);
    if (!Object.keys(errs).length) void save(Object.fromEntries(LINK_FIELDS.map(([k]) => [k, values[k] || null])));
  };
  return (
    <form class="stack" onSubmit={submit} noValidate>
      <section class="card card-pad stack">
        {LINK_FIELDS.map(([k, , label]) => (
          <Field key={k} label={t(label)} optional error={local[k] ?? errors[k]}>
            {(id, d) => <input id={id} class="input" type="url" placeholder="https://" value={values[k]} aria-describedby={d} onInput={(e) => setValues({ ...values, [k]: e.currentTarget.value.trim() })} />}
          </Field>
        ))}
      </section>
      <div class="form-foot">
        <button type="submit" class="btn btn-primary" disabled={busy}>
          {busy && <Spinner />} {t('Save links')}
        </button>
      </div>
    </form>
  );
}

function pickImage(maxBytes: number, onPick: (f: File) => void) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/png,image/jpeg,image/gif,image/webp';
  input.onchange = () => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > maxBytes) {
      toast('error', t('Image too large'), t('The limit is {size} KB.', { size: Math.round(maxBytes / 1024) }));
      return;
    }
    onPick(f);
  };
  input.click();
}

function Media({ m, reload }: { m: Manage; reload: () => void }) {
  const p = m.project;
  const [busy, setBusy] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  if (!has(m.perms, PERM.EDIT_DETAILS)) return <NoAccess what={t('images')} />;
  const send = async (kind: 'icon' | 'banner' | 'gallery', f: File) => {
    setBusy(kind);
    try {
      const path = kind === 'gallery' ? `/api/projects/${p.id}/gallery${title.trim() ? `?title=${encodeURIComponent(title.trim())}` : ''}` : `/api/projects/${p.id}/${kind}`;
      await upload(kind === 'gallery' ? 'POST' : 'PUT', path, f, () => undefined, f.type || 'application/octet-stream');
      toast('success', kind === 'icon' ? t('Icon updated') : kind === 'banner' ? t('Banner updated') : t('Image added'), t('It was committed to your repository.'));
      setTitle('');
      reload();
    } catch (e) {
      errorToast(e, t('Upload failed'));
    } finally {
      setBusy(null);
    }
  };
  const remove = async (path: string, label: string) => {
    try {
      await api('DELETE', path);
      toast('success', t('{what} removed', { what: label }));
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <section class="card card-pad">
        <div class="media-row">
          <ProjectIcon src={p.iconUrl} name={p.name} size={96} />
          <div class="stack-sm">
            <h3>{t('Icon')}</h3>
            <p class="muted">{t('Square PNG, JPEG, GIF or WebP, up to {size} KB. It’s committed to your repo under .argonite/.', { size: Math.round(SITE.limits.iconMaxBytes / 1024) })}</p>
            <div class="row-actions">
              <button type="button" class="btn btn-primary" disabled={!!busy} onClick={() => pickImage(SITE.limits.iconMaxBytes, (f) => send('icon', f))}>
                {busy === 'icon' ? <Spinner /> : <Icon name="upload" />} {t('Upload icon')}
              </button>
              {p.iconUrl && (
                <button type="button" class="btn btn-danger-soft" onClick={() => remove(`/api/projects/${p.id}/icon`, t('Icon'))}>
                  {t('Remove')}
                </button>
              )}
            </div>
          </div>
        </div>
      </section>
      <section class="card card-pad stack">
        <h3>{t('Banner')}</h3>
        {p.bannerUrl && (
          <div class="project-banner project-banner-preview">
            <VerifiedImg src={p.bannerUrl} />
          </div>
        )}
        <p class="muted">{t('A wide image shown across the top of your project page. 1600×400 works well, up to {size} KB.', { size: Math.round(SITE.limits.galleryMaxBytes / 1024) })}</p>
        <div class="row-actions">
          <button type="button" class="btn" disabled={!!busy} onClick={() => pickImage(SITE.limits.galleryMaxBytes, (f) => send('banner', f))}>
            {busy === 'banner' ? <Spinner /> : <Icon name="image" />} {p.bannerUrl ? t('Replace banner') : t('Upload banner')}
          </button>
          {p.bannerUrl && (
            <button type="button" class="btn btn-danger-soft" onClick={() => remove(`/api/projects/${p.id}/banner`, t('Banner'))}>
              {t('Remove')}
            </button>
          )}
        </div>
      </section>
      <section class="card card-pad stack">
        <div class="section-head section-head-tight">
          <h3>{t('Gallery')}</h3>
          <span class="muted">
            {p.gallery.length}/{SITE.limits.galleryMaxImages}
          </span>
        </div>
        {p.gallery.length > 0 && (
          <div class="gallery-grid gallery-grid-edit">
            {p.gallery.map((g) => (
              <figure key={g.id} class="gallery-item">
                <VerifiedImg src={g.url} alt={g.title ?? ''} loading="lazy" />
                <figcaption>
                  <span>{g.title ?? t('Untitled')}</span>
                  <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label={t('Remove image')} onClick={() => remove(`/api/projects/${p.id}/gallery/${g.id}`, t('Image'))}>
                    <Icon name="trash" />
                  </button>
                </figcaption>
              </figure>
            ))}
          </div>
        )}
        {p.gallery.length < SITE.limits.galleryMaxImages && (
          <div class="form-row form-row-end">
            <Field label={t('Caption')} optional>
              {(id) => <input id={id} class="input" value={title} maxLength={80} onInput={(e) => setTitle(e.currentTarget.value)} />}
            </Field>
            <button type="button" class="btn" disabled={!!busy} onClick={() => pickImage(SITE.limits.galleryMaxBytes, (f) => send('gallery', f))}>
              {busy === 'gallery' ? <Spinner /> : <Icon name="image" />} {t('Add image')}
            </button>
          </div>
        )}
      </section>
    </div>
  );
}

function EditVersion({ v, project, onClose, reload }: { v: Version; project: Project; onClose: () => void; reload: () => void }) {
  const info = typeInfo(project.type)!;
  const [name, setName] = useState(v.name);
  const [channel, setChannel] = useState<Channel>(v.channel);
  const [changelog, setChangelog] = useState(v.changelog);
  const [loaders, setLoaders] = useState(v.loaders);
  const [gvs, setGvs] = useState(v.gameVersions);
  const [featured, setFeatured] = useState(v.featured);
  const [deps, setDeps] = useState<DepDraft[]>(v.dependencies.map((d) => ({ projectId: d.projectId, name: d.projectName ?? d.projectId, slug: d.projectSlug ?? '', kind: d.kind })));
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!loaders.length || !gvs.length) {
      toast('error', t('Pick at least one loader and one Minecraft version.'));
      return;
    }
    setBusy(true);
    try {
      await api('PATCH', `/api/versions/${v.id}`, {
        name,
        channel,
        changelog,
        featured,
        loaders,
        gameVersions: gvs,
        dependencies: deps.map((d) => ({ projectId: d.projectId, kind: d.kind })),
      });
      toast('success', t('Version updated'));
      reload();
      onClose();
    } catch (e) {
      errorToast(e, t('Could not save'));
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      wide
      title={t('Edit {version}', { version: v.versionNumber })}
      description={t('The files themselves can’t change. Upload a new version for that.')}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" class="btn btn-primary" disabled={busy} onClick={save}>
            {busy && <Spinner />} {t('Save')}
          </button>
        </>
      }
    >
      <Field label={t('Display name')}>{(id) => <input id={id} class="input" value={name} maxLength={80} onInput={(e) => setName(e.currentTarget.value)} />}</Field>
      <div class="segmented" role="group" aria-label={t('Release channel')}>
        {CHANNELS.map((c) => (
          <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
            {t(c[0].toUpperCase() + c.slice(1))}
          </button>
        ))}
      </div>
      {info.loaders.length > 1 && (
        <div class="chips">
          {info.loaders.map((l) => (
            <button key={l} type="button" class="chip" aria-pressed={loaders.includes(l)} onClick={() => setLoaders((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))}>
              {loaderLabel(l)}
            </button>
          ))}
        </div>
      )}
      <label class="check">
        <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.currentTarget.checked)} />
        <span>{t('Feature this version')}</span>
      </label>
      <Field label={t('Minecraft versions')}>{(id) => <GameVersionPicker id={id} selected={gvs} onChange={setGvs} />}</Field>
      <Field label={t('Dependencies')}>{() => <DependencyPicker value={deps} onChange={setDeps} excludeId={project.id} />}</Field>
      <Field label={t('Changelog')}>{(id) => <MarkdownEditor id={id} value={changelog} onInput={setChangelog} maxLength={SITE.limits.changelogMaxChars} rows={8} />}</Field>
    </Modal>
  );
}

function ScanDetail({ v }: { v: Version }) {
  const { user } = useSession();
  const openFile = async (fileId: string) => {
    try {
      const r = await api<{ url: string }>('GET', `/api/mod/files/${fileId}/link`);
      window.open(r.url, '_blank', 'noopener,noreferrer');
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="scan-detail">
      {Object.entries(v.scans ?? {}).map(([id, s]) => (
        <div key={id} class="stack-sm">
          <div class="row-actions">
            <strong class="mono">{s.filename}</strong>
            <span class="badge">{t(FILE_KIND_LABELS[s.kind])}</span>
            <span class="field-hint">
              {t('Verdict')}: {s.verdict ? t(s.verdict) : s.uploaded ? t('pending') : t('not uploaded')} · {t('Engines')}: {s.engines.join(', ') || '—'}
            </span>
            {isStaff(user) && s.uploaded && (
              <button type="button" class="btn btn-ghost btn-sm" onClick={() => openFile(id)}>
                <Icon name="download" /> {t('Get file')}
              </button>
            )}
          </div>
          {s.capabilities.length > 0 && (
            <div class="chips">
              {s.capabilities.map((c) => (
                <span key={c} class="chip">
                  {c.replace(/_/g, ' ')}
                </span>
              ))}
            </div>
          )}
          <NativeList natives={s.natives ?? []} />
          {s.findings.length > 0 ? (
            <ul class="finding-list">
              {s.findings.map((f, i) => (
                <li key={i} class={`finding sev-${f.severity}`}>
                  <span class="badge">{t(f.severity)}</span>
                  <span>
                    {f.detail}
                    {f.path && <span class="mono finding-path"> {f.path}</span>}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            s.verdict && <span class="field-hint">{t('No findings.')}</span>
          )}
        </div>
      ))}
    </div>
  );
}

function Versions({ m, reload }: { m: Manage; reload: () => void }) {
  const [editing, setEditing] = useState<Version | null>(null);
  const [deleting, setDeleting] = useState<Version | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);
  const canUpload = has(m.perms, PERM.UPLOAD_VERSION);
  const canDelete = has(m.perms, PERM.DELETE_VERSION);
  const del = async () => {
    try {
      await api('DELETE', `/api/versions/${deleting!.id}`);
      toast('success', t('Version deleted'), t('Published GitHub releases stay in your repository; draft ones are cleaned up.'));
      setDeleting(null);
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  const retry = async (v: Version) => {
    setRetrying(v.id);
    try {
      const r = await api<{ status: string }>('POST', `/api/versions/${v.id}/publish`);
      toast(r.status === 'live' ? 'success' : 'info', r.status === 'live' ? t('Published') : t('Still couldn’t publish on GitHub'));
      reload();
    } catch (e) {
      errorToast(e);
    } finally {
      setRetrying(null);
    }
  };
  if (!m.versions.length) {
    return (
      <Empty icon="upload" title={t('No versions yet')}>
        {canUpload && (
          <Link href={`/project/${m.project.slug}/upload`} class="btn btn-primary">
            {t('Upload your first version')}
          </Link>
        )}
      </Empty>
    );
  }
  return (
    <div class="stack">
      <span class="muted">{t('{n} versions', { n: m.versions.length })}</span>
      <ul class="manage-list card">
        {m.versions.map((v) => {
          const files = Object.keys(v.scans ?? {}).length;
          return (
            <li key={v.id} class="manage-row">
              <div class="manage-row-main">
                <div class="manage-row-title">
                  <strong>{v.name}</strong>
                  <span class="mono muted">{v.versionNumber}</span>
                  <ChannelBadge channel={v.channel} />
                  <StatusBadge status={v.status} />
                  {v.featured && <span class="badge badge-accent">{t('Featured')}</span>}
                </div>
                <span class="field-hint">
                  {date(v.publishedAt ?? v.createdAt)} · {v.loaders.map(loaderLabel).join(', ')} · {v.gameVersions.slice(0, 4).join(', ')}
                  {v.gameVersions.length > 4 ? ` +${v.gameVersions.length - 4}` : ''}
                  {files > 1 && ` · ${tn(files, '{n} file', '{n} files')}`}
                </span>
                {v.statusReason && v.status !== 'live' && <span class="manage-reason">{v.statusReason}</span>}
                {open === v.id && <ScanDetail v={v} />}
              </div>
              <div class="row-actions">
                {v.publishPending && canUpload && (
                  <button type="button" class="btn btn-sm btn-primary" disabled={retrying === v.id} onClick={() => retry(v)}>
                    {retrying === v.id ? <Spinner /> : <Icon name="refresh" />} {t('Publish now')}
                  </button>
                )}
                <button type="button" class="btn btn-ghost btn-sm" onClick={() => setOpen(open === v.id ? null : v.id)} aria-expanded={open === v.id}>
                  {t('Scan report')}
                </button>
                {v.status === 'live' && (
                  <Link href={`/project/${m.project.slug}/version/${v.id}`} class="btn btn-ghost btn-sm btn-icon" aria-label={t('View version')}>
                    <Icon name="eye" />
                  </Link>
                )}
                {canUpload && (
                  <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label={t('Edit version')} onClick={() => setEditing(v)}>
                    <Icon name="edit" />
                  </button>
                )}
                {canDelete && (
                  <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label={t('Delete version')} onClick={() => setDeleting(v)}>
                    <Icon name="trash" />
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {editing && <EditVersion v={editing} project={m.project} onClose={() => setEditing(null)} reload={reload} />}
      {deleting && (
        <Modal
          title={t('Delete {version}?', { version: deleting.versionNumber })}
          description={t('It disappears from the site and downloads stop. A published GitHub release stays in your repository.')}
          onClose={() => setDeleting(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" onClick={del}>
                {t('Delete version')}
              </button>
            </>
          }
        >
          <span />
        </Modal>
      )}
    </div>
  );
}

interface MyOrg {
  id: string;
  slug: string;
  name: string;
  role: string;
  accepted: boolean;
  orgPermissions: number;
}

function Members({ m, reload }: { m: Manage; reload: () => void }) {
  const { user } = useSession();
  const [username, setUsername] = useState('');
  const [perms, setPerms] = useState(PERM_DEFAULT_MEMBER & m.perms);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<{ id: string; name: string; perms: number } | null>(null);
  const isOwner = m.project.author.id === user?.id;
  const orgs = useAsync(() => (isOwner ? api<{ organizations: MyOrg[] }>('GET', '/api/me/organizations') : Promise.resolve({ organizations: [] as MyOrg[] })), [isOwner]);
  const [orgId, setOrgId] = useState(m.project.org?.id ?? '');

  const invite = async (e: Event) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api('POST', `/api/projects/${m.project.id}/members`, { username: username.trim(), permissions: perms });
      toast('success', t('Invite sent'), t('{name} can accept it from their dashboard.', { name: username }));
      setUsername('');
      reload();
    } catch (err) {
      errorToast(err, t('Could not invite'));
    } finally {
      setBusy(false);
    }
  };
  const remove = async (userId: string, self: boolean) => {
    try {
      await api('DELETE', `/api/projects/${m.project.id}/members/${userId}`);
      toast('success', self ? t('You left the project') : t('Member removed'));
      if (self) navigate('/dashboard');
      else reload();
    } catch (e) {
      errorToast(e);
    }
  };
  const savePerms = async () => {
    if (!editing) return;
    try {
      await api('PATCH', `/api/projects/${m.project.id}/members/${editing.id}`, { permissions: editing.perms });
      toast('success', t('Permissions updated'));
      setEditing(null);
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  const moveOrg = async () => {
    try {
      await api('POST', `/api/projects/${m.project.id}/organization`, { orgId: orgId || null });
      toast('success', orgId ? t('Moved into the organisation') : t('Removed from the organisation'));
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <ul class="manage-list card">
        {m.project.members.map((mem) => {
          const self = mem.user.id === user?.id;
          return (
            <li key={mem.user.id} class="manage-row">
              <div class="member">
                <Avatar src={mem.user.avatarUrl} name={mem.user.username} />
                <span>
                  <strong>{mem.user.username}</strong>
                  <span>
                    {mem.role === 'owner' ? t('Owner') : t('Maintainer')}
                    {!mem.accepted && ` · ${t('invite pending')}`}
                  </span>
                </span>
              </div>
              <div class="row-actions">
                {mem.role !== 'owner' && has(m.perms, PERM.EDIT_MEMBER) && (
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => setEditing({ id: mem.user.id, name: mem.user.username, perms: mem.permissions })}>
                    {t('Permissions')}
                  </button>
                )}
                {mem.role !== 'owner' && (has(m.perms, PERM.REMOVE_MEMBER) || self) && (
                  <button type="button" class="btn btn-ghost btn-sm" onClick={() => remove(mem.user.id, self)}>
                    {self ? t('Leave') : mem.accepted ? t('Remove') : t('Cancel invite')}
                  </button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {has(m.perms, PERM.MANAGE_INVITES) && (
        <form class="card card-pad stack" onSubmit={invite}>
          <Field label={t('Invite by GitHub username')} hint={t('They must have signed in to {site} once.', { site: SITE.name })}>
            {(id, d) => <input id={id} class="input" value={username} maxLength={39} aria-describedby={d} onInput={(e) => setUsername(e.currentTarget.value)} />}
          </Field>
          <details>
            <summary>{t('Permissions for the new member')}</summary>
            <ProjectPermissionPicker value={perms} editable={m.perms} onChange={setPerms} />
          </details>
          <div class="form-foot">
            <button type="submit" class="btn btn-primary" disabled={busy || !username.trim()}>
              {t('Invite')}
            </button>
          </div>
        </form>
      )}
      {isOwner && (
        <section class="card card-pad stack">
          <h3>{t('Organisation')}</h3>
          <p class="muted">{t('Projects in an organisation are shared with all of its members, with the permissions the organisation gives them.')}</p>
          <div class="form-row form-row-end">
            <Field label={t('Owned by')}>
              {(id) => (
                <select id={id} class="select" value={orgId} onChange={(e) => setOrgId(e.currentTarget.value)}>
                  <option value="">{t('Just me')}</option>
                  {(orgs.data?.organizations ?? [])
                    .filter((o) => o.accepted)
                    .map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                </select>
              )}
            </Field>
            <button type="button" class="btn" disabled={orgId === (m.project.org?.id ?? '')} onClick={moveOrg}>
              {t('Save')}
            </button>
          </div>
          <Link href="/organizations/new" class="btn btn-ghost btn-sm">
            <Icon name="plus" /> {t('Create an organisation')}
          </Link>
        </section>
      )}
      {editing && (
        <Modal
          title={t('Permissions for {name}', { name: editing.name })}
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-primary" onClick={savePerms}>
                {t('Save')}
              </button>
            </>
          }
        >
          <ProjectPermissionPicker value={editing.perms} editable={m.perms} onChange={(v) => setEditing({ ...editing, perms: v })} />
        </Modal>
      )}
    </div>
  );
}

function Danger({ m }: { m: Manage }) {
  const [confirm, setConfirm] = useState('');
  const [open, setOpen] = useState(false);
  if (!has(m.perms, PERM.DELETE_PROJECT)) return <NoAccess what={t('whether this project exists')} />;
  const del = async () => {
    try {
      await api('DELETE', `/api/projects/${m.project.id}`, { confirm });
      toast('success', t('Project deleted'));
      navigate('/dashboard');
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <section class="card card-pad stack danger-zone">
      <h3>{t('Delete project')}</h3>
      <p class="muted">{t('The project page and all downloads go away. Your GitHub repository and its releases are not touched.')}</p>
      <div>
        <button type="button" class="btn btn-danger" onClick={() => setOpen(true)}>
          {t('Delete project')}
        </button>
      </div>
      {open && (
        <Modal
          title={t('Delete this project?')}
          description={t('Type {slug} to confirm.', { slug: m.project.slug })}
          onClose={() => setOpen(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setOpen(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" disabled={confirm !== m.project.slug} onClick={del}>
                {t('Delete forever')}
              </button>
            </>
          }
        >
          <input class="input" value={confirm} aria-label={t('Confirm project URL')} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </Modal>
      )}
    </section>
  );
}

type TabId = 'general' | 'description' | 'links' | 'media' | 'versions' | 'members' | 'publishing' | 'analytics' | 'moderation' | 'danger';

function SettingsInner({ slug }: { slug: string }) {
  const loc = useLocation();
  const { user } = useSession();
  const { data, error, loading, reload } = useAsync(() => api<Manage>('GET', `/api/projects/${encodeURIComponent(slug)}`), [slug]);
  useHead(data ? t('Settings · {name}', { name: data.project.name }) : t('Project settings'), undefined, 'noindex');
  if (loading && !data) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="lock" title={t('Project not found or you don’t have access')} />
      </div>
    );
  }
  const p = data.project;
  const staff = isStaff(user);
  if (!data.role && !staff) {
    return (
      <div class="container page">
        <Empty icon="lock" title={t('Only members can change this project')} />
      </div>
    );
  }
  const tabs: [TabId, string][] = data.role
    ? [
        ['general', t('General')],
        ['description', t('Description')],
        ['links', t('Links')],
        ['media', t('Images')],
        ['versions', t('Versions')],
        ['members', t('Members')],
        ['publishing', t('Publishing')],
        ...(has(data.perms, PERM.VIEW_ANALYTICS) ? ([['analytics', t('Analytics')]] as [TabId, string][]) : []),
        ['moderation', t('Moderation')],
        ['danger', t('Delete')],
      ]
    : [
        ['versions', t('Versions')],
        ['moderation', t('Moderation')],
      ];
  const wanted = loc.query.get('tab') as TabId | null;
  const tab: TabId = tabs.find(([id]) => id === wanted)?.[0] ?? tabs[0][0];
  const pending = data.versions.filter((v) => v.status === 'review' || v.status === 'scanning' || v.publishPending).length;
  return (
    <div class="container page">
      <Link href={`/project/${p.slug}`} class="back-link">
        <Icon name="chevronLeft" /> {t('View project')}
      </Link>
      <div class="page-head">
        <div class="settings-title">
          <ProjectIcon src={p.iconUrl} name={p.name} size={48} />
          <div>
            <h1>{p.name}</h1>
            <p class="page-sub">
              {p.status === 'draft' ? t('Draft · goes public when your first version passes its scan') : p.status === 'delisted' ? t('Delisted') : p.archived ? t('Archived') : t('Published')}
            </p>
          </div>
        </div>
        {has(data.perms, PERM.UPLOAD_VERSION) && (
          <Link href={`/project/${p.slug}/upload`} class="btn btn-primary">
            <Icon name="upload" /> {t('Upload version')}
          </Link>
        )}
      </div>
      {p.status === 'delisted' && data.statusReason && (
        <Alert kind="warning" title={t('Delisted by a moderator.')}>
          {data.statusReason}
        </Alert>
      )}
      {p.repo.status !== 'ok' && (
        <Alert kind="danger" title={t('Repository problem.')}>
          {t('{repo} is no longer available as linked. Downloads are paused. Contact {email} to sort it out.', { repo: p.repo.fullName, email: SITE.email('support') })}
        </Alert>
      )}
      <Tabs current={tab} items={tabs.map(([id, label]) => ({ id, label, count: id === 'versions' && pending ? pending : undefined, onClick: () => setQuery({ tab: id === tabs[0][0] ? null : id }) }))} />
      <div class="settings-body">
        {tab === 'general' && <General m={data} reload={reload} />}
        {tab === 'description' && <Description m={data} reload={reload} />}
        {tab === 'links' && <Links m={data} reload={reload} />}
        {tab === 'media' && <Media m={data} reload={reload} />}
        {tab === 'versions' && <Versions m={data} reload={reload} />}
        {tab === 'members' && <Members m={data} reload={reload} />}
        {tab === 'publishing' && <Publishing project={p} settings={data.autoPublish} perms={data.perms} reload={reload} />}
        {tab === 'analytics' && <Analytics project={p} />}
        {tab === 'moderation' && <ModThread project={p} />}
        {tab === 'danger' && <Danger m={data} />}
      </div>
    </div>
  );
}

export default function ProjectSettings({ params }: { params: Record<string, string> }) {
  return <RequireAuth>{() => <SettingsInner slug={params.slug} />}</RequireAuth>;
}

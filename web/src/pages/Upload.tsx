import { useEffect, useRef, useState } from 'preact/hooks';
import { versionsForPack } from '../../../shared/packformats';
import { PERM, has } from '../../../shared/permissions';
import { CHANNELS, FILE_KINDS, FILE_KIND_LABELS, loaderLabel, typeInfo, type Channel, type FileKind } from '../../../shared/taxonomy';
import type { Project, Version } from '../../../shared/types';
import { fileExtension, sanitizeFilename, validateVersionNumber } from '../../../shared/validate';
import { DependencyPicker, type DepDraft } from '../components/DependencyPicker';
import { GameVersionPicker, loadGameVersions } from '../components/GameVersionPicker';
import { Icon } from '../components/Icon';
import { MarkdownEditor } from '../components/Markdown';
import { RequireAuth } from '../components/RequireAuth';
import { Turnstile, type TurnstileHandle } from '../components/Turnstile';
import { Alert, Empty, Field, PageLoading, Spinner, StatusBadge, useAsync } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api, upload } from '../lib/api';
import { bytes } from '../lib/format';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, useLocation } from '../lib/router';
import { detectMeta, type DetectedMeta } from '../lib/zipmeta';
import { Select } from '../components/Select';

type Stage =
  | { kind: 'form' }
  | { kind: 'uploading'; versionId: string; loaded: number; total: number; file: number; files: number }
  | { kind: 'scanning'; versionId: string }
  | { kind: 'result'; version: Version };

const MAX_EXTRA = 5;
const CODE_TYPES = new Set(['mod', 'plugin', 'modpack']);

interface Extra {
  file: File;
  kind: FileKind;
}

function extraAccept(type: string, kind: FileKind): string[] {
  if (!CODE_TYPES.has(type)) return ['.zip'];
  if (kind === 'sources' || kind === 'javadoc' || kind === 'dev') return ['.jar'];
  if (kind === 'server' || kind === 'client') return ['.zip', '.mrpack'];
  return ['.jar', '.zip'];
}

function guessKind(name: string, type: string): FileKind {
  const n = name.toLowerCase();
  if (!CODE_TYPES.has(type)) return 'other';
  if (n.endsWith('-sources.jar')) return 'sources';
  if (n.endsWith('-javadoc.jar')) return 'javadoc';
  if (/-(dev|deobf)\.jar$/.test(n)) return 'dev';
  if (/server/.test(n)) return 'server';
  return 'other';
}

function FileDrop({ accept, file, onFile, error, compact }: { accept: string[]; file: File | null; onFile: (f: File) => void; error?: string; compact?: boolean }) {
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  return (
    <div
      class={`dropzone${over ? ' is-over' : ''}${file ? ' has-file' : ''}${error ? ' has-error' : ''}${compact ? ' dropzone-compact' : ''}`}
      onDragOver={(e) => {
        e.preventDefault();
        setOver(true);
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const f = e.dataTransfer?.files?.[0];
        if (f) onFile(f);
      }}
    >
      <input ref={input} type="file" class="sr-only" accept={accept.join(',')} onChange={(e) => e.currentTarget.files?.[0] && onFile(e.currentTarget.files[0])} />
      <span class="dropzone-icon">
        <Icon name={file ? 'file' : 'upload'} />
      </span>
      {file ? (
        <div class="dropzone-text">
          <strong>{file.name}</strong>
          <span>{bytes(file.size)}</span>
        </div>
      ) : (
        <div class="dropzone-text">
          <strong>{t('Drop your {types} file here', { types: accept.join(' / ') })}</strong>
          <span>{t('Up to {size}', { size: bytes(SITE.limits.fileMaxBytes) })}</span>
        </div>
      )}
      <button type="button" class="btn" onClick={() => input.current?.click()}>
        {file ? t('Choose another') : t('Choose file')}
      </button>
      {error && <span class="field-error dropzone-error">{error}</span>}
    </div>
  );
}

function ScanResult({ version, project, onAnother }: { version: Version; project: Project; onAnother: () => void }) {
  const s = version.status;
  const scans = Object.values(version.scans ?? {});
  const findings = scans.flatMap((x) => x.findings.map((f) => ({ ...f, file: x.kind === 'primary' ? null : x.filename })));
  return (
    <section class="card card-pad stack result-card">
      <StatusBadge status={s} />
      <h2>
        {s === 'live'
          ? t('Your version is live')
          : s === 'review'
            ? t('Waiting for a moderator')
            : s === 'rejected'
              ? t('This upload was rejected')
              : version.publishPending
                ? t('Passed, publishing on GitHub')
                : t('Upload status')}
      </h2>
      <p class="muted">
        {s === 'live'
          ? t('It passed the scan, its GitHub release is now published, and players can download it.')
          : s === 'review'
            ? t('A moderator will take a quick look before it goes live. Its GitHub release stays a draft until then.')
            : (version.statusReason ?? t('Check your dashboard for details.'))}
      </p>
      {findings.length > 0 && (
        <ul class="finding-list">
          {findings.slice(0, 10).map((f, i) => (
            <li key={i} class={`finding sev-${f.severity}`}>
              <span class="badge">{t(f.severity)}</span>
              <span>
                {f.detail}
                {f.file && <span class="muted"> ({f.file})</span>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <div class="row-actions">
        <Link href={s === 'live' ? `/project/${project.slug}/version/${version.id}` : `/project/${project.slug}/settings?tab=versions`} class="btn btn-primary">
          {s === 'live' ? t('View version') : t('Manage versions')}
        </Link>
        <button type="button" class="btn" onClick={onAnother}>
          {t('Upload another')}
        </button>
      </div>
    </section>
  );
}

// Things worth fixing before the scanner has to say so.
function Warnings({ meta, type }: { meta: DetectedMeta | null; type: string }) {
  if (!meta) return null;
  const out: { kind: 'danger' | 'warning' | 'info'; text: string }[] = [];
  if (!CODE_TYPES.has(type) && meta.hasCode) out.push({ kind: 'danger', text: t('This file contains Java code or programs. Resource packs, data packs and shaders can’t include any, so it would be rejected.') });
  if (meta.wrappedFolder) out.push({ kind: 'warning', text: t('Everything is inside a “{folder}” folder. Zip the folder’s contents instead, or Minecraft won’t find it.', { folder: meta.wrappedFolder }) });
  if (type === 'mod' && !meta.loaders.length) out.push({ kind: 'warning', text: t('No loader metadata was found in this jar. Mods without it are held for a moderator.') });
  if (type === 'resourcepack' && !meta.hasAssets) out.push({ kind: 'info', text: t('No assets folder was found. Is this really a resource pack?') });
  if (type === 'datapack' && !meta.hasData) out.push({ kind: 'info', text: t('No data folder was found. Is this really a data pack?') });
  if (type === 'shader' && !meta.hasShaders && !meta.hasAssets) out.push({ kind: 'info', text: t('No shaders folder was found. Is this really a shader pack?') });
  return (
    <>
      {out.map((w, i) => (
        <Alert key={i} kind={w.kind}>
          {w.text}
        </Alert>
      ))}
    </>
  );
}

function UploadForm({ slug, onReset }: { slug: string; onReset: () => void }) {
  const loc = useLocation();
  const { data, error, loading } = useAsync(() => api<{ project: Project; role: string | null; perms: number }>('GET', `/api/projects/${encodeURIComponent(slug)}`), [slug]);
  useHead(data ? t('Upload · {name}', { name: data.project.name }) : t('Upload'), undefined, 'noindex');

  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | undefined>();
  const [meta, setMeta] = useState<DetectedMeta | null>(null);
  const [extras, setExtras] = useState<Extra[]>([]);
  const [extraError, setExtraError] = useState<string | undefined>();
  const [versionNumber, setVersionNumber] = useState('');
  const [name, setName] = useState('');
  const [channel, setChannel] = useState<Channel>('release');
  const [featured, setFeatured] = useState(false);
  const [loaders, setLoaders] = useState<string[]>([]);
  const [gameVersions, setGameVersions] = useState<string[]>([]);
  const [packSuggestion, setPackSuggestion] = useState<string[]>([]);
  const [deps, setDeps] = useState<DepDraft[]>([]);
  const [changelog, setChangelog] = useState('');
  const [token, setToken] = useState<string | null>(null);
  const turnstile = useRef<TurnstileHandle | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [stage, setStage] = useState<Stage>({ kind: 'form' });
  const pending = useRef<{ id: string; files: { id: string; filename: string }[] } | null>(null);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );

  const info = data ? typeInfo(data.project.type)! : null;
  useEffect(() => {
    if (info && info.loaders.length === 1) setLoaders(info.loaders);
  }, [info?.id]);

  const checkFile = (f: File, allowed: string[]): string | undefined => {
    if (!allowed.includes(fileExtension(f.name))) return t('This file must be a {types} file.', { types: allowed.join(' / ') });
    if (f.size > SITE.limits.fileMaxBytes) return t('That file is {size}; the limit is {limit}.', { size: bytes(f.size), limit: bytes(SITE.limits.fileMaxBytes) });
    if (f.size < 22) return t('That file is empty.');
    return undefined;
  };

  const pickFile = async (f: File) => {
    if (!info) return;
    const err = checkFile(f, info.extensions);
    setFileError(err);
    if (err) return;
    setFile(f);
    const m = await detectMeta(f);
    setMeta(m);
    if (m.versionNumber && !versionNumber && !validateVersionNumber(m.versionNumber)) setVersionNumber(m.versionNumber);
    const fitting = m.loaders.filter((l) => info.loaders.includes(l));
    if (fitting.length && !loaders.length) setLoaders(fitting);
    const known = (await loadGameVersions().catch(() => [])).map((g) => g.id);
    if (m.gameVersions.length && !gameVersions.length) {
      const set = new Set(known);
      setGameVersions(m.gameVersions.filter((g) => set.has(g)));
    }
    if (m.packFormat && (info.id === 'resourcepack' || info.id === 'datapack' || info.id === 'shader')) {
      setPackSuggestion(versionsForPack(info.id === 'datapack' ? 'data' : 'resource', m.packFormat, known));
    } else {
      setPackSuggestion([]);
    }
  };

  const addExtra = (f: File) => {
    if (!data) return;
    setExtraError(undefined);
    if (extras.length >= MAX_EXTRA) return setExtraError(t('A version can have up to {n} extra files.', { n: MAX_EXTRA }));
    const kind = guessKind(f.name, data.project.type);
    const err = checkFile(f, extraAccept(data.project.type, kind));
    if (err) return setExtraError(err);
    if (file && f.name === file.name) return setExtraError(t('Each file needs a different name.'));
    if (extras.some((x) => x.file.name === f.name)) return setExtraError(t('Each file needs a different name.'));
    setExtras((list) => [...list, { file: f, kind }]);
  };

  const poll = async (versionId: string) => {
    setStage({ kind: 'scanning', versionId });
    const started = Date.now();
    while (alive.current) {
      await new Promise((r) => setTimeout(r, Date.now() - started < 60_000 ? 3000 : 8000));
      if (!alive.current) return;
      try {
        const { version } = await api<{ version: Version }>('GET', `/api/versions/${versionId}`);
        if (version.status !== 'scanning' && version.status !== 'uploading') {
          setStage({ kind: 'result', version });
          return;
        }
      } catch {
        // Keep polling through blips; the scan result is stored server-side either way.
      }
      if (Date.now() - started > 20 * 60_000) return;
    }
  };

  const sendFiles = async (versionId: string, targets: { id: string; filename: string }[]) => {
    const blobs = [file!, ...extras.map((x) => x.file)];
    const total = blobs.reduce((n, b) => n + b.size, 0);
    let done = 0;
    for (let i = 0; i < targets.length; i++) {
      const blob = blobs[i];
      const type = fileExtension(blob.name) === '.jar' ? 'application/java-archive' : 'application/zip';
      setStage({ kind: 'uploading', versionId, loaded: done, total, file: i + 1, files: targets.length });
      await upload('PUT', `/api/files/${targets[i].id}`, blob, (p) => setStage({ kind: 'uploading', versionId, loaded: done + p.loaded, total, file: i + 1, files: targets.length }), type);
      done += blob.size;
    }
    pending.current = null;
    void poll(versionId);
  };

  const submit = async (e: Event) => {
    e.preventDefault();
    setFormError(null);
    const errs: Record<string, string> = {};
    if (!file) errs.file = t('Choose a file to upload.');
    const vn = validateVersionNumber(versionNumber);
    if (vn) errs.versionNumber = vn;
    if (!loaders.length) errs.loaders = t('Pick at least one.');
    if (!gameVersions.length) errs.gameVersions = t('Pick at least one Minecraft version.');
    setErrors(errs);
    setFileError(errs.file);
    if (Object.keys(errs).length || !data || !file) return;
    try {
      if (!pending.current) {
        const res = await api<{ id: string; files: { id: string; filename: string }[] }>('POST', `/api/projects/${data.project.id}/versions`, {
          versionNumber,
          name: name || versionNumber,
          channel,
          featured,
          loaders,
          gameVersions,
          changelog,
          dependencies: deps.map((d) => ({ projectId: d.projectId, kind: d.kind })),
          files: [
            { filename: sanitizeFilename(file.name, info!.extensions) ?? file.name, size: file.size, kind: 'primary' },
            ...extras.map((x) => ({ filename: sanitizeFilename(x.file.name, extraAccept(data.project.type, x.kind)) ?? x.file.name, size: x.file.size, kind: x.kind })),
          ],
          turnstileToken: token,
        });
        pending.current = { id: res.id, files: res.files };
      }
      await sendFiles(pending.current.id, pending.current.files);
    } catch (err) {
      turnstile.current?.reset();
      setStage({ kind: 'form' });
      if (err instanceof ApiError) {
        setErrors(err.fields);
        setFormError(pending.current ? `${err.message} ${t('Your details are saved; press Publish to retry the upload.')}` : err.message);
      } else setFormError(t('Upload failed. Check your connection and try again.'));
    }
  };

  if (loading) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="lock" title={t('You can’t upload to this project')}>
          <p>{error?.message}</p>
        </Empty>
      </div>
    );
  }
  if (!data.role || !has(data.perms, PERM.UPLOAD_VERSION)) {
    return (
      <div class="container page">
        <Empty icon="lock" title={t('Your role in this project doesn’t allow uploading versions')} />
      </div>
    );
  }

  const project = data.project;
  return (
    <div class="container page page-narrow">
      <Link href={`/project/${project.slug}`} class="back-link">
        <Icon name="chevronLeft" /> {project.name}
      </Link>
      <div class="page-head">
        <div>
          <h1>{t('Upload a version')}</h1>
          <p class="page-sub">
            {t('Files go to a draft release in {repo}. It’s published only after every file passes the scan.', { repo: project.repo.fullName })}
          </p>
        </div>
      </div>
      {loc.query.get('new') && stage.kind === 'form' && (
        <Alert kind="success" title={t('Project created.')}>
          {t('It stays private as a draft until your first version passes its scan.')}
        </Alert>
      )}

      {stage.kind === 'uploading' && (
        <section class="card card-pad stack progress-card">
          <h2>{stage.files > 1 ? t('Uploading file {n} of {total}', { n: stage.file, total: stage.files }) : t('Uploading to GitHub')}</h2>
          <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={stage.total} aria-valuenow={stage.loaded}>
            <span style={{ width: `${Math.round((stage.loaded / Math.max(stage.total, 1)) * 100)}%` }} />
          </div>
          <span class="field-hint">{t('{loaded} of {total}. Keep this tab open.', { loaded: bytes(stage.loaded), total: bytes(stage.total) })}</span>
        </section>
      )}
      {stage.kind === 'scanning' && (
        <section class="card card-pad stack progress-card">
          <div class="scan-anim">
            <Spinner />
            <h2>{t('Scanning your files')}</h2>
          </div>
          <p class="muted">
            {t('We’re scanning your files. This can take from a few minutes up to about an hour. You can leave this page; the result also appears on your dashboard.')}
          </p>
        </section>
      )}
      {stage.kind === 'result' && <ScanResult version={stage.version} project={project} onAnother={onReset} />}

      {stage.kind === 'form' && (
        <form class="stack-lg" onSubmit={submit} noValidate>
          <section class="card card-pad stack">
            <FileDrop accept={info!.extensions} file={file} onFile={pickFile} error={fileError} />
            <Warnings meta={meta} type={project.type} />
            <details class="extra-files" open={extras.length > 0}>
              <summary>
                {t('Extra files')} <span class="optional">{t('Optional')}</span>
              </summary>
              <p class="field-hint">
                {CODE_TYPES.has(project.type) ? t('Sources, javadoc, development builds or a server pack. Each one is scanned and signed like the main file.') : t('Alternative versions of the pack, such as a lower resolution. Each one is scanned and signed like the main file.')}
              </p>
              {extras.length > 0 && (
                <ul class="extra-list">
                  {extras.map((x, i) => (
                    <li key={x.file.name}>
                      <Icon name="file" />
                      <span class="extra-name">
                        <strong>{x.file.name}</strong>
                        <span class="muted">{bytes(x.file.size)}</span>
                      </span>
                      {CODE_TYPES.has(project.type) && (
                        <Select
                          class="select select-sm"
                          value={x.kind}
                          aria-label={t('File type')}
                          onChange={(v) => {
                            const kind = v as FileKind;
                            if (!extraAccept(project.type, kind).includes(fileExtension(x.file.name))) {
                              setExtraError(t('That file type doesn’t fit a {kind}.', { kind: t(FILE_KIND_LABELS[kind]).toLowerCase() }));
                              return;
                            }
                            setExtras((list) => list.map((y, j) => (j === i ? { ...y, kind } : y)));
                          }}
                        >
                          {FILE_KINDS.filter((k) => k !== 'primary').map((k) => (
                            <option key={k} value={k}>
                              {t(FILE_KIND_LABELS[k])}
                            </option>
                          ))}
                        </Select>
                      )}
                      <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label={t('Remove {name}', { name: x.file.name })} onClick={() => setExtras((list) => list.filter((_, j) => j !== i))}>
                        <Icon name="x" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {extras.length < MAX_EXTRA && (
                <FileDrop accept={CODE_TYPES.has(project.type) ? ['.jar', '.zip', '.mrpack'] : ['.zip']} file={null} onFile={addExtra} error={extraError} compact />
              )}
            </details>
          </section>
          <section class="card card-pad stack">
            <h2 class="form-section-title">{t('Version details')}</h2>
            <div class="form-row">
              <Field label={t('Version number')} hint={t('Used as the GitHub release tag.')} error={errors.versionNumber}>
                {(id, d) => (
                  <input id={id} class="input mono-ish" value={versionNumber} maxLength={64} placeholder="1.0.0" aria-describedby={d} aria-invalid={!!errors.versionNumber} onInput={(e) => setVersionNumber(e.currentTarget.value.trim())} />
                )}
              </Field>
              <Field label={t('Display name')} optional>
                {(id) => <input id={id} class="input" value={name} maxLength={80} placeholder={versionNumber || t('Defaults to the version number')} onInput={(e) => setName(e.currentTarget.value)} />}
              </Field>
            </div>
            <div class="field">
              <span class="field-label">{t('Release channel')}</span>
              <div class="segmented" role="group" aria-label={t('Release channel')}>
                {CHANNELS.map((c) => (
                  <button key={c} type="button" aria-pressed={channel === c} onClick={() => setChannel(c)}>
                    {t(c[0].toUpperCase() + c.slice(1))}
                  </button>
                ))}
              </div>
            </div>
            {info!.loaders.length > 1 && (
              <div class="field">
                <span class="field-label">{project.type === 'plugin' ? t('Platforms') : t('Loaders')}</span>
                <div class="chips">
                  {info!.loaders.map((l) => (
                    <button key={l} type="button" class="chip" aria-pressed={loaders.includes(l)} onClick={() => setLoaders((cur) => (cur.includes(l) ? cur.filter((x) => x !== l) : [...cur, l]))}>
                      {loaderLabel(l)}
                    </button>
                  ))}
                </div>
                {project.type === 'mod' && <span class="field-hint">{t('Pick every loader it runs on, including through compatibility layers like Sinytra Connector.')}</span>}
                {errors.loaders && <span class="field-error">{errors.loaders}</span>}
              </div>
            )}
            <Field label={t('Minecraft versions')} error={errors.gameVersions}>
              {(id, d) => <GameVersionPicker id={id} describedBy={d} selected={gameVersions} onChange={setGameVersions} />}
            </Field>
            {packSuggestion.length > 0 && packSuggestion.some((g) => !gameVersions.includes(g)) && (
              <Alert kind="info">
                {t('This pack’s pack_format matches {versions}.', { versions: packSuggestion.length > 4 ? `${packSuggestion[packSuggestion.length - 1]}–${packSuggestion[0]}` : packSuggestion.join(', ') })}{' '}
                <button type="button" class="btn btn-sm" onClick={() => setGameVersions((cur) => [...new Set([...cur, ...packSuggestion])])}>
                  {t('Add them')}
                </button>
              </Alert>
            )}
            <label class="check">
              <input type="checkbox" checked={featured} onChange={(e) => setFeatured(e.currentTarget.checked)} />
              <span>
                {t('Feature this version')}
                <span class="field-hint">{t('Featured versions are pinned on the project page. Up to 5.')}</span>
              </span>
            </label>
          </section>
          <section class="card card-pad stack">
            <h2 class="form-section-title">{t('Dependencies')}</h2>
            <DependencyPicker value={deps} onChange={setDeps} excludeId={project.id} />
          </section>
          <section class="card card-pad stack">
            <Field label={t('Changelog')} optional>
              {(id, d) => <MarkdownEditor id={id} describedBy={d} value={changelog} onInput={setChangelog} maxLength={SITE.limits.changelogMaxChars} rows={8} placeholder={t('What changed in this version?')} />}
            </Field>
          </section>
          {formError && <Alert kind="danger">{formError}</Alert>}
          <div class="form-foot">
            <Turnstile onToken={setToken} handle={turnstile} />
            <button type="submit" class="btn btn-primary btn-lg" disabled={!token && !pending.current}>
              <Icon name="upload" /> {t('Publish version')}
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

export default function Upload({ params }: { params: Record<string, string> }) {
  const [round, setRound] = useState(0);
  return (
    <RequireAuth>
      {() => (
        <UploadForm
          key={round}
          slug={params.slug}
          onReset={() => {
            setRound((r) => r + 1);
            window.scrollTo({ top: 0 });
          }}
        />
      )}
    </RequireAuth>
  );
}

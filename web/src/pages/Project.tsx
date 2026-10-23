import { useEffect, useMemo, useState } from 'preact/hooks';
import { sortGameVersionsDesc } from '../../../shared/gameversions';
import { PERM, has } from '../../../shared/permissions';
import { projectHead } from '../../../shared/seo';
import { FILE_KIND_LABELS, categoryLabel, licenseLabel, loaderLabel, typeInfo } from '../../../shared/taxonomy';
import type { FileInfo, Project, ProjectSummary, Version } from '../../../shared/types';
import { AddToCollection } from '../components/AddToCollection';
import { Comments } from '../components/Comments';
import { DownloadButton } from '../components/DownloadButton';
import { Icon, type IconName } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { PackContents } from '../components/PackContents';
import { ReportDialog } from '../components/ReportDialog';
import { Alert, Avatar, ChannelBadge, CopyField, Empty, Menu, Modal, PageLoading, ProjectIcon, Spinner, Tabs, useAsync } from '../components/ui';
import { SITE, API_URL } from '../config';
import { ApiError, api, loginUrl, pub } from '../lib/api';
import { signatureValid } from '../lib/download';
import { ago, bytes, count, date, number } from '../lib/format';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { Link, navigate, useLocation } from '../lib/router';
import { errorToast, isStaff, toast, useSession } from '../lib/store';

type Tab = 'overview' | 'versions' | 'changelog' | 'gallery' | 'contents' | 'comments' | 'version';
const TABS: Tab[] = ['versions', 'changelog', 'gallery', 'contents', 'comments'];

interface Loaded {
  project: Project;
  versions: Version[];
  draft: boolean;
  statusReason: string | null;
}

async function loadProject(slug: string, signedIn: boolean): Promise<Loaded> {
  try {
    const [project, list] = await Promise.all([pub<Project>(`/v1/projects/${encodeURIComponent(slug)}`), pub<{ versions: Version[] }>(`/v1/projects/${encodeURIComponent(slug)}/versions`)]);
    return { project, versions: list.versions, draft: false, statusReason: null };
  } catch (e) {
    // Drafts aren't public; members and moderators can still preview them through the authenticated API.
    if (!(e instanceof ApiError) || e.status !== 404 || !signedIn) throw e;
    const r = await api<{ project: Project; versions: Version[]; statusReason: string | null }>('GET', `/api/projects/${encodeURIComponent(slug)}`);
    return { project: r.project, versions: r.versions.filter((v) => v.status === 'live' && v.file), draft: true, statusReason: r.statusReason };
  }
}

// One view per project per browser session; the server also dedupes per visitor per day.
function countView(projectId: string): void {
  try {
    const key = `argonite-viewed-${projectId}`;
    if (sessionStorage.getItem(key)) return;
    sessionStorage.setItem(key, '1');
  } catch {
    // Storage blocked: still count; the server dedupes.
  }
  fetch(`${API_URL}/v1/projects/${projectId}/view`, { method: 'POST', credentials: 'omit', keepalive: true }).catch(() => undefined);
}

const QD_KEY = 'argonite-quick-download';

export function readPref(): { loader?: string; gv?: string } {
  try {
    return JSON.parse(localStorage.getItem(QD_KEY) ?? '{}') as { loader?: string; gv?: string };
  } catch {
    return {};
  }
}

function savePref(loader: string, gv: string): void {
  try {
    localStorage.setItem(QD_KEY, JSON.stringify({ loader, gv }));
  } catch {
    // Storage blocked; the picker still works for this visit.
  }
}

// Remembers the player's loader and game version across projects so the right file is one click away.
function QuickDownload({ versions, slug, project }: { versions: Version[]; slug: string; project: Project }) {
  const usable = versions.filter((v) => v.file);
  const loaders = useMemo(() => [...new Set(usable.flatMap((v) => v.loaders))], [versions]);
  const gvs = useMemo(() => sortGameVersionsDesc([...new Set(usable.flatMap((v) => v.gameVersions))]), [versions]);
  const [loader, setLoader] = useState(() => {
    const pref = readPref().loader;
    return pref && loaders.includes(pref) ? pref : (usable[0]?.loaders[0] ?? '');
  });
  const [gv, setGv] = useState(() => {
    const pref = readPref().gv;
    return pref && gvs.includes(pref) ? pref : (sortGameVersionsDesc(usable[0]?.gameVersions ?? [])[0] ?? '');
  });
  const matches = usable.filter((v) => (!loader || v.loaders.includes(loader)) && (!gv || v.gameVersions.includes(gv)));
  const pick = matches.find((v) => v.channel === 'release') ?? matches[0];

  if (!usable.length) {
    return (
      <div class="quick-dl">
        <span class="panel-title">{t('Download')}</span>
        <p class="muted">{t('No verified files yet.')}</p>
      </div>
    );
  }
  const update = (l: string, g: string) => {
    setLoader(l);
    setGv(g);
    savePref(l, g);
  };
  return (
    <div class="quick-dl">
      <div class="quick-dl-pickers">
        {loaders.length > 1 && (
          <label>
            <span class="panel-title">{project.type === 'plugin' ? t('Platform') : t('Loader')}</span>
            <select class="select" value={loader} onChange={(e) => update(e.currentTarget.value, gv)}>
              {loaders.map((l) => (
                <option key={l} value={l}>
                  {loaderLabel(l)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          <span class="panel-title">Minecraft</span>
          <select class="select" value={gv} onChange={(e) => update(loader, e.currentTarget.value)}>
            {gvs.map((g) => (
              <option key={g} value={g}>
                {g}
              </option>
            ))}
          </select>
        </label>
      </div>
      {pick ? (
        <>
          <DownloadButton version={pick} label={t('Download {version}', { version: pick.versionNumber })} size="btn-lg" variant="btn-primary btn-block" />
          <span class="quick-dl-meta">
            <ChannelBadge channel={pick.channel} />
            <span>
              {bytes(pick.file!.size)} · {date(pick.publishedAt)}
            </span>
            <Link href={`/project/${slug}/version/${pick.id}`}>{t('Details')}</Link>
          </span>
        </>
      ) : (
        <p class="quick-dl-empty">
          {t('No file for {loader} on {version}.', { loader: loaderLabel(loader), version: gv })} <Link href={`/project/${slug}/versions`}>{t('See all versions')}</Link>
        </p>
      )}
    </div>
  );
}

function FollowButton({ project, initial }: { project: Project; initial: boolean | null }) {
  const { user } = useSession();
  const loc = useLocation();
  const [following, setFollowing] = useState<boolean | null>(initial);
  const [count_, setCount] = useState(project.follows);
  useEffect(() => setFollowing(initial), [initial]);
  if (!user) {
    return (
      <a class="btn" href={loginUrl(loc.path)}>
        <Icon name="heart" /> {t('Follow')}
      </a>
    );
  }
  const toggle = async () => {
    const next = !following;
    setFollowing(next);
    setCount((c) => c + (next ? 1 : -1));
    try {
      await api(next ? 'PUT' : 'DELETE', `/api/projects/${project.id}/follow`);
    } catch (e) {
      setFollowing(!next);
      setCount((c) => c + (next ? -1 : 1));
      errorToast(e, t('Could not update follow'));
    }
  };
  return (
    <button type="button" class={`btn${following ? ' btn-soft' : ''}`} aria-pressed={!!following} onClick={toggle} disabled={following === null}>
      <Icon name="heart" class={following ? 'icon-filled' : ''} />
      {following ? t('Following') : t('Follow')}
      <span class="btn-count">{count(count_)}</span>
    </button>
  );
}

function ModerateProject({ project, onDone }: { project: Project; onDone: () => void }) {
  const [action, setAction] = useState<'delisted' | 'removed' | 'active' | null>(null);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/mod/projects/${project.id}/status`, { status: action, reason, resetRepo: action === 'active' });
      toast('success', t('Project updated'));
      setAction(null);
      onDone();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <div class="menu-sep" />
      <Link class="menu-item" href={`/project/${project.slug}/settings?tab=moderation`}>
        <Icon name="message" /> {t('Message the team')}
      </Link>
      <button type="button" class="menu-item" onClick={() => setAction('active')}>
        <Icon name="refresh" /> {t('Restore listing')}
      </button>
      <button type="button" class="menu-item" onClick={() => setAction('delisted')}>
        <Icon name="eye" /> {t('Delist')}
      </button>
      <button type="button" class="menu-item danger" onClick={() => setAction('removed')}>
        <Icon name="trash" /> {t('Remove')}
      </button>
      {action && (
        <Modal
          title={action === 'active' ? t('Restore project') : action === 'delisted' ? t('Delist project') : t('Remove project')}
          description={
            action === 'removed'
              ? t('Removed projects disappear and their downloads stop.')
              : action === 'delisted'
                ? t('Delisted projects are hidden from search but stay reachable by link.')
                : t('The project becomes visible again.')
          }
          onClose={() => setAction(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setAction(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class={`btn ${action === 'active' ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (action !== 'active' && reason.trim().length < 3)} onClick={submit}>
                {t('Confirm')}
              </button>
            </>
          }
        >
          <textarea class="textarea" rows={3} placeholder={t('Reason (shown to the owner)')} value={reason} maxLength={500} onInput={(e) => setReason(e.currentTarget.value)} />
        </Modal>
      )}
    </>
  );
}

function BadgeDialog({ project, onClose }: { project: Project; onClose: () => void }) {
  const page = `${SITE.url}/project/${project.slug}`;
  const kinds: { id: string; label: string }[] = [
    { id: 'downloads', label: t('Downloads') },
    { id: 'version', label: t('Latest version') },
    { id: 'followers', label: t('Followers') },
  ];
  return (
    <Modal title={t('Badges for your README')} description={t('Live badges that link back to this page. They update about once an hour.')} onClose={onClose} wide>
      <div class="stack">
        {kinds.map((k) => {
          const img = `${API_URL}/v1/badge/${project.slug}/${k.id}.svg`;
          return (
            <div key={k.id} class="stack-sm">
              <div class="row-actions">
                <span class="aside-label">{k.label}</span>
                <img src={img} alt="" height={20} loading="lazy" />
              </div>
              <CopyField value={`[![${k.label}](${img})](${page})`} label={t('Markdown')} />
            </div>
          );
        })}
      </div>
    </Modal>
  );
}

function UsedBy({ project }: { project: Project }) {
  const { data } = useAsync(() => pub<{ projects: ProjectSummary[] }>(`/v1/projects/${project.slug}/dependents?limit=6`), [project.id]);
  if (!data?.projects.length) return null;
  return (
    <section class="card card-body">
      <h2 class="panel-title">{t('Used by')}</h2>
      <ul class="mini-list">
        {data.projects.map((p) => (
          <li key={p.id}>
            <Link href={`/project/${p.slug}`} class="mini-item">
              <ProjectIcon src={p.iconUrl} name={p.name} size={28} />
              <span>
                <strong>{p.name}</strong>
                <span class="muted">{count(p.downloads)}</span>
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Sidebar({ project, versions }: { project: Project; versions: Version[] }) {
  const gvs = sortGameVersionsDesc(project.gameVersions);
  const [allVersions, setAllVersions] = useState(false);
  const shownGvs = allVersions ? gvs : gvs.slice(0, 8);
  const featured = versions.filter((v) => v.featured).slice(0, 5);
  const links: { href: string | null; label: string; icon: IconName }[] = [
    { href: project.links.source, label: t('Source code'), icon: 'code' },
    { href: project.links.issues, label: t('Issue tracker'), icon: 'alert' },
    { href: project.links.wiki, label: t('Wiki'), icon: 'book' },
    { href: project.links.discord, label: 'Discord', icon: 'message' },
    { href: project.links.donation, label: t('Support the creator'), icon: 'gift' },
  ];
  const sides: Record<string, string> = { required: t('Required'), optional: t('Optional'), unsupported: t('Not needed'), unknown: t('Unknown') };
  return (
    <aside class="project-aside">
      <section class="card card-body">
        <h2 class="panel-title">{t('Compatibility')}</h2>
        <div class="aside-block">
          <span class="aside-label">Minecraft</span>
          <div class="chips">
            {shownGvs.length ? (
              shownGvs.map((v) => (
                <span key={v} class="chip">
                  {v}
                </span>
              ))
            ) : (
              <span class="muted">{t('No live versions yet')}</span>
            )}
            {gvs.length > 8 && (
              <button type="button" class="chip" onClick={() => setAllVersions((a) => !a)}>
                {allVersions ? t('Show fewer') : t('+{n} more', { n: gvs.length - 8 })}
              </button>
            )}
          </div>
        </div>
        {project.loaders.length > 0 && (
          <div class="aside-block">
            <span class="aside-label">{project.type === 'plugin' ? t('Platforms') : t('Loaders')}</span>
            <div class="chips">
              {project.loaders.map((l) => (
                <span key={l} class="chip">
                  {loaderLabel(l)}
                </span>
              ))}
            </div>
          </div>
        )}
        {(project.type === 'mod' || project.type === 'modpack') && (
          <dl class="kv aside-kv">
            <dt>{t('Client')}</dt>
            <dd>{sides[project.clientSide]}</dd>
            <dt>{t('Server')}</dt>
            <dd>{sides[project.serverSide]}</dd>
          </dl>
        )}
      </section>

      {featured.length > 0 && (
        <section class="card card-body">
          <h2 class="panel-title">{t('Featured versions')}</h2>
          <ul class="mini-list">
            {featured.map((v) => (
              <li key={v.id} class="featured-row">
                <Link href={`/project/${project.slug}/version/${v.id}`} class="mini-item">
                  <span>
                    <strong>{v.name}</strong>
                    <span class="muted">
                      {v.loaders.map(loaderLabel).join(', ')} · {v.gameVersions.slice(0, 2).join(', ')}
                    </span>
                  </span>
                </Link>
                <DownloadButton version={v} label="" size="btn-sm" variant="btn-soft btn-icon" />
              </li>
            ))}
          </ul>
        </section>
      )}

      <section class="card card-body">
        <h2 class="panel-title">{t('Details')}</h2>
        <dl class="kv">
          <dt>{t('License')}</dt>
          <dd>
            {project.links.license ? (
              <a href={project.links.license} target="_blank" rel="noopener noreferrer nofollow">
                {licenseLabel(project.license)}
              </a>
            ) : (
              licenseLabel(project.license)
            )}
          </dd>
          <dt>{t('Published')}</dt>
          <dd>{date(project.publishedAt)}</dd>
          <dt>{t('Updated')}</dt>
          <dd>{ago(project.updatedAt)}</dd>
          <dt>{t('Downloads')}</dt>
          <dd>{number(project.downloads)}</dd>
          <dt>{t('Views')}</dt>
          <dd>{number(project.views)}</dd>
          <dt>{t('Versions')}</dt>
          <dd>{versions.length}</dd>
        </dl>
      </section>

      {links.some((l) => l.href) && (
        <section class="card card-body">
          <h2 class="panel-title">{t('Links')}</h2>
          <ul class="link-list">
            {links
              .filter((l) => l.href)
              .map((l) => (
                <li key={l.label}>
                  <a href={l.href!} target="_blank" rel="noopener noreferrer nofollow ugc">
                    <Icon name={l.icon} />
                    {l.label}
                    <Icon name="external" class="link-ext" />
                  </a>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section class="card card-body">
        <h2 class="panel-title">{t('Creators')}</h2>
        <ul class="member-list">
          {project.org && (
            <li>
              <Link href={`/organization/${project.org.slug}`} class="member">
                <Avatar src={project.org.avatarUrl} name={project.org.name} />
                <span>
                  <strong>{project.org.name}</strong>
                  <span>{t('Organisation')}</span>
                </span>
              </Link>
            </li>
          )}
          {project.members.map((m) => (
            <li key={m.user.id}>
              <Link href={`/user/${m.user.username}`} class="member">
                <Avatar src={m.user.avatarUrl} name={m.user.username} />
                <span>
                  <strong>{m.user.username}</strong>
                  <span>{m.role === 'owner' ? t('Owner') : t('Maintainer')}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <UsedBy project={project} />

      <section class="card card-body verified-box">
        <h2 class="panel-title">{tn(2, 'File', 'Files')}</h2>
        <p>
          <Icon name="shieldCheck" />
          {t('Files live in')}{' '}
          <a href={project.repo.url} target="_blank" rel="noopener noreferrer">
            {project.repo.fullName}
          </a>
          . {t('Every download is checked against a signed fingerprint.')}
        </p>
        <Link href="/how-it-works" class="btn btn-ghost btn-sm">
          {t('How verification works')}
        </Link>
      </section>
    </aside>
  );
}

function VersionRow({ v, slug }: { v: Version; slug: string }) {
  const extras = v.files.length - 1;
  return (
    <li class="version-row">
      <Link href={`/project/${slug}/version/${v.id}`} class="version-row-main">
        <span class="version-row-title">
          <strong>{v.name}</strong>
          <ChannelBadge channel={v.channel} />
          {v.featured && (
            <span class="badge badge-accent">
              <Icon name="tag" /> {t('Featured')}
            </span>
          )}
        </span>
        <span class="version-row-meta">
          <span class="mono">{v.versionNumber}</span>
          <span>{v.loaders.map(loaderLabel).join(', ')}</span>
          <span>{v.gameVersions.slice(0, 3).join(', ') + (v.gameVersions.length > 3 ? ` +${v.gameVersions.length - 3}` : '')}</span>
          {extras > 0 && <span>{tn(extras, '+{n} file', '+{n} files')}</span>}
        </span>
      </Link>
      <span class="version-row-stats">
        <span>{date(v.publishedAt)}</span>
        <span>
          <Icon name="download" /> {count(v.downloads)}
        </span>
      </span>
      <DownloadButton version={v} label="" size="btn-sm" variant="btn-soft btn-icon" />
    </li>
  );
}

function VersionsTab({ versions, slug }: { versions: Version[]; slug: string }) {
  const [loader, setLoader] = useState('');
  const [gv, setGv] = useState('');
  const [channel, setChannel] = useState('');
  const loaders = useMemo(() => [...new Set(versions.flatMap((v) => v.loaders))], [versions]);
  const gvs = useMemo(() => sortGameVersionsDesc([...new Set(versions.flatMap((v) => v.gameVersions))]), [versions]);
  const shown = versions.filter((v) => (!loader || v.loaders.includes(loader)) && (!gv || v.gameVersions.includes(gv)) && (!channel || v.channel === channel));
  if (!versions.length) return <Empty icon="package" title={t('No versions yet')} />;
  return (
    <div class="stack">
      <div class="version-filters">
        <select class="select" value={loader} onChange={(e) => setLoader(e.currentTarget.value)} aria-label={t('Filter by loader')}>
          <option value="">{t('All loaders')}</option>
          {loaders.map((l) => (
            <option key={l} value={l}>
              {loaderLabel(l)}
            </option>
          ))}
        </select>
        <select class="select" value={gv} onChange={(e) => setGv(e.currentTarget.value)} aria-label={t('Filter by game version')}>
          <option value="">{t('All game versions')}</option>
          {gvs.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <select class="select" value={channel} onChange={(e) => setChannel(e.currentTarget.value)} aria-label={t('Filter by channel')}>
          <option value="">{t('All channels')}</option>
          <option value="release">{t('Release')}</option>
          <option value="beta">{t('Beta')}</option>
          <option value="alpha">{t('Alpha')}</option>
        </select>
      </div>
      {shown.length ? (
        <ul class="version-list card">
          {shown.map((v) => (
            <VersionRow key={v.id} v={v} slug={slug} />
          ))}
        </ul>
      ) : (
        <Empty icon="filter" title={t('No versions match those filters')} />
      )}
    </div>
  );
}

function ChangelogTab({ versions, slug }: { versions: Version[]; slug: string }) {
  const [limit, setLimit] = useState(15);
  if (!versions.length) return <Empty icon="book" title={t('No versions yet')} />;
  return (
    <div class="stack">
      <ol class="changelog">
        {versions.slice(0, limit).map((v) => (
          <li key={v.id} class="changelog-entry card card-body">
            <div class="changelog-head">
              <Link href={`/project/${slug}/version/${v.id}`}>
                <strong>{v.name}</strong>
              </Link>
              <ChannelBadge channel={v.channel} />
              <span class="muted">{date(v.publishedAt)}</span>
            </div>
            <Markdown source={v.changelog} empty={t('No changelog provided.')} />
          </li>
        ))}
      </ol>
      {versions.length > limit && (
        <button type="button" class="btn btn-block" onClick={() => setLimit((l) => l + 15)}>
          {t('Show older versions')}
        </button>
      )}
    </div>
  );
}

function GalleryTab({ project }: { project: Project }) {
  const [open, setOpen] = useState<number | null>(null);
  if (!project.gallery.length) return <Empty icon="image" title={t('No images yet')} />;
  const img = open !== null ? project.gallery[open] : null;
  return (
    <>
      <div class="gallery-grid">
        {project.gallery.map((g, i) => (
          <button key={g.id} type="button" class="gallery-item" onClick={() => setOpen(i)} aria-label={g.title ?? t('Image {n}', { n: i + 1 })}>
            <img src={g.url} alt={g.title ?? ''} loading="lazy" decoding="async" referrerpolicy="no-referrer" />
            {g.title && <span>{g.title}</span>}
          </button>
        ))}
      </div>
      {img && (
        <Modal title={img.title ?? t('{name} image {n}', { name: project.name, n: open! + 1 })} onClose={() => setOpen(null)} wide>
          <img class="lightbox-img" src={img.url} alt={img.title ?? ''} referrerpolicy="no-referrer" />
          {project.gallery.length > 1 && (
            <div class="lightbox-nav">
              <button type="button" class="btn" onClick={() => setOpen((open! - 1 + project.gallery.length) % project.gallery.length)}>
                <Icon name="chevronLeft" /> {t('Previous')}
              </button>
              <button type="button" class="btn" onClick={() => setOpen((open! + 1) % project.gallery.length)}>
                {t('Next')} <Icon name="chevronRight" />
              </button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

interface Resolved {
  dependencies: { project: ProjectSummary | null; version: Version }[];
  missing: { projectId: string; name: string; slug: string }[];
}

// Finds a live version of every required dependency (and theirs) that fits the player's setup.
function DependencyFinder({ version }: { version: Version }) {
  const pref = readPref();
  const [loader, setLoader] = useState(pref.loader && version.loaders.includes(pref.loader) ? pref.loader : version.loaders[0]);
  const [gv, setGv] = useState(pref.gv && version.gameVersions.includes(pref.gv) ? pref.gv : version.gameVersions[0]);
  const [result, setResult] = useState<Resolved | null>(null);
  const [busy, setBusy] = useState(false);
  const find = async () => {
    setBusy(true);
    try {
      setResult(await pub<Resolved>(`/v1/versions/${version.id}/resolve?loader=${encodeURIComponent(loader ?? '')}&gameVersion=${encodeURIComponent(gv ?? '')}`));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack-sm dep-finder">
      <span class="aside-label">{t('Get the required dependencies')}</span>
      <div class="row-actions">
        {version.loaders.length > 1 && (
          <select class="select select-sm" value={loader} onChange={(e) => setLoader(e.currentTarget.value)} aria-label={t('Loader')}>
            {version.loaders.map((l) => (
              <option key={l} value={l}>
                {loaderLabel(l)}
              </option>
            ))}
          </select>
        )}
        <select class="select select-sm" value={gv} onChange={(e) => setGv(e.currentTarget.value)} aria-label="Minecraft">
          {version.gameVersions.map((g) => (
            <option key={g} value={g}>
              {g}
            </option>
          ))}
        </select>
        <button type="button" class="btn btn-sm" onClick={find} disabled={busy}>
          {busy ? <Spinner /> : <Icon name="search" />}
          {t('Find')}
        </button>
      </div>
      {result && (
        <ul class="dep-list">
          {result.dependencies.map((d) => (
            <li key={d.version.id}>
              <Link href={`/project/${d.project?.slug ?? ''}/version/${d.version.id}`}>{d.project?.name ?? d.version.name}</Link>
              <span class="mono"> {d.version.versionNumber}</span>
              <DownloadButton version={d.version} label="" size="btn-sm" variant="btn-soft btn-icon" />
            </li>
          ))}
          {result.missing.map((m) => (
            <li key={m.projectId} class="text-warning">
              <Link href={`/project/${m.slug}`}>{m.name}</Link> — {t('no version for this setup')}
            </li>
          ))}
          {!result.dependencies.length && !result.missing.length && <li class="muted">{t('Nothing else is required.')}</li>}
        </ul>
      )}
    </div>
  );
}

function FileCard({ version, file }: { version: Version; file: FileInfo }) {
  const [sig, setSig] = useState<boolean | null>(null);
  const [showHashes, setShowHashes] = useState(file.kind === 'primary');
  useEffect(() => {
    setSig(null);
    signatureValid(version, file).then(setSig);
  }, [file.id]);
  return (
    <div class="file-card">
      <div class="file-name">
        <Icon name="file" />
        <span>
          <strong>{file.filename}</strong>
          <span>
            {FILE_KIND_LABELS[file.kind] ? t(FILE_KIND_LABELS[file.kind]) : file.kind} · {bytes(file.size)}
          </span>
        </span>
        <DownloadButton version={version} file={file} label="" size="btn-sm" variant={file.kind === 'primary' ? 'btn-primary btn-icon' : 'btn-soft btn-icon'} />
      </div>
      <div class="sig-status">
        {sig === null ? (
          <span class="badge">{t('Checking signature…')}</span>
        ) : sig ? (
          <span class="badge badge-success">
            <Icon name="shieldCheck" /> {t('Signature valid')}
          </span>
        ) : (
          <span class="badge badge-danger">
            <Icon name="shieldAlert" /> {t('Signature invalid')}
          </span>
        )}
        <span class="field-hint">{t('Scanned {date}', { date: date(file.scannedAt) })}</span>
        {file.kind !== 'primary' && (
          <button type="button" class="btn btn-ghost btn-sm" onClick={() => setShowHashes((s) => !s)} aria-expanded={showHashes}>
            {showHashes ? t('Hide hashes') : t('Show hashes')}
          </button>
        )}
      </div>
      {showHashes && (
        <div class="stack-sm">
          <span class="aside-label">SHA-256</span>
          <CopyField value={file.sha256} label="SHA-256" />
          <span class="aside-label">SHA-512</span>
          <CopyField value={file.sha512} label="SHA-512" />
        </div>
      )}
    </div>
  );
}

function VersionView({ project, version, onReport, onChanged }: { project: Project; version: Version; onReport: () => void; onChanged: () => void }) {
  const { user } = useSession();
  const [revoking, setRevoking] = useState(false);
  const [reason, setReason] = useState('');
  const revoke = async () => {
    try {
      await api('POST', `/api/mod/versions/${version.id}/decision`, { action: 'revoke', reason });
      toast('success', t('Version revoked'), t('Downloads are blocked immediately.'));
      setRevoking(false);
      onChanged();
    } catch (e) {
      errorToast(e);
    }
  };
  const required = version.dependencies.filter((d) => d.kind === 'required');
  return (
    <div class="version-view">
      <Link href={`/project/${project.slug}/versions`} class="back-link">
        <Icon name="chevronLeft" /> {t('All versions')}
      </Link>
      <div class="version-head">
        <div>
          <div class="version-title">
            <h2>{version.name}</h2>
            <ChannelBadge channel={version.channel} />
          </div>
          <p class="muted">
            <span class="mono">{version.versionNumber}</span> · {t('published {date} by', { date: date(version.publishedAt) })}{' '}
            <Link href={`/user/${version.author.username}`}>{version.author.username}</Link>
          </p>
        </div>
        <div class="row-actions">
          <DownloadButton version={version} />
          <Menu label={t('More actions')} trigger={<Icon name="list" />}>
            {(close) => (
              <>
                {version.releaseUrl && (
                  <a class="menu-item" href={version.releaseUrl} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <Icon name="github" /> {t('View GitHub release')}
                  </a>
                )}
                <button type="button" class="menu-item" onClick={() => (close(), onReport())}>
                  <Icon name="flag" /> {t('Report version')}
                </button>
                {isStaff(user) && (
                  <button type="button" class="menu-item danger" onClick={() => (close(), setRevoking(true))}>
                    <Icon name="shieldAlert" /> {t('Revoke version')}
                  </button>
                )}
              </>
            )}
          </Menu>
        </div>
      </div>
      <div class="version-grid">
        <section class="card card-body">
          <h3 class="panel-title">{t('Changelog')}</h3>
          <Markdown source={version.changelog} empty={t('No changelog provided.')} />
        </section>
        <section class="card card-body version-file">
          <h3 class="panel-title">{tn(version.files.length, 'File', 'Files')}</h3>
          <div class="stack">
            {version.files.map((f) => (
              <FileCard key={f.id} version={version} file={f} />
            ))}
          </div>
          <dl class="kv">
            <dt>{t('Loaders')}</dt>
            <dd>{version.loaders.map(loaderLabel).join(', ')}</dd>
            <dt>Minecraft</dt>
            <dd>{version.gameVersions.join(', ')}</dd>
            <dt>{t('Downloads')}</dt>
            <dd>{number(version.downloads)}</dd>
          </dl>
          {version.dependencies.length > 0 && (
            <div class="stack-sm">
              <span class="aside-label">{t('Dependencies')}</span>
              <ul class="dep-list">
                {version.dependencies.map((d) => (
                  <li key={d.projectId}>
                    {d.projectSlug ? <Link href={`/project/${d.projectSlug}`}>{d.projectName}</Link> : d.projectName}
                    {d.versionNumber && <span class="mono"> {d.versionNumber}</span>}
                    <span class={`badge ${d.kind === 'required' ? 'badge-accent' : d.kind === 'incompatible' ? 'badge-danger' : ''}`}>{t(d.kind)}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {required.length > 0 && <DependencyFinder version={version} />}
        </section>
      </div>
      {revoking && (
        <Modal
          title={t('Revoke this version')}
          description={t('Downloads stop immediately everywhere, including launchers using the API.')}
          onClose={() => setRevoking(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setRevoking(false)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-danger" disabled={reason.trim().length < 3} onClick={revoke}>
                {t('Revoke')}
              </button>
            </>
          }
        >
          <textarea class="textarea" rows={3} placeholder={t('Reason (shown to the author)')} maxLength={500} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
        </Modal>
      )}
    </div>
  );
}

export default function ProjectPage({ params }: { params: Record<string, string> }) {
  const loc = useLocation();
  const { user, ready } = useSession();
  const slug = params.slug.toLowerCase();
  const sub = loc.path.split('/')[3] as Tab | undefined;
  const tab: Tab = params.versionId ? 'version' : sub && TABS.includes(sub) ? sub : 'overview';
  const { data, error, loading, reload } = useAsync(() => (ready ? loadProject(slug, !!user) : new Promise<Loaded>(() => undefined)), [slug, ready, user?.id]);
  const [reporting, setReporting] = useState<{ type: 'project' | 'version'; id: string; label: string } | null>(null);
  const [badges, setBadges] = useState(false);
  const [viewer, setViewer] = useState<{ following: boolean | null; role: string | null; perms: number }>({ following: null, role: null, perms: 0 });
  const head = data ? projectHead(data.project, tab, tab === 'version' ? data.versions.find((v) => v.id === params.versionId) : null) : null;
  useHead(head ? head.title : null, head?.description, head?.noindex || data?.draft ? 'noindex' : undefined);
  useEffect(() => {
    if (!user || !data) return setViewer({ following: null, role: null, perms: 0 });
    api<{ following: boolean; role: string | null; perms: number }>('GET', `/api/projects/${data.project.id}/viewer`).then(setViewer, () => setViewer({ following: false, role: null, perms: 0 }));
  }, [user?.id, data?.project.id]);
  useEffect(() => {
    if (data && data.project.slug !== slug) navigate(loc.path.replace(`/project/${params.slug}`, `/project/${data.project.slug}`), { replace: true, scroll: false });
  }, [data?.project.slug]);
  useEffect(() => {
    if (data && !data.draft) countView(data.project.id);
  }, [data?.project.id]);

  if (loading && !data) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="search" title={error instanceof ApiError && error.status === 404 ? t('Project not found') : t('Could not load this project')}>
          <p>{error instanceof ApiError && error.status === 404 ? t('It may have been removed, or the link is wrong.') : error?.message}</p>
          <Link href="/browse" class="btn">
            {t('Browse projects')}
          </Link>
        </Empty>
      </div>
    );
  }

  const { project, versions } = data;
  const version = tab === 'version' ? versions.find((v) => v.id === params.versionId) : undefined;
  const canManage = !!viewer.role;
  const go = (path: string) => () => navigate(path, { scroll: false });
  const base = `/project/${project.slug}`;
  const typeLabel = typeInfo(project.type)?.label;

  return (
    <div class="container page">
      {project.bannerUrl && (
        <div class="project-banner">
          <img src={project.bannerUrl} alt="" referrerpolicy="no-referrer" decoding="async" />
        </div>
      )}
      {data.draft && (
        <Alert kind="info" title={t('Draft preview.')}>
          {t('Only project members and moderators can see this page until the first version passes its scan.')}
        </Alert>
      )}
      {project.archived && (
        <Alert kind="warning" title={t('Archived.')}>
          {t('The creators have stopped working on this project. Existing files still download and verify, but there won’t be updates.')}
        </Alert>
      )}
      {project.status === 'delisted' && (
        <Alert kind="warning" title={t('Delisted.')}>
          {data.statusReason ? t('This project is hidden from search: {reason}', { reason: data.statusReason }) : t('This project is hidden from search.')}
        </Alert>
      )}
      {project.repo.status !== 'ok' && (
        <Alert kind="danger" title={t('Downloads paused.')}>
          {project.repo.status === 'transferred'
            ? t('The linked GitHub repository was transferred to another account. Downloads are blocked until this is resolved.')
            : project.repo.status === 'private'
              ? t('The linked GitHub repository was made private. Downloads are blocked until this is resolved.')
              : t('The linked GitHub repository was removed. Downloads are blocked until this is resolved.')}
        </Alert>
      )}

      <header class="project-head">
        <ProjectIcon src={project.iconUrl} name={project.name} size={96} />
        <div class="project-head-main">
          <div class="project-head-title">
            <h1>{project.name}</h1>
            {typeLabel && <span class="chip chip-type">{t(typeLabel)}</span>}
            {project.archived && <span class="chip chip-muted">{t('Archived')}</span>}
          </div>
          <p class="project-head-summary">{project.summary}</p>
          <div class="project-head-meta">
            <span class="project-byline">
              {t('by')}{' '}
              {project.org ? <Link href={`/organization/${project.org.slug}`}>{project.org.name}</Link> : <Link href={`/user/${project.author.username}`}>{project.author.username}</Link>}
            </span>
            <span>
              <Icon name="download" /> <strong>{count(project.downloads)}</strong> {t('downloads')}
            </span>
            <span>
              <Icon name="heart" /> <strong>{count(project.follows)}</strong> {t('followers')}
            </span>
            <span>
              <Icon name="clock" /> {t('Updated {when}', { when: ago(project.updatedAt) })}
            </span>
            {project.categories.map((c) => (
              <span key={c} class="chip chip-muted">
                {t(categoryLabel(c))}
              </span>
            ))}
          </div>
          <div class="row-actions project-head-actions">
            <FollowButton project={project} initial={viewer.following} />
            {!data.draft && <AddToCollection projectId={project.id} />}
            {canManage && (
              <Link href={`${base}/settings`} class="btn btn-icon" aria-label={t('Project settings')}>
                <Icon name="settings" />
              </Link>
            )}
            <Menu label={t('More actions')} trigger={<Icon name="list" />}>
              {(close) => (
                <>
                  <a class="menu-item" href={project.repo.url} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <Icon name="github" /> {t('GitHub repository')}
                  </a>
                  {canManage && has(viewer.perms, PERM.UPLOAD_VERSION) && (
                    <Link class="menu-item" href={`${base}/upload`} onClick={close}>
                      <Icon name="upload" /> {t('Upload a version')}
                    </Link>
                  )}
                  <a class="menu-item" href={`${API_URL}/v1/projects/${project.slug}/feed.xml`} target="_blank" rel="noopener noreferrer" onClick={close}>
                    <Icon name="globe" /> {t('RSS feed')}
                  </a>
                  <button type="button" class="menu-item" onClick={() => (close(), setBadges(true))}>
                    <Icon name="tag" /> {t('README badges')}
                  </button>
                  {user ? (
                    <button type="button" class="menu-item" onClick={() => (close(), setReporting({ type: 'project', id: project.id, label: project.name }))}>
                      <Icon name="flag" /> {t('Report project')}
                    </button>
                  ) : (
                    <a class="menu-item" href={loginUrl(loc.path)}>
                      <Icon name="flag" /> {t('Sign in to report')}
                    </a>
                  )}
                  {isStaff(user) && <ModerateProject project={project} onDone={reload} />}
                </>
              )}
            </Menu>
          </div>
        </div>
        <div class="project-head-dl">
          {project.repo.status === 'ok' ? (
            <QuickDownload versions={versions} slug={project.slug} project={project} />
          ) : (
            <div class="quick-dl">
              <span class="panel-title">{t('Download')}</span>
              <p class="muted">{t('Paused while the repository issue is resolved.')}</p>
            </div>
          )}
        </div>
      </header>

      <Tabs
        current={tab === 'version' ? 'versions' : tab}
        items={[
          { id: 'overview', label: t('Overview'), href: base, onClick: go(base) },
          { id: 'versions', label: t('Versions'), count: versions.length, href: `${base}/versions`, onClick: go(`${base}/versions`) },
          { id: 'changelog', label: t('Changelog'), href: `${base}/changelog`, onClick: go(`${base}/changelog`) },
          ...(project.type === 'modpack' ? [{ id: 'contents', label: t('Contents'), href: `${base}/contents`, onClick: go(`${base}/contents`) }] : []),
          ...(project.gallery.length ? [{ id: 'gallery', label: t('Gallery'), count: project.gallery.length, href: `${base}/gallery`, onClick: go(`${base}/gallery`) }] : []),
          ...(!data.draft ? [{ id: 'comments', label: t('Comments'), href: `${base}/comments`, onClick: go(`${base}/comments`) }] : []),
        ]}
      />

      <div class={`project-body${tab === 'version' || tab === 'contents' || tab === 'comments' ? ' project-body-full' : ''}`}>
        <div class="project-content">
          {tab === 'overview' && (
            <section class="card card-pad">
              <Markdown source={project.description || project.summary} empty={t('The creator hasn’t written a description yet.')} />
            </section>
          )}
          {tab === 'versions' && <VersionsTab versions={versions} slug={project.slug} />}
          {tab === 'changelog' && <ChangelogTab versions={versions} slug={project.slug} />}
          {tab === 'gallery' && <GalleryTab project={project} />}
          {tab === 'contents' && <PackContents version={versions[0]} />}
          {tab === 'comments' && (
            <Comments projectId={project.id} projectName={project.name} canModerate={has(viewer.perms, PERM.MODERATE_COMMENTS)} isMember={!!viewer.role} />
          )}
          {tab === 'version' &&
            (version ? (
              <VersionView
                project={project}
                version={version}
                onReport={() => (user ? setReporting({ type: 'version', id: version.id, label: `${project.name} ${version.versionNumber}` }) : navigate(loginUrl(loc.path)))}
                onChanged={reload}
              />
            ) : (
              <Empty icon="search" title={t('Version not found')}>
                <p>{t('It may have been removed or is not live.')}</p>
                <Link href={`${base}/versions`} class="btn">
                  {t('All versions')}
                </Link>
              </Empty>
            ))}
        </div>
        {tab !== 'version' && tab !== 'contents' && tab !== 'comments' && <Sidebar project={project} versions={versions} />}
      </div>
      {reporting && <ReportDialog targetType={reporting.type} targetId={reporting.id} label={reporting.label} onClose={() => setReporting(null)} />}
      {badges && <BadgeDialog project={project} onClose={() => setBadges(false)} />}
    </div>
  );
}

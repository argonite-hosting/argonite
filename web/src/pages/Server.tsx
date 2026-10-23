import { useState } from 'preact/hooks';
import { SERVER_REGIONS, SERVER_TAGS } from '../../../shared/taxonomy';
import type { ServerListing } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { Markdown } from '../components/Markdown';
import { ProjectCard } from '../components/ProjectCard';
import { ReportDialog } from '../components/ReportDialog';
import { Alert, Avatar, CopyField, Empty, Menu, Modal, PageLoading, Spinner, useAsync } from '../components/ui';
import { ApiError, api, pub } from '../lib/api';
import { ago, date } from '../lib/format';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';
import { errorToast, isStaff, toast, useSession } from '../lib/store';
import { PlayerCount, ServerFavicon } from './Servers';
import { safeHref, useBlockedLinks } from '../lib/blockedLinks';

export default function ServerPage({ params }: { params: Record<string, string> }) {
  const blocked = useBlockedLinks();
  const { user } = useSession();
  const { data, error, loading, reload } = useAsync(() => pub<ServerListing>(`/v1/servers/${encodeURIComponent(params.slug)}`), [params.slug]);
  const [fresh, setFresh] = useState<ServerListing | null>(null);
  const [busy, setBusy] = useState(false);
  const [reporting, setReporting] = useState(false);
  const [moderating, setModerating] = useState<'active' | 'delisted' | 'removed' | null>(null);
  const [reason, setReason] = useState('');
  const s = fresh ?? data;
  useHead(s ? s.name : null, s?.summary, s?.status !== 'active' ? 'noindex' : undefined);
  if (loading && !s) return <PageLoading />;
  if (error || !s) {
    return (
      <div class="container page">
        <Empty icon="server" title={error instanceof ApiError && error.status === 404 ? t('Server not found') : t('Could not load this server')} />
      </div>
    );
  }
  const own = user?.id === s.owner.id;
  const refresh = async () => {
    setBusy(true);
    try {
      setFresh(await api<ServerListing>('POST', `/api/servers/${s.slug}/ping`));
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const moderate = async () => {
    try {
      await api('POST', `/api/mod/servers/${s.slug}/status`, { status: moderating, reason });
      toast('success', t('Server updated'));
      setModerating(null);
      setReason('');
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="container page">
      {s.status === 'delisted' && <Alert kind="warning">{t('This server is hidden from the list.')}</Alert>}
      <header class="project-head server-head">
        <ServerFavicon s={s} size={96} />
        <div class="project-head-main">
          <div class="project-head-title">
            <h1>{s.name}</h1>
            <span class="chip chip-type">{s.edition === 'java' ? 'Java' : 'Bedrock'}</span>
          </div>
          <p class="project-head-summary">{s.summary}</p>
          {s.motd && <p class="server-motd mono">{s.motd}</p>}
          <div class="project-head-meta">
            <span class="project-byline">
              {t('by')} {s.org ? <Link href={`/organization/${s.org.slug}`}>{s.org.name}</Link> : <Link href={`/user/${s.owner.username}`}>{s.owner.username}</Link>}
            </span>
            {s.tags.map((tg) => (
              <span key={tg} class="chip chip-muted">
                {t(SERVER_TAGS.find((x) => x.id === tg)?.label ?? tg)}
              </span>
            ))}
          </div>
          <div class="row-actions project-head-actions">
            {safeHref(s.links.website, blocked) && (
              <a class="btn" href={s.links.website!} target="_blank" rel="noopener noreferrer nofollow ugc">
                <Icon name="globe" /> {t('Website')}
              </a>
            )}
            {safeHref(s.links.discord, blocked) && (
              <a class="btn" href={s.links.discord!} target="_blank" rel="noopener noreferrer nofollow ugc">
                <Icon name="message" /> Discord
              </a>
            )}
            {own && (
              <Link href={`/server/${s.slug}/edit`} class="btn btn-icon" aria-label={t('Edit server')}>
                <Icon name="settings" />
              </Link>
            )}
            {user && (
              <Menu label={t('More actions')} trigger={<Icon name="list" />}>
                {(close) => (
                  <>
                    {!own && (
                      <button type="button" class="menu-item" onClick={() => (close(), setReporting(true))}>
                        <Icon name="flag" /> {t('Report server')}
                      </button>
                    )}
                    {isStaff(user) && (
                      <>
                        <div class="menu-sep" />
                        <button type="button" class="menu-item" onClick={() => (close(), setModerating('active'))}>
                          <Icon name="refresh" /> {t('Restore listing')}
                        </button>
                        <button type="button" class="menu-item" onClick={() => (close(), setModerating('delisted'))}>
                          <Icon name="eye" /> {t('Delist')}
                        </button>
                        <button type="button" class="menu-item danger" onClick={() => (close(), setModerating('removed'))}>
                          <Icon name="trash" /> {t('Remove')}
                        </button>
                      </>
                    )}
                  </>
                )}
              </Menu>
            )}
          </div>
        </div>
        <div class="project-head-dl">
          <div class="quick-dl">
            <span class="panel-title">{t('Join')}</span>
            <CopyField value={s.address} label={t('Server address')} />
            <PlayerCount s={s} />
            <span class="field-hint">
              {s.lastPingAt ? t('Checked {when}', { when: ago(s.lastPingAt) }) : t('Not checked yet')}
              {s.uptime !== null && ` · ${t('{n}% uptime', { n: s.uptime })}`}
            </span>
            {own && s.edition === 'java' && (
              <button type="button" class="btn btn-sm" disabled={busy} onClick={refresh}>
                {busy ? <Spinner /> : <Icon name="refresh" />} {t('Check now')}
              </button>
            )}
          </div>
        </div>
      </header>
      <div class="project-body">
        <div class="project-content stack">
          {s.modpack && (
            <section class="stack-sm">
              <h2 class="section-title">{t('Runs this modpack')}</h2>
              <ProjectCard p={s.modpack} showType />
            </section>
          )}
          <section class="card card-pad">
            <Markdown source={s.description || s.summary} empty={t('No description yet.')} />
          </section>
        </div>
        <aside class="project-aside">
          <section class="card card-body">
            <h2 class="panel-title">{t('Details')}</h2>
            <dl class="kv">
              <dt>{t('Edition')}</dt>
              <dd>{s.edition === 'java' ? 'Java' : 'Bedrock'}</dd>
              <dt>{t('Region')}</dt>
              <dd>{t(SERVER_REGIONS.find((r) => r.id === s.region)?.label ?? s.region)}</dd>
              {s.gameVersion && (
                <>
                  <dt>{t('Version')}</dt>
                  <dd>{s.gameVersion}</dd>
                </>
              )}
              <dt>{t('Listed')}</dt>
              <dd>{date(s.createdAt)}</dd>
            </dl>
          </section>
          <section class="card card-body">
            <h2 class="panel-title">{t('Listed by')}</h2>
            <Link href={`/user/${s.owner.username}`} class="member">
              <Avatar src={s.owner.avatarUrl} name={s.owner.username} />
              <span>
                <strong>{s.owner.username}</strong>
              </span>
            </Link>
          </section>
        </aside>
      </div>
      {moderating && (
        <Modal
          title={moderating === 'active' ? t('Restore listing') : moderating === 'delisted' ? t('Delist server') : t('Remove server')}
          onClose={() => setModerating(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setModerating(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class={`btn ${moderating === 'active' ? 'btn-primary' : 'btn-danger'}`} disabled={moderating !== 'active' && reason.trim().length < 3} onClick={moderate}>
                {t('Confirm')}
              </button>
            </>
          }
        >
          <textarea class="textarea" rows={3} maxLength={500} placeholder={t('Reason (shown to the owner)')} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
        </Modal>
      )}
      {reporting && <ReportDialog targetType="server" targetId={s.id} label={s.name} onClose={() => setReporting(false)} />}
    </div>
  );
}

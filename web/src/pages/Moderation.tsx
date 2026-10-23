import { useState } from 'preact/hooks';
import { REPORT_REASONS, loaderLabel } from '../../../shared/taxonomy';
import type { AuditEntry, Report, ReviewItem } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { RequireAuth } from '../components/RequireAuth';
import { Avatar, ChannelBadge, Empty, HostList, SandboxList, Modal, NativeList, PageLoading, ProjectIcon, StatusBadge, Tabs, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { ago, bytes, date } from '../lib/format';
import { useHead } from '../lib/head';
import { Link, setQuery, useLocation } from '../lib/router';
import { errorToast, toast, useSession } from '../lib/store';
import { t, tn } from '../lib/i18n';

function Decision({ item, action, onClose, onDone }: { item: ReviewItem; action: 'approve' | 'reject'; onClose: () => void; onDone: () => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/mod/versions/${item.version.id}/decision`, { action, reason });
      toast('success', action === 'approve' ? t('Approved') : t('Rejected'));
      onDone();
      onClose();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={t(action === 'approve' ? 'Approve {name}' : 'Reject {name}', { name: `${item.project.name} ${item.version.versionNumber}` })}
      description={action === 'approve' ? t('It goes live immediately with its signed fingerprint.') : t('The author sees your reason.')}
      onClose={onClose}
      footer={
        <>
          <button type="button" class="btn" onClick={onClose}>
            {t('Cancel')}
          </button>
          <button type="button" class={`btn ${action === 'approve' ? 'btn-primary' : 'btn-danger'}`} disabled={busy || (action === 'reject' && reason.trim().length < 3)} onClick={go}>
            {action === 'approve' ? t('Approve') : t('Reject')}
          </button>
        </>
      }
    >
      <textarea class="textarea" rows={3} maxLength={500} placeholder={action === 'approve' ? t('Note (optional)') : t('Reason')} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
    </Modal>
  );
}

function Queue({ status }: { status: 'review' | 'rejected' }) {
  const { data, loading, reload } = useAsync(() => api<{ items: ReviewItem[] }>('GET', `/api/mod/queue?status=${status}`), [status]);
  const [deciding, setDeciding] = useState<{ item: ReviewItem; action: 'approve' | 'reject' } | null>(null);
  if (loading && !data) return <PageLoading />;
  if (!data?.items.length) return <Empty icon="checkCircle" title={status === 'review' ? t('The review queue is empty') : t('Nothing rejected recently')} />;
  return (
    <div class="stack">
      {data.items.map((item) => {
        const v = item.version;
        return (
          <article key={v.id} class="card review-card">
            <header class="review-head">
              <Link href={`/project/${item.project.slug}`} class="member">
                <ProjectIcon src={item.project.iconUrl} name={item.project.name} size={44} />
                <span>
                  <strong>
                    {item.project.name} <span class="mono muted">{v.versionNumber}</span>
                  </strong>
                  <span>
                    {t('by {name}', { name: v.author.username })} · {t('uploaded {when}', { when: ago(v.createdAt) })}
                  </span>
                </span>
              </Link>
              <div class="row-actions">
                <ChannelBadge channel={v.channel} />
                <StatusBadge status={v.status} />
              </div>
            </header>
            <div class="review-body">
              {v.statusReason && (
                <p class="manage-reason">
                  <Icon name="info" /> {v.statusReason}
                </p>
              )}
              <dl class="kv review-kv">
                <dt>{t('File')}</dt>
                <dd>{v.file ? `${v.file.filename} · ${bytes(v.file.size)}` : t('No fingerprint')}</dd>
                <dt>{t('Loaders')}</dt>
                <dd>{v.loaders.map(loaderLabel).join(', ')}</dd>
                <dt>{t('Engines')}</dt>
                <dd>{v.scan?.engines.join(', ') || '—'}</dd>
                {v.file && (
                  <>
                    <dt>SHA-256</dt>
                    <dd class="mono hash">{v.file.sha256}</dd>
                  </>
                )}
              </dl>
              {v.scan && v.scan.capabilities.length > 0 && (
                <div class="chips">
                  {v.scan.capabilities.map((c) => (
                    <span key={c} class="chip">
                      {c.replace(/_/g, ' ')}
                    </span>
                  ))}
                </div>
              )}
              <NativeList natives={Object.values(v.scans ?? {}).flatMap((x) => x.natives ?? [])} />
              <HostList hosts={[...new Set(Object.values(v.scans ?? {}).flatMap((x) => x.hosts ?? []))].sort()} />
              {v.scan && v.scan.findings.length > 0 && (
                <ul class="finding-list">
                  {v.scan.findings.map((f, i) => (
                    <li key={i} class={`finding sev-${f.severity}`}>
                      <span class="badge">{f.severity}</span>
                      <span>
                        {f.detail}
                        {f.path && <span class="mono finding-path"> {f.path}</span>}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
              <SandboxList runs={v.sandbox} />
            </div>
            <footer class="review-foot">
              {v.releaseUrl && (
                <a class="btn btn-ghost btn-sm" href={v.releaseUrl} target="_blank" rel="noopener noreferrer">
                  <Icon name="github" /> {t('Release')}
                </a>
              )}
              {status === 'review' ? (
                <>
                  <button type="button" class="btn btn-danger-soft btn-sm" onClick={() => setDeciding({ item, action: 'reject' })}>
                    {t('Reject')}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" disabled={!v.file} onClick={() => setDeciding({ item, action: 'approve' })}>
                    {t('Approve')}
                  </button>
                </>
              ) : null}
            </footer>
          </article>
        );
      })}
      {deciding && <Decision item={deciding.item} action={deciding.action} onClose={() => setDeciding(null)} onDone={reload} />}
    </div>
  );
}

function Reports() {
  const [status, setStatus] = useState<'open' | 'resolved' | 'dismissed'>('open');
  const { data, loading, reload } = useAsync(() => api<{ reports: Report[] }>('GET', `/api/mod/reports?status=${status}`), [status]);
  const [closing, setClosing] = useState<{ r: Report; status: 'resolved' | 'dismissed' } | null>(null);
  const [note, setNote] = useState('');
  const close = async () => {
    try {
      await api('POST', `/api/mod/reports/${closing!.r.id}`, { status: closing!.status, resolution: note });
      toast('success', t('Report closed'));
      setClosing(null);
      setNote('');
      reload();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <div class="segmented" role="group" aria-label={t('Report status')}>
        {(['open', 'resolved', 'dismissed'] as const).map((s) => (
          <button key={s} type="button" aria-pressed={status === s} onClick={() => setStatus(s)}>
            {t(s[0].toUpperCase() + s.slice(1))}
          </button>
        ))}
      </div>
      {loading && !data ? (
        <PageLoading />
      ) : !data?.reports.length ? (
        <Empty icon="flag" title={t('No reports here')} />
      ) : (
        <ul class="manage-list card">
          {data.reports.map((r) => (
            <li key={r.id} class="manage-row report-row">
              <div class="manage-row-main">
                <div class="manage-row-title">
                  <span class="badge badge-warning">{t(REPORT_REASONS.find((x) => x.id === r.reason)?.label ?? r.reason)}</span>
                  <Link href={r.targetUrl}>{r.targetLabel}</Link>
                  <span class="muted">({r.targetType})</span>
                </div>
                <p class="report-details">{r.details}</p>
                <span class="field-hint">
                  {t('Reported by {name}', { name: r.reporter.username })} · {ago(r.createdAt)}
                  {r.resolution && ` · ${r.resolution}`}
                </span>
              </div>
              {r.status === 'open' && (
                <div class="row-actions">
                  <button type="button" class="btn btn-sm" onClick={() => setClosing({ r, status: 'dismissed' })}>
                    {t('Dismiss')}
                  </button>
                  <button type="button" class="btn btn-primary btn-sm" onClick={() => setClosing({ r, status: 'resolved' })}>
                    {t('Resolve')}
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
      {closing && (
        <Modal
          title={closing.status === 'resolved' ? t('Resolve report') : t('Dismiss report')}
          description={t('Take any action on the target first (revoke, delist, ban), then close the report.')}
          onClose={() => setClosing(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setClosing(null)}>
                {t('Cancel')}
              </button>
              <button type="button" class="btn btn-primary" onClick={close}>
                {t('Close report')}
              </button>
            </>
          }
        >
          <textarea class="textarea" rows={3} maxLength={500} placeholder={t('What was done (optional)')} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
        </Modal>
      )}
    </div>
  );
}

interface LookedUp {
  id: string;
  username: string;
  avatar_url: string;
  role: string;
  banned: number;
  ban_reason: string | null;
  created_at: number;
  approved_uploads: number;
}

function Users() {
  const { user: me } = useSession();
  const [q, setQ] = useState('');
  const [found, setFound] = useState<LookedUp | null>(null);
  const [reason, setReason] = useState('');
  const lookup = async (e?: Event) => {
    e?.preventDefault();
    try {
      const r = await api<{ user: LookedUp }>('GET', `/api/mod/users?username=${encodeURIComponent(q.trim())}`);
      setFound(r.user);
    } catch (err) {
      setFound(null);
      errorToast(err, t('Not found'));
    }
  };
  const ban = async (banned: boolean) => {
    try {
      await api('POST', `/api/mod/users/${found!.id}/ban`, { banned, reason });
      toast('success', banned ? t('User suspended') : t('User restored'));
      setReason('');
      await lookup();
    } catch (e) {
      errorToast(e);
    }
  };
  const role = async (r: string) => {
    try {
      await api('POST', `/api/admin/users/${found!.id}/role`, { role: r });
      toast('success', t('Role updated'));
      await lookup();
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <div class="stack">
      <form class="form-row form-row-end" onSubmit={lookup}>
        <div class="input-icon grow">
          <Icon name="search" />
          <input class="input" placeholder={t('GitHub username')} value={q} aria-label={t('Username')} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <button type="submit" class="btn" disabled={!q.trim()}>
          {t('Look up')}
        </button>
      </form>
      {found && (
        <section class="card card-pad stack">
          <div class="member">
            <Avatar src={found.avatar_url} name={found.username} />
            <span>
              <strong>
                <Link href={`/user/${found.username}`}>{found.username}</Link>
              </strong>
              <span>
                {t(found.role[0].toUpperCase() + found.role.slice(1))} · {t('joined {date}', { date: date(found.created_at) })} · {tn(found.approved_uploads, '{n} approved upload', '{n} approved uploads')}
              </span>
            </span>
          </div>
          {found.banned ? <p class="manage-reason">{t('Suspended: {reason}', { reason: found.ban_reason ?? '' })}</p> : null}
          <textarea class="textarea" rows={2} maxLength={500} placeholder={t('Reason')} value={reason} onInput={(e) => setReason(e.currentTarget.value)} />
          <div class="row-actions">
            {found.banned ? (
              <button type="button" class="btn" onClick={() => ban(false)}>
                {t('Lift suspension')}
              </button>
            ) : (
              <button type="button" class="btn btn-danger" disabled={reason.trim().length < 3} onClick={() => ban(true)}>
                {t('Suspend user')}
              </button>
            )}
            {me?.role === 'admin' && (
              <select class="select select-inline" value={found.role} aria-label={t('Role')} onChange={(e) => role(e.currentTarget.value)}>
                <option value="user">{t('User')}</option>
                <option value="moderator">{t('Moderator')}</option>
                <option value="admin">{t('Admin')}</option>
              </select>
            )}
          </div>
        </section>
      )}
    </div>
  );
}

function Audit() {
  const [before, setBefore] = useState<number | null>(null);
  const { data, loading } = useAsync(() => api<{ entries: AuditEntry[] }>('GET', `/api/mod/audit${before ? `?before=${before}` : ''}`), [before]);
  if (loading && !data) return <PageLoading />;
  if (!data?.entries.length) return <Empty icon="list" title={t('No audit entries')} />;
  return (
    <div class="stack">
      <div class="table-wrap card">
        <table class="table">
          <thead>
            <tr>
              <th>{t('When')}</th>
              <th>{t('Who')}</th>
              <th>{t('Action')}</th>
              <th>{t('Target')}</th>
            </tr>
          </thead>
          <tbody>
            {data.entries.map((e) => (
              <tr key={e.id}>
                <td title={new Date(e.createdAt).toISOString()}>{ago(e.createdAt)}</td>
                <td>{e.actor?.username ?? t('system')}</td>
                <td class="mono">{e.action}</td>
                <td class="mono muted">
                  {e.targetType}:{e.targetId.slice(-8)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {data.entries.length === 100 && (
        <button type="button" class="btn" onClick={() => setBefore(data.entries[data.entries.length - 1].createdAt)}>
          {t('Older entries')}
        </button>
      )}
    </div>
  );
}

const TABS = [
  ['queue', 'Review queue'],
  ['rejected', 'Rejected'],
  ['reports', 'Reports'],
  ['users', 'Users'],
  ['audit', 'Audit log'],
] as const;

function Inner() {
  useHead(t('Moderation'), undefined, 'noindex');
  const loc = useLocation();
  const tab = TABS.find(([id]) => id === loc.query.get('tab'))?.[0] ?? 'queue';
  return (
    <div class="container page">
      <div class="page-head">
        <div>
          <h1>{t('Moderation')}</h1>
          <p class="page-sub">{t('Every action here is written to the audit log.')}</p>
        </div>
      </div>
      <Tabs current={tab} items={TABS.map(([id, label]) => ({ id, label: t(label), onClick: () => setQuery({ tab: id === 'queue' ? null : id }) }))} />
      <div class="settings-body">
        {tab === 'queue' && <Queue status="review" />}
        {tab === 'rejected' && <Queue status="rejected" />}
        {tab === 'reports' && <Reports />}
        {tab === 'users' && <Users />}
        {tab === 'audit' && <Audit />}
      </div>
    </div>
  );
}

export default function Moderation() {
  return <RequireAuth staff>{() => <Inner />}</RequireAuth>;
}

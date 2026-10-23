import { useEffect, useState } from 'preact/hooks';
import { REPORT_REASONS, loaderLabel } from '../../../shared/taxonomy';
import type { AuditEntry, Finding, Report, ReviewItem, Version } from '../../../shared/types';
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

// Plain names for the behaviour tags the scanner puts on files.
function capability(id: string): string {
  const names: Record<string, string> = {
    network: t('Uses the network'),
    process_exec: t('Starts other programs'),
    native_code: t('Ships native code'),
    dynamic_classloading: t('Loads code at runtime'),
    instrumentation: t('Uses Java instrumentation'),
    crypto_decode: t('Decrypts data'),
    credential_access: t('Reads saved logins'),
    jar_writing: t('Writes jar files'),
    session_token: t('Reads the Minecraft session token'),
    class_transformer: t('Rewrites game classes'),
    patches_loader: t('Patches the mod loader'),
    outside_game_dir: t('Reads outside the game folder'),
  };
  return names[id] ?? id.replace(/_/g, ' ');
}

type Tone = 'info' | 'warning' | 'danger';

// The reasons a version is waiting, from the automatic checks, as short labelled lines.
function reasonsOf(v: Version): { tone: Tone; text: string }[] {
  const raw = v.reviewDetail || v.statusReason || '';
  const parts = (raw.includes('\n') ? raw.split('\n') : raw.split(/\.\s+(?=[A-Z])/)).map((s) => s.trim().replace(/\.$/, '')).filter(Boolean);
  return parts.map((p) => {
    if (/^First upload from this account/.test(p)) return { tone: 'info', text: t('First upload from this account') };
    if (/^New GitHub account/.test(p)) return { tone: 'info', text: t('The uploader’s GitHub account is new') };
    let m = /^(New sensitive behaviour since the last version|Sensitive behaviour): (.*)$/.exec(p);
    if (m) {
      const list = m[2].split(/,\s*/).map(capability).join(', ');
      return { tone: 'warning', text: m[1].startsWith('New') ? t('New since the last version: {list}', { list }) : t('Sensitive behaviour: {list}', { list }) };
    }
    m = /^Flagged by the scanner: (.*)$/.exec(p);
    if (m) return { tone: 'warning', text: t('Scanner: {detail}', { detail: m[1] }) };
    if (/malware|malicious|caught it/i.test(p)) return { tone: 'danger', text: p };
    return { tone: /^(New native|Native library changed|New links|Has more links)/.test(p) ? 'warning' : 'info', text: p };
  });
}

const SERIOUS = new Set(['high', 'critical']);

function Findings({ list }: { list: Finding[] }) {
  const serious = list.filter((f) => SERIOUS.has(f.severity));
  const minor = list.filter((f) => !SERIOUS.has(f.severity));
  const row = (f: Finding, i: number) => (
    <li key={i} class={`finding sev-${f.severity}`}>
      <span class="badge">{t(f.severity)}</span>
      <span>
        {f.detail}
        {f.path && <span class="mono finding-path"> {f.path}</span>}
      </span>
    </li>
  );
  return (
    <>
      {serious.length > 0 ? <ul class="finding-list">{serious.map(row)}</ul> : <p class="review-ok">{t('Nothing serious found.')}</p>}
      {minor.length > 0 && (
        <details class="review-more">
          <summary>{tn(minor.length, '{n} minor note', '{n} minor notes')}</summary>
          <ul class="finding-list">{minor.map(row)}</ul>
        </details>
      )}
    </>
  );
}

const OS_LABEL: Record<string, string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS' };

// Starting behaviour tests, and what they found.
function VmTests({ v, systems, onStarted }: { v: Version; systems: string[]; onStarted: () => void }) {
  const runs = v.sandbox ?? [];
  const running = new Set<string>(runs.filter((r) => r.outcome === 'running').map((r) => r.os));
  const [picked, setPicked] = useState<Set<string>>(() => new Set(runs.length ? [] : ['linux']));
  const [busy, setBusy] = useState(false);
  if (!systems.length) return null;
  const toggle = (os: string) => {
    const next = new Set(picked);
    if (next.has(os)) next.delete(os);
    else next.add(os);
    setPicked(next);
  };
  const start = async () => {
    setBusy(true);
    try {
      await api('POST', `/api/mod/versions/${v.id}/sandbox`, { systems: [...picked].filter((os) => !running.has(os)) });
      toast('success', t('Tests started. They usually take 10 to 40 minutes.'));
      setPicked(new Set());
      onStarted();
    } catch (e) {
      errorToast(e);
    } finally {
      setBusy(false);
    }
  };
  const choosable = [...picked].filter((os) => !running.has(os));
  return (
    <section class="review-section">
      <h3>{t('Behaviour tests')}</h3>
      {runs.length === 0 && <p class="field-hint">{t('Run the file inside real Minecraft on a fresh machine, with the network cut off and bait files planted, to see what it does.')}</p>}
      {runs.length > 0 && <SandboxList runs={runs} detailed hideTitle />}
      <div class="vm-picker">
        {systems.map((os) => (
          <label key={os} class={`vm-option${running.has(os) ? ' is-running' : ''}`}>
            <input type="checkbox" checked={picked.has(os) || running.has(os)} disabled={running.has(os) || busy} onChange={() => toggle(os)} />
            <span>{OS_LABEL[os] ?? os}</span>
            {running.has(os) && <span class="spinner spinner-sm" aria-label={t('Running')} />}
          </label>
        ))}
        <button type="button" class="btn btn-sm" disabled={busy || !choosable.length} onClick={start}>
          <Icon name="shield" /> {runs.length ? t('Test again') : t('Test on VMs')}
        </button>
      </div>
    </section>
  );
}

function ReviewCard({ item, status, systems, onDecide, reload }: { item: ReviewItem; status: 'review' | 'rejected'; systems: string[]; onDecide: (action: 'approve' | 'reject') => void; reload: () => void }) {
  const v = item.version;
  const reasons = reasonsOf(v);
  const findings = Object.values(v.scans ?? {}).flatMap((s) => s.findings ?? []);
  const capabilities = [...new Set(Object.values(v.scans ?? {}).flatMap((s) => s.capabilities ?? []))];
  const natives = Object.values(v.scans ?? {}).flatMap((x) => x.natives ?? []);
  const hosts = [...new Set(Object.values(v.scans ?? {}).flatMap((x) => x.hosts ?? []))].sort();
  const testFindings = (v.sandbox ?? []).flatMap((r) => r.findings);
  const level: Tone =
    findings.some((f) => f.severity === 'critical') || testFindings.some((f) => f.severity === 'critical')
      ? 'danger'
      : reasons.some((r) => r.tone !== 'info') || findings.some((f) => f.severity === 'high') || testFindings.some((f) => f.severity === 'high')
        ? 'warning'
        : 'info';
  const verdict = v.scan?.verdict;
  return (
    <article class={`card review-card review-${level}`}>
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
          <span class={`badge review-level review-level-${level}`}>{level === 'danger' ? t('Signs of malware') : level === 'warning' ? t('Needs a closer look') : t('Routine check')}</span>
          <ChannelBadge channel={v.channel} />
          <StatusBadge status={v.status} />
        </div>
      </header>
      <div class="review-body">
        {reasons.length > 0 && (
          <section class="review-section">
            <h3>{status === 'review' ? t('Why it’s waiting') : t('Why it was rejected')}</h3>
            <ul class="review-reasons">
              {reasons.map((r, i) => (
                <li key={i} class={`review-reason tone-${r.tone}`}>
                  <Icon name={r.tone === 'info' ? 'info' : 'alert'} />
                  <span>{r.text}</span>
                </li>
              ))}
            </ul>
          </section>
        )}
        <section class="review-section">
          <h3>{t('File')}</h3>
          <p class="review-file">
            <strong class="mono">{v.file ? v.file.filename : t('No fingerprint')}</strong>
            {v.file && <span class="muted"> · {bytes(v.file.size)}</span>}
            <span class="muted"> · {v.loaders.map(loaderLabel).join(', ')}</span>
            {v.gameVersions.length > 0 && <span class="muted"> · {v.gameVersions.slice(0, 3).join(', ')}{v.gameVersions.length > 3 ? '…' : ''}</span>}
          </p>
          <h3>{t('Scan')}</h3>
          <p class="review-verdict">
            <span class={`badge verdict-${verdict ?? 'none'}`}>{verdict ? t(verdict) : t('pending')}</span>
          </p>
          <Findings list={findings} />
          {(capabilities.length > 0 || natives.length > 0 || hosts.length > 0 || v.file) && (
            <details class="review-more">
              <summary>{t('Details')}</summary>
              {capabilities.length > 0 && (
                <div class="chips">
                  {capabilities.map((c) => (
                    <span key={c} class="chip" title={c}>
                      {capability(c)}
                    </span>
                  ))}
                </div>
              )}
              <NativeList natives={natives} />
              <HostList hosts={hosts} />
              <dl class="kv review-kv">
                <dt>{t('Engines')}</dt>
                <dd>{v.scan?.engines.join(', ') || '—'}</dd>
                {v.file && (
                  <>
                    <dt>SHA-256</dt>
                    <dd class="mono hash">{v.file.sha256}</dd>
                  </>
                )}
              </dl>
            </details>
          )}
        </section>
        <VmTests v={v} systems={systems} onStarted={reload} />
      </div>
      <footer class="review-foot">
        {v.releaseUrl && (
          <a class="btn btn-ghost btn-sm" href={v.releaseUrl} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> {t('Release')}
          </a>
        )}
        {status === 'review' ? (
          <>
            <button type="button" class="btn btn-danger-soft btn-sm" onClick={() => onDecide('reject')}>
              {t('Reject')}
            </button>
            <button type="button" class="btn btn-primary btn-sm" disabled={!v.file} onClick={() => onDecide('approve')}>
              {t('Approve')}
            </button>
          </>
        ) : null}
      </footer>
    </article>
  );
}

function Queue({ status }: { status: 'review' | 'rejected' }) {
  const { data, loading, reload } = useAsync(() => api<{ items: ReviewItem[]; sandboxSystems?: string[] }>('GET', `/api/mod/queue?status=${status}`), [status]);
  const [deciding, setDeciding] = useState<{ item: ReviewItem; action: 'approve' | 'reject' } | null>(null);
  const anyRunning = !!data?.items.some((i) => (i.version.sandbox ?? []).some((r) => r.outcome === 'running'));
  // While tests run, refresh quietly so results show up without reloading the page.
  useEffect(() => {
    if (!anyRunning) return;
    const id = setInterval(reload, 30_000);
    return () => clearInterval(id);
  }, [anyRunning, reload]);
  if (loading && !data) return <PageLoading />;
  if (!data?.items.length) return <Empty icon="checkCircle" title={status === 'review' ? t('The review queue is empty') : t('Nothing rejected recently')} />;
  return (
    <div class="stack">
      {data.items.map((item) => (
        <ReviewCard key={item.version.id} item={item} status={status} systems={data.sandboxSystems ?? []} onDecide={(action) => setDeciding({ item, action })} reload={reload} />
      ))}
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

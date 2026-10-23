import { useState } from 'preact/hooks';
import { ORG_PERM, ORG_PERM_ALL, ORG_PERM_LABELS, PERM_ALL, PERM_DEFAULT_MEMBER, has } from '../../../shared/permissions';
import type { Organization } from '../../../shared/types';
import { Icon } from '../components/Icon';
import { ProjectCard } from '../components/ProjectCard';
import { PermissionPicker, ProjectPermissionPicker } from '../components/ProjectPanels';
import { ReportDialog } from '../components/ReportDialog';
import { Avatar, Empty, Field, Menu, Modal, PageLoading, Spinner, Tabs, useAsync } from '../components/ui';
import { SITE } from '../config';
import { ApiError, api, pub } from '../lib/api';
import { count, date } from '../lib/format';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { Link, navigate, setQuery, useLocation } from '../lib/router';
import { errorToast, toast, useSession } from '../lib/store';

function Manage({ org, reload, orgPerms, projectPerms }: { org: Organization; reload: () => void; orgPerms: number; projectPerms: number }) {
  const { user } = useSession();
  const [name, setName] = useState(org.name);
  const [summary, setSummary] = useState(org.summary);
  const [github, setGithub] = useState(org.githubLogin ?? '');
  const [username, setUsername] = useState('');
  const [perms, setPerms] = useState(PERM_DEFAULT_MEMBER & projectPerms);
  const [orgP, setOrgP] = useState(0);
  const [editing, setEditing] = useState<{ id: string; name: string; perms: number; orgPerms: number } | null>(null);
  const [confirm, setConfirm] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const run = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast('success', ok);
      reload();
      return true;
    } catch (e) {
      errorToast(e);
      return false;
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="stack-lg">
      {has(orgPerms, ORG_PERM.EDIT_DETAILS) && (
        <form
          class="card card-pad stack"
          onSubmit={(e) => {
            e.preventDefault();
            void run(() => api('PATCH', `/api/organizations/${org.slug}`, { name, summary, githubLogin: github || null }), t('Saved'));
          }}
        >
          <h2 class="form-section-title">{t('Profile')}</h2>
          <Field label={t('Name')}>{(id) => <input id={id} class="input" maxLength={64} value={name} onInput={(e) => setName(e.currentTarget.value)} />}</Field>
          <Field label={t('Summary')} optional>
            {(id) => <textarea id={id} class="textarea" rows={2} maxLength={200} value={summary} onInput={(e) => setSummary(e.currentTarget.value)} />}
          </Field>
          <Field label={t('GitHub organisation')} optional hint={t('Uses its avatar. You must be an admin of it on GitHub.')}>
            {(id, d) => <input id={id} class="input" maxLength={39} value={github} aria-describedby={d} onInput={(e) => setGithub(e.currentTarget.value.trim())} />}
          </Field>
          <div class="form-foot">
            <button type="submit" class="btn btn-primary" disabled={busy}>
              {busy && <Spinner />} {t('Save')}
            </button>
          </div>
        </form>
      )}
      <section class="stack">
        <h2 class="section-title">{t('Members')}</h2>
        <ul class="manage-list card">
          {org.members.map((m) => {
            const self = m.user.id === user?.id;
            return (
              <li key={m.user.id} class="manage-row">
                <div class="member">
                  <Avatar src={m.user.avatarUrl} name={m.user.username} />
                  <span>
                    <strong>{m.user.username}</strong>
                    <span>{m.role === 'owner' ? t('Owner') : t('Member')}</span>
                  </span>
                </div>
                <div class="row-actions">
                  {m.role !== 'owner' && has(orgPerms, ORG_PERM.EDIT_MEMBER) && (
                    <button type="button" class="btn btn-ghost btn-sm" onClick={() => setEditing({ id: m.user.id, name: m.user.username, perms: m.permissions, orgPerms: m.orgPermissions })}>
                      {t('Permissions')}
                    </button>
                  )}
                  {m.role !== 'owner' && (self || has(orgPerms, ORG_PERM.REMOVE_MEMBER)) && (
                    <button
                      type="button"
                      class="btn btn-ghost btn-sm"
                      onClick={() => run(() => api('DELETE', `/api/organizations/${org.slug}/members/${m.user.id}`), self ? t('You left the organisation') : t('Member removed'))}
                    >
                      {self ? t('Leave') : t('Remove')}
                    </button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
        {has(orgPerms, ORG_PERM.MANAGE_INVITES) && (
          <form
            class="card card-pad stack"
            onSubmit={async (e) => {
              e.preventDefault();
              if (await run(() => api('POST', `/api/organizations/${org.slug}/members`, { username: username.trim(), permissions: perms, orgPermissions: orgP }), t('Invite sent'))) setUsername('');
            }}
          >
            <Field label={t('Invite by GitHub username')} hint={t('They must have signed in to {site} once.', { site: SITE.name })}>
              {(id, d) => <input id={id} class="input" maxLength={39} value={username} aria-describedby={d} onInput={(e) => setUsername(e.currentTarget.value)} />}
            </Field>
            <details>
              <summary>{t('What they can do in the organisation’s projects')}</summary>
              <ProjectPermissionPicker value={perms} editable={projectPerms} onChange={setPerms} />
            </details>
            <details>
              <summary>{t('What they can do in the organisation')}</summary>
              <PermissionPicker labels={ORG_PERM_LABELS} flags={ORG_PERM} value={orgP} editable={orgPerms} onChange={setOrgP} />
            </details>
            <div class="form-foot">
              <button type="submit" class="btn btn-primary" disabled={busy || !username.trim()}>
                {t('Invite')}
              </button>
            </div>
          </form>
        )}
      </section>
      {has(orgPerms, ORG_PERM.DELETE_ORG) && (
        <section class="card card-pad stack danger-zone">
          <h3>{t('Delete organisation')}</h3>
          <p class="muted">{t('Its projects go back to the people who created them.')}</p>
          <div>
            <button type="button" class="btn btn-danger" onClick={() => setDeleting(true)}>
              {t('Delete organisation')}
            </button>
          </div>
        </section>
      )}
      {editing && (
        <Modal
          title={t('Permissions for {name}', { name: editing.name })}
          wide
          onClose={() => setEditing(null)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setEditing(null)}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                class="btn btn-primary"
                onClick={async () => {
                  if (await run(() => api('PATCH', `/api/organizations/${org.slug}/members/${editing.id}`, { permissions: editing.perms, orgPermissions: editing.orgPerms }), t('Permissions updated'))) setEditing(null);
                }}
              >
                {t('Save')}
              </button>
            </>
          }
        >
          <h3 class="panel-title">{t('In the organisation’s projects')}</h3>
          <ProjectPermissionPicker value={editing.perms} editable={projectPerms} onChange={(v) => setEditing({ ...editing, perms: v })} />
          <h3 class="panel-title">{t('In the organisation')}</h3>
          <PermissionPicker labels={ORG_PERM_LABELS} flags={ORG_PERM} value={editing.orgPerms} editable={orgPerms} onChange={(v) => setEditing({ ...editing, orgPerms: v })} />
        </Modal>
      )}
      {deleting && (
        <Modal
          title={t('Delete {name}?', { name: org.name })}
          description={t('Type {slug} to confirm.', { slug: org.slug })}
          onClose={() => setDeleting(false)}
          footer={
            <>
              <button type="button" class="btn" onClick={() => setDeleting(false)}>
                {t('Cancel')}
              </button>
              <button
                type="button"
                class="btn btn-danger"
                disabled={confirm !== org.slug}
                onClick={async () => {
                  try {
                    await api('DELETE', `/api/organizations/${org.slug}`, { confirm });
                    toast('success', t('Organisation deleted'));
                    navigate('/dashboard?tab=organizations');
                  } catch (e) {
                    errorToast(e);
                  }
                }}
              >
                {t('Delete forever')}
              </button>
            </>
          }
        >
          <input class="input" value={confirm} aria-label={t('Confirm organisation URL')} onInput={(e) => setConfirm(e.currentTarget.value)} />
        </Modal>
      )}
    </div>
  );
}

export default function OrganizationPage({ params }: { params: Record<string, string> }) {
  const loc = useLocation();
  const { user } = useSession();
  const { data, error, loading, reload } = useAsync(() => pub<Organization>(`/v1/organizations/${encodeURIComponent(params.slug)}`), [params.slug]);
  const [reporting, setReporting] = useState(false);
  useHead(data ? data.name : null, data?.summary || (data ? t('Minecraft projects by {name}', { name: data.name }) : undefined), data && !data.projects.length ? 'noindex' : undefined);
  if (loading && !data) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="building" title={error instanceof ApiError && error.status === 404 ? t('Organisation not found') : t('Could not load this organisation')} />
      </div>
    );
  }
  const me = data.members.find((m) => m.user.id === user?.id);
  const orgPerms = me ? (me.role === 'owner' ? ORG_PERM_ALL : me.orgPermissions) : 0;
  const projectPerms = me ? (me.role === 'owner' ? PERM_ALL : me.permissions) : 0;
  const tab = loc.query.get('tab') === 'manage' && me ? 'manage' : 'projects';
  const downloads = data.projects.reduce((n, p) => n + p.downloads, 0);
  return (
    <div class="container page">
      <header class="profile-head card card-pad">
        <Avatar src={data.avatarUrl} name={data.name} size="lg" />
        <div class="profile-main">
          <div class="profile-title">
            <h1>{data.name}</h1>
            <span class="badge">{t('Organisation')}</span>
          </div>
          {data.summary && <p class="profile-bio">{data.summary}</p>}
          <div class="profile-stats">
            <span>
              <Icon name="package" /> {tn(data.projects.length, '{n} project', '{n} projects')}
            </span>
            <span>
              <Icon name="download" /> {t('{n} downloads', { n: count(downloads) })}
            </span>
            <span>
              <Icon name="users" /> {t('{n} members', { n: data.members.length })}
            </span>
            <span>
              <Icon name="clock" /> {t('Since {date}', { date: date(data.createdAt) })}
            </span>
          </div>
          <ul class="avatar-row" aria-label={t('Members')}>
            {data.members.slice(0, 12).map((m) => (
              <li key={m.user.id}>
                <Link href={`/user/${m.user.username}`} title={m.user.username}>
                  <Avatar src={m.user.avatarUrl} name={m.user.username} size="sm" />
                </Link>
              </li>
            ))}
          </ul>
        </div>
        <div class="row-actions">
          {data.githubLogin && (
            <a class="btn" href={`https://github.com/${data.githubLogin}`} target="_blank" rel="noopener noreferrer">
              <Icon name="github" /> GitHub
            </a>
          )}
          {user && !me && (
            <Menu label={t('More actions')} trigger={<Icon name="list" />}>
              {(close) => (
                <button type="button" class="menu-item" onClick={() => (close(), setReporting(true))}>
                  <Icon name="flag" /> {t('Report organisation')}
                </button>
              )}
            </Menu>
          )}
        </div>
      </header>
      {me && (
        <Tabs
          current={tab}
          items={[
            { id: 'projects', label: t('Projects'), onClick: () => setQuery({ tab: null }) },
            { id: 'manage', label: t('Manage'), onClick: () => setQuery({ tab: 'manage' }) },
          ]}
        />
      )}
      <section class="section section-tight">
        {tab === 'manage' ? (
          <Manage org={data} reload={reload} orgPerms={orgPerms} projectPerms={projectPerms} />
        ) : data.projects.length ? (
          <div class="result-list">
            {data.projects.map((p) => (
              <ProjectCard key={p.id} p={p} showType />
            ))}
          </div>
        ) : (
          <Empty icon="package" title={t('No published projects yet')}>
            {me && <p>{t('Move a project in from its settings, under Members.')}</p>}
          </Empty>
        )}
      </section>
      {reporting && <ReportDialog targetType="organization" targetId={data.id} label={data.name} onClose={() => setReporting(false)} />}
    </div>
  );
}

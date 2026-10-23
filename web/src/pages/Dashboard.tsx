import type { CollectionSummary, Invite, ProjectSummary, ServerListing } from '../../../shared/types';
import { CollectionList } from '../components/CollectionList';
import { Icon } from '../components/Icon';
import { ProjectCard } from '../components/ProjectCard';
import { RequireAuth } from '../components/RequireAuth';
import { Avatar, Empty, PageLoading, ProjectIcon, Tabs, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { ago, count } from '../lib/format';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, setQuery, useLocation } from '../lib/router';
import { errorToast, refreshSession, toast, useSession } from '../lib/store';

interface MyProject {
  project: ProjectSummary;
  status: string;
  ownerId: string;
  pendingVersions: number;
}

interface MyOrg {
  id: string;
  slug: string;
  name: string;
  avatarUrl: string | null;
  role: string;
  accepted: boolean;
}

type TabId = 'projects' | 'following' | 'collections' | 'organizations' | 'servers';

function Invites({ onChange }: { onChange: () => void }) {
  const invites = useAsync(() => api<{ invites: Invite[] }>('GET', '/api/me/invites'), []);
  const orgs = useAsync(() => api<{ organizations: MyOrg[] }>('GET', '/api/me/organizations'), []);
  const pendingOrgs = (orgs.data?.organizations ?? []).filter((o) => !o.accepted);
  const answerProject = async (projectId: string, accept: boolean) => {
    try {
      await api('POST', `/api/projects/${projectId}/invite`, { accept });
      toast('success', accept ? t('Invite accepted') : t('Invite declined'));
      invites.reload();
      onChange();
      void refreshSession();
    } catch (e) {
      errorToast(e);
    }
  };
  const answerOrg = async (slug: string, accept: boolean) => {
    try {
      await api('POST', `/api/organizations/${slug}/invite`, { accept });
      toast('success', accept ? t('Invite accepted') : t('Invite declined'));
      orgs.reload();
      void refreshSession();
    } catch (e) {
      errorToast(e);
    }
  };
  if (!invites.data?.invites.length && !pendingOrgs.length) return null;
  return (
    <section class="section section-tight">
      <h2 class="section-title">{t('Invites')}</h2>
      <ul class="manage-list card">
        {invites.data?.invites.map((inv) => (
          <li key={inv.project.id} class="manage-row">
            <div class="member">
              <ProjectIcon src={inv.project.iconUrl} name={inv.project.name} size={40} />
              <span>
                <strong>{inv.project.name}</strong>
                <span>{t('Project team invite')}</span>
              </span>
            </div>
            <div class="row-actions">
              <button type="button" class="btn btn-primary btn-sm" onClick={() => answerProject(inv.project.id, true)}>
                {t('Accept')}
              </button>
              <button type="button" class="btn btn-sm" onClick={() => answerProject(inv.project.id, false)}>
                {t('Decline')}
              </button>
            </div>
          </li>
        ))}
        {pendingOrgs.map((o) => (
          <li key={o.id} class="manage-row">
            <div class="member">
              <Avatar src={o.avatarUrl} name={o.name} />
              <span>
                <strong>{o.name}</strong>
                <span>{t('Organisation invite')}</span>
              </span>
            </div>
            <div class="row-actions">
              <button type="button" class="btn btn-primary btn-sm" onClick={() => answerOrg(o.slug, true)}>
                {t('Accept')}
              </button>
              <button type="button" class="btn btn-sm" onClick={() => answerOrg(o.slug, false)}>
                {t('Decline')}
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Projects() {
  const mine = useAsync(() => api<{ projects: MyProject[] }>('GET', '/api/me/projects'), []);
  return (
    <>
      <Invites onChange={mine.reload} />
      <section class="section section-tight">
        {mine.loading ? (
          <PageLoading />
        ) : mine.data?.projects.length ? (
          <ul class="manage-list card">
            {mine.data.projects.map(({ project: p, status, pendingVersions }) => (
              <li key={p.id} class="manage-row">
                <Link href={`/project/${p.slug}`} class="member dash-project">
                  <ProjectIcon src={p.iconUrl} name={p.name} size={44} />
                  <span>
                    <strong>{p.name}</strong>
                    <span>
                      {status === 'draft' ? t('Draft') : status === 'delisted' ? t('Delisted') : p.archived ? t('Archived') : t('Published')} · {t('{n} downloads', { n: count(p.downloads) })} ·{' '}
                      {t('updated {when}', { when: ago(p.updatedAt) })}
                    </span>
                  </span>
                </Link>
                <div class="row-actions">
                  {pendingVersions > 0 && (
                    <span class="badge badge-warning">
                      <Icon name="clock" /> {t('{n} pending', { n: pendingVersions })}
                    </span>
                  )}
                  <Link href={`/project/${p.slug}/upload`} class="btn btn-sm">
                    <Icon name="upload" /> {t('Upload')}
                  </Link>
                  <Link href={`/project/${p.slug}/settings?tab=analytics`} class="btn btn-ghost btn-sm btn-icon" aria-label={t('Analytics for {name}', { name: p.name })}>
                    <Icon name="activity" />
                  </Link>
                  <Link href={`/project/${p.slug}/settings`} class="btn btn-ghost btn-sm btn-icon" aria-label={t('Settings for {name}', { name: p.name })}>
                    <Icon name="settings" />
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        ) : (
          <div class="card">
            <Empty icon="package" title={t('You haven’t created anything yet')}>
              <p>{t('Projects publish releases to a GitHub repository you own.')}</p>
              <Link href="/new" class="btn btn-primary">
                {t('Create your first project')}
              </Link>
            </Empty>
          </div>
        )}
      </section>
    </>
  );
}

function Following() {
  const follows = useAsync(() => api<{ projects: ProjectSummary[] }>('GET', '/api/me/follows'), []);
  if (follows.loading) return <PageLoading />;
  return follows.data?.projects.length ? (
    <div class="result-list">
      {follows.data.projects.map((p) => (
        <ProjectCard key={p.id} p={p} showType />
      ))}
    </div>
  ) : (
    <div class="card">
      <Empty icon="heart" title={t('Not following anything yet')}>
        <p>{t('Follow projects to get notified about new versions.')}</p>
      </Empty>
    </div>
  );
}

function Collections() {
  const mine = useAsync(() => api<{ collections: CollectionSummary[] }>('GET', '/api/me/collections'), []);
  if (mine.loading) return <PageLoading />;
  return (
    <div class="stack">
      <p class="muted">{t('Save projects to collections from any project page. Public collections show on your profile.')}</p>
      <CollectionList list={mine.data?.collections ?? []} empty={t('No collections yet')} />
    </div>
  );
}

function Organizations() {
  const orgs = useAsync(() => api<{ organizations: MyOrg[] }>('GET', '/api/me/organizations'), []);
  if (orgs.loading) return <PageLoading />;
  const list = (orgs.data?.organizations ?? []).filter((o) => o.accepted);
  return (
    <div class="stack">
      <div class="row-actions">
        <Link href="/organizations/new" class="btn btn-primary">
          <Icon name="plus" /> {t('New organisation')}
        </Link>
      </div>
      {list.length ? (
        <ul class="manage-list card">
          {list.map((o) => (
            <li key={o.id} class="manage-row">
              <Link href={`/organization/${o.slug}`} class="member">
                <Avatar src={o.avatarUrl} name={o.name} />
                <span>
                  <strong>{o.name}</strong>
                  <span>{o.role === 'owner' ? t('Owner') : t('Member')}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div class="card">
          <Empty icon="building" title={t('You’re not in any organisations')}>
            <p>{t('Organisations share projects between a team, with permissions per member.')}</p>
          </Empty>
        </div>
      )}
    </div>
  );
}

function Servers() {
  const mine = useAsync(() => api<{ servers: ServerListing[] }>('GET', '/api/me/servers'), []);
  if (mine.loading) return <PageLoading />;
  return (
    <div class="stack">
      <div class="row-actions">
        <Link href="/servers/new" class="btn btn-primary">
          <Icon name="plus" /> {t('List a server')}
        </Link>
      </div>
      {mine.data?.servers.length ? (
        <ul class="manage-list card">
          {mine.data.servers.map((s) => (
            <li key={s.id} class="manage-row">
              <Link href={`/server/${s.slug}`} class="member">
                <span class={`status-dot${s.online ? ' is-online' : ''}`} aria-hidden="true" />
                <span>
                  <strong>{s.name}</strong>
                  <span class="mono">{s.address}</span>
                </span>
              </Link>
              <Link href={`/server/${s.slug}/edit`} class="btn btn-ghost btn-sm btn-icon" aria-label={t('Edit {name}', { name: s.name })}>
                <Icon name="settings" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div class="card">
          <Empty icon="server" title={t('No servers listed')} />
        </div>
      )}
    </div>
  );
}

function Inner() {
  useHead(t('Dashboard'), undefined, 'noindex');
  const loc = useLocation();
  const { user } = useSession();
  const tabs: [TabId, string][] = [
    ['projects', t('Projects')],
    ['following', t('Following')],
    ['collections', t('Collections')],
    ['organizations', t('Organisations')],
    ['servers', t('Servers')],
  ];
  const wanted = loc.query.get('tab') as TabId | null;
  const tab: TabId = tabs.find(([id]) => id === wanted)?.[0] ?? 'projects';
  return (
    <div class="container page">
      <div class="page-head">
        <div>
          <h1>{t('Dashboard')}</h1>
          <p class="page-sub">{t('Everything you make, follow and save.')}</p>
        </div>
        <Link href="/new" class="btn btn-primary">
          <Icon name="plus" /> {t('New project')}
        </Link>
      </div>
      <Tabs
        current={tab}
        items={tabs.map(([id, label]) => ({ id, label, count: id === 'projects' && user?.pendingInvites ? user.pendingInvites : undefined, onClick: () => setQuery({ tab: id === 'projects' ? null : id }) }))}
      />
      <div class="settings-body">
        {tab === 'projects' && <Projects />}
        {tab === 'following' && <Following />}
        {tab === 'collections' && <Collections />}
        {tab === 'organizations' && <Organizations />}
        {tab === 'servers' && <Servers />}
      </div>
    </div>
  );
}

export default function Dashboard() {
  return <RequireAuth>{() => <Inner />}</RequireAuth>;
}

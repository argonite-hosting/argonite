import { useState } from 'preact/hooks';
import { userHead } from '../../../shared/seo';
import type { CollectionSummary, ProjectSummary, UserPublic } from '../../../shared/types';
import { CollectionList } from '../components/CollectionList';
import { Icon } from '../components/Icon';
import { ProjectCard } from '../components/ProjectCard';
import { ReportDialog } from '../components/ReportDialog';
import { Avatar, Empty, Menu, PageLoading, Tabs, useAsync } from '../components/ui';
import { SITE } from '../config';
import { ApiError, pub } from '../lib/api';
import { count, date } from '../lib/format';
import { useHead } from '../lib/head';
import { t, tn } from '../lib/i18n';
import { Link } from '../lib/router';
import { useSession } from '../lib/store';
import { safeHref, useBlockedLinks } from '../lib/blockedLinks';

interface Profile {
  user: UserPublic;
  projects: ProjectSummary[];
  links: { label: string; url: string }[];
}

export default function UserPage({ params }: { params: Record<string, string> }) {
  const blocked = useBlockedLinks();
  const { user: me } = useSession();
  const { data, error, loading } = useAsync(() => pub<Profile>(`/v1/users/${encodeURIComponent(params.username)}`), [params.username]);
  const collections = useAsync(() => pub<{ collections: CollectionSummary[] }>(`/v1/users/${encodeURIComponent(params.username)}/collections`), [params.username]);
  const [reporting, setReporting] = useState(false);
  const [tab, setTab] = useState<'projects' | 'collections'>('projects');
  const head = data ? userHead(data.user, data.projects.length, SITE.name) : null;
  useHead(head ? head.title : null, head?.description, head?.noindex ? 'noindex' : undefined);
  if (loading) return <PageLoading />;
  if (error || !data) {
    return (
      <div class="container page">
        <Empty icon="user" title={error instanceof ApiError && error.status === 404 ? t('User not found') : t('Could not load this profile')} />
      </div>
    );
  }
  const { user, projects, links } = data;
  const downloads = projects.reduce((s, p) => s + p.downloads, 0);
  const publicCollections = collections.data?.collections ?? [];
  return (
    <div class="container page">
      <header class="profile-head card card-pad">
        <Avatar src={user.avatarUrl} name={user.username} size="lg" />
        <div class="profile-main">
          <div class="profile-title">
            <h1>{user.displayName || user.username}</h1>
            {user.role !== 'user' && <span class="badge badge-accent">{user.role === 'admin' ? t('Admin') : t('Moderator')}</span>}
          </div>
          <p class="muted">@{user.username}</p>
          {user.bio && <p class="profile-bio">{user.bio}</p>}
          <div class="profile-stats">
            <span>
              <Icon name="package" /> {tn(projects.length, '{n} project', '{n} projects')}
            </span>
            <span>
              <Icon name="download" /> {t('{n} downloads', { n: count(downloads) })}
            </span>
            <span>
              <Icon name="clock" /> {t('Joined {date}', { date: date(user.createdAt) })}
            </span>
          </div>
          {links?.length > 0 && (
            <ul class="profile-links">
              {links.filter((l) => safeHref(l.url, blocked)).map((l) => (
                <li key={l.url}>
                  <a href={l.url} target="_blank" rel="noopener noreferrer nofollow ugc">
                    <Icon name="link" /> {l.label}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div class="row-actions">
          <a class="btn" href={`https://github.com/${user.username}`} target="_blank" rel="noopener noreferrer">
            <Icon name="github" /> GitHub
          </a>
          {me && me.id !== user.id && (
            <Menu label={t('More actions')} trigger={<Icon name="list" />}>
              {(close) => (
                <button type="button" class="menu-item" onClick={() => (close(), setReporting(true))}>
                  <Icon name="flag" /> {t('Report user')}
                </button>
              )}
            </Menu>
          )}
        </div>
      </header>
      <Tabs
        current={tab}
        items={[
          { id: 'projects', label: t('Projects'), count: projects.length, onClick: () => setTab('projects') },
          { id: 'collections', label: t('Collections'), count: publicCollections.length, onClick: () => setTab('collections') },
        ]}
      />
      <section class="section section-tight">
        {tab === 'projects' &&
          (projects.length ? (
            <div class="result-list">
              {projects.map((p) => (
                <ProjectCard key={p.id} p={p} showType />
              ))}
            </div>
          ) : (
            <Empty icon="package" title={t('No published projects yet')}>
              {me?.id === user.id && (
                <Link href="/new" class="btn btn-primary">
                  {t('Create a project')}
                </Link>
              )}
            </Empty>
          ))}
        {tab === 'collections' && <CollectionList list={publicCollections} empty={t('No public collections')} />}
      </section>
      {reporting && <ReportDialog targetType="user" targetId={user.id} label={user.username} onClose={() => setReporting(false)} />}
    </div>
  );
}

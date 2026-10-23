import type { Notification } from '../../../shared/types';
import { Icon, type IconName } from '../components/Icon';
import { RequireAuth } from '../components/RequireAuth';
import { Empty, PageLoading, useAsync } from '../components/ui';
import { api } from '../lib/api';
import { ago, date } from '../lib/format';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { notificationText } from '../lib/notifications';
import { Link } from '../lib/router';
import { refreshSession } from '../lib/store';

const ICONS: Record<Notification['kind'], IconName> = {
  version: 'package',
  invite: 'users',
  org_invite: 'building',
  comment: 'message',
  reply: 'message',
  mod_message: 'shield',
  version_status: 'shieldCheck',
};

function Inner() {
  useHead(t('Notifications'), undefined, 'noindex');
  const { data, loading } = useAsync(async () => {
    const r = await api<{ notifications: Notification[] }>('GET', '/api/me/notifications');
    await api('POST', '/api/me/notifications/read');
    void refreshSession();
    return r;
  }, []);
  return (
    <div class="container page page-narrow">
      <div class="page-head">
        <div>
          <h1>{t('Notifications')}</h1>
          <p class="page-sub">{t('The last 30 days.')}</p>
        </div>
        <Link href="/settings?tab=notifications" class="btn btn-ghost">
          <Icon name="settings" /> {t('Feed and settings')}
        </Link>
      </div>
      {loading ? (
        <PageLoading />
      ) : data?.notifications.length ? (
        <ul class="manage-list card">
          {data.notifications.map((n) => {
            const text = notificationText(n);
            return (
              <li key={n.id} class={`manage-row notif-row${n.unread ? ' is-unread' : ''}`}>
                <Link href={n.url} class="member">
                  <span class="notif-icon">
                    <Icon name={ICONS[n.kind]} />
                  </span>
                  <span>
                    <strong>{text.title}</strong>
                    <span>{text.body}</span>
                  </span>
                </Link>
                <time class="muted" title={date(n.createdAt)}>
                  {ago(n.createdAt)}
                </time>
              </li>
            );
          })}
        </ul>
      ) : (
        <div class="card">
          <Empty icon="bell" title={t('You’re all caught up.')} />
        </div>
      )}
    </div>
  );
}

export default function Notifications() {
  return <RequireAuth>{() => <Inner />}</RequireAuth>;
}

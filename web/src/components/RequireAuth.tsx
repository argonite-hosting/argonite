import type { ComponentChildren } from 'preact';
import type { Me } from '../../../shared/types';
import { loginUrl } from '../lib/api';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { useLocation } from '../lib/router';
import { isStaff, useSession } from '../lib/store';
import { Icon } from './Icon';
import { Empty, PageLoading } from './ui';

function SignIn() {
  const loc = useLocation();
  useHead(t('Sign in'), undefined, 'noindex');
  return (
    <div class="container page">
      <Empty icon="lock" title={t('Sign in to continue')}>
        <p>{t('Use your GitHub account. We only ask for access to repositories you choose.')}</p>
        <a class="btn btn-primary" href={loginUrl(loc.path + (loc.query.toString() ? `?${loc.query}` : ''))}>
          <Icon name="github" /> {t('Sign in with GitHub')}
        </a>
      </Empty>
    </div>
  );
}

export function RequireAuth({ children, staff = false }: { children: (user: Me) => ComponentChildren; staff?: boolean }) {
  const { ready, user } = useSession();
  if (!ready) return <PageLoading />;
  if (!user) return <SignIn />;
  if (staff && !isStaff(user)) {
    return (
      <div class="container page">
        <Empty icon="lock" title={t('Moderators only')} />
      </div>
    );
  }
  return <>{children(user)}</>;
}

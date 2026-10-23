import { Icon } from '../components/Icon';
import { Empty } from '../components/ui';
import { loginUrl } from '../lib/api';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link, useLocation } from '../lib/router';

function reasons(): Record<string, string> {
  return {
    denied: t('You cancelled the GitHub sign-in.'),
    expired: t('The sign-in took too long or your browser blocked our cookie. Try again.'),
    state: t('The sign-in request didn’t match. Try again from this browser tab.'),
    github: t('GitHub didn’t confirm the sign-in. Try again in a moment.'),
    code: t('GitHub sent back an invalid response.'),
  };
}

export default function AuthError() {
  useHead(t('Sign-in problem'), undefined, 'noindex');
  const reason = useLocation().query.get('reason') ?? '';
  return (
    <div class="container page">
      <Empty icon="lock" title={t('Sign-in didn’t complete')}>
        <p>{reasons()[reason] ?? t('Something went wrong while signing in.')}</p>
        <div class="row-actions">
          <a class="btn btn-primary" href={loginUrl('/')}>
            <Icon name="github" /> {t('Try again')}
          </a>
          <Link class="btn" href="/">
            {t('Home')}
          </Link>
        </div>
      </Empty>
    </div>
  );
}

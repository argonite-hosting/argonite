import { Empty } from '../components/ui';
import { useHead } from '../lib/head';
import { t } from '../lib/i18n';
import { Link } from '../lib/router';

export default function NotFound() {
  useHead(t('Page not found'), undefined, 'noindex');
  return (
    <div class="container page">
      <Empty icon="search" title={t('Page not found')}>
        <p>{t('The page you’re looking for doesn’t exist or has moved.')}</p>
        <div class="row-actions">
          <Link href="/" class="btn btn-primary">
            {t('Home')}
          </Link>
          <Link href="/browse" class="btn">
            {t('Browse projects')}
          </Link>
        </div>
      </Empty>
    </div>
  );
}

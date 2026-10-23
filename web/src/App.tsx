import { PROJECT_TYPES } from '../../shared/taxonomy';
import { CommandPalette, usePaletteShortcut } from './components/CommandPalette';
import { Footer } from './components/Footer';
import { Header } from './components/Header';
import { Empty, PageLoading, Toasts } from './components/ui';
import { t, useLocale } from './lib/i18n';
import { route, useRoutePage, type Route } from './lib/router';

const browse = () => import('./pages/Browse');
const project = () => import('./pages/Project');
const serverForm = () => import('./pages/ServerForm');

const ROUTES: Route[] = [
  route('/', () => import('./pages/Home')),
  route('/browse', browse),
  ...PROJECT_TYPES.map((t) => route(`/${t.path}`, browse)),
  route('/project/:slug', project),
  route('/project/:slug/versions', project),
  route('/project/:slug/gallery', project),
  route('/project/:slug/changelog', project),
  route('/project/:slug/contents', project),
  route('/project/:slug/comments', project),
  route('/project/:slug/version/:versionId', project),
  route('/project/:slug/settings', () => import('./pages/ProjectSettings')),
  route('/project/:slug/upload', () => import('./pages/Upload')),
  route('/new', () => import('./pages/NewProject')),
  route('/user/:username', () => import('./pages/User')),
  route('/dashboard', () => import('./pages/Dashboard')),
  route('/notifications', () => import('./pages/Notifications')),
  route('/collection/:id', () => import('./pages/Collection')),
  route('/organizations/new', () => import('./pages/NewOrganization')),
  route('/organization/:slug', () => import('./pages/Organization')),
  route('/servers', () => import('./pages/Servers')),
  route('/servers/new', serverForm),
  route('/server/:slug', () => import('./pages/Server')),
  route('/server/:slug/edit', serverForm),
  route('/settings', () => import('./pages/Settings')),
  route('/moderation', () => import('./pages/Moderation')),
  route('/api-docs', () => import('./pages/ApiDocs')),
  route('/how-it-works', () => import('./pages/HowItWorks')),
  route('/legal/:page', () => import('./pages/Legal')),
  route('/auth/error', () => import('./pages/AuthError')),
];
const NOT_FOUND = route('/__404', () => import('./pages/NotFound'));

export function App() {
  const { Page, params, failed, path } = useRoutePage(ROUTES, NOT_FOUND);
  // Re-render everything when the language changes.
  useLocale();
  usePaletteShortcut();
  return (
    <>
      <a class="skip-link" href="#main">
        {t('Skip to content')}
      </a>
      <Header />
      <main id="main" class="site-main" tabIndex={-1}>
        {failed ? (
          <div class="container">
            <Empty icon="refresh" title={t('This page failed to load')}>
              <p>{t('A new version of the site may have just been deployed.')}</p>
              <button type="button" class="btn btn-primary" onClick={() => window.location.reload()}>
                {t('Reload')}
              </button>
            </Empty>
          </div>
        ) : Page ? (
          <Page key={params.slug ?? path} params={params} />
        ) : (
          <PageLoading />
        )}
      </main>
      <Footer />
      <Toasts />
      <CommandPalette />
    </>
  );
}

import { useEffect, useLayoutEffect, useRef, useState } from 'preact/hooks';
import { PROJECT_TYPES } from '../../../shared/taxonomy';
import type { Notification } from '../../../shared/types';
import { SITE } from '../config';
import { api, loginUrl } from '../lib/api';
import { ago } from '../lib/format';
import { t } from '../lib/i18n';
import { notificationText } from '../lib/notifications';
import { Link, navigate, useLocation } from '../lib/router';
import { errorToast, isStaff, refreshSession, session, useSession, useStore } from '../lib/store';
import { setTheme, theme, type ThemeChoice } from '../lib/theme';
import { openPalette } from './CommandPalette';
import { Icon } from './Icon';
import { Logo } from './Logo';
import { Avatar, Menu, Spinner } from './ui';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function ThemeMenu() {
  const current = useStore(theme);
  const icon = current === 'system' ? 'monitor' : current === 'dark' ? 'moon' : 'sun';
  const themes: { id: ThemeChoice; label: string; icon: 'sun' | 'moon' | 'monitor' }[] = [
    { id: 'light', label: t('Light'), icon: 'sun' },
    { id: 'dark', label: t('Dark'), icon: 'moon' },
    { id: 'system', label: t('Match system'), icon: 'monitor' },
  ];
  return (
    <Menu label={t('Change theme')} trigger={<Icon name={icon} />}>
      {(close) =>
        themes.map((th) => (
          <button
            key={th.id}
            type="button"
            class="menu-item"
            role="menuitemradio"
            aria-checked={current === th.id}
            onClick={() => {
              setTheme(th.id);
              close();
            }}
          >
            <Icon name={th.icon} />
            {th.label}
            {current === th.id && <Icon name="check" class="menu-check" />}
          </button>
        ))
      }
    </Menu>
  );
}

function Bell() {
  const { user } = useSession();
  const [items, setItems] = useState<Notification[] | null>(null);
  if (!user) return null;
  const unread = user.unreadNotifications;
  const load = async () => {
    try {
      const r = await api<{ notifications: Notification[] }>('GET', '/api/me/notifications');
      setItems(r.notifications.slice(0, 8));
      if (unread) {
        await api('POST', '/api/me/notifications/read');
        session.set({ ...session.get(), user: { ...user, unreadNotifications: 0 } });
      }
    } catch (e) {
      errorToast(e);
    }
  };
  return (
    <span class="bell" onClick={() => items === null && void load()}>
      <Menu
        label={unread ? t('Notifications ({n} new)', { n: unread }) : t('Notifications')}
        trigger={
          <>
            <Icon name="bell" />
            {unread > 0 && <span class="bell-dot">{unread > 9 ? '9+' : unread}</span>}
          </>
        }
      >
        {(close) => (
          <div class="notif-menu">
            <div class="menu-header">
              <strong>{t('Notifications')}</strong>
            </div>
            {items === null ? (
              <div class="page-loading">
                <Spinner />
              </div>
            ) : items.length ? (
              items.map((n) => {
                const text = notificationText(n);
                return (
                  <Link key={n.id} class={`menu-item notif-item${n.unread ? ' is-unread' : ''}`} href={n.url} onClick={close}>
                    <span>
                      <strong>{text.title}</strong>
                      <span class="muted">
                        {text.body} · {ago(n.createdAt)}
                      </span>
                    </span>
                  </Link>
                );
              })
            ) : (
              <p class="muted notif-empty">{t('You’re all caught up.')}</p>
            )}
            <div class="menu-sep" />
            <Link class="menu-item" href="/notifications" onClick={close}>
              <Icon name="list" /> {t('See all')}
            </Link>
          </div>
        )}
      </Menu>
    </span>
  );
}

async function signOut() {
  try {
    await api('POST', '/auth/logout');
  } catch (e) {
    errorToast(e, t('Could not sign out'));
  }
  await refreshSession();
  navigate('/');
}

function AccountMenu() {
  const { user } = useSession();
  if (!user) return null;
  return (
    <Menu label={t('Account menu')} triggerClass="avatar-button" trigger={<Avatar src={user.avatarUrl} name={user.username} />}>
      {(close) => (
        <>
          <div class="menu-header">
            <strong>{user.displayName || user.username}</strong>
            <span>@{user.username}</span>
          </div>
          <Link class="menu-item" href="/dashboard" onClick={close}>
            <Icon name="layout" /> {t('Dashboard')}
            {user.pendingInvites > 0 && <span class="badge badge-accent menu-badge">{user.pendingInvites}</span>}
          </Link>
          <Link class="menu-item" href="/dashboard?tab=collections" onClick={close}>
            <Icon name="folder" /> {t('Collections')}
          </Link>
          <Link class="menu-item" href={`/user/${user.username}`} onClick={close}>
            <Icon name="user" /> {t('Public profile')}
          </Link>
          <Link class="menu-item" href="/settings" onClick={close}>
            <Icon name="settings" /> {t('Settings')}
          </Link>
          {isStaff(user) && (
            <Link class="menu-item" href="/moderation" onClick={close}>
              <Icon name="shield" /> {t('Moderation')}
            </Link>
          )}
          <div class="menu-sep" />
          <button
            type="button"
            class="menu-item"
            onClick={() => {
              close();
              void signOut();
            }}
          >
            <Icon name="logOut" /> {t('Sign out')}
          </button>
        </>
      )}
    </Menu>
  );
}

const TIGHT_CTA = 36;

export function Header() {
  const loc = useLocation();
  const { ready, user } = useSession();
  const [drawer, setDrawer] = useState(false);
  useEffect(() => setDrawer(false), [loc.path]);
  const signIn = loginUrl(loc.path + (loc.query.toString() ? `?${loc.query}` : ''));
  const links = [...PROJECT_TYPES.map((p) => ({ href: `/${p.path}`, label: t(p.plural) })), { href: '/servers', label: t('Servers') }];
  const nav = useRef<HTMLElement>(null);
  const ctaChrome = useRef(0);
  const [fit, setFit] = useState<'full' | 'tight' | 'compact'>('full');
  // Keep the links on one line in every language: first the main button drops its label, then the
  // links move into the menu. Room is worked out as if nothing were collapsed, so widening the
  // window brings everything back.
  useLayoutEffect(() => {
    const el = nav.current;
    const inner = el?.parentElement;
    if (!el || !inner) return;
    const measure = () => {
      const header = inner.parentElement;
      const logo = inner.querySelector<HTMLElement>('.header-logo');
      const actions = inner.querySelector<HTMLElement>('.header-actions');
      if (!header || !logo || !actions) return;
      const cta = actions.querySelector<HTMLElement>('.header-cta');
      const label = cta?.querySelector<HTMLElement>('span');
      const tight = header.classList.contains('is-tight');
      const compact = header.classList.contains('is-compact');
      // Width the button adds besides its label (padding, icon, gap), taken while the label shows.
      if (cta && label && !tight && label.offsetWidth) ctaChrome.current = cta.offsetWidth - label.offsetWidth;
      const savings = cta && label && ctaChrome.current ? Math.max(0, ctaChrome.current + label.offsetWidth - TIGHT_CTA) : 0;
      const burger = compact ? (actions.querySelector<HTMLElement>('.header-burger')?.offsetWidth ?? 0) + parseFloat(getComputedStyle(actions).columnGap || '0') : 0;
      const style = getComputedStyle(inner);
      const gap = parseFloat(style.columnGap) || 0;
      const room = inner.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - logo.offsetWidth - (actions.offsetWidth - burger + (tight ? savings : 0)) - gap * 2;
      const items = [...el.children] as HTMLElement[];
      const linkGap = parseFloat(getComputedStyle(el).columnGap) || 0;
      const needed = items.reduce((sum, item) => sum + item.offsetWidth, 0) + linkGap * Math.max(0, items.length - 1);
      const slack = room - needed;
      setFit(slack >= 0 ? 'full' : slack + savings >= 0 ? 'tight' : 'compact');
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(inner);
    return () => ro.disconnect();
  }, [links.map((l) => l.label).join('|'), ready, !!user]);
  const compact = fit === 'compact';

  return (
    <header class={`site-header${fit === 'full' ? '' : ` is-${fit}`}`}>
      <div class="container header-inner">
        <Link href="/" class="header-logo" aria-label={t('{site} home', { site: SITE.name })}>
          <Logo />
        </Link>
        <nav ref={nav} class="header-nav" aria-label={t('Browse')} aria-hidden={compact || undefined}>
          {links.map((l) => (
            <Link key={l.href} href={l.href} class="nav-link" aria-current={loc.path === l.href ? 'page' : undefined}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div class="header-actions">
          <button type="button" class="palette-trigger" onClick={openPalette} aria-label={t('Search and commands')}>
            <Icon name="search" />
            <span class="palette-trigger-text">{t('Search')}</span>
            <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
          </button>
          <ThemeMenu />
          {ready && user ? (
            <>
              <Bell />
              <Link href="/new" class="btn btn-primary header-new header-cta" aria-label={t('New project')}>
                <Icon name="plus" />
                <span>{t('New project')}</span>
              </Link>
              <AccountMenu />
            </>
          ) : ready ? (
            <a class="btn btn-primary header-signin header-cta" href={signIn} aria-label={t('Sign in')}>
              <Icon name="github" />
              <span>{t('Sign in')}</span>
            </a>
          ) : (
            <span class="header-placeholder" />
          )}
          <button class="btn btn-ghost btn-icon header-burger" type="button" aria-label={drawer ? t('Close menu') : t('Open menu')} aria-expanded={drawer} onClick={() => setDrawer((d) => !d)}>
            <Icon name={drawer ? 'x' : 'menu'} />
          </button>
        </div>
      </div>
      {drawer && (
        <nav class="drawer" aria-label={t('Browse')}>
          {links.map((l) => (
            <Link key={l.href} href={l.href} class="drawer-link" aria-current={loc.path === l.href ? 'page' : undefined}>
              {l.label}
              <Icon name="chevronRight" />
            </Link>
          ))}
        </nav>
      )}
    </header>
  );
}

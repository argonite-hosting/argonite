import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { PROJECT_TYPES, typeInfo } from '../../../shared/taxonomy';
import type { ProjectSummary, SearchResult } from '../../../shared/types';
import { loginUrl, pub } from '../lib/api';
import { t } from '../lib/i18n';
import { navigate, useLocation } from '../lib/router';
import { Store, isStaff, useSession, useStore } from '../lib/store';
import { setTheme } from '../lib/theme';
import { TYPE_ICON } from '../lib/typeIcons';
import { Icon, type IconName } from './Icon';
import { ProjectIcon } from './ui';

export const paletteOpen = new Store(false);

export function openPalette(): void {
  paletteOpen.set(true);
}

interface Item {
  id: string;
  label: string;
  hint?: string;
  icon?: IconName;
  project?: ProjectSummary;
  run: () => void;
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  return !!el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName));
}

export function usePaletteShortcut(): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        paletteOpen.set(!paletteOpen.get());
      } else if (e.key === '/' && !isTyping(e.target) && !paletteOpen.get()) {
        e.preventDefault();
        paletteOpen.set(true);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
}

export function CommandPalette() {
  const open = useStore(paletteOpen);
  return open ? <Palette onClose={() => paletteOpen.set(false)} /> : null;
}

function Palette({ onClose }: { onClose: () => void }) {
  const { user } = useSession();
  const loc = useLocation();
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProjectSummary[]>([]);
  const [busy, setBusy] = useState(false);
  const [active, setActive] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);

  // Layout effect so focus lands before the first paint and no keystrokes typed right after Ctrl+K get lost.
  useLayoutEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      setBusy(false);
      return;
    }
    setBusy(true);
    const timer = setTimeout(() => {
      pub<SearchResult>(`/v1/search?q=${encodeURIComponent(term)}&limit=6`)
        .then((r) => setHits(r.hits))
        .catch(() => setHits([]))
        .finally(() => setBusy(false));
    }, 160);
    return () => clearTimeout(timer);
  }, [q]);

  const go = (href: string) => () => {
    onClose();
    navigate(href);
  };

  const commands = useMemo<Item[]>(() => {
    const base: Item[] = [
      ...PROJECT_TYPES.map((pt) => ({ id: `type-${pt.id}`, label: t('Browse {things}', { things: t(pt.plural).toLowerCase() }), icon: TYPE_ICON[pt.id], run: go(`/${pt.path}`) })),
      { id: 'servers', label: t('Browse servers'), icon: 'server', run: go('/servers') },
      { id: 'how', label: t('How verification works'), icon: 'shieldCheck', run: go('/how-it-works') },
      { id: 'api', label: t('Public API'), icon: 'code', run: go('/api-docs') },
      { id: 'light', label: t('Switch to light theme'), icon: 'sun', run: () => (setTheme('light'), onClose()) },
      { id: 'dark', label: t('Switch to dark theme'), icon: 'moon', run: () => (setTheme('dark'), onClose()) },
    ];
    if (user) {
      base.unshift(
        { id: 'new', label: t('Create a project'), icon: 'plus', run: go('/new') },
        { id: 'dash', label: t('Dashboard'), icon: 'layout', run: go('/dashboard') },
        { id: 'notes', label: t('Notifications'), icon: 'bell', run: go('/notifications') },
        { id: 'cols', label: t('My collections'), icon: 'folder', run: go('/dashboard?tab=collections') },
        { id: 'org', label: t('Create an organisation'), icon: 'building', run: go('/organizations/new') },
        { id: 'server', label: t('List a server'), icon: 'server', run: go('/servers/new') },
        { id: 'tokens', label: t('API tokens'), icon: 'key', run: go('/settings?tab=tokens') },
        { id: 'settings', label: t('Account settings'), icon: 'settings', run: go('/settings') },
      );
      if (isStaff(user)) base.push({ id: 'mod', label: t('Moderation queue'), icon: 'shield', run: go('/moderation') });
    } else {
      base.unshift({ id: 'signin', label: t('Sign in with GitHub'), icon: 'github', run: () => window.location.assign(loginUrl(loc.path)) });
    }
    return base;
  }, [user?.id, loc.path]);

  const term = q.trim().toLowerCase();
  const items: Item[] = [
    ...hits.map((p) => ({ id: `p-${p.id}`, label: p.name, hint: t(typeInfo(p.type)?.label ?? ''), project: p, run: go(`/project/${p.slug}`) })),
    ...(term ? [{ id: 'all', label: t('Search everything for “{q}”', { q: q.trim() }), icon: 'search' as IconName, run: go(`/browse?q=${encodeURIComponent(q.trim())}`) }] : []),
    ...commands.filter((c) => !term || c.label.toLowerCase().includes(term)),
  ];
  const safeActive = Math.min(active, Math.max(items.length - 1, 0));

  useEffect(() => setActive(0), [q, hits.length]);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-index="${safeActive}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [safeActive]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => (items.length ? (a + 1) % items.length : 0));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => (items.length ? (a - 1 + items.length) % items.length : 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      items[safeActive]?.run();
    } else if (e.key === 'Tab') {
      e.preventDefault();
    }
  };

  return (
    <div class="palette-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class="palette" role="dialog" aria-modal="true" aria-label={t('Command palette')} onKeyDown={onKey}>
        <div class="palette-search">
          <Icon name="search" />
          <input
            ref={input}
            type="text"
            placeholder={t('Search projects or jump to…')}
            value={q}
            maxLength={200}
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-list"
            aria-activedescendant={items[safeActive] ? `palette-${items[safeActive].id}` : undefined}
            onInput={(e) => setQ(e.currentTarget.value)}
          />
          {busy ? <span class="spinner" aria-hidden="true" /> : <kbd>esc</kbd>}
        </div>
        <ul class="palette-list" id="palette-list" role="listbox" ref={list}>
          {items.map((it, i) => (
            <li
              key={it.id}
              id={`palette-${it.id}`}
              role="option"
              aria-selected={i === safeActive}
              data-index={i}
              class={`palette-item${i === safeActive ? ' is-active' : ''}`}
              onMouseMove={() => i !== safeActive && setActive(i)}
              onClick={() => it.run()}
            >
              {it.project ? <ProjectIcon src={it.project.iconUrl} name={it.project.name} size={24} /> : <Icon name={it.icon ?? 'chevronRight'} />}
              <span class="palette-label">{it.label}</span>
              {it.hint && <span class="palette-hint">{it.hint}</span>}
              {i === safeActive && <kbd class="palette-enter">↵</kbd>}
            </li>
          ))}
          {!items.length && <li class="palette-empty">{t('No matches.')}</li>}
        </ul>
        <div class="palette-foot">
          <span>
            <kbd>↑</kbd>
            <kbd>↓</kbd> {t('move')}
          </span>
          <span>
            <kbd>↵</kbd> {t('open')}
          </span>
          <span>
            <kbd>/</kbd> {t('or')} <kbd>Ctrl K</kbd> {t('anywhere')}
          </span>
        </div>
      </div>
    </div>
  );
}

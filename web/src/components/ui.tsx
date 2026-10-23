import type { ComponentChildren, TargetedMouseEvent } from 'preact';
import { useEffect, useId, useRef, useState } from 'preact/hooks';
import { loaderLabel, type VersionStatus } from '../../../shared/taxonomy';
import type { SandboxSummary } from '../../../shared/types';
import { initials } from '../lib/format';
import { dismissToast, toast, toasts, useStore } from '../lib/store';
import { Icon, type IconName } from './Icon';
import { t, tn } from '../lib/i18n';
import { useVerifiedImage } from '../lib/verifiedImage';

export function Avatar({ src, name, size = 'md' }: { src: string | null | undefined; name: string; size?: 'sm' | 'md' | 'lg' }) {
  const [broken, setBroken] = useState(false);
  const cls = `avatar${size === 'sm' ? ' avatar-sm' : size === 'lg' ? ' avatar-lg' : ''}`;
  if (!src || broken) {
    return (
      <span class={`${cls} avatar-fallback`} aria-hidden="true">
        {initials(name)}
      </span>
    );
  }
  return <img class={cls} src={src} alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onError={() => setBroken(true)} />;
}

// Shown wherever a version is offered: native libraries run outside Java's sandbox.
export function NativeBadge({ version }: { version: { files: { nativeFiles: number }[] } }) {
  if (!version.files.some((f) => f.nativeFiles > 0)) return null;
  return (
    <span class="badge badge-warning" title={t('This version bundles native libraries or programs. They run outside Java’s sandbox, so moderators review them.')}>
      <Icon name="cpu" /> {t('Native code')}
    </span>
  );
}

// The native files inside a scanned file, for owners and moderators.
export function NativeList({ natives }: { natives: { path: string; sha256: string; size: number; platform: string }[] }) {
  if (!natives.length) return null;
  const platform: Record<string, string> = { windows: 'Windows', linux: 'Linux', macos: 'macOS', unknown: t('Unknown') };
  return (
    <div class="native-list">
      <strong>{t('Native files')}</strong>
      <ul>
        {natives.map((n) => (
          <li key={n.path}>
            <span class="badge">{platform[n.platform] ?? n.platform}</span>
            <span class="mono finding-path">{n.path}</span>
            <span class="mono muted" title={n.sha256}>
              {n.sha256.slice(0, 12)}…
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

// Websites a scanned file links to, for owners and moderators.
export function HostList({ hosts }: { hosts: string[] }) {
  if (!hosts.length) return null;
  return (
    <details class="native-list">
      <summary>
        <strong>{t('Websites it links to')}</strong> <span class="muted">({hosts.length})</span>
      </summary>
      <ul>
        {hosts.map((h) => (
          <li key={h}>
            <span class="mono finding-path">{h}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}

const SANDBOX_OS: Record<SandboxSummary['os'], string> = { linux: 'Linux', windows: 'Windows', macos: 'macOS' };

// What the behaviour tests saw when the file ran inside real Minecraft on fresh machines.
// Authors get each machine's status only; `detailed` (moderators) adds what it saw.
export function SandboxList({ runs, detailed = false }: { runs?: SandboxSummary[]; detailed?: boolean }) {
  if (!runs?.length) return null;
  const outcome = (r: SandboxSummary) =>
    r.outcome === 'running' ? t('Running') : r.outcome === 'tested' ? t('Tested') : r.outcome === 'unsupported' ? t('Not tested') : t('Didn’t finish');
  return (
    <div class="sandbox-list">
      <strong>{t('Behaviour tests')}</strong>
      <ul>
        {runs.map((r) => (
          <li key={r.os} class="sandbox-run">
            <div class="sandbox-head">
              <span class="sandbox-os">{SANDBOX_OS[r.os]}</span>
              <span class={`badge sandbox-${r.outcome}`}>{outcome(r)}</span>
              {r.outcome === 'tested' && (
                <span class="field-hint">
                  {[
                    [r.loader ? loaderLabel(r.loader) : null, r.gameVersion].filter(Boolean).join(' '),
                    r.server ? t('Server started') : t('Server didn’t start'),
                    r.joined ? t('Client joined') : r.client ? t('Client started') : t('Client not run'),
                    r.dependencies ? tn(r.dependencies, '{n} dependency', '{n} dependencies') : '',
                    r.watched >= 60 ? tn(Math.round(r.watched / 60), 'watched {n} minute', 'watched {n} minutes') : '',
                  ]
                    .filter(Boolean)
                    .join(' · ')}
                </span>
              )}
              {r.outcome !== 'tested' && r.note && <span class="field-hint">{r.note}</span>}
            </div>
            {r.findings.length > 0 ? (
              <ul class="finding-list">
                {r.findings.map((f, i) => (
                  <li key={i} class={`finding sev-${f.severity}`}>
                    <span class="badge">{t(f.severity)}</span>
                    <span>{f.detail}</span>
                  </li>
                ))}
              </ul>
            ) : (
              detailed && r.outcome === 'tested' && <p class="field-hint">{t('Nothing suspicious happened.')}</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}

// An image from an author's repository, shown only once it matches its recorded SHA-256.
export function VerifiedImg({ src, alt = '', class: cls, loading }: { src: string | null; alt?: string; class?: string; loading?: 'lazy' | 'eager' }) {
  const verified = useVerifiedImage(src);
  if (!verified) return verified === undefined ? <span class={`img-pending${cls ? ` ${cls}` : ''}`} aria-hidden="true" /> : null;
  return <img class={cls} src={verified} alt={alt} loading={loading} decoding="async" />;
}

export function ProjectIcon({ src, name, size = 64 }: { src: string | null; name: string; size?: number }) {
  const [broken, setBroken] = useState(false);
  const verified = useVerifiedImage(src);
  const style = { width: `${size}px`, height: `${size}px`, borderRadius: `${Math.round(size * 0.22)}px` };
  if (verified === undefined) return <span class="project-icon project-icon-fallback" style={style} aria-hidden="true" />;
  if (!verified || broken) {
    return (
      <span class="project-icon project-icon-fallback" style={{ ...style, fontSize: `${Math.round(size * 0.42)}px` }} aria-hidden="true">
        {initials(name).slice(0, 1)}
      </span>
    );
  }
  return <img class="project-icon" style={style} src={verified} alt="" decoding="async" onError={() => setBroken(true)} />;
}

export function Spinner({ label }: { label?: string }) {
  return <span class="spinner" role="status" aria-label={label ?? t('Loading')} />;
}

export function PageLoading() {
  return (
    <div class="page-loading">
      <Spinner />
    </div>
  );
}

export function Empty({ icon = 'package', title, children }: { icon?: IconName; title: string; children?: ComponentChildren }) {
  return (
    <div class="empty">
      <Icon name={icon} />
      <h3>{title}</h3>
      {children}
    </div>
  );
}

export function Alert({ kind = 'info', title, children }: { kind?: 'info' | 'warning' | 'danger' | 'success'; title?: string; children?: ComponentChildren }) {
  const icon: IconName = kind === 'success' ? 'checkCircle' : kind === 'info' ? 'info' : 'alert';
  return (
    <div class={`alert alert-${kind}`} role={kind === 'danger' ? 'alert' : undefined}>
      <Icon name={icon} />
      <div>
        {title && <strong>{title} </strong>}
        {children}
      </div>
    </div>
  );
}

interface FieldProps {
  label: string;
  hint?: ComponentChildren;
  error?: string;
  optional?: boolean;
  children: (id: string, describedBy: string | undefined) => ComponentChildren;
}

export function Field({ label, hint, error, optional, children }: FieldProps) {
  const id = useId();
  const hintId = hint || error ? `${id}-hint` : undefined;
  return (
    <div class="field">
      <label class="field-label" for={id}>
        <span>{label}</span>
        {optional && <span class="optional">{t('Optional')}</span>}
      </label>
      {children(id, hintId)}
      {error ? (
        <span class="field-error" id={hintId}>
          {error}
        </span>
      ) : hint ? (
        <span class="field-hint" id={hintId}>
          {hint}
        </span>
      ) : null}
    </div>
  );
}

export function Modal({
  title,
  description,
  onClose,
  children,
  footer,
  wide,
}: {
  title: string;
  description?: ComponentChildren;
  onClose: () => void;
  children: ComponentChildren;
  footer?: ComponentChildren;
  wide?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const node = ref.current;
    const focusables = () =>
      Array.from(node?.querySelectorAll<HTMLElement>('button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])') ?? []).filter(
        (el) => !el.hasAttribute('disabled'),
      );
    (focusables().find((el) => el.tagName !== 'BUTTON' || !el.classList.contains('modal-close')) ?? node)?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      } else if (e.key === 'Tab') {
        const list = focusables();
        if (!list.length) return;
        const first = list[0];
        const last = list[list.length - 1];
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      previous?.focus?.();
    };
  }, []);
  return (
    <div class="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div class={`modal${wide ? ' modal-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} ref={ref} tabIndex={-1}>
        <div class="modal-head">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p>{description}</p>}
          </div>
          <button class="btn btn-ghost btn-sm btn-icon modal-close" type="button" onClick={onClose} aria-label={t('Close')}>
            <Icon name="x" />
          </button>
        </div>
        <div class="modal-body">{children}</div>
        {footer && <div class="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Menu({
  trigger,
  label,
  children,
  align = 'right',
  triggerClass = 'btn btn-ghost btn-icon',
}: {
  trigger: ComponentChildren;
  label: string;
  children: (close: () => void) => ComponentChildren;
  align?: 'left' | 'right';
  triggerClass?: string;
}) {
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div class="menu-wrap" ref={wrap}>
      <button type="button" class={triggerClass} aria-haspopup="menu" aria-expanded={open} aria-label={label} onClick={() => setOpen((o) => !o)}>
        {trigger}
      </button>
      {open && (
        <div class={`menu${align === 'left' ? ' menu-left' : ''}`} role="menu">
          {children(() => setOpen(false))}
        </div>
      )}
    </div>
  );
}

export function Pagination({ page, pages, onPage }: { page: number; pages: number; onPage: (p: number) => void }) {
  if (pages <= 1) return null;
  const items: (number | '…')[] = [];
  const add = (n: number) => items.push(n);
  add(1);
  if (page > 3) items.push('…');
  for (let n = Math.max(2, page - 1); n <= Math.min(pages - 1, page + 1); n++) add(n);
  if (page < pages - 2) items.push('…');
  if (pages > 1) add(pages);
  return (
    <nav class="pagination" aria-label={t('Pagination')}>
      <button class="btn btn-sm" type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} aria-label={t('Previous page')}>
        <Icon name="chevronLeft" />
      </button>
      {items.map((it, i) =>
        it === '…' ? (
          <span key={`e${i}`} class="ellipsis">
            …
          </span>
        ) : (
          <button key={it} class="btn btn-sm" type="button" aria-current={it === page ? 'page' : undefined} onClick={() => onPage(it)}>
            {it}
          </button>
        ),
      )}
      <button class="btn btn-sm" type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} aria-label={t('Next page')}>
        <Icon name="chevronRight" />
      </button>
    </nav>
  );
}

export function CopyField({ value, label }: { value: string; label: string }) {
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      toast('success', t('{what} copied', { what: label }), undefined, 2500);
    } catch {
      toast('error', t('Could not copy'), t('Your browser blocked clipboard access.'));
    }
  };
  return (
    <div class="copy-field">
      <code title={value}>{value}</code>
      <button class="btn btn-ghost btn-sm btn-icon" type="button" onClick={copy} aria-label={t('Copy {what}', { what: label })}>
        <Icon name="copy" />
      </button>
    </div>
  );
}

const STATUS: Record<VersionStatus, { label: string; cls: string; icon: IconName }> = {
  uploading: { label: 'Uploading', cls: 'badge', icon: 'upload' },
  scanning: { label: 'Scanning', cls: 'badge badge-accent', icon: 'shield' },
  review: { label: 'In review', cls: 'badge badge-warning', icon: 'eye' },
  live: { label: 'Live', cls: 'badge badge-success', icon: 'shieldCheck' },
  rejected: { label: 'Rejected', cls: 'badge badge-danger', icon: 'shieldAlert' },
  revoked: { label: 'Revoked', cls: 'badge badge-danger', icon: 'shieldAlert' },
  unavailable: { label: 'Unavailable', cls: 'badge badge-danger', icon: 'alert' },
  deleted: { label: 'Deleted', cls: 'badge', icon: 'trash' },
};

export function StatusBadge({ status }: { status: VersionStatus }) {
  const s = STATUS[status];
  return (
    <span class={s.cls}>
      <Icon name={s.icon} />
      {t(s.label)}
    </span>
  );
}

export function ChannelBadge({ channel }: { channel: string }) {
  if (channel === 'release') return <span class="badge badge-success">{t('Release')}</span>;
  if (channel === 'beta') return <span class="badge badge-warning">{t('Beta')}</span>;
  return <span class="badge badge-danger">{t('Alpha')}</span>;
}

export function Toasts() {
  const list = useStore(toasts);
  return (
    <div class="toasts" aria-live="polite" aria-relevant="additions">
      {list.map((item) => (
        <div key={item.id} class={`toast toast-${item.kind}`} role={item.kind === 'error' ? 'alert' : 'status'}>
          <Icon name={item.kind === 'success' ? 'checkCircle' : item.kind === 'error' ? 'alert' : 'info'} />
          <div class="toast-body">
            <strong>{item.title}</strong>
            {item.body && <p>{item.body}</p>}
          </div>
          <button type="button" onClick={() => dismissToast(item.id)} aria-label={t('Dismiss')}>
            <Icon name="x" />
          </button>
        </div>
      ))}
    </div>
  );
}

export function Tabs({ items, current }: { items: { id: string; label: string; href?: string; count?: number; onClick?: () => void }[]; current: string }) {
  return (
    <div class="tabs" role="tablist">
      {items.map((it) =>
        it.href ? (
          <a
            key={it.id}
            class="tab"
            role="tab"
            href={it.href}
            aria-selected={current === it.id}
            onClick={(e: TargetedMouseEvent<HTMLAnchorElement>) => {
              if (e.button !== 0 || e.metaKey || e.ctrlKey) return;
              e.preventDefault();
              it.onClick?.();
            }}
          >
            {it.label}
            {it.count !== undefined && <span class="count">{it.count}</span>}
          </a>
        ) : (
          <button key={it.id} type="button" class="tab" role="tab" aria-selected={current === it.id} onClick={it.onClick}>
            {it.label}
            {it.count !== undefined && <span class="count">{it.count}</span>}
          </button>
        ),
      )}
    </div>
  );
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | undefined; error: Error | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | undefined; error: Error | null; loading: boolean }>({ data: undefined, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (error: Error) => alive && setState({ data: undefined, error, loading: false }),
    );
    return () => {
      alive = false;
    };
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

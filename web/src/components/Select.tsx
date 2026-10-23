// A dropdown that looks like the rest of the site instead of the operating system's. It takes the same
// <option> children as a native <select>, and follows the "select-only combobox" pattern: arrow keys,
// Home/End, Enter, Escape, Tab and typing to jump all work, and long lists get a filter box.
import { type ComponentChildren, toChildArray, type VNode } from 'preact';
import { createPortal } from 'preact/compat';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'preact/hooks';
import { t } from '../lib/i18n';
import { Icon } from './Icon';

interface Option {
  value: string;
  label: string;
  disabled: boolean;
}

interface Props {
  value: string | number;
  onChange: (value: string) => void;
  children: ComponentChildren;
  id?: string;
  class?: string;
  disabled?: boolean;
  'aria-label'?: string;
  'aria-describedby'?: string;
}

const FILTER_AT = 12;

function textOf(node: ComponentChildren): string {
  return toChildArray(node)
    .map((c) => (typeof c === 'string' || typeof c === 'number' ? String(c) : textOf((c as VNode<{ children?: ComponentChildren }>).props?.children)))
    .join('');
}

function optionsOf(children: ComponentChildren): Option[] {
  const out: Option[] = [];
  for (const c of toChildArray(children)) {
    if (typeof c !== 'object' || !c) continue;
    const v = c as VNode<{ value?: string | number; children?: ComponentChildren; disabled?: boolean }>;
    if (v.type === 'option') {
      const label = textOf(v.props.children);
      out.push({ value: String(v.props.value ?? label), label, disabled: !!v.props.disabled });
    } else {
      out.push(...optionsOf(v.props.children));
    }
  }
  return out;
}

export function Select({ value, onChange, children, id, class: cls = 'select', disabled, 'aria-label': ariaLabel, 'aria-describedby': describedBy }: Props) {
  const options = useMemo(() => optionsOf(children), [children]);
  const current = String(value);
  const selected = options.find((o) => o.value === current);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [filter, setFilter] = useState('');
  const [place, setPlace] = useState<{ left: number; top: number; width: number; maxHeight: number; up: boolean } | null>(null);
  const button = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const typed = useRef({ text: '', at: 0 });
  const autoId = useId();
  const listId = `${id ?? autoId}-list`;
  const filterable = options.length > FILTER_AT;
  const shown = filter ? options.filter((o) => o.label.toLowerCase().includes(filter.toLowerCase())) : options;

  const enabled = (i: number) => i >= 0 && i < shown.length && !shown[i].disabled;
  const step = (from: number, dir: 1 | -1) => {
    for (let i = from + dir; i >= 0 && i < shown.length; i += dir) if (enabled(i)) return i;
    return from;
  };
  const first = () => step(-1, 1);
  const last = () => step(shown.length, -1);

  const position = () => {
    const r = button.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom - 8;
    const above = r.top - 8;
    const up = below < 220 && above > below;
    const maxHeight = Math.max(140, Math.min(320, up ? above : below));
    setPlace({ left: Math.max(8, Math.min(r.left, window.innerWidth - Math.max(r.width, 180) - 8)), top: up ? r.top - 4 : r.bottom + 4, width: r.width, maxHeight, up });
  };

  const show = () => {
    if (disabled) return;
    setFilter('');
    const i = options.findIndex((o) => o.value === current);
    setActive(i >= 0 ? i : options.findIndex((o) => !o.disabled));
    position();
    setOpen(true);
  };
  const hide = (refocus = true) => {
    setOpen(false);
    setFilter('');
    if (refocus) button.current?.focus();
  };
  const choose = (o: Option | undefined) => {
    if (!o || o.disabled) return;
    if (o.value !== current) onChange(o.value);
    hide();
  };

  // Typing a few letters jumps to the first option that starts with them, like a native select.
  const typeahead = (key: string, apply: (i: number) => void) => {
    const now = Date.now();
    typed.current = { text: (now - typed.current.at < 700 ? typed.current.text : '') + key.toLowerCase(), at: now };
    const i = options.findIndex((o) => !o.disabled && o.label.toLowerCase().startsWith(typed.current.text));
    if (i >= 0) apply(i);
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault();
        show();
      } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        typeahead(e.key, (i) => choose(options[i]));
      }
      return;
    }
    const moves: Record<string, () => number> = {
      ArrowDown: () => step(active, 1),
      ArrowUp: () => step(active, -1),
      Home: first,
      End: last,
      PageDown: () => Math.min(last(), step(active + 7, 1)),
      PageUp: () => Math.max(first(), step(active - 7, -1)),
    };
    if (moves[e.key]) {
      e.preventDefault();
      setActive(moves[e.key]());
    } else if (e.key === 'Enter' || (e.key === ' ' && !filterable)) {
      e.preventDefault();
      choose(shown[active]);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      hide();
    } else if (e.key === 'Tab') {
      hide(false);
    } else if (!filterable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      typeahead(e.key, setActive);
    }
  };

  useLayoutEffect(() => {
    if (!open) return;
    if (filterable) search.current?.focus();
    list.current?.querySelector<HTMLElement>('[data-active="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [open, active, filterable]);

  useEffect(() => {
    if (!open) return;
    const outside = (e: PointerEvent) => {
      const target = e.target as Node;
      if (!button.current?.contains(target) && !list.current?.parentElement?.contains(target)) hide(false);
    };
    const move = () => position();
    document.addEventListener('pointerdown', outside, true);
    window.addEventListener('resize', move);
    window.addEventListener('scroll', move, true);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      window.removeEventListener('resize', move);
      window.removeEventListener('scroll', move, true);
    };
  }, [open]);

  useEffect(() => {
    if (open && filter) setActive(shown.findIndex((o) => !o.disabled));
  }, [filter]);

  const optionId = (i: number) => `${listId}-${i}`;
  return (
    <>
      <button
        ref={button}
        type="button"
        id={id}
        class={`${cls} select-trigger`}
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && !filterable && active >= 0 ? optionId(active) : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        disabled={disabled}
        onClick={() => (open ? hide() : show())}
        onKeyDown={onKeyDown}
      >
        <span class="select-value">{selected?.label ?? ' '}</span>
      </button>
      {open &&
        place &&
        createPortal(
          <div
            class={`select-pop${place.up ? ' is-up' : ''}`}
            style={{ left: `${place.left}px`, top: `${place.top}px`, minWidth: `${place.width}px`, maxHeight: `${place.maxHeight}px` }}
          >
            {filterable && (
              <div class="select-filter">
                <Icon name="search" />
                <input
                  ref={search}
                  class="select-filter-input"
                  value={filter}
                  placeholder={t('Filter')}
                  aria-label={t('Filter')}
                  aria-controls={listId}
                  aria-activedescendant={active >= 0 ? optionId(active) : undefined}
                  onInput={(e) => setFilter(e.currentTarget.value)}
                  onKeyDown={onKeyDown}
                />
              </div>
            )}
            <ul ref={list} id={listId} role="listbox" class="select-list" aria-label={ariaLabel}>
              {shown.map((o, i) => (
                <li
                  key={o.value}
                  id={optionId(i)}
                  role="option"
                  class="select-option"
                  aria-selected={o.value === current}
                  aria-disabled={o.disabled || undefined}
                  data-active={i === active}
                  onPointerMove={() => !o.disabled && setActive(i)}
                  onPointerDown={(e) => e.preventDefault()}
                  onClick={() => choose(o)}
                >
                  <span class="select-option-label">{o.label}</span>
                  {o.value === current && <Icon name="check" />}
                </li>
              ))}
              {!shown.length && <li class="select-empty">{t('No matches')}</li>}
            </ul>
          </div>,
          document.body,
        )}
    </>
  );
}

import { useEffect, useState } from 'preact/hooks';
import { DEPENDENCY_KINDS, type DependencyKind } from '../../../shared/taxonomy';
import type { ProjectSummary, SearchResult } from '../../../shared/types';
import { pub } from '../lib/api';
import { Icon } from './Icon';
import { ProjectIcon } from './ui';
import { t } from '../lib/i18n';

export interface DepDraft {
  projectId: string;
  name: string;
  slug: string;
  kind: DependencyKind;
}

export function DependencyPicker({ value, onChange, excludeId }: { value: DepDraft[]; onChange: (v: DepDraft[]) => void; excludeId: string }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setHits([]);
      return;
    }
    const t = setTimeout(() => {
      pub<SearchResult>(`/v1/search?q=${encodeURIComponent(term)}&limit=6`)
        .then((r) => setHits(r.hits.filter((h) => h.id !== excludeId && !value.some((d) => d.projectId === h.id))))
        .catch(() => setHits([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  return (
    <div class="dep-picker">
      {value.length > 0 && (
        <ul class="dep-edit-list">
          {value.map((d) => (
            <li key={d.projectId}>
              <span class="dep-name">{d.name}</span>
              <select
                class="select"
                value={d.kind}
                aria-label={t('Relationship to {name}', { name: d.name })}
                onChange={(e) => onChange(value.map((x) => (x.projectId === d.projectId ? { ...x, kind: e.currentTarget.value as DependencyKind } : x)))}
              >
                {DEPENDENCY_KINDS.map((k) => (
                  <option key={k} value={k}>
                    {t(k[0].toUpperCase() + k.slice(1))}
                  </option>
                ))}
              </select>
              <button type="button" class="btn btn-ghost btn-sm btn-icon" aria-label={t('Remove {name}', { name: d.name })} onClick={() => onChange(value.filter((x) => x.projectId !== d.projectId))}>
                <Icon name="x" />
              </button>
            </li>
          ))}
        </ul>
      )}
      <div class="input-icon">
        <Icon name="search" />
        <input class="input" type="search" placeholder={t('Search published projects to add')} value={q} aria-label={t('Search dependencies')} onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {hits.length > 0 && (
        <ul class="dep-results">
          {hits.map((h) => (
            <li key={h.id}>
              <button
                type="button"
                onClick={() => {
                  onChange([...value, { projectId: h.id, name: h.name, slug: h.slug, kind: 'required' }]);
                  setQ('');
                  setHits([]);
                }}
              >
                <ProjectIcon src={h.iconUrl} name={h.name} size={28} />
                <span>{h.name}</span>
                <Icon name="plus" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {value.length >= 30 && <span class="field-hint">{t('That’s the maximum of 30 dependencies.')}</span>}
    </div>
  );
}

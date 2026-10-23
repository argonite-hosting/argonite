import { useMemo, useState } from 'preact/hooks';
import type { GameVersion } from '../../../shared/types';
import { pub } from '../lib/api';
import { Icon } from './Icon';
import { useAsync } from './ui';
import { t } from '../lib/i18n';

let cache: Promise<GameVersion[]> | null = null;

export function loadGameVersions(): Promise<GameVersion[]> {
  cache ??= pub<{ gameVersions: GameVersion[] }>('/v1/tags/game-versions')
    .then((r) => r.gameVersions)
    .catch((e) => {
      cache = null;
      throw e;
    });
  return cache;
}

export function useGameVersions() {
  return useAsync(loadGameVersions, []);
}

function majorLine(id: string): string | null {
  const m = /^(\d+\.\d+)(\.\d+)?$/.exec(id);
  return m ? m[1] : null;
}

export function GameVersionPicker({ selected, onChange, id, describedBy }: { selected: string[]; onChange: (v: string[]) => void; id?: string; describedBy?: string }) {
  const { data, error, loading } = useGameVersions();
  const [q, setQ] = useState('');
  const [snapshots, setSnapshots] = useState(false);
  const chosen = new Set(selected);

  const list = useMemo(() => {
    const all = data ?? [];
    const needle = q.trim().toLowerCase();
    return all.filter((v) => (snapshots || v.type === 'release' || chosen.has(v.id)) && (!needle || v.id.toLowerCase().includes(needle))).slice(0, 200);
  }, [data, q, snapshots, selected]);

  const lines = useMemo(() => {
    const seen: string[] = [];
    for (const v of data ?? []) {
      const line = v.type === 'release' ? majorLine(v.id) : null;
      if (line && !seen.includes(line)) seen.push(line);
      if (seen.length >= 6) break;
    }
    return seen;
  }, [data]);

  const toggle = (v: string) => onChange(chosen.has(v) ? selected.filter((x) => x !== v) : [...selected, v]);
  const addLine = (line: string) => {
    const add = (data ?? []).filter((v) => v.type === 'release' && majorLine(v.id) === line).map((v) => v.id);
    onChange([...new Set([...selected, ...add])]);
  };

  if (error) return <p class="field-error">{t('Could not load Minecraft versions. Refresh to try again.')}</p>;
  return (
    <div class="gv-picker">
      {selected.length > 0 && (
        <div class="chips">
          {selected.map((v) => (
            <button key={v} type="button" class="chip" aria-pressed="true" onClick={() => toggle(v)} aria-label={t('Remove {name}', { name: v })}>
              {v}
              <Icon name="x" />
            </button>
          ))}
        </div>
      )}
      <div class="gv-toolbar">
        <div class="input-icon">
          <Icon name="search" />
          <input id={id} class="input" type="search" placeholder={t('Search versions')} value={q} aria-describedby={describedBy} onInput={(e) => setQ(e.currentTarget.value)} />
        </div>
        <label class="check gv-snap">
          <input type="checkbox" checked={snapshots} onChange={(e) => setSnapshots(e.currentTarget.checked)} />
          {t('Snapshots')}
        </label>
      </div>
      {lines.length > 0 && (
        <div class="chips">
          {lines.map((l) => (
            <button key={l} type="button" class="chip" onClick={() => addLine(l)}>
              <Icon name="plus" />
              {t('All {line}.x', { line: l })}
            </button>
          ))}
        </div>
      )}
      <div class="gv-list" role="group" aria-label={t('Minecraft versions')}>
        {loading && <span class="field-hint">{t('Loading versions…')}</span>}
        {list.map((v) => (
          <label key={v.id} class="check">
            <input type="checkbox" checked={chosen.has(v.id)} onChange={() => toggle(v.id)} />
            {v.id}
            {v.type === 'snapshot' && <span class="count">{t('snapshot')}</span>}
          </label>
        ))}
      </div>
    </div>
  );
}

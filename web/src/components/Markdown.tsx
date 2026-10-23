import { useEffect, useState } from 'preact/hooks';
import { Spinner } from './ui';
import { t } from '../lib/i18n';

type Renderer = (src: string) => string;
let renderer: Promise<Renderer> | null = null;

// marked + DOMPurify only load when a page actually shows Markdown.
function loadRenderer(): Promise<Renderer> {
  renderer ??= import('../lib/markdown').then((m) => m.renderMarkdown);
  return renderer;
}

export function Markdown({ source, empty }: { source: string; empty?: string }) {
  const [html, setHtml] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    if (!source.trim()) {
      setHtml('');
      return;
    }
    loadRenderer().then((render) => alive && setHtml(render(source)));
    return () => {
      alive = false;
    };
  }, [source]);
  if (html === null) return <Spinner />;
  if (!html) return <p class="muted">{empty ?? t('Nothing here yet.')}</p>;
  return <div class="prose" dangerouslySetInnerHTML={{ __html: html }} />;
}

export function MarkdownEditor({
  id,
  value,
  onInput,
  rows = 14,
  maxLength,
  placeholder,
  describedBy,
}: {
  id: string;
  value: string;
  onInput: (v: string) => void;
  rows?: number;
  maxLength: number;
  placeholder?: string;
  describedBy?: string;
}) {
  const [mode, setMode] = useState<'write' | 'preview'>('write');
  return (
    <div class="md-editor">
      <div class="md-editor-bar">
        <div class="segmented">
          <button type="button" aria-pressed={mode === 'write'} onClick={() => setMode('write')}>
            {t('Write')}
          </button>
          <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
            {t('Preview')}
          </button>
        </div>
        <span class="field-hint">
          Markdown · {value.length.toLocaleString()}/{maxLength.toLocaleString()}
        </span>
      </div>
      {mode === 'write' ? (
        <textarea
          id={id}
          class="textarea mono-ish"
          rows={rows}
          value={value}
          maxLength={maxLength}
          placeholder={placeholder}
          aria-describedby={describedBy}
          onInput={(e) => onInput(e.currentTarget.value)}
        />
      ) : (
        <div class="md-preview">
          <Markdown source={value} empty={t('Nothing to preview.')} />
        </div>
      )}
    </div>
  );
}

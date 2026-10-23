import { useRef, useState } from 'preact/hooks';
import type { FileInfo, Version } from '../../../shared/types';
import { VerificationError, verifiedDownload, type DownloadState, type Phase } from '../lib/download';
import { bytes } from '../lib/format';
import { t } from '../lib/i18n';
import { Icon } from './Icon';
import { Alert, Modal, Spinner } from './ui';

const ORDER: Phase[] = ['signature', 'connecting', 'downloading', 'verifying', 'saving', 'done'];

function steps(): { phase: Phase[]; label: string }[] {
  return [
    { phase: ['signature'], label: t('Check the scanner’s signature') },
    { phase: ['connecting', 'downloading'], label: t('Download from the author’s GitHub release') },
    { phase: ['verifying'], label: t('Match SHA-256 and SHA-512 fingerprints') },
    { phase: ['saving', 'done'], label: t('Save to your computer') },
  ];
}

export function DownloadButton({
  version,
  file,
  label,
  size = '',
  variant = 'btn-primary',
}: {
  version: Version;
  file?: FileInfo;
  label?: string;
  size?: '' | 'btn-sm' | 'btn-lg';
  variant?: string;
}) {
  const target = file ?? version.file;
  const text = label ?? t('Download');
  const [state, setState] = useState<DownloadState | null>(null);
  const [failedAt, setFailedAt] = useState<Phase | null>(null);
  const abort = useRef<AbortController | null>(null);
  const running = !!state && state.phase !== 'done' && state.phase !== 'failed';

  const start = async () => {
    abort.current = new AbortController();
    setFailedAt(null);
    let last: Phase = 'signature';
    try {
      await verifiedDownload(
        version,
        (s) => {
          last = s.phase;
          setState(s);
        },
        abort.current.signal,
        target ?? undefined,
      );
    } catch (e) {
      if ((e as Error).name === 'AbortError') {
        setState(null);
        return;
      }
      setFailedAt(last);
      setState({
        phase: 'failed',
        loaded: 0,
        total: target?.size ?? 0,
        error: (e as Error).message,
        tampered: e instanceof VerificationError && e.tampered,
      });
    }
  };

  const close = () => {
    abort.current?.abort();
    setState(null);
  };

  const at = state?.phase === 'failed' ? failedAt ?? 'signature' : state?.phase ?? 'signature';
  const idx = ORDER.indexOf(at);
  const accessible = text ? undefined : t('Download {name}', { name: target?.filename ?? version.versionNumber });

  return (
    <>
      <button type="button" class={`btn ${variant} ${size}`} onClick={start} disabled={!target || running} aria-label={accessible} title={accessible}>
        <Icon name="download" />
        {text}
      </button>
      {state && (
        <Modal
          title={state.phase === 'done' ? t('Verified and saved') : state.phase === 'failed' ? t('Download blocked') : t('Verifying download')}
          description={
            <>
              {target?.filename} · {bytes(target?.size ?? 0)}
            </>
          }
          onClose={close}
          footer={
            <button type="button" class={`btn ${state.phase === 'done' ? 'btn-primary' : ''}`} onClick={close}>
              {running ? t('Cancel') : t('Close')}
            </button>
          }
        >
          <ol class="verify-steps">
            {steps().map((step, i) => {
              const stepIdx = Math.max(...step.phase.map((p) => ORDER.indexOf(p)));
              const firstIdx = Math.min(...step.phase.map((p) => ORDER.indexOf(p)));
              const failedHere = state.phase === 'failed' && step.phase.includes(at);
              const done = state.phase === 'done' || (!failedHere && idx > stepIdx);
              const active = !done && !failedHere && idx >= firstIdx && idx <= stepIdx && state.phase !== 'failed';
              return (
                <li key={i} class={`verify-step${done ? ' is-done' : ''}${active ? ' is-active' : ''}${failedHere ? ' is-failed' : ''}`}>
                  <span class="verify-dot">{done ? <Icon name="check" /> : failedHere ? <Icon name="x" /> : active ? <Spinner /> : i + 1}</span>
                  <span>{step.label}</span>
                </li>
              );
            })}
          </ol>
          {(state.phase === 'downloading' || state.phase === 'connecting') && (
            <div class="stack-sm">
              <div class="progress" role="progressbar" aria-valuemin={0} aria-valuemax={state.total} aria-valuenow={state.loaded}>
                <span style={{ width: `${state.total ? Math.round((state.loaded / state.total) * 100) : 0}%` }} />
              </div>
              <span class="field-hint">{t('{loaded} of {total}', { loaded: bytes(state.loaded), total: bytes(state.total) })}</span>
            </div>
          )}
          {state.phase === 'done' && (
            <Alert kind="success" title={t('All checks passed.')}>
              {t('The file matches the exact bytes our scanner checked and signed.')}
            </Alert>
          )}
          {state.phase === 'failed' && (
            <Alert kind="danger" title={state.tampered ? t('Integrity check failed.') : t('Download failed.')}>
              {state.error}
              {state.tampered && ` ${t('We have flagged this version for review.')}`}
            </Alert>
          )}
        </Modal>
      )}
    </>
  );
}

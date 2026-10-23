import { useEffect, useRef, useState } from 'preact/hooks';
import { mountTurnstile, turnstileEnabled } from '../lib/turnstile';
import { t } from '../lib/i18n';

export interface TurnstileHandle {
  reset(): void;
}

// Renders the bot check and reports its token. Without a site key in config/site.json, forms stay disabled.
export function Turnstile({ onToken, handle }: { onToken: (t: string | null) => void; handle?: { current: TurnstileHandle | null } }) {
  const el = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!turnstileEnabled) {
      return;
    }
    let widget: { reset(): void; remove(): void } | null = null;
    let alive = true;
    mountTurnstile(el.current!, onToken)
      .then((w) => {
        if (!alive) return w.remove();
        widget = w;
        if (handle) handle.current = w;
      })
      .catch((e: Error) => alive && setError(e.message));
    return () => {
      alive = false;
      widget?.remove();
    };
  }, []);
  if (!turnstileEnabled) {
    return <span class="field-error">{t('Bot protection isn’t configured on this site yet.')}</span>;
  }
  return (
    <div class="turnstile">
      <div ref={el} />
      {error && <span class="field-error">{error}</span>}
    </div>
  );
}

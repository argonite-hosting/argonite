import { useId } from 'preact/hooks';
import { SITE } from '../config';

const FLASK = 'M26 10V27L11.5 50.5C9 54.5 11.5 59 16.5 59H47.5C52.5 59 55 54.5 52.5 50.5L38 27V10Z';
const RIM = 'M22 4h20a3 3 0 0 1 0 6H22a3 3 0 0 1 0-6Z';
const TILT = 'rotate(22 32 34) translate(32 34) scale(0.86) translate(-32 -34)';

// A tilted flask. The liquid is clipped to the glass but stays level, which sells the tilt.
export function LogoMark({ size = 28 }: { size?: number }) {
  const clip = `flask-${useId()}`;
  return (
    <svg viewBox="0 0 64 64" width={size} height={size} aria-hidden="true" focusable="false">
      <defs>
        <clipPath id={clip}>
          <path transform={TILT} d={FLASK} />
        </clipPath>
      </defs>
      <g transform={TILT}>
        <path d={FLASK} fill="#2563EB" fill-opacity="0.16" stroke="#2563EB" stroke-width="4.5" stroke-linejoin="round" />
        <path d={RIM} fill="#2563EB" />
      </g>
      <rect y="41" width="64" height="30" fill="#2563EB" clip-path={`url(#${clip})`} />
    </svg>
  );
}

export function Logo() {
  return (
    <span class="logo">
      <LogoMark />
      <span class="logo-word">{SITE.name.toLowerCase()}</span>
    </span>
  );
}

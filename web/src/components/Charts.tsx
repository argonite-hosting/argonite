// Small, dependency-free charts for project analytics. One measure per chart (views and downloads
// never share an axis), thin marks, recessive grid, and a hover crosshair with a tooltip.
import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { date, number } from '../lib/format';

interface Point {
  day: string;
  value: number;
}

const H = 200;
const PAD = { top: 12, right: 12, bottom: 24, left: 40 };

function niceMax(v: number): number {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10) * pow;
}

export function LineChart({ points, title }: { points: Point[]; title: string }) {
  const [hover, setHover] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const frame = useRef<HTMLDivElement>(null);
  const [W, setW] = useState(640);
  // Match the drawing width to the element so text and lines never stretch.
  useEffect(() => {
    const el = frame.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => setW(Math.max(280, Math.round(entry.contentRect.width))));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const iw = W - PAD.left - PAD.right;
  const ih = H - PAD.top - PAD.bottom;
  const x = (i: number) => PAD.left + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.top + ih - (v / max) * ih;
  const line = useMemo(() => points.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.value).toFixed(1)}`).join(''), [points, max, W]);
  const area = `${line}L${x(points.length - 1).toFixed(1)},${PAD.top + ih}L${x(0).toFixed(1)},${PAD.top + ih}Z`;
  const ticks = [0, max / 2, max];
  const labels = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);

  const onMove = (e: PointerEvent) => {
    const rect = svg.current?.getBoundingClientRect();
    if (!rect || !points.length) return;
    const px = ((e.clientX - rect.left) / rect.width) * W;
    const i = Math.round(((px - PAD.left) / iw) * (points.length - 1));
    setHover(Math.max(0, Math.min(points.length - 1, i)));
  };

  const h = hover !== null ? points[hover] : null;
  return (
    <figure class="chart">
      <figcaption class="chart-title">{title}</figcaption>
      <div class="chart-frame" ref={frame}>
        <svg ref={svg} viewBox={`0 0 ${W} ${H}`} width={W} height={H} role="img" aria-label={title} onPointerMove={onMove} onPointerLeave={() => setHover(null)}>
          {ticks.map((tk) => (
            <g key={tk}>
              <line class="chart-grid" x1={PAD.left} x2={W - PAD.right} y1={y(tk)} y2={y(tk)} />
              <text class="chart-axis" x={PAD.left - 6} y={y(tk) + 4} text-anchor="end">
                {number(tk)}
              </text>
            </g>
          ))}
          {labels.map((i) => (
            <text key={i} class="chart-axis" x={x(i)} y={H - 6} text-anchor={i === 0 ? 'start' : i === points.length - 1 ? 'end' : 'middle'}>
              {date(Date.parse(points[i].day))}
            </text>
          ))}
          <path class="chart-area" d={area} />
          <path class="chart-line" d={line} />
          {h && hover !== null && (
            <g>
              <line class="chart-cross" x1={x(hover)} x2={x(hover)} y1={PAD.top} y2={PAD.top + ih} />
              <circle class="chart-dot" cx={x(hover)} cy={y(h.value)} r={4} />
            </g>
          )}
        </svg>
        {h && hover !== null && (
          <div class="chart-tip" style={{ left: `${(x(hover) / W) * 100}%` }}>
            <strong>{number(h.value)}</strong>
            <span>{date(Date.parse(h.day))}</span>
          </div>
        )}
      </div>
    </figure>
  );
}

export function BarList({ rows, title, empty }: { rows: { label: string; value: number; href?: string }[]; title: string; empty: string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <figure class="chart">
      <figcaption class="chart-title">{title}</figcaption>
      {rows.length ? (
        <ul class="bar-list">
          {rows.map((r) => (
            <li key={r.label} title={`${r.label}: ${number(r.value)}`}>
              <span class="bar-label">{r.href ? <a href={r.href}>{r.label}</a> : r.label}</span>
              <span class="bar-track">
                <span class="bar-fill" style={{ width: `${Math.max(2, (r.value / max) * 100)}%` }} />
              </span>
              <span class="bar-value">{number(r.value)}</span>
            </li>
          ))}
        </ul>
      ) : (
        <p class="muted">{empty}</p>
      )}
    </figure>
  );
}

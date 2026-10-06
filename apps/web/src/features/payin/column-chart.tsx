'use client';

import { cn } from '@pay2all/ui/lib/utils';
import { useEffect, useRef, useState } from 'react';

export interface ColumnSeries {
  key: string;
  label: string;
  /** CSS colour (design token var). */
  color: string;
}
export interface ColumnDatum {
  label: string;
  /** Full label for tooltip/table (e.g. "6 Oct 2026, 14:00"). */
  title: string;
  values: Record<string, number>;
}

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const pow = 10 ** Math.floor(Math.log10(v));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * pow >= v / 4)! * pow;
  return Math.ceil(v / step) * step;
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    if (!ref.current) return;
    const ro = new ResizeObserver(([e]) => setWidth(e!.contentRect.width));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return [ref, width] as const;
}

const HEIGHT = 200;
const PAD = { top: 8, right: 4, bottom: 22, left: 52 };
const GAP = 2; // surface gap between stacked segments

/**
 * Columns (stacked when >1 series) in plain SVG. Hairline grid, ≤24px columns with a 4px rounded
 * data-end, 2px surface gaps between segments, per-column hover tooltip on a full-band hit target,
 * legend for ≥2 series, and a table view so values never depend on colour or hover.
 */
export function ColumnChart({ data, series, formatValue, ariaLabel, integer = false }: { data: ColumnDatum[]; series: ColumnSeries[]; formatValue: (v: number) => string; ariaLabel: string; /** Counts: ticks stay whole numbers. */ integer?: boolean }) {
  const [ref, width] = useWidth<HTMLDivElement>();
  const [hover, setHover] = useState<number | null>(null);
  const [asTable, setAsTable] = useState(false);
  const total = (d: ColumnDatum) => series.reduce((s, x) => s + (d.values[x.key] ?? 0), 0);
  const rawMax = Math.max(0, ...data.map(total));
  const max = integer ? Math.max(4, Math.ceil(niceMax(rawMax) / 4) * 4) : niceMax(rawMax);
  const ticks = [0, max / 4, max / 2, (3 * max) / 4, max];
  const plotW = Math.max(0, width - PAD.left - PAD.right);
  const plotH = HEIGHT - PAD.top - PAD.bottom;
  const band = data.length ? plotW / data.length : 0;
  const barW = Math.max(2, Math.min(24, band * 0.6));
  const y = (v: number) => PAD.top + plotH - (v / max) * plotH;
  const labelEvery = Math.max(1, Math.ceil(data.length / Math.max(1, Math.floor(plotW / 56))));

  return (
    <div>
      <div className="mb-2 flex items-center justify-between gap-2">
        {series.length > 1 ? (
          <ul className="flex flex-wrap gap-3 text-xs" aria-label="Legend">
            {series.map((s) => (
              <li key={s.key} className="text-muted-foreground flex items-center gap-1.5"><span className="size-2.5 rounded-sm" style={{ background: s.color }} />{s.label}</li>
            ))}
          </ul>
        ) : <span />}
        <button type="button" className="text-muted-foreground hover:text-foreground text-xs underline-offset-2 hover:underline" onClick={() => setAsTable((t) => !t)}>
          {asTable ? 'Show chart' : 'View as table'}
        </button>
      </div>
      {asTable ? (
        <div className="max-h-64 overflow-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="bg-muted/50 text-muted-foreground text-xs"><tr><th className="px-3 py-1.5 text-left font-medium">Period</th>{series.map((s) => <th key={s.key} className="px-3 py-1.5 text-right font-medium">{s.label}</th>)}</tr></thead>
            <tbody>{data.map((d) => <tr key={d.title} className="border-t"><td className="px-3 py-1.5">{d.title}</td>{series.map((s) => <td key={s.key} className="tabular px-3 py-1.5 text-right">{formatValue(d.values[s.key] ?? 0)}</td>)}</tr>)}</tbody>
          </table>
        </div>
      ) : (
        <div ref={ref} className="relative" onMouseLeave={() => setHover(null)}>
          {width > 0 && (
            <svg width={width} height={HEIGHT} role="img" aria-label={ariaLabel} className="block overflow-visible">
              {ticks.map((t) => (
                <g key={t}>
                  <line x1={PAD.left} x2={width - PAD.right} y1={y(t)} y2={y(t)} stroke="var(--border)" strokeWidth={1} shapeRendering="crispEdges" />
                  <text x={PAD.left - 8} y={y(t)} dy="0.32em" textAnchor="end" className="fill-muted-foreground tabular text-[10px]">{formatValue(t)}</text>
                </g>
              ))}
              {data.map((d, i) => {
                const cx = PAD.left + band * i + band / 2;
                let acc = 0;
                const visible = series.filter((s) => (d.values[s.key] ?? 0) > 0);
                return (
                  <g key={d.title} opacity={hover === null || hover === i ? 1 : 0.45}>
                    {visible.map((s, si) => {
                      const v = d.values[s.key]!;
                      const top = y(acc + v);
                      const bottom = y(acc) - (si > 0 ? GAP : 0);
                      acc += v;
                      const h = Math.max(1, bottom - top);
                      const isTop = si === visible.length - 1;
                      const r = isTop ? Math.min(4, h, barW / 2) : 0;
                      const x = cx - barW / 2;
                      // Rounded data-end, square at the baseline.
                      const path = `M${x},${top + h} V${top + r} Q${x},${top} ${x + r},${top} H${x + barW - r} Q${x + barW},${top} ${x + barW},${top + r} V${top + h} Z`;
                      return <path key={s.key} d={path} fill={s.color} />;
                    })}
                    {i % labelEvery === 0 && <text x={cx} y={HEIGHT - 6} textAnchor="middle" className="fill-muted-foreground text-[10px]">{d.label}</text>}
                    <rect x={cx - band / 2} y={PAD.top} width={band} height={plotH} fill="transparent" onMouseEnter={() => setHover(i)} onFocus={() => setHover(i)} tabIndex={-1} />
                  </g>
                );
              })}
            </svg>
          )}
          {hover !== null && data[hover] && (
            <div
              className={cn('bg-popover text-popover-foreground pointer-events-none absolute top-0 z-10 min-w-36 rounded-md border px-3 py-2 text-xs shadow-md')}
              style={{ left: Math.min(Math.max(0, PAD.left + band * hover + band / 2 - 72), Math.max(0, width - 160)) }}
            >
              <p className="mb-1 font-medium">{data[hover].title}</p>
              {series.map((s) => (
                <p key={s.key} className="flex items-center justify-between gap-3">
                  <span className="text-muted-foreground flex items-center gap-1.5"><span className="size-2 rounded-sm" style={{ background: s.color }} />{s.label}</span>
                  <span className="tabular font-medium">{formatValue(data[hover]!.values[s.key] ?? 0)}</span>
                </p>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

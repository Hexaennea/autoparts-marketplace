// Single-series daily bar chart: thin bars anchored to the baseline with 4px rounded data-ends,
// recessive grid, hover tooltip with a larger hit target, and an equivalent data table.
import { useRef, useState } from "react";
import { day } from "../lib/format";

interface Point { day: string; value: number }

function niceMax(max: number): number {
  if (max <= 0) return 1;
  const exp = Math.pow(10, Math.floor(Math.log10(max)));
  const n = max / exp;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10;
  return step * exp;
}

function barPath(x: number, y: number, w: number, h: number, r: number): string {
  if (h <= 0) return "";
  const rr = Math.min(r, w / 2, h);
  return `M${x},${y + h}V${y + rr}Q${x},${y} ${x + rr},${y}H${x + w - rr}Q${x + w},${y} ${x + w},${y + rr}V${y + h}Z`;
}

export function DailyBars({ points, format, label, height = 200 }: { points: Point[]; format: (n: number) => string; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const [table, setTable] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const width = 720;
  const pad = { top: 12, right: 8, bottom: 26, left: 56 };
  const innerW = width - pad.left - pad.right;
  const innerH = height - pad.top - pad.bottom;
  const max = niceMax(Math.max(...points.map((p) => p.value), 0));
  const slot = innerW / Math.max(points.length, 1);
  const barW = Math.max(2, slot - 2);
  const ticks = [0, max / 2, max];
  const active = hover !== null ? points[hover] : undefined;
  const total = points.reduce((s, p) => s + p.value, 0);

  return (
    <figure className="chart-fig">
      <figcaption className="chart-fig__cap">
        <span className="sr-only">{label}. </span>
        <button type="button" className="link-btn small" onClick={() => setTable((t) => !t)} aria-pressed={table}>
          {table ? "Show chart" : "Show as table"}
        </button>
      </figcaption>
      {table ? (
        <div className="table-wrap" style={{ maxHeight: height + 40 }}>
          <table className="table">
            <thead><tr><th>Day</th><th className="right">{label}</th></tr></thead>
            <tbody>
              {points.map((p) => <tr key={p.day}><td>{day(p.day)}</td><td className="right">{format(p.value)}</td></tr>)}
              <tr><td className="strong">Total</td><td className="right strong">{format(total)}</td></tr>
            </tbody>
          </table>
        </div>
      ) : (
        <div className="chart-wrap" ref={wrap} style={{ position: "relative" }} onMouseLeave={() => setHover(null)}>
          <svg className="chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${label}, last ${points.length} days, total ${format(total)}`}>
            {ticks.map((t) => {
              const y = pad.top + innerH - (t / max) * innerH;
              return (
                <g key={t}>
                  <line className="gridline" x1={pad.left} x2={width - pad.right} y1={y} y2={y} />
                  <text x={pad.left - 8} y={y + 4} textAnchor="end">{format(t)}</text>
                </g>
              );
            })}
            {points.map((p, i) => {
              const h = (p.value / max) * innerH;
              const x = pad.left + i * slot + (slot - barW) / 2;
              const y = pad.top + innerH - h;
              return (
                <g key={p.day}>
                  {p.value > 0 ? (
                    <path className={`bar ${hover === i ? "is-hover" : ""}`} d={barPath(x, y, barW, h, 4)} />
                  ) : (
                    <rect className="bar bar--zero" x={x} y={pad.top + innerH - 2} width={barW} height={2} rx={1} />
                  )}
                  <rect x={pad.left + i * slot} y={pad.top} width={slot} height={innerH} fill="transparent" onMouseEnter={() => setHover(i)} />
                  {(i % 7 === 0 || (i === points.length - 1 && i % 7 >= 4)) && (
                    <text x={x + barW / 2} y={height - 8} textAnchor="middle">{day(p.day)}</text>
                  )}
                </g>
              );
            })}
          </svg>
          {active && hover !== null && (
            <div
              className="chart-tip"
              style={{
                left: `${((pad.left + hover * slot + slot / 2) / width) * 100}%`,
                top: `${((pad.top + innerH - (active.value / max) * innerH) / height) * 100}%`,
                marginTop: -8,
              }}
            >
              <strong>{format(active.value)}</strong> · {day(active.day)}
            </div>
          )}
        </div>
      )}
    </figure>
  );
}

// Tiny dependency-free charts. The admin app ships zero UI libraries by
// design, so these are hand-rolled inline SVG rather than pulling in a chart
// package. They cover exactly what the dashboard needs: a filled area/line
// for a daily series, and grouped bars. All colours come from CSS tokens.

interface Point {
  label: string;
  value: number;
}

const PAD = { l: 8, r: 8, t: 8, b: 18 };

function niceMax(v: number): number {
  if (v <= 0) return 1;
  const mag = Math.pow(10, Math.floor(Math.log10(v)));
  const n = v / mag;
  const step = n <= 1 ? 1 : n <= 2 ? 2 : n <= 5 ? 5 : 10;
  return step * mag;
}

/** Filled area + line for a single daily series. */
export function AreaChart({
  points,
  height = 160,
  color = "var(--live)",
}: {
  points: Point[];
  height?: number;
  color?: string;
}) {
  const W = 640;
  const H = height;
  const max = niceMax(Math.max(1, ...points.map((p) => p.value)));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const x = (i: number) =>
    PAD.l + (points.length <= 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v: number) => PAD.t + ih - (v / max) * ih;

  const line = points.map((p, i) => `${x(i)},${y(p.value)}`).join(" ");
  const area =
    points.length > 0
      ? `${PAD.l},${PAD.t + ih} ${line} ${PAD.l + iw},${PAD.t + ih}`
      : "";
  // Roughly six evenly-spaced date ticks, first and last always shown.
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="area chart">
      {[0, 0.5, 1].map((g) => (
        <line
          key={g}
          x1={PAD.l}
          x2={PAD.l + iw}
          y1={PAD.t + ih * g}
          y2={PAD.t + ih * g}
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {area && <polygon points={area} fill={color} opacity={0.12} />}
      {points.length > 1 && (
        <polyline points={line} fill="none" stroke={color} strokeWidth={2} />
      )}
      {points.map((p, i) =>
        i % tickEvery === 0 || i === points.length - 1 ? (
          <text
            key={p.label + i}
            x={x(i)}
            y={H - 4}
            fontSize={10}
            fill="var(--muted)"
            textAnchor="middle"
          >
            {p.label}
          </text>
        ) : null,
      )}
      <text x={PAD.l} y={PAD.t + 8} fontSize={10} fill="var(--muted)">
        {max.toLocaleString("en-IN")}
      </text>
    </svg>
  );
}

/** Grouped/overlaid bars for two series over the same days. */
export function BarPairChart({
  points,
  height = 160,
  colorA = "var(--live)",
  colorB = "var(--amber)",
}: {
  points: { label: string; a: number; b: number }[];
  height?: number;
  colorA?: string;
  colorB?: string;
}) {
  const W = 640;
  const H = height;
  const max = niceMax(Math.max(1, ...points.flatMap((p) => [p.a, p.b])));
  const iw = W - PAD.l - PAD.r;
  const ih = H - PAD.t - PAD.b;
  const slot = iw / Math.max(1, points.length);
  const bw = Math.max(2, Math.min(10, slot / 3));
  const y = (v: number) => PAD.t + ih - (v / max) * ih;
  const tickEvery = Math.max(1, Math.ceil(points.length / 6));

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" height={H} role="img" aria-label="bar chart">
      {[0, 0.5, 1].map((g) => (
        <line
          key={g}
          x1={PAD.l}
          x2={PAD.l + iw}
          y1={PAD.t + ih * g}
          y2={PAD.t + ih * g}
          stroke="var(--line)"
          strokeWidth={1}
        />
      ))}
      {points.map((p, i) => {
        const cx = PAD.l + slot * i + slot / 2;
        return (
          <g key={p.label + i}>
            <rect x={cx - bw - 1} y={y(p.a)} width={bw} height={PAD.t + ih - y(p.a)} fill={colorA} />
            <rect x={cx + 1} y={y(p.b)} width={bw} height={PAD.t + ih - y(p.b)} fill={colorB} />
            {(i % tickEvery === 0 || i === points.length - 1) && (
              <text x={cx} y={H - 4} fontSize={10} fill="var(--muted)" textAnchor="middle">
                {p.label}
              </text>
            )}
          </g>
        );
      })}
      <text x={PAD.l} y={PAD.t + 8} fontSize={10} fill="var(--muted)">
        {max.toLocaleString("en-IN")}
      </text>
    </svg>
  );
}

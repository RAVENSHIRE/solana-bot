import { useEffect, useId, useRef, useState } from "react";
import { price, time } from "./format";
export type ChartPoint = {
  timestamp: string;
  price: number;
  action_marker?: "BUY" | "SELL" | null;
};

function timeValues(points: ChartPoint[]) {
  let offset = 0;
  let prior = -Infinity;
  return points.map((p) => {
    const clock = /^\d{2}:\d{2}:\d{2}$/.test(p.timestamp);
    let value = clock
      ? p.timestamp.split(":").reduce((a, v) => a * 60 + Number(v), 0) * 1000
      : Date.parse(p.timestamp);
    if (clock && value + offset < prior) offset += 86400000;
    value += offset;
    prior = value;
    return value;
  });
}

export function Chart({
  points,
  baseline,
  label = "Price",
  compact = false,
}: {
  points: ChartPoint[];
  baseline?: number | null;
  label?: string;
  compact?: boolean;
}) {
  const id = useId().replace(/:/g, "");
  const [hover, setHover] = useState<number | null>(null);
  const container = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({
    width: 1000,
    height: compact ? 300 : 530,
  });
  const empty = points.length === 0;
  useEffect(() => {
    if (!container.current) return;
    const observer = new ResizeObserver(([entry]) => {
      setViewport({
        width: Math.max(240, entry.contentRect.width),
        height: Math.max(220, entry.contentRect.height),
      });
    });
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [empty]);
  if (!points.length)
    return (
      <div className={`empty-chart ${compact ? "compact" : ""}`}>
        <div className="empty-chart-grid" />
        <div className="empty-chart-label">
          <span className="empty-chart-icon">↗</span>
          <strong>Waiting for {label.toLowerCase()} data</strong>
          <span>Recorded observations will appear here.</span>
        </div>
      </div>
    );
  const { width, height } = viewport;
  const left = 8,
    right = 104,
    top = 25,
    bottom = 40;
  const w = width - left - right,
    h = height - top - bottom;
  const values = points.map((p) => p.price);
  if (baseline !== null && baseline !== undefined) values.push(baseline);
  const low = Math.min(...values),
    high = Math.max(...values);
  const padding = (high - low || Math.abs(high) * 0.02 || 1) * 0.1;
  const min = low - padding,
    max = high + padding;
  const times = timeValues(points);
  const firstTime = times[0],
    lastTime = times.at(-1)!;
  const x = (i: number) =>
    lastTime > firstTime
      ? left + ((times[i] - firstTime) / (lastTime - firstTime)) * w
      : left + w / 2;
  const y = (value: number) => top + ((max - value) / (max - min)) * h;
  const path = points
    .map(
      (p, i) => `${i ? "L" : "M"}${x(i).toFixed(2)},${y(p.price).toFixed(2)}`,
    )
    .join(" ");
  const last = points.at(-1)!;
  const color =
    last.price >= (baseline ?? points[0].price) ? "#00bc87" : "#ff3855";
  const hoverIndex = hover === null ? null : Math.min(hover, points.length - 1);
  const selected = hoverIndex === null ? null : points[hoverIndex];
  const candidates = [
    ...new Set(
      width < 500
        ? [0, points.length - 1]
        : [
            0,
            Math.floor((points.length - 1) / 3),
            Math.floor(((points.length - 1) * 2) / 3),
            points.length - 1,
          ],
    ),
  ];
  const indices: number[] = [];
  for (const index of candidates) {
    const edge = index === 0 || index === points.length - 1;
    if (edge || (x(index) - x(indices.at(-1) ?? 0) >= 112 && x(points.length - 1) - x(index) >= 112)) indices.push(index);
  }
  return (
    <div ref={container} className={`chart ${compact ? "compact" : ""}`}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        role="img"
        aria-label={`${label}, ${points.length} observations. Latest ${price(last.price)} at ${time(last.timestamp)}`}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const box = e.currentTarget.getBoundingClientRect();
          const target = ((e.clientX - box.left) / box.width) * width;
          let best = 0;
          for (let i = 1; i < points.length; i++)
            if (Math.abs(x(i) - target) < Math.abs(x(best) - target)) best = i;
          setHover(best);
        }}
      >
        <defs>
          <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity=".27" />
            <stop offset="100%" stopColor={color} stopOpacity=".015" />
          </linearGradient>
        </defs>
        {Array.from({ length: 5 }, (_, i) => {
          const value = max - ((max - min) * i) / 4;
          return (
            <g key={i}>
              <line
                className="grid-line"
                x1={left}
                x2={left + w}
                y1={y(value)}
                y2={y(value)}
              />
              <text className="axis-label" x={left + w + 12} y={y(value) + 4}>
                {price(value)}
              </text>
            </g>
          );
        })}
        <path
          d={`${path} L${x(points.length - 1)},${top + h} L${x(0)},${top + h} Z`}
          fill={`url(#${id})`}
        />
        <path
          d={path}
          stroke={color}
          strokeWidth="2"
          fill="none"
          vectorEffect="non-scaling-stroke"
        />
        {baseline !== null && baseline !== undefined && (
          <g>
            <line
              x1={left}
              x2={left + w}
              y1={y(baseline)}
              y2={y(baseline)}
              stroke="#98a0ae"
              strokeDasharray="5 5"
            />
            <text className="axis-label" x={left + 8} y={y(baseline) - 8}>
              Entry {price(baseline)}
            </text>
          </g>
        )}
        <line
          x1={left}
          x2={left + w}
          y1={y(last.price)}
          y2={y(last.price)}
          stroke={color}
          strokeDasharray="4 5"
          opacity=".65"
        />
        <circle
          cx={x(points.length - 1)}
          cy={y(last.price)}
          r="5"
          fill={color}
          stroke="white"
          strokeWidth="2"
        />
        <rect
          x={left + w + 5}
          y={y(last.price) - 12}
          width="96"
          height="24"
          rx="5"
          fill={color}
        />
        <text
          x={left + w + 53}
          y={y(last.price) + 4}
          textAnchor="middle"
          className="last-price"
        >
          {price(last.price)}
        </text>
        {points.map(
          (p, i) =>
            p.action_marker && (
              <g key={i}>
                <circle
                  cx={x(i)}
                  cy={y(p.price)}
                  r="10"
                  fill={p.action_marker === "BUY" ? "#00a475" : "#ed2946"}
                  stroke="white"
                  strokeWidth="2"
                />
                <text
                  x={x(i)}
                  y={y(p.price) + 4}
                  textAnchor="middle"
                  className="marker-label"
                >
                  {p.action_marker === "BUY" ? "B" : "S"}
                </text>
                <title>
                  {p.action_marker} · {price(p.price)} · {time(p.timestamp)}
                </title>
              </g>
            ),
        )}
        {indices.map((i) => (
          <text
            key={i}
            x={x(i)}
            y={height - 10}
            textAnchor={
              i === 0 ? "start" : i === points.length - 1 ? "end" : "middle"
            }
            className="axis-label"
          >
            {time(points[i].timestamp)}
          </text>
        ))}
        {selected && hoverIndex !== null && (
          <g>
            <line
              x1={x(hoverIndex)}
              x2={x(hoverIndex)}
              y1={top}
              y2={top + h}
              stroke="#949baa"
              strokeDasharray="4 4"
            />
            <circle
              cx={x(hoverIndex)}
              cy={y(selected.price)}
              r="4"
              fill={color}
            />
          </g>
        )}
      </svg>
      {selected && (
        <div className="chart-tooltip">
          {time(selected.timestamp)}
          <strong>{price(selected.price)}</strong>
          {selected.action_marker}
        </div>
      )}
    </div>
  );
}

export function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <span className="sparkline-empty">--</span>;
  const min = Math.min(...values),
    max = Math.max(...values),
    range = max - min || 1;
  const points = values
    .map(
      (v, i) =>
        `${(i / (values.length - 1)) * 56},${24 - ((v - min) / range) * 20}`,
    )
    .join(" ");
  return (
    <svg
      className="sparkline"
      viewBox="0 0 56 28"
      role="img"
      aria-label="Recent price observations"
    >
      <polyline
        points={points}
        fill="none"
        stroke={values.at(-1)! >= values[0] ? "#00bc87" : "#ff3855"}
        strokeWidth="1.5"
      />
    </svg>
  );
}

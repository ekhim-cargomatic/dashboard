/**
 * Pass rate over time.
 *
 * One series, so it takes the accent hue and needs no legend — the card title
 * names it. Colour-vision safety is not in play with a single line, which is why
 * the trend deliberately plots *rate* rather than a multi-series status breakdown
 * (that lives in the volume chart next to it).
 *
 * The y-axis is zoomed to the data band rather than pinned to 0–100%: a suite that
 * lives between 88% and 96% shows nothing useful on a full-height axis. The band
 * is labelled so the zoom is never mistaken for a full scale.
 */

import { useMemo, useState } from 'react';
import type { TrendPoint } from '../lib/aggregate';
import { dateTime, duration, int, pct } from '../lib/format';
import { useElementWidth } from '../lib/useElementWidth';
import { Tooltip, type TooltipState } from './Tooltip';

interface Props {
  points: TrendPoint[];
  height?: number;
}

const MARGIN = { top: 12, right: 16, bottom: 26, left: 46 };

export function TrendChart({ points, height = 220 }: Props) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  const scale = useMemo(() => {
    if (points.length === 0) return null;

    const values = points.map((p) => p.passRate);
    const rawMin = Math.min(...values);
    const rawMax = Math.max(...values);

    // Pad the band by 15% of its span, clamped to [0,1], with a 4pp floor so a
    // dead-flat series still gets a sane axis.
    const span = Math.max(rawMax - rawMin, 0.04);
    const min = Math.max(0, rawMin - span * 0.15);
    const max = Math.min(1, rawMax + span * 0.15);
    const range = max - min || 1;

    const x = (i: number) =>
      points.length === 1 ? plotWidth / 2 : (i / (points.length - 1)) * plotWidth;
    const y = (v: number) => plotHeight - ((v - min) / range) * plotHeight;

    // Four gridlines read as a scale without becoming a ruler.
    const ticks = Array.from({ length: 4 }, (_, i) => min + (range * i) / 3);

    // Use the fewest decimals that still tell every tick apart. A narrow band —
    // one run, or a suite pinned near a single value — would otherwise render as
    // "0% / 0% / 0% / 1%", which reads as a broken axis rather than a tight one.
    const decimals = [0, 1, 2].find((d) => {
      const labels = ticks.map((t) => pct(t, d));
      return new Set(labels).size === labels.length;
    }) ?? 2;

    return { x, y, min, max, ticks, decimals };
  }, [points, plotWidth, plotHeight]);

  if (!scale || points.length === 0) {
    return <p className="empty-note">No runs in this window.</p>;
  }

  const line = points
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${scale.x(i).toFixed(1)},${scale.y(p.passRate).toFixed(1)}`)
    .join(' ');
  const area = `${line} L${scale.x(points.length - 1).toFixed(1)},${plotHeight} L${scale.x(0).toFixed(1)},${plotHeight} Z`;

  // Show at most ~6 date labels regardless of run count.
  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  const handleMove = (event: React.MouseEvent<SVGRectElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    const offsetX = event.clientX - bounds.left;
    const ratio = plotWidth === 0 ? 0 : offsetX / plotWidth;
    const index = Math.max(0, Math.min(points.length - 1, Math.round(ratio * (points.length - 1))));
    const point = points[index];

    setTip({
      x: MARGIN.left + scale.x(index),
      y: MARGIN.top + scale.y(point.passRate),
      title: `${point.run.workflow} #${point.run.runNumber}`,
      subtitle: dateTime(point.run.finishedAt),
      rows: [
        { label: 'Pass rate', value: pct(point.passRate) },
        { label: 'Needs attention', value: int(point.impacted) },
        { label: 'Tests', value: int(point.total) },
        { label: 'Duration', value: duration(point.durationMs) },
      ],
      footer: `${point.run.environment}${point.run.commitShort ? ` · ${point.run.commitShort}` : ''}`,
    });
  };

  const hoveredIndex = tip
    ? Math.max(0, Math.min(points.length - 1, Math.round(((tip.x - MARGIN.left) / plotWidth) * (points.length - 1))))
    : -1;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart"
        width="100%"
        height={height}
        role="img"
        aria-label={`Pass rate across ${points.length} runs, from ${pct(points[0].passRate)} to ${pct(points[points.length - 1].passRate)}`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {scale.ticks.map((value) => (
            <g key={value}>
              <line className="gridline" x1={0} x2={plotWidth} y1={scale.y(value)} y2={scale.y(value)} />
              <text className="tick-label" x={-8} y={scale.y(value)} dy="0.32em" textAnchor="end">
                {pct(value, scale.decimals)}
              </text>
            </g>
          ))}

          <path d={area} fill="var(--accent)" opacity="0.09" />
          <path
            d={line}
            fill="none"
            stroke="var(--accent)"
            strokeWidth="2"
            strokeLinejoin="round"
            strokeLinecap="round"
          />

          {/* Markers only when they will not collide — ≥8px targets otherwise. */}
          {points.length <= 40 &&
            points.map((p, i) => (
              <circle
                key={p.run.prefix}
                cx={scale.x(i)}
                cy={scale.y(p.passRate)}
                r={i === hoveredIndex ? 4.5 : 3}
                fill="var(--accent)"
                stroke="var(--surface-1)"
                strokeWidth="2"
              />
            ))}

          {hoveredIndex >= 0 && (
            <line
              className="axis-line"
              x1={scale.x(hoveredIndex)}
              x2={scale.x(hoveredIndex)}
              y1={0}
              y2={plotHeight}
              strokeDasharray="3 3"
            />
          )}

          <line className="axis-line" x1={0} x2={plotWidth} y1={plotHeight} y2={plotHeight} />

          {points.map((p, i) =>
            i % labelEvery === 0 ? (
              <text
                key={p.run.prefix}
                className="tick-label"
                x={scale.x(i)}
                y={plotHeight + 16}
                textAnchor="middle"
              >
                {new Date(p.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
              </text>
            ) : null,
          )}

          <rect
            width={plotWidth}
            height={plotHeight}
            fill="transparent"
            onMouseMove={handleMove}
            onMouseLeave={() => setTip(null)}
          />
        </g>
      </svg>
      <Tooltip state={tip} width={width} height={height} />
    </div>
  );
}

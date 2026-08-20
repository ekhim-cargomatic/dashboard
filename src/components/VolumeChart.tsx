/**
 * Test volume and outcome mix per run.
 *
 * Part-to-whole over time, so a stacked bar. This is the one chart where several
 * colours sit next to each other, and they are the reserved status palette rather
 * than a categorical one — hue is backed by a glyph in the legend, a 2px surface
 * gap between segments, and the run table below carrying the same numbers.
 */

import { useMemo, useState } from 'react';
import { STACK_ORDER, statusMeta } from '../lib/status';
import type { TrendPoint } from '../lib/aggregate';
import { dateTime, int, pct } from '../lib/format';
import { useElementWidth } from '../lib/useElementWidth';
import { Tooltip, type TooltipState } from './Tooltip';
import type { Status } from '../types';

interface Props {
  points: TrendPoint[];
  height?: number;
}

const MARGIN = { top: 12, right: 12, bottom: 26, left: 46 };
const SEGMENT_GAP = 2; // the surface gap that keeps adjacent fills separable

export function VolumeChart({ points, height = 220 }: Props) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  /*
   * Skipped is excluded by default, and that is not a cosmetic choice.
   *
   * A tag-filtered behave run emits every scenario in the suite and marks the
   * non-matching ones skipped, so a real smoke run is 2,097 skipped out of 2,111.
   * Stacking that swamps the plot: the bar is 99% grey and the passed/failed
   * segments this chart exists to show are sub-pixel. Plotting executed tests
   * keeps it readable; the toggle is there because "did the pass rate rise
   * because tests were skipped?" is still a question worth being able to ask.
   */
  const [includeSkipped, setIncludeSkipped] = useState(false);
  const stackOrder = includeSkipped ? STACK_ORDER : STACK_ORDER.filter((s) => s !== 'skipped');

  const plotWidth = Math.max(120, width - MARGIN.left - MARGIN.right);
  const plotHeight = height - MARGIN.top - MARGIN.bottom;

  const geometry = useMemo(() => {
    if (points.length === 0) return null;

    const valueOf = (p: TrendPoint) =>
      stackOrder.reduce((sum, status) => sum + (p[status as keyof TrendPoint] as number), 0);
    const max = Math.max(...points.map(valueOf), 1);
    // Bars keep a 25% gutter, capped so a 3-run window doesn't render slabs.
    const slot = plotWidth / points.length;
    const barWidth = Math.max(3, Math.min(slot * 0.75, 42));
    const y = (v: number) => plotHeight - (v / max) * plotHeight;

    const step = Math.pow(10, Math.floor(Math.log10(max))) / 2 || 1;
    const ticks: number[] = [];
    for (let v = 0; v <= max; v += step) ticks.push(v);
    if (ticks.length > 6) ticks.splice(0, ticks.length, 0, max / 2, max);

    return { max, slot, barWidth, y, ticks };
  }, [points, plotWidth, plotHeight, stackOrder]);

  if (!geometry || points.length === 0) {
    return <p className="empty-note">No runs in this window.</p>;
  }

  const labelEvery = Math.max(1, Math.ceil(points.length / 6));

  const showTip = (point: TrendPoint, x: number, y: number) => {
    setTip({
      x,
      y,
      title: `${point.run.workflow} #${point.run.runNumber}`,
      subtitle: dateTime(point.run.finishedAt),
      rows: [
        ...STACK_ORDER.map((status) => {
          const meta = statusMeta(status);
          return {
            label: meta.label,
            value: int(point[status as keyof TrendPoint] as number),
            color: meta.color,
            glyph: meta.glyph,
          };
        }),
        { label: 'Pass rate', value: pct(point.passRate) },
      ],
    });
  };

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div
        className="legend"
        style={{ marginBottom: 8, justifyContent: 'space-between', alignItems: 'center' }}
      >
        <span style={{ display: 'inline-flex', gap: 14, flexWrap: 'wrap' }}>
        {stackOrder.map((status) => {
          const meta = statusMeta(status);
          return (
            <span className="legend-item" key={status}>
              <span className="legend-swatch" style={{ background: meta.color }} aria-hidden="true" />
              <span className="legend-glyph" aria-hidden="true">
                {meta.glyph}
              </span>
              {meta.label}
            </span>
          );
        })}
        </span>
        <span className="segmented" role="group" aria-label="Skipped tests">
          <button
            type="button"
            aria-pressed={!includeSkipped}
            onClick={() => setIncludeSkipped(false)}
          >
            Executed
          </button>
          <button
            type="button"
            aria-pressed={includeSkipped}
            onClick={() => setIncludeSkipped(true)}
          >
            + skipped
          </button>
        </span>
      </div>

      <svg
        className="chart"
        width="100%"
        height={height}
        role="img"
        aria-label={`Outcome mix across ${points.length} runs`}
      >
        <g transform={`translate(${MARGIN.left},${MARGIN.top})`}>
          {geometry.ticks.map((value) => (
            <g key={value}>
              <line className="gridline" x1={0} x2={plotWidth} y1={geometry.y(value)} y2={geometry.y(value)} />
              <text className="tick-label" x={-8} y={geometry.y(value)} dy="0.32em" textAnchor="end">
                {int(Math.round(value))}
              </text>
            </g>
          ))}

          {points.map((point, index) => {
            const centre = geometry.slot * (index + 0.5);
            const x = centre - geometry.barWidth / 2;
            let cursor = 0; // running total from the baseline upward

            return (
              <g
                key={point.run.prefix}
                onMouseEnter={(event) => {
                  const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                  showTip(point, MARGIN.left + centre, event.clientY - bounds.top);
                }}
                onMouseLeave={() => setTip(null)}
              >
                {/* Hit target wider than the bar, so thin bars stay hoverable. */}
                <rect
                  x={geometry.slot * index}
                  y={0}
                  width={geometry.slot}
                  height={plotHeight}
                  fill="transparent"
                />
                {stackOrder.map((status) => {
                  const value = point[status as keyof TrendPoint] as number;
                  if (!value) return null;

                  const rawHeight = (value / geometry.max) * plotHeight;
                  const segmentHeight = Math.max(1, rawHeight - SEGMENT_GAP);
                  const yPos = plotHeight - cursor - rawHeight;
                  cursor += rawHeight;

                  return (
                    <rect
                      key={status}
                      x={x}
                      y={yPos}
                      width={geometry.barWidth}
                      height={segmentHeight}
                      rx={Math.min(3, geometry.barWidth / 3)}
                      fill={statusMeta(status as Status).color}
                    />
                  );
                })}
              </g>
            );
          })}

          <line className="axis-line" x1={0} x2={plotWidth} y1={plotHeight} y2={plotHeight} />

          {points.map((point, index) =>
            index % labelEvery === 0 ? (
              <text
                key={point.run.prefix}
                className="tick-label"
                x={geometry.slot * (index + 0.5)}
                y={plotHeight + 16}
                textAnchor="middle"
              >
                {new Date(point.at).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric' })}
              </text>
            ) : null,
          )}
        </g>
      </svg>
      <Tooltip state={tip} width={width} height={height} />
    </div>
  );
}

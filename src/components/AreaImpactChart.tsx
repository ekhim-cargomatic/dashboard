/**
 * Which area was affected most.
 *
 * Magnitude comparison across up-to-26 long-named categories, so: horizontal
 * bars, sorted worst-first, one hue. Sequential blue rather than a categorical
 * palette — the areas are not identities to tell apart, they are quantities to
 * rank, and one hue stays readable under every colour vision deficiency.
 *
 * Two metrics, because they answer different questions and disagree often:
 *   volume  — where the failures actually landed (a big area fails more in absolute terms)
 *   rate    — how bad an area is for its size (a small area can be 100% broken)
 */

import { useMemo, useState } from 'react';
import type { AreaImpact } from '../lib/aggregate';
import { int, pct, truncate } from '../lib/format';
import { rampColor, rampInk } from '../lib/status';
import { useElementWidth } from '../lib/useElementWidth';
import { Tooltip, type TooltipState } from './Tooltip';

export type ImpactMetric = 'volume' | 'rate';

interface Props {
  areas: AreaImpact[];
  metric: ImpactMetric;
  /** Rows to draw; the rest fold into an "others" note rather than a 27th hue. */
  limit?: number;
  onSelect?: (key: string) => void;
  selected?: string | null;
}

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 148;
const VALUE_WIDTH = 62;

export function AreaImpactChart({ areas, metric, limit = 12, onSelect, selected }: Props) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  const ranked = useMemo(() => {
    const withFailures = areas.filter((area) => area.impacted > 0);
    const sorted =
      metric === 'rate'
        ? [...withFailures].sort((a, b) => b.failRate - a.failRate || b.impacted - a.impacted)
        : withFailures;
    return { shown: sorted.slice(0, limit), hidden: sorted.slice(limit) };
  }, [areas, metric, limit]);

  const valueOf = (area: AreaImpact) => (metric === 'rate' ? area.failRate : area.impacted);
  const formatValue = (area: AreaImpact) =>
    metric === 'rate' ? pct(area.failRate, 1) : int(area.impacted);

  const max = Math.max(...ranked.shown.map(valueOf), metric === 'rate' ? 0.01 : 1);
  const barMax = Math.max(60, width - LABEL_WIDTH - VALUE_WIDTH - 8);
  const height = ranked.shown.length * ROW_HEIGHT + 4;

  if (ranked.shown.length === 0) {
    return (
      <p className="empty-note">
        No failures in this window — nothing to rank. <span aria-hidden="true">✓</span>
      </p>
    );
  }

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg className="chart" width="100%" height={height} role="img" aria-label="Areas ranked by failure impact">
        {ranked.shown.map((area, index) => {
          const value = valueOf(area);
          const barWidth = Math.max(2, (value / max) * barMax);
          const color = rampColor(value, max);
          const ink = rampInk(value, max);
          const y = index * ROW_HEIGHT;
          const isSelected = selected === area.key;

          return (
            <g
              key={area.key}
              style={{ cursor: onSelect ? 'pointer' : 'default' }}
              onClick={() => onSelect?.(area.key)}
              onMouseMove={(event) => {
                const bounds = event.currentTarget.ownerSVGElement!.getBoundingClientRect();
                setTip({
                  x: event.clientX - bounds.left,
                  y: y + ROW_HEIGHT,
                  title: area.label,
                  rows: [
                    { label: 'Needs attention', value: int(area.impacted) },
                    { label: 'Fail rate', value: pct(area.failRate) },
                    { label: 'Tests executed', value: int(area.executed) },
                    {
                      label: 'Runs affected',
                      value: `${area.runsAffected} of ${area.runsSeen}`,
                    },
                  ],
                  footer:
                    area.runsAffected === area.runsSeen && area.runsSeen > 1
                      ? 'Failed in every run — likely a real regression, not a flake.'
                      : area.runsAffected === 1 && area.runsSeen > 2
                        ? 'Failed in a single run — check for a one-off.'
                        : undefined,
                });
              }}
              onMouseLeave={() => setTip(null)}
            >
              <rect x={0} y={y} width={Math.max(width, 1)} height={ROW_HEIGHT} fill={isSelected ? 'var(--ghost)' : 'transparent'} />

              <text
                className="bar-label"
                x={LABEL_WIDTH - 10}
                y={y + ROW_HEIGHT / 2}
                dy="0.32em"
                textAnchor="end"
                fontWeight={isSelected ? 600 : 400}
              >
                {truncate(area.label, 20)}
              </text>

              <rect
                x={LABEL_WIDTH}
                y={y + 4}
                width={barWidth}
                height={ROW_HEIGHT - 10}
                rx={4}
                fill={color}
              />

              {/* Direct label on every bar — the relief for a ramp whose pale
                  steps sit below 3:1 against the surface. */}
              {barWidth > 46 ? (
                <text
                  className="value-label"
                  x={LABEL_WIDTH + barWidth - 8}
                  y={y + ROW_HEIGHT / 2}
                  dy="0.32em"
                  textAnchor="end"
                  fill={ink}
                >
                  {formatValue(area)}
                </text>
              ) : (
                <text
                  className="value-label"
                  x={LABEL_WIDTH + barWidth + 8}
                  y={y + ROW_HEIGHT / 2}
                  dy="0.32em"
                >
                  {formatValue(area)}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {ranked.hidden.length > 0 && (
        <p className="dim" style={{ fontSize: 12, margin: '6px 0 0' }}>
          + {ranked.hidden.length} more area{ranked.hidden.length === 1 ? '' : 's'} with failures (
          {int(ranked.hidden.reduce((sum, area) => sum + area.impacted, 0))} tests) — see the table below.
        </p>
      )}

      <Tooltip state={tip} width={width} height={height} />
    </div>
  );
}

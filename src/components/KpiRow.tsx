/**
 * Headline numbers for the most recent run.
 *
 * A KPI row of stat tiles rather than a chart — these are single current values,
 * and a bar chart of five unrelated measures would be harder to read, not easier.
 * The hero figure carries a sparkline because pass rate is the one number whose
 * direction matters as much as its level.
 */

import type { Delta, TrendPoint } from '../lib/aggregate';
import { duration, int, pct, pp, relativeTime } from '../lib/format';
import type { RunSummary } from '../types';

interface Props {
  latest: RunSummary;
  delta: Delta;
  trendPoints: TrendPoint[];
}

/** Signed delta, coloured and arrowed. `goodWhenUp` flips the polarity for
 * measures where a rise is bad (failures, duration). */
function DeltaBadge({
  value,
  format,
  goodWhenUp,
}: {
  value: number;
  format: (value: number) => string;
  goodWhenUp: boolean;
}) {
  if (value === 0) return <span className="delta flat">no change</span>;
  const improved = goodWhenUp ? value > 0 : value < 0;
  return (
    <span className={`delta ${improved ? 'up' : 'down'}`}>
      <span aria-hidden="true">{value > 0 ? '▲' : '▼'}</span>
      {format(value)}
    </span>
  );
}

/** Bare sparkline — no axes, no labels; the tile's value carries the number. */
function Sparkline({ points }: { points: TrendPoint[] }) {
  if (points.length < 2) return null;

  const width = 168;
  const height = 34;
  const values = points.map((p) => p.passRate);
  const min = Math.min(...values);
  const max = Math.max(...values);
  // A flat series would divide by zero; give it a nominal band so it draws mid-height.
  const span = max - min < 0.005 ? 0.005 : max - min;

  const x = (i: number) => (i / (points.length - 1)) * width;
  const y = (v: number) => height - ((v - min) / span) * (height - 4) - 2;

  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.passRate).toFixed(1)}`).join(' ');
  const area = `${line} L${width},${height} L0,${height} Z`;
  const last = points[points.length - 1];

  return (
    <svg
      className="chart"
      viewBox={`0 0 ${width} ${height}`}
      width={width}
      height={height}
      role="img"
      aria-label={`Pass rate across the last ${points.length} runs`}
      style={{ marginTop: 6 }}
    >
      <path d={area} fill="var(--accent)" opacity="0.1" />
      <path d={line} fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      <circle cx={width} cy={y(last.passRate)} r="3" fill="var(--accent)" stroke="var(--surface-1)" strokeWidth="2" />
    </svg>
  );
}

function Tile({
  label,
  value,
  meta,
  children,
}: {
  label: string;
  value: string;
  meta?: React.ReactNode;
  children?: React.ReactNode;
}) {
  return (
    <div className="tile">
      <div className="tile-label">{label}</div>
      <div className="tile-value">{value}</div>
      {meta && <div className="tile-meta">{meta}</div>}
      {children}
    </div>
  );
}

export function KpiRow({ latest, delta, trendPoints }: Props) {
  const { totals } = latest;
  const executed = totals.total - totals.skipped;

  return (
    <div className="kpi-row">
      <div className="tile hero">
        <div className="tile-label">Pass rate — latest run</div>
        <div className="tile-value">{pct(latest.passRate)}</div>
        <div className="tile-meta">
          {delta.previous ? (
            <DeltaBadge value={delta.passRate} format={pp} goodWhenUp />
          ) : (
            <span className="dim">no earlier run to compare</span>
          )}{' '}
          <span className="dim">
            · {int(totals.passed)} of {int(executed)} executed
          </span>
        </div>
        <Sparkline points={trendPoints.slice(-30)} />
      </div>

      <Tile
        label="Needs attention"
        value={int(totals.impacted)}
        meta={
          <>
            <DeltaBadge value={delta.impacted} format={(v) => `${Math.abs(v)}`} goodWhenUp={false} />{' '}
            <span className="dim">
              · {int(totals.failed)} failed, {int(totals.broken)} broken
            </span>
          </>
        }
      />

      <Tile
        label="Tests run"
        value={int(totals.total)}
        meta={
          <>
            <span className="dim">{int(totals.skipped)} skipped</span>
            {delta.total !== 0 && (
              <>
                {' · '}
                <span className="dim">
                  {delta.total > 0 ? '+' : ''}
                  {delta.total} vs previous
                </span>
              </>
            )}
          </>
        }
      />

      <Tile
        label="Flaky in run"
        value={int(latest.flakyCount)}
        meta={<span className="dim">passed on retry</span>}
      />

      <Tile
        label="Wall clock"
        value={duration(latest.wallClockMs)}
        meta={
          delta.previous ? (
            <DeltaBadge
              value={delta.durationMs}
              format={(v) => duration(Math.abs(v))}
              goodWhenUp={false}
            />
          ) : (
            <span className="dim">—</span>
          )
        }
      />

      <Tile
        label="Finished"
        value={relativeTime(latest.finishedAt)}
        meta={
          <span className="dim">
            {latest.environment}
            {latest.branch ? ` · ${latest.branch}` : ''}
          </span>
        }
      />
    </div>
  );
}

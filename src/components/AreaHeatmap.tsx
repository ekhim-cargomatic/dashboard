/**
 * Area × run grid of fail rates.
 *
 * The bar chart says which area is worst right now; this says whether it has been
 * worst all week. A solid horizontal band is a regression someone owns; scattered
 * cells are flakiness. That distinction is the whole reason this chart exists.
 *
 * Grid magnitude, so: sequential blue, one hue, full ramp. Hatched cells mean the
 * area had no tests in that run (a sharded or targeted job), which is different
 * from "ran and passed" — an empty cell would conflate the two.
 */

import { useState } from 'react';
import type { HeatmapRow } from '../lib/aggregate';
import { dateTime, int, pct, truncate } from '../lib/format';
import { rampColor } from '../lib/status';
import { useElementWidth } from '../lib/useElementWidth';
import { Tooltip, type TooltipState } from './Tooltip';
import type { RunSummary } from '../types';

interface Props {
  rows: HeatmapRow[];
  runs: RunSummary[];
  onSelectRun?: (runPrefix: string) => void;
}

const LABEL_WIDTH = 140;

export function AreaHeatmap({ rows, runs, onSelectRun }: Props) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const [tip, setTip] = useState<TooltipState | null>(null);

  if (rows.length === 0 || runs.length === 0) {
    return <p className="empty-note">No failing areas in this window.</p>;
  }

  // Scale to the worst cell rather than to 100%: most suites never approach a
  // 100% area failure rate, and a fixed scale would render the whole grid pale.
  const max = Math.max(...rows.flatMap((row) => row.cells.map((cell) => cell.failRate)), 0.05);

  const cellWidth = Math.max(14, Math.min(30, (width - LABEL_WIDTH - 16) / runs.length - 2));
  const height = rows.length * 24 + 40;

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <div
        className="heatmap"
        style={{ gridTemplateColumns: `${LABEL_WIDTH}px repeat(${runs.length}, ${cellWidth}px)` }}
      >
        {rows.map((row) => (
          <div style={{ display: 'contents' }} key={row.key}>
            <div className="heat-row-label" title={row.label}>
              {truncate(row.label, 18)}
            </div>
            {row.cells.map((cell, index) => {
              const run = runs[index];
              return (
                <button
                  type="button"
                  key={cell.runPrefix}
                  className={`heat-cell${cell.present ? '' : ' empty'}`}
                  style={
                    cell.present
                      ? { background: cell.failRate > 0 ? rampColor(cell.failRate, max) : 'var(--surface-2)' }
                      : undefined
                  }
                  aria-label={`${row.label}, ${run.workflow} run ${run.runNumber}: ${
                    cell.present ? `${pct(cell.failRate)} fail rate, ${cell.impacted} of ${cell.total}` : 'not covered'
                  }`}
                  onClick={() => onSelectRun?.(cell.runPrefix)}
                  onMouseEnter={(event) => {
                    const bounds = event.currentTarget.closest('.chart-wrap')!.getBoundingClientRect();
                    const rect = event.currentTarget.getBoundingClientRect();
                    setTip({
                      x: rect.left - bounds.left + rect.width / 2,
                      y: rect.top - bounds.top + rect.height,
                      title: row.label,
                      subtitle: `${run.workflow} #${run.runNumber} · ${dateTime(run.finishedAt)}`,
                      rows: cell.present
                        ? [
                            { label: 'Fail rate', value: pct(cell.failRate) },
                            { label: 'Needs attention', value: int(cell.impacted) },
                            { label: 'Tests', value: int(cell.total) },
                          ]
                        : [{ label: 'Coverage', value: 'not run' }],
                    });
                  }}
                  onMouseLeave={() => setTip(null)}
                />
              );
            })}
          </div>
        ))}
      </div>

      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          gap: 12,
          marginTop: 10,
          paddingLeft: LABEL_WIDTH,
          flexWrap: 'wrap',
        }}
      >
        <span className="dim" style={{ fontSize: 11 }}>
          {dateTime(runs[0].finishedAt)} → {dateTime(runs[runs.length - 1].finishedAt)}
        </span>
        <div className="heat-scale">
          <span>0%</span>
          <div className="heat-scale-swatches">
            {[0, 0.25, 0.5, 0.75, 1].map((step) => (
              <span key={step} style={{ background: rampColor(step * max, max) }} />
            ))}
          </div>
          <span>{pct(max, 0)} fail rate</span>
          <span
            className="heat-cell empty"
            style={{ width: 16, height: 10, marginLeft: 8, display: 'inline-block' }}
            aria-hidden="true"
          />
          <span>not run</span>
        </div>
      </div>

      <Tooltip state={tip} width={width} height={height} />
    </div>
  );
}

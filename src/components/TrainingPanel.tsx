/**
 * Training & SOP coverage — behind the `training` feature flag.
 *
 * Same question as the rest of the dashboard, different subject: which area is
 * worst, and how bad is it. "Needs attention" here means stale, undated, or
 * carrying a note that says something other than "complete".
 *
 * Data is dev-only (see lib/training.ts); in a deployed build this renders an
 * explanation rather than an empty panel.
 */

import { useEffect, useMemo, useState } from 'react';
import {
  analyseRows,
  groupBy,
  loadTrainingMatrix,
  totals,
  type GroupDimension,
  type TrainingRow,
} from '../lib/training';
import { int, pct, truncate } from '../lib/format';
import { rampColor, rampInk } from '../lib/status';
import { useElementWidth } from '../lib/useElementWidth';

const DIMENSIONS: { value: GroupDimension; label: string }[] = [
  { value: 'lifecycleStep', label: 'Lifecycle step' },
  { value: 'persona', label: 'Persona' },
  { value: 'owner', label: 'Owner' },
  { value: 'format', label: 'Format' },
];

const ROW_HEIGHT = 26;
const LABEL_WIDTH = 210;

/** Horizontal ranked bars — magnitude, so one hue, sorted worst-first. */
function AttentionBars({
  groups,
}: {
  groups: { key: string; needsAttention: number; total: number; attentionRate: number }[];
}) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const shown = groups.filter((g) => g.needsAttention > 0).slice(0, 12);
  if (shown.length === 0) return <p className="empty-note">Nothing needs attention.</p>;

  const max = Math.max(...shown.map((g) => g.needsAttention), 1);
  const barMax = Math.max(60, width - LABEL_WIDTH - 96);

  return (
    <div className="chart-wrap" ref={wrapRef}>
      <svg
        className="chart"
        width="100%"
        height={shown.length * ROW_HEIGHT + 4}
        role="img"
        aria-label="Training areas ranked by material needing attention"
      >
        {shown.map((group, index) => {
          const barWidth = Math.max(2, (group.needsAttention / max) * barMax);
          const y = index * ROW_HEIGHT;
          return (
            <g key={group.key}>
              <title>
                {group.key}: {group.needsAttention} of {group.total} need attention
              </title>
              <text
                className="bar-label"
                x={LABEL_WIDTH - 10}
                y={y + ROW_HEIGHT / 2}
                dy="0.32em"
                textAnchor="end"
              >
                {truncate(group.key, 30)}
              </text>
              <rect
                x={LABEL_WIDTH}
                y={y + 4}
                width={barWidth}
                height={ROW_HEIGHT - 10}
                rx={4}
                fill={rampColor(group.needsAttention, max)}
              />
              {barWidth > 46 ? (
                <text
                  className="value-label"
                  x={LABEL_WIDTH + barWidth - 8}
                  y={y + ROW_HEIGHT / 2}
                  dy="0.32em"
                  textAnchor="end"
                  fill={rampInk(group.needsAttention, max)}
                >
                  {group.needsAttention}
                </text>
              ) : (
                <text
                  className="value-label"
                  x={LABEL_WIDTH + barWidth + 8}
                  y={y + ROW_HEIGHT / 2}
                  dy="0.32em"
                >
                  {group.needsAttention}
                </text>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

const AGE_LABEL = (row: TrainingRow) =>
  row.ageDays === null
    ? 'no date'
    : row.ageDays > 730
      ? `${Math.floor(row.ageDays / 365)}y`
      : `${Math.floor(row.ageDays / 30)}mo`;

export function TrainingPanel() {
  const [csv, setCsv] = useState<string | null>(null);
  const [state, setState] = useState<'loading' | 'ready' | 'unavailable'>('loading');
  const [dimension, setDimension] = useState<GroupDimension>('lifecycleStep');

  useEffect(() => {
    let cancelled = false;
    loadTrainingMatrix().then((text) => {
      if (cancelled) return;
      setCsv(text);
      setState(text ? 'ready' : 'unavailable');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const rows = useMemo(() => (csv ? analyseRows(csv) : []), [csv]);
  const summary = useMemo(() => totals(rows), [rows]);
  const groups = useMemo(() => groupBy(rows, dimension), [rows, dimension]);

  const worst = useMemo(
    () =>
      [...rows]
        .filter((r) => r.needsAttention)
        // Undated rows sort last, not first. Treating "no date" as infinitely old
        // filled this table with the 36 undated rows and buried the genuinely
        // ancient 2019/2020 material the heading promises.
        .sort((a, b) => {
          if (a.ageDays === null && b.ageDays === null) return a.material.localeCompare(b.material);
          if (a.ageDays === null) return 1;
          if (b.ageDays === null) return -1;
          return b.ageDays - a.ageDays;
        })
        .slice(0, 25),
    [rows],
  );

  if (state === 'loading') {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Training &amp; SOP coverage</h2>
        </div>
        <p className="empty-note">Loading…</p>
      </div>
    );
  }

  if (state === 'unavailable') {
    return (
      <div className="card">
        <div className="card-head">
          <h2>Training &amp; SOP coverage</h2>
          <span className="hint">local data only</span>
        </div>
        <p className="card-sub">
          The matrix is deliberately not deployed. It names process owners, links internal
          documents and records candid notes about business gaps, and both this repo and the
          dashboard bucket are public — so the file stays untracked on the machine that runs it.
        </p>
        <pre>
{`To view it locally:
  1. place the sheet at  data/training-sop-matrix.csv   (already gitignored)
  2. npm run dev
  3. open  http://localhost:5173/?ff=training`}
        </pre>
      </div>
    );
  }

  return (
    <>
      <div className="kpi-row" style={{ marginBottom: 16 }}>
        <div className="tile hero">
          <div className="tile-label">Needs attention</div>
          <div className="tile-value">{pct(summary.needsAttention / (summary.total || 1), 0)}</div>
          <div className="tile-meta">
            <span className="dim">
              {int(summary.needsAttention)} of {int(summary.total)} materials
            </span>
          </div>
        </div>
        <div className="tile">
          <div className="tile-label">Stale &gt; 1 year</div>
          <div className="tile-value">{int(summary.stale)}</div>
          <div className="tile-meta dim">{int(summary.aging)} aging (6–12mo)</div>
        </div>
        <div className="tile">
          <div className="tile-label">Flagged in notes</div>
          <div className="tile-value">{int(summary.flagged)}</div>
          <div className="tile-meta dim">note is not "complete"</div>
        </div>
        <div className="tile">
          <div className="tile-label">No date recorded</div>
          <div className="tile-value">{int(summary.unknown)}</div>
          <div className="tile-meta dim">staleness unknowable</div>
        </div>
        <div className="tile">
          <div className="tile-label">Median age</div>
          <div className="tile-value">
            {summary.medianAgeDays === null ? '—' : `${Math.floor(summary.medianAgeDays / 30)}mo`}
          </div>
          <div className="tile-meta dim">dated rows only</div>
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h2>Where the gaps are</h2>
          <div className="segmented" role="group" aria-label="Group training by">
            {DIMENSIONS.map((option) => (
              <button
                key={option.value}
                type="button"
                aria-pressed={dimension === option.value}
                onClick={() => setDimension(option.value)}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
        <p className="card-sub">
          "Needs attention" means stale (over a year old), undated, or carrying a note that says
          something other than complete. Dates in the sheet are hand-maintained and inconsistent, so
          undated rows are counted separately rather than guessed at.
        </p>
        <AttentionBars groups={groups} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head">
          <h2>Oldest material needing attention</h2>
          <span className="hint">
            {worst.length} of {int(summary.needsAttention)}
          </span>
        </div>
        <div className="table-scroll">
          <table className="data">
            <thead>
              <tr>
                <th>Material</th>
                <th>Lifecycle step</th>
                <th>Owner</th>
                <th className="num">Age</th>
                <th>Why</th>
              </tr>
            </thead>
            <tbody>
              {worst.map((row, index) => (
                <tr key={`${row.material}-${index}`}>
                  <td>
                    {truncate(row.material, 60)}
                    <div className="dim" style={{ fontSize: 11 }}>
                      {row.persona} · {row.format}
                    </div>
                  </td>
                  <td className="dim">{truncate(row.lifecycleStep, 28)}</td>
                  <td>{row.owner}</td>
                  <td className="num">{AGE_LABEL(row)}</td>
                  <td className="wrap-anywhere dim" style={{ fontSize: 12 }}>
                    {row.flagged ? truncate(row.notes, 90) : `stale — ${row.lastUpdatedRaw || 'no date'}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

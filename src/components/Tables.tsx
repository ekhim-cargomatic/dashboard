/**
 * The table views.
 *
 * These are not an afterthought: the area chart's pale ramp steps sit below 3:1
 * against the surface, and the documented relief for that is visible labels plus
 * a table of the same numbers. `AreaTable` is that table. It is also the honest
 * home for the long tail the charts cap — 26 domains do not belong in a legend.
 */

import { useState } from 'react';

import type { AreaImpact, MergedCluster } from '../lib/aggregate';
import { dateTime, duration, int, pct, relativeTime, truncate } from '../lib/format';
import { labelForDomain } from '../lib/domains.generated';
import { statusMeta } from '../lib/status';
import type { AppConfig, RunSummary } from '../types';
import { reportUrl } from '../lib/s3';

/** Status as colour + glyph + word — never colour alone. */
export function StatusChip({ status }: { status: string }) {
  const meta = statusMeta(status);
  return (
    <span className="chip" style={{ color: meta.text }}>
      <span className="chip-glyph" aria-hidden="true">
        {meta.glyph}
      </span>
      {meta.label}
    </span>
  );
}

// --------------------------------------------------------------------------- //

export function AreaTable({ areas, groupLabel }: { areas: AreaImpact[]; groupLabel: string }) {
  if (areas.length === 0) return <p className="empty-note">No areas to show.</p>;

  return (
    <div className="table-scroll">
      <table className="data">
        <caption className="visually-hidden">
          {groupLabel} ranked by number of failing tests
        </caption>
        <thead>
          <tr>
            <th>{groupLabel}</th>
            <th className="num">Needs attention</th>
            <th className="num">Executed</th>
            <th className="num">Fail rate</th>
            <th className="num">Runs affected</th>
          </tr>
        </thead>
        <tbody>
          {areas.map((area) => (
            <tr key={area.key}>
              <td>{area.label}</td>
              <td className="num">{int(area.impacted)}</td>
              <td className="num">{int(area.executed)}</td>
              <td className="num">{pct(area.failRate)}</td>
              <td className="num">
                {area.runsAffected} / {area.runsSeen}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------- //

export function ClustersTable({ clusters }: { clusters: MergedCluster[] }) {
  if (clusters.length === 0) {
    return <p className="empty-note">No failures in this window.</p>;
  }

  return (
    <div className="table-scroll">
      <table className="data">
        <caption className="visually-hidden">
          Failure messages grouped by fingerprint, most frequent first
        </caption>
        <thead>
          <tr>
            <th className="num">Tests</th>
            <th className="num">Runs</th>
            <th>Error</th>
            <th>Areas</th>
          </tr>
        </thead>
        <tbody>
          {clusters.map((cluster) => (
            <tr key={cluster.fingerprint}>
              <td className="num">
                <b>{int(cluster.count)}</b>
              </td>
              <td className="num dim">{cluster.runs}</td>
              <td className="wrap-anywhere">
                <span className="mono">{truncate(cluster.example || cluster.fingerprint, 180)}</span>
              </td>
              <td>
                {cluster.domains.slice(0, 4).map((domain) => (
                  <span className="tag" key={domain}>
                    {labelForDomain(domain)}
                  </span>
                ))}
                {cluster.domains.length > 4 && (
                  <span className="dim" style={{ fontSize: 11 }}>
                    +{cluster.domains.length - 4}
                  </span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// --------------------------------------------------------------------------- //

export function RunsTable({
  runs,
  config,
  onSelect,
  selectedKey,
}: {
  runs: RunSummary[];
  config: AppConfig;
  onSelect: (runPrefix: string) => void;
  selectedKey: string | null;
}) {
  // A 90-day window can hold hundreds of runs; showing them all turns the page
  // into a scroll marathon for a table nobody reads past the first screen.
  const [expanded, setExpanded] = useState(false);
  const COLLAPSED = 15;
  const visible = expanded ? runs : runs.slice(0, COLLAPSED);

  if (runs.length === 0) return <p className="empty-note">No runs in this window.</p>;

  return (
    <div className="table-scroll">
      <table className="data">
        <caption className="visually-hidden">Runs in the current filter, newest first</caption>
        <thead>
          <tr>
            <th>Run</th>
            <th>Finished</th>
            <th>Env</th>
            <th>Branch</th>
            <th className="num">Pass rate</th>
            <th className="num">Attention</th>
            <th className="num">Tests</th>
            <th className="num">Duration</th>
            <th>Report</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((run) => (
            <tr
              key={run.prefix}
              onClick={() => onSelect(run.prefix)}
              style={{
                cursor: 'pointer',
                background: selectedKey === run.prefix ? 'var(--ghost)' : undefined,
              }}
            >
              <td>
                {run.workflow} <span className="dim">#{run.runNumber}</span>
                {run.commitShort && (
                  <div className="mono dim" style={{ fontSize: 11 }}>
                    {run.commitShort}
                  </div>
                )}
              </td>
              <td title={dateTime(run.finishedAt)}>{relativeTime(run.finishedAt)}</td>
              <td>{run.environment}</td>
              <td className="dim">{truncate(run.branch || '—', 18)}</td>
              <td className="num">
                <b>{pct(run.passRate)}</b>
              </td>
              <td className="num">{int(run.totals.impacted)}</td>
              <td className="num dim">{int(run.totals.total)}</td>
              <td className="num dim">{duration(run.wallClockMs)}</td>
              <td onClick={(event) => event.stopPropagation()}>
                <a href={reportUrl(config, run)} target="_blank" rel="noreferrer">
                  Allure ↗
                </a>
                {run.ciUrl && (
                  <>
                    {' '}
                    <a href={run.ciUrl} target="_blank" rel="noreferrer" className="dim">
                      CI ↗
                    </a>
                  </>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {runs.length > COLLAPSED && (
        <button
          className="btn"
          style={{ marginTop: 10 }}
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? 'Show fewer' : `Show all ${runs.length} runs`}
        </button>
      )}
    </div>
  );
}

// --------------------------------------------------------------------------- //

export function FailuresTable({ run, areaFilter }: { run: RunSummary; areaFilter: string | null }) {
  // The area key can be a tag, a domain or a feature depending on how the chart
  // is grouped, so match all three rather than assuming one.
  const failures = areaFilter
    ? run.failures.filter(
        (failure) =>
          failure.domain === areaFilter ||
          failure.suite === areaFilter ||
          (failure.tags ?? []).includes(areaFilter),
      )
    : run.failures;

  if (failures.length === 0) {
    return (
      <p className="empty-note">
        {areaFilter ? 'No failures in the selected area for this run.' : 'No failures in this run.'}
      </p>
    );
  }

  return (
    <div className="table-scroll">
      <table className="data">
        <caption className="visually-hidden">Failing tests in the selected run</caption>
        <thead>
          <tr>
            <th>Test</th>
            <th>Area</th>
            <th>Status</th>
            <th>Error</th>
          </tr>
        </thead>
        <tbody>
          {failures.slice(0, 100).map((failure) => (
            <tr key={failure.uuid || `${failure.historyId}-${failure.name}`}>
              <td>
                {truncate(failure.name, 64)}
                <div className="dim" style={{ fontSize: 11 }}>
                  {failure.suite}
                </div>
              </td>
              <td>{labelForDomain(failure.domain)}</td>
              <td>
                <StatusChip status={failure.status} />
              </td>
              <td className="wrap-anywhere mono" style={{ fontSize: 11 }}>
                {truncate(failure.message || '—', 160)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {failures.length > 100 && (
        <p className="dim" style={{ fontSize: 12 }}>
          Showing 100 of {int(failures.length)} — open the Allure report for the rest.
        </p>
      )}
    </div>
  );
}

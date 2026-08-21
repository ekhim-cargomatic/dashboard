import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  DEFAULT_FILTERS,
  applyFilters,
  areaImpact,
  deltaFromPrevious,
  facets,
  heatmap,
  mergeClusters,
  trend,
  type Filters as FilterState,
} from './lib/aggregate';
import { loadConfig } from './lib/config';
import { discoverRuns, fetchRunSummaries } from './lib/s3';
import { enrichWithFailureDetail } from './lib/allure';
import { int, relativeTime } from './lib/format';
import { AreaHeatmap } from './components/AreaHeatmap';
import { AreaImpactChart, type ImpactMetric } from './components/AreaImpactChart';
import { Filters } from './components/Filters';
import { KpiRow } from './components/KpiRow';
import { TrendChart } from './components/TrendChart';
import { VolumeChart } from './components/VolumeChart';
import { AreaTable, ClustersTable, FailuresTable, RunsTable } from './components/Tables';
import type { AppConfig, GroupBy, RunSummary } from './types';

type Theme = 'light' | 'dark' | 'system';

/**
 * Areas are grouped by raw behave tag.
 *
 * The grouping used to be switchable (domain / tag / feature / layer). Tag is the
 * behave-native answer to "which area is affected" and does not depend on
 * tag_map.yaml being current, so it is now the single grouping and the toggle is
 * gone. The other groupings remain implemented in lib/aggregate.ts — changing
 * this constant is all it takes to switch.
 */
const GROUP_BY: GroupBy = 'tag';
const GROUP_LABEL = 'Tag';

interface LoadState {
  status: 'loading' | 'ready' | 'error';
  message?: string;
  detail?: string;
  loaded: number;
  total: number;
  method?: 'listing' | 'index';
}

export default function App() {
  const [config, setConfig] = useState<AppConfig | null>(null);
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [load, setLoad] = useState<LoadState>({ status: 'loading', loaded: 0, total: 0 });

  const [filters, setFilters] = useState<FilterState>(DEFAULT_FILTERS);
  const [metric, setMetric] = useState<ImpactMetric>('volume');
  const [selectedRunPrefix, setSelectedRunPrefix] = useState<string | null>(null);
  const [selectedArea, setSelectedArea] = useState<string | null>(null);
  const [theme, setTheme] = useState<Theme>(
    () => (localStorage.getItem('qa-theme') as Theme) ?? 'system',
  );

  useEffect(() => {
    if (theme === 'system') document.documentElement.removeAttribute('data-theme');
    else document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('qa-theme', theme);
  }, [theme]);

  const refresh = useCallback(async (activeConfig: AppConfig) => {
    setLoad({ status: 'loading', loaded: 0, total: 0 });
    try {
      const { refs, method } = await discoverRuns(activeConfig);
      if (refs.length === 0) {
        setRuns([]);
        setLoad({
          status: 'ready',
          loaded: 0,
          total: 0,
          method,
          message: 'The bucket has no runs under this prefix yet.',
        });
        return;
      }

      setLoad({ status: 'loading', loaded: 0, total: refs.length, method });
      const summaries = await fetchRunSummaries(activeConfig, refs, (loaded, total) =>
        setLoad((prev) => ({ ...prev, loaded, total })),
      );

      // Show the dashboard as soon as the aggregates are in. Failure *messages*
      // cost one request per failing test, so they load afterwards for a few
      // recent runs only and the clustering card fills in when they arrive.
      setRuns(summaries);
      setLoad({ status: 'ready', loaded: summaries.length, total: refs.length, method });

      const recent = summaries.slice(0, activeConfig.clusterRuns);
      if (recent.length > 0) {
        await Promise.all(recent.map((run) => enrichWithFailureDetail(activeConfig, run)));
        // New array identity so the memoised aggregates recompute.
        setRuns((previous) => [...previous]);
      }
    } catch (error) {
      setLoad({
        status: 'error',
        loaded: 0,
        total: 0,
        message: 'Could not read the results bucket.',
        detail: error instanceof Error ? error.message : String(error),
      });
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    loadConfig().then((loaded) => {
      if (cancelled) return;
      setConfig(loaded);
      void refresh(loaded);
    });
    return () => {
      cancelled = true;
    };
  }, [refresh]);

  // ------------------------------------------------------------- derived -- //

  const allFacets = useMemo(() => facets(runs), [runs]);

  // Land on a single workflow rather than "all".
  //
  // A trend line across mixed workflows is misleading: a 44-test targeted run and
  // a 407-test regression have unrelated pass rates, and interleaving them by time
  // produces a sawtooth that looks like instability but is just two populations.
  // The busiest workflow is the one people came to look at; "All workflows" stays
  // one click away for cross-suite comparison.
  const didPickDefault = useRef(false);
  useEffect(() => {
    if (didPickDefault.current || allFacets.workflows.length === 0) return;
    didPickDefault.current = true;
    if (allFacets.workflows.length > 1) {
      setFilters((prev) => ({ ...prev, workflow: allFacets.workflows[0].value }));
    }
  }, [allFacets]);
  const filtered = useMemo(() => applyFilters(runs, filters), [runs, filters]);
  const trendPoints = useMemo(() => trend(filtered), [filtered]);
  const delta = useMemo(() => deltaFromPrevious(filtered), [filtered]);
  const areas = useMemo(() => areaImpact(filtered, GROUP_BY), [filtered]);
  const grid = useMemo(() => heatmap(filtered, GROUP_BY), [filtered]);
  const clusters = useMemo(() => mergeClusters(filtered), [filtered]);

  // The run whose detail panel is shown — the newest unless one was clicked.
  const selectedRun = useMemo(
    () => filtered.find((run) => run.prefix === selectedRunPrefix) ?? filtered[0] ?? null,
    [filtered, selectedRunPrefix],
  );

  // A filter change can strip the selected area out of the data; drop it rather
  // than silently filtering the failures table to nothing.
  useEffect(() => {
    if (selectedArea && !areas.some((area) => area.key === selectedArea)) setSelectedArea(null);
  }, [areas, selectedArea]);

  // --------------------------------------------------------------- views -- //

  if (load.status === 'loading' && runs.length === 0) {
    return (
      <div className="app">
        <div className="state">
          <h2>Loading runs…</h2>
          <p>
            {load.total > 0
              ? `Reading ${int(load.loaded)} of ${int(load.total)} run summaries from S3.`
              : 'Listing the results bucket.'}
          </p>
          {load.total > 0 && (
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${(load.loaded / load.total) * 100}%` }} />
            </div>
          )}
        </div>
      </div>
    );
  }

  if (load.status === 'error') {
    return (
      <div className="app">
        <div className="state">
          <h2>{load.message}</h2>
          <p className="muted">{load.detail}</p>
          <pre>
{`Checklist
  1. Runs are published under "${config?.runsPrefix ?? 'runs/'}" in the bucket.
  2. The bucket policy grants s3:GetObject and s3:ListBucket to the public.
  3. CloudFront forwards query strings to the origin and does NOT set a
     default root object — see infra/cloudfront-function.js.
  4. If the dashboard is on a different origin than the data, the bucket
     needs a CORS rule allowing GET from this origin.`}
          </pre>
          {config && (
            <button className="btn" style={{ marginTop: 14 }} onClick={() => void refresh(config)}>
              Retry
            </button>
          )}
        </div>
      </div>
    );
  }

  if (runs.length === 0) {
    return (
      <div className="app">
        <div className="state">
          <h2>No runs published yet</h2>
          <p className="muted">
            {load.message} Once a CI job uploads its first report, it appears here automatically —
            no configuration needed.
          </p>
          <pre>
{`Expected layout
  ${config?.runsPrefix ?? 'runs/'}<suite>/<run_id>/
      index.html          the generated Allure report
      widgets/summary.json
      data/suites.json
  ${config?.runsPrefix ?? 'runs/'}<suite>/latest/    mirror of the newest run (skipped when listing)`}
          </pre>
        </div>
      </div>
    );
  }

  const latest = filtered[0];

  return (
    <div className="app">
      {/*
        One bar: identity, scope controls, and view controls. Previously this was a
        title block stacked on a separate filter card, which spent two rows and a
        border on four dropdowns.
      */}
      <header className="topbar">
        <div className="brand">
          <h1>QA Automation Dashboard</h1>
          <p className="brand-meta">
            <strong>{filters.workflow || 'all suites'}</strong>
            <span className="sep" aria-hidden="true">
              ·
            </span>
            {int(filtered.length)} of {int(runs.length)} runs
            <span className="sep" aria-hidden="true">
              ·
            </span>
            updated {relativeTime(runs[0]?.finishedAt ?? null)}
            {load.method === 'index' && (
              <>
                <span className="sep" aria-hidden="true">
                  ·
                </span>
                static index
              </>
            )}
          </p>
        </div>

        <div className="topbar-controls">
          <Filters filters={filters} onChange={setFilters} facets={allFacets} />

          <div className="topbar-divider" aria-hidden="true" />

          <div className="segmented" role="group" aria-label="Theme">
            {(['light', 'system', 'dark'] as Theme[]).map((option) => (
              <button
                key={option}
                type="button"
                aria-pressed={theme === option}
                onClick={() => setTheme(option)}
              >
                {option === 'light' ? 'Light' : option === 'dark' ? 'Dark' : 'Auto'}
              </button>
            ))}
          </div>
          <button
            className="btn icon-btn"
            title="Reload from S3"
            onClick={() => config && void refresh(config)}
          >
            <span aria-hidden="true">↻</span>
            <span className="visually-hidden">Refresh</span>
          </button>
        </div>
      </header>

      {!latest ? (
        <div className="state" style={{ marginTop: 20 }}>
          <h2>No runs match these filters</h2>
          <p className="muted">Widen the time range or clear a filter.</p>
        </div>
      ) : (
        <>
          <section className="block">
            <KpiRow latest={latest} delta={delta} trendPoints={trendPoints} />
          </section>

          <section className="block grid cols-2">
            <div className="card">
              <div className="card-head">
                <h2>Pass rate trend</h2>
                <span className="hint">{filtered.length} runs</span>
              </div>
              <p className="card-sub">
                Axis is zoomed to the observed range, not 0–100%.
              </p>
              <TrendChart points={trendPoints} />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Outcome mix per run</h2>
              </div>
              <p className="card-sub">
                Executed tests and how they landed. <em>+ skipped</em> shows the whole suite —
                useful to catch a pass rate that rose because more was skipped.
              </p>
              <VolumeChart points={trendPoints} />
            </div>
          </section>

          <section className="block grid split-wide">
            <div className="card">
              <div className="card-head">
                <h2>Most affected areas</h2>
                <div className="segmented" role="group" aria-label="Impact metric">
                  <button
                    type="button"
                    aria-pressed={metric === 'volume'}
                    onClick={() => setMetric('volume')}
                  >
                    By volume
                  </button>
                  <button
                    type="button"
                    aria-pressed={metric === 'rate'}
                    onClick={() => setMetric('rate')}
                  >
                    By fail rate
                  </button>
                </div>
              </div>
              <p className="card-sub">
                {metric === 'volume'
                  ? 'Where failures landed across the whole window. Large areas dominate simply by being large — switch to fail rate to normalise.'
                  : 'How bad each area is for its size. A small area can top this chart on a handful of tests — check the volume view before acting.'}{' '}
                Click a bar to filter the failures table.
{' '}
                <strong>
                  A scenario carries several tags, so these rows overlap and do not sum to the run
                  total.
                </strong>{' '}
                Scope (@smoke), layer (@ui) and traceability tags (@C22747, @CAR-1234) are
                excluded.
              </p>
              <AreaImpactChart
                areas={areas}
                metric={metric}
                onSelect={(key) => setSelectedArea(key === selectedArea ? null : key)}
                selected={selectedArea}
              />
            </div>

            <div className="card">
              <div className="card-head">
                <h2>Severity &amp; layer — latest run</h2>
              </div>
              <p className="card-sub">Where the latest run's failures sit.</p>
              <div className="table-scroll">
                <table className="data">
                  <thead>
                    <tr>
                      <th>Slice</th>
                      <th className="num">Attention</th>
                      <th className="num">Total</th>
                      <th className="num">Fail rate</th>
                    </tr>
                  </thead>
                  <tbody>
                    {latest.severities.map((row) => (
                      <tr key={`sev-${row.severity}`}>
                        <td>
                          <span className="tag">severity</span> {row.severity}
                        </td>
                        <td className="num">{int(row.impacted)}</td>
                        <td className="num dim">{int(row.total)}</td>
                        <td className="num">{(row.failRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                    {latest.layers.map((row) => (
                      <tr key={`layer-${row.layer}`}>
                        <td>
                          <span className="tag">layer</span> {row.layer}
                        </td>
                        <td className="num">{int(row.impacted)}</td>
                        <td className="num dim">{int(row.total)}</td>
                        <td className="num">{(row.failRate * 100).toFixed(1)}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>

          <section className="block">
            <div className="card">
              <div className="card-head">
                <h2>Persistent or one-off?</h2>
                <span className="hint">{GROUP_LABEL} × run</span>
              </div>
              <p className="card-sub">
                A solid horizontal band means an area has failed in every run — that is a
                regression someone owns. Scattered cells mean intermittent failures. Click a cell to
                jump to that run.
              </p>
              <AreaHeatmap rows={grid.rows} runs={grid.runs} onSelectRun={setSelectedRunPrefix} />
            </div>
          </section>

          <section className="block">
            <div className="card">
              <div className="card-head">
                <h2>Top failure reasons</h2>
                <span className="hint">grouped by error signature</span>
              </div>
              <p className="card-sub">
                IDs, timestamps and quoted values are normalised, so one root cause is one row
                rather than one row per affected test.
              </p>
              <ClustersTable clusters={clusters} />
            </div>
          </section>

          <section className="block">
            <div className="card">
              <div className="card-head">
                <h2>{GROUP_LABEL} breakdown</h2>
                <span className="hint">all {areas.length} areas</span>
              </div>
              <p className="card-sub">
                The full table behind the chart above, including areas with no failures.
              </p>
              <AreaTable areas={areas} groupLabel={GROUP_LABEL} />
            </div>
          </section>

          {selectedRun && (
            <section className="block">
              <div className="card">
                <div className="card-head">
                  <h2>
                    Failures — {selectedRun.workflow} #{selectedRun.runNumber}
                  </h2>
                  <span className="hint">
                    {selectedArea ? `filtered to ${selectedArea}` : 'all areas'}
                    {selectedArea && (
                      <>
                        {' · '}
                        <button
                          className="btn"
                          style={{ padding: '2px 8px', fontSize: 12 }}
                          onClick={() => setSelectedArea(null)}
                        >
                          clear
                        </button>
                      </>
                    )}
                  </span>
                </div>
                <p className="card-sub">
                  {int(selectedRun.failureCount)} failing tests in this run.
                  {selectedRun.failureCount > selectedRun.failures.length &&
                    ` Showing the first ${selectedRun.failures.length}.`}
                </p>
                <FailuresTable run={selectedRun} areaFilter={selectedArea} />
              </div>
            </section>
          )}

          <section className="block">
            <div className="card">
              <div className="card-head">
                <h2>Runs</h2>
                <span className="hint">click a row to inspect its failures</span>
              </div>
              <RunsTable
                runs={filtered}
                config={config!}
                onSelect={setSelectedRunPrefix}
                selectedKey={selectedRun?.prefix ?? null}
              />
            </div>
          </section>
        </>
      )}
    </div>
  );
}

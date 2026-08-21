/**
 * Cross-run analysis.
 *
 * Each `qa-summary.json` already describes one run. Everything here answers
 * questions that only make sense across runs: is the suite getting better or
 * worse, which area is *persistently* broken rather than briefly red, and which
 * tests flip between pass and fail.
 */

import { labelForDomain } from './domains.generated';
import type { GroupBy, RunSummary } from '../types';

export interface Filters {
  workflow: string; // '' = all
  environment: string; // '' = all
  branch: string; // '' = all
  days: number; // 0 = all time
}

export const DEFAULT_FILTERS: Filters = { workflow: '', environment: '', branch: '', days: 30 };

/**
 * Oldest-first ordering.
 *
 * `runKey` starts with a UTC timestamp so it sorts chronologically, but it is
 * only unique *within* a workflow — two jobs finishing in the same second with
 * the same run number collide. `prefix` breaks the tie and keeps the order stable.
 */
export const byTimeAscending = (a: RunSummary, b: RunSummary): number =>
  a.runKey.localeCompare(b.runKey) || a.prefix.localeCompare(b.prefix);

export function applyFilters(runs: RunSummary[], filters: Filters): RunSummary[] {
  const cutoff = filters.days > 0 ? Date.now() - filters.days * 86_400_000 : 0;

  return runs.filter((run) => {
    if (filters.workflow && run.workflowSlug !== filters.workflow) return false;
    if (filters.environment && run.environment !== filters.environment) return false;
    if (filters.branch && run.branch !== filters.branch) return false;
    if (cutoff) {
      const at = new Date(run.finishedAt ?? run.generatedAt).getTime();
      if (Number.isFinite(at) && at < cutoff) return false;
    }
    return true;
  });
}

/** Distinct values for the filter dropdowns, each with a run count. */
export function facets(runs: RunSummary[]) {
  const collect = (pick: (run: RunSummary) => string, label?: (key: string) => string) => {
    const counts = new Map<string, number>();
    for (const run of runs) {
      const key = pick(run);
      if (key) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
      .map(([value, count]) => ({ value, count, label: label?.(value) ?? value }));
  };

  return {
    workflows: collect(
      (r) => r.workflowSlug,
      (slug) => runs.find((r) => r.workflowSlug === slug)?.workflow ?? slug,
    ),
    environments: collect((r) => r.environment),
    branches: collect((r) => r.branch),
  };
}

// --------------------------------------------------------------------------- //
// Grouping
// --------------------------------------------------------------------------- //

/** Read the rows for the selected grouping out of a run, uniformly keyed. */
export function rowsFor(run: RunSummary, groupBy: GroupBy): { key: string; impacted: number; total: number; failRate: number; passed: number; skipped: number }[] {
  const source =
    groupBy === 'domain'
      ? run.domains
      : groupBy === 'tag'
        ? (run.tags ?? [])
        : groupBy === 'suite'
          ? run.suites
          : run.layers;

  return source.map((row) => ({
    key:
      groupBy === 'domain'
        ? (row as { domain: string }).domain
        : groupBy === 'tag'
          ? (row as { tag: string }).tag
          : groupBy === 'suite'
            ? (row as { suite: string }).suite
            : (row as { layer: string }).layer,
    impacted: row.impacted,
    total: row.total,
    failRate: row.failRate,
    passed: row.passed,
    skipped: row.skipped,
  }));
}

export function labelForKey(key: string, groupBy: GroupBy): string {
  if (groupBy === 'domain') return labelForDomain(key);
  if (groupBy === 'layer') return key === 'untagged' ? 'Untagged' : key.toUpperCase();
  // Tags keep their literal @ prefix so they are obviously the raw behave tag
  // rather than a tag_map domain with a similar name.
  if (groupBy === 'tag') return `@${key}`;
  return key;
}

export interface AreaImpact {
  key: string;
  label: string;
  /** failed + broken, summed across the filtered runs. */
  impacted: number;
  /** Tests executed (total − skipped), summed. */
  executed: number;
  total: number;
  failRate: number;
  /** How many of the filtered runs had at least one failure here. */
  runsAffected: number;
  runsSeen: number;
}

/**
 * Roll every filtered run up by area — the "what was affected most" backbone.
 *
 * `impacted` answers "where did the failures land", `failRate` answers "how bad
 * is this area for its size", and `runsAffected` separates a chronically broken
 * area from one that had a single ugly night.
 */
export function areaImpact(runs: RunSummary[], groupBy: GroupBy): AreaImpact[] {
  const acc = new Map<string, AreaImpact>();

  for (const run of runs) {
    for (const row of rowsFor(run, groupBy)) {
      let entry = acc.get(row.key);
      if (!entry) {
        entry = {
          key: row.key,
          label: labelForKey(row.key, groupBy),
          impacted: 0,
          executed: 0,
          total: 0,
          failRate: 0,
          runsAffected: 0,
          runsSeen: 0,
        };
        acc.set(row.key, entry);
      }
      entry.impacted += row.impacted;
      entry.executed += row.total - row.skipped;
      entry.total += row.total;
      entry.runsSeen += 1;
      if (row.impacted > 0) entry.runsAffected += 1;
    }
  }

  const areas = [...acc.values()];
  for (const area of areas) {
    area.failRate = area.executed > 0 ? area.impacted / area.executed : 0;
  }

  return areas.sort(
    (a, b) => b.impacted - a.impacted || b.failRate - a.failRate || a.label.localeCompare(b.label),
  );
}

// --------------------------------------------------------------------------- //
// Trend
// --------------------------------------------------------------------------- //

export interface TrendPoint {
  run: RunSummary;
  /** X value — chronological index, oldest = 0. */
  index: number;
  at: number;
  passRate: number;
  total: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  impacted: number;
  durationMs: number;
}

/** Oldest-to-newest series for the trend charts. */
export function trend(runs: RunSummary[]): TrendPoint[] {
  return [...runs]
    .sort(byTimeAscending)
    .map((run, index) => ({
      run,
      index,
      at: new Date(run.finishedAt ?? run.generatedAt).getTime(),
      passRate: run.passRate,
      total: run.totals.total,
      passed: run.totals.passed,
      failed: run.totals.failed,
      broken: run.totals.broken,
      skipped: run.totals.skipped,
      impacted: run.totals.impacted,
      durationMs: run.wallClockMs,
    }));
}

/** Difference between the newest run and the one before it. */
export interface Delta {
  passRate: number;
  impacted: number;
  total: number;
  durationMs: number;
  previous: RunSummary | null;
}

export function deltaFromPrevious(runs: RunSummary[]): Delta {
  const [latest, previous] = runs; // runs arrive newest-first
  if (!latest || !previous) {
    return { passRate: 0, impacted: 0, total: 0, durationMs: 0, previous: null };
  }
  return {
    passRate: latest.passRate - previous.passRate,
    impacted: latest.totals.impacted - previous.totals.impacted,
    total: latest.totals.total - previous.totals.total,
    durationMs: latest.wallClockMs - previous.wallClockMs,
    previous,
  };
}

// --------------------------------------------------------------------------- //
// Heatmap
// --------------------------------------------------------------------------- //

export interface HeatmapCell {
  /** S3 prefix — the only globally unique run id. `runKey` repeats across workflows. */
  runPrefix: string;
  failRate: number;
  impacted: number;
  total: number;
  present: boolean;
}

export interface HeatmapRow {
  key: string;
  label: string;
  cells: HeatmapCell[];
  impacted: number;
}

/**
 * Area × run grid of fail rates.
 *
 * A bar chart says which area has the most failures right now; this says whether
 * that area has been red all week or just tonight — the difference between a
 * regression and a flake.
 */
export function heatmap(runs: RunSummary[], groupBy: GroupBy, topN = 12, maxRuns = 24): {
  rows: HeatmapRow[];
  runs: RunSummary[];
} {
  const chronological = [...runs]
    .sort(byTimeAscending)
    .slice(-maxRuns);

  const top = areaImpact(runs, groupBy)
    .filter((area) => area.impacted > 0)
    .slice(0, topN);

  const rows: HeatmapRow[] = top.map((area) => {
    const cells = chronological.map((run) => {
      const row = rowsFor(run, groupBy).find((r) => r.key === area.key);
      if (!row) {
        return { runPrefix: run.prefix, failRate: 0, impacted: 0, total: 0, present: false };
      }
      return {
        runPrefix: run.prefix,
        failRate: row.failRate,
        impacted: row.impacted,
        total: row.total,
        present: true,
      };
    });
    return { key: area.key, label: area.label, cells, impacted: area.impacted };
  });

  return { rows, runs: chronological };
}

// --------------------------------------------------------------------------- //
// Failure clusters
// --------------------------------------------------------------------------- //

export interface MergedCluster {
  fingerprint: string;
  count: number;
  example: string;
  domains: string[];
  suites: string[];
  runs: number;
}

/** Merge per-run failure clusters across the filtered window. */
export function mergeClusters(runs: RunSummary[], limit = 15): MergedCluster[] {
  const merged = new Map<string, MergedCluster>();

  for (const run of runs) {
    for (const cluster of run.clusters) {
      let entry = merged.get(cluster.fingerprint);
      if (!entry) {
        entry = {
          fingerprint: cluster.fingerprint,
          count: 0,
          example: cluster.example,
          domains: [],
          suites: [],
          runs: 0,
        };
        merged.set(cluster.fingerprint, entry);
      }
      entry.count += cluster.count;
      entry.runs += 1;
      for (const domain of cluster.domains) {
        if (!entry.domains.includes(domain)) entry.domains.push(domain);
      }
      for (const suite of cluster.suites) {
        if (!entry.suites.includes(suite)) entry.suites.push(suite);
      }
    }
  }

  return [...merged.values()].sort((a, b) => b.count - a.count).slice(0, limit);
}

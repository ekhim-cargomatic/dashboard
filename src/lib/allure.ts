/**
 * Read a generated Allure report straight from S3 and normalise it into the
 * `RunSummary` shape the rest of the dashboard already speaks.
 *
 * CI publishes clean Allure mirrors — no dashboard-specific file — so the
 * aggregation the CI summariser used to do now happens here. The trick is doing
 * it in two small fetches per run rather than thousands:
 *
 *   widgets/summary.json   totals + wall-clock start/stop (epoch ms)
 *   data/suites.json       every test with status, TAGS and duration
 *
 * `data/suites.json` carrying `tags` is what makes this viable: risk-domain
 * attribution needs the behave tags, and without that file the only source would
 * be one `data/test-cases/<uid>.json` per test.
 *
 * Failure *messages* do live only in those per-test files, so they are fetched
 * lazily and only for a handful of recent runs — see `enrichWithFailureDetail`.
 */

import { isAreaTag, resolveDomains, resolveLayers } from './domains';
import type {
  AppConfig,
  Bucket,
  FailureCluster,
  RunSummary,
  Status,
} from '../types';

// --------------------------------------------------------------------------- //
// Allure's own file shapes (only the fields we use)
// --------------------------------------------------------------------------- //

interface AllureStatistic {
  failed?: number;
  broken?: number;
  skipped?: number;
  passed?: number;
  unknown?: number;
  total?: number;
}

interface AllureSummary {
  reportName?: string;
  statistic?: AllureStatistic;
  time?: { start?: number; stop?: number; duration?: number };
}

interface AllureNode {
  name?: string;
  uid?: string;
  status?: string;
  time?: { start?: number; stop?: number; duration?: number };
  tags?: string[];
  children?: AllureNode[];
}

interface AllureSeverityEntry {
  uid?: string;
  name?: string;
  status?: string;
  severity?: string;
}

/** `widgets/environment.json` — key/value pairs from environment.properties. */
interface AllureEnvEntry {
  name?: string;
  values?: string[];
}

interface AllureTestCase {
  uid?: string;
  name?: string;
  fullName?: string;
  historyId?: string;
  status?: string;
  statusMessage?: string;
  statusTrace?: string;
  statusDetails?: { message?: string; trace?: string };
}

/** One test, flattened out of the Allure trees. */
interface FlatTest {
  uid: string;
  name: string;
  status: Status;
  durationMs: number;
  tags: string[];
  /** Nested suite path, when the report has one. */
  path: string;
  feature: string;
  severity: string;
  domain: string;
  domains: string[];
  layers: string[];
}

// --------------------------------------------------------------------------- //
// Fetching
// --------------------------------------------------------------------------- //

const STATUSES: Status[] = ['passed', 'failed', 'broken', 'skipped', 'unknown'];
const asStatus = (value: unknown): Status =>
  STATUSES.includes(value as Status) ? (value as Status) : 'unknown';

const joinUrl = (base: string, path: string) =>
  base ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : `/${path.replace(/^\//, '')}`;

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/**
 * Pull the handful of run-level facts we care about out of Allure's environment
 * widget, tolerating the various names teams give them.
 */
function readEnvironment(entries: AllureEnvEntry[] | null): {
  environment: string;
  branch: string;
  commit: string;
} {
  const lookup = new Map<string, string>();
  for (const entry of entries ?? []) {
    if (entry.name) lookup.set(entry.name.toLowerCase().replace(/[^a-z]/g, ''), entry.values?.[0] ?? '');
  }
  const first = (...keys: string[]) => {
    for (const key of keys) {
      const value = lookup.get(key);
      if (value) return value;
    }
    return '';
  };
  return {
    environment: first('env', 'environment', 'stage', 'targetenv'),
    branch: first('branch', 'gitbranch', 'refname'),
    commit: first('commit', 'gitcommit', 'sha', 'revision'),
  };
}

// --------------------------------------------------------------------------- //
// Tree walking
// --------------------------------------------------------------------------- //

/**
 * Collect leaves (tests) from an Allure tree, remembering the branch names above
 * each one. Allure omits levels that have no corresponding label, so the depth
 * varies between reports and cannot be assumed.
 */
function collectLeaves(
  node: AllureNode | null | undefined,
  ancestry: string[],
  out: { node: AllureNode; path: string[] }[],
): void {
  if (!node) return;
  if (Array.isArray(node.children) && node.children.length > 0) {
    // The synthetic root ("suites" / "behaviors") is not part of the path.
    const nextAncestry = ancestry.length === 0 && !node.status ? [] : [...ancestry, node.name ?? ''];
    for (const child of node.children) collectLeaves(child, nextAncestry, out);
    return;
  }
  if (node.uid) out.push({ node, path: ancestry.filter(Boolean) });
}

/** uid → the first-level grouping name it sits under (a behave Feature). */
function buildFeatureIndex(behaviors: AllureNode | null): Map<string, string> {
  const index = new Map<string, string>();
  for (const feature of behaviors?.children ?? []) {
    const leaves: { node: AllureNode; path: string[] }[] = [];
    for (const child of feature.children ?? []) collectLeaves(child, [], leaves);
    // A feature with no sub-grouping holds its tests directly.
    if (leaves.length === 0 && feature.children) {
      for (const child of feature.children) if (child.uid) leaves.push({ node: child, path: [] });
    }
    for (const leaf of leaves) {
      if (leaf.node.uid) index.set(leaf.node.uid, feature.name ?? '(no feature)');
    }
  }
  return index;
}

// --------------------------------------------------------------------------- //
// Aggregation
// --------------------------------------------------------------------------- //

const blankBucket = (): Omit<Bucket, 'impacted' | 'failRate'> => ({
  total: 0,
  durationMs: 0,
  passed: 0,
  failed: 0,
  broken: 0,
  skipped: 0,
  unknown: 0,
});

function rowsFrom<K extends string>(
  map: Map<string, ReturnType<typeof blankBucket>>,
  key: K,
): (Bucket & Record<K, string>)[] {
  return [...map.entries()]
    .map(([name, bucket]) => {
      const impacted = bucket.failed + bucket.broken;
      const executed = bucket.total - bucket.skipped;
      return {
        [key]: name,
        ...bucket,
        impacted,
        failRate: executed > 0 ? Number((impacted / executed).toFixed(4)) : 0,
      } as Bucket & Record<K, string>;
    })
    .sort(
      (a, b) =>
        b.impacted - a.impacted ||
        b.failRate - a.failRate ||
        String(a[key]).localeCompare(String(b[key])),
    );
}

/**
 * Build a RunSummary from an Allure report published at `prefix`.
 * Returns null when there is no readable report there — a half-finished upload,
 * or a prefix that is not a run at all.
 */
export async function loadAllureRun(
  config: AppConfig,
  prefix: string,
  meta: { suite: string; runId: string },
): Promise<RunSummary | null> {
  const base = config.dataBaseUrl;
  const at = (file: string) => joinUrl(base, `${prefix}/${file}`);

  const summary = await fetchJson<AllureSummary>(at('widgets/summary.json'));
  if (!summary?.statistic) return null;

  const [suitesTree, behaviorsTree, severityList, environment] = await Promise.all([
    fetchJson<AllureNode>(at('data/suites.json')),
    fetchJson<AllureNode>(at('data/behaviors.json')),
    fetchJson<AllureSeverityEntry[]>(at('widgets/severity.json')),
    fetchJson<AllureEnvEntry[]>(at('widgets/environment.json')),
  ]);

  // Populated only if CI writes an `environment.properties` into allure-results.
  // It usually doesn't, so these stay blank and the dashboard hides the filters
  // rather than showing dropdowns with a single "unknown" option.
  const env = readEnvironment(environment);

  const leaves: { node: AllureNode; path: string[] }[] = [];
  collectLeaves(suitesTree, [], leaves);

  const featureIndex = buildFeatureIndex(behaviorsTree);
  const severityIndex = new Map<string, string>();
  for (const entry of severityList ?? []) {
    if (entry.uid) severityIndex.set(entry.uid, entry.severity ?? 'normal');
  }

  const tests: FlatTest[] = leaves.map(({ node, path }) => {
    const tags = (node.tags ?? []).map((t) => String(t).toLowerCase());
    const { matched, primary } = resolveDomains(tags);
    return {
      uid: node.uid!,
      name: node.name ?? '',
      status: asStatus(node.status),
      durationMs: node.time?.duration ?? 0,
      tags,
      path: path.join(' / ') || '(root)',
      feature: featureIndex.get(node.uid!) ?? '(no feature)',
      severity: severityIndex.get(node.uid!) ?? 'normal',
      domain: primary,
      domains: matched,
      layers: resolveLayers(tags),
    };
  });

  const byDomain = new Map<string, ReturnType<typeof blankBucket>>();
  const byFeature = new Map<string, ReturnType<typeof blankBucket>>();
  const byLayer = new Map<string, ReturnType<typeof blankBucket>>();
  const bySeverity = new Map<string, ReturnType<typeof blankBucket>>();
  const byTag = new Map<string, ReturnType<typeof blankBucket>>();

  const bucketFor = (map: Map<string, ReturnType<typeof blankBucket>>, key: string) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = blankBucket();
      map.set(key, bucket);
    }
    return bucket;
  };

  for (const test of tests) {
    const bump = (bucket: ReturnType<typeof blankBucket>) => {
      bucket.total += 1;
      bucket[test.status] += 1;
      bucket.durationMs += test.durationMs;
    };
    bump(bucketFor(byDomain, test.domain));
    // Grouping by feature rather than directory: allure-behave reliably sets the
    // `feature` label, but rarely the parentSuite/suite labels that would give a
    // file path, so `data/suites.json` is usually flat.
    bump(bucketFor(byFeature, test.feature));
    bump(bucketFor(bySeverity, test.severity));
    for (const layer of test.layers) bump(bucketFor(byLayer, layer));
    // A scenario lands in every area tag it carries, so these buckets overlap by
    // design and will not sum to the run total. That is the honest shape for
    // "which area is affected" when a scenario genuinely spans two areas.
    for (const tag of test.tags) {
      if (isAreaTag(tag)) bump(bucketFor(byTag, tag));
    }
  }

  /*
   * Totals come from the same `data/suites.json` leaves that every breakdown is
   * built from, not from widgets/summary.json.
   *
   * The two normally agree exactly (verified against production: 2111 either
   * way). But if they ever diverge — a truncated upload, a retry counted
   * differently — taking headline numbers from one source and the per-area rows
   * from another makes the page contradict itself, and the domain rows visibly
   * fail to add up to the total. Consistency matters more here than matching
   * Allure's own arithmetic, and summary.json remains the source for wall-clock
   * time, which the leaves cannot give.
   */
  const stat = summary.statistic ?? {};
  const counted = { passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0 };
  for (const test of tests) counted[test.status] += 1;

  const totals =
    tests.length > 0
      ? {
          total: tests.length,
          durationMs: tests.reduce((sum, t) => sum + t.durationMs, 0),
          ...counted,
          impacted: counted.failed + counted.broken,
        }
      : {
          // No readable suites.json — fall back to the summary so the run still
          // contributes a trend point rather than vanishing.
          total: stat.total ?? 0,
          durationMs: 0,
          passed: stat.passed ?? 0,
          failed: stat.failed ?? 0,
          broken: stat.broken ?? 0,
          skipped: stat.skipped ?? 0,
          unknown: stat.unknown ?? 0,
          impacted: (stat.failed ?? 0) + (stat.broken ?? 0),
        };
  const executed = totals.total - totals.skipped;

  const start = summary.time?.start;
  const stop = summary.time?.stop;
  const iso = (ms: number | undefined) =>
    Number.isFinite(ms) ? new Date(ms as number).toISOString().replace(/\.\d{3}Z$/, 'Z') : null;

  const failures = tests
    .filter((t) => t.status === 'failed' || t.status === 'broken')
    .map((t) => ({
      name: t.name,
      fullName: t.name,
      feature: t.feature,
      suite: t.path,
      domain: t.domain,
      domains: t.domains,
      status: t.status,
      severity: t.severity,
      // Filled in later by enrichWithFailureDetail; the message is not in the
      // files we fetch up front.
      message: '',
      fingerprint: '',
      durationMs: t.durationMs,
      historyId: t.name,
      uuid: t.uid,
      tags: t.tags,
    }))
    .sort(
      (a, b) =>
        Number(a.status !== 'failed') - Number(b.status !== 'failed') ||
        a.domain.localeCompare(b.domain) ||
        a.name.localeCompare(b.name),
    );

  const severityOrder = ['blocker', 'critical', 'normal', 'minor', 'trivial'];
  const rankSeverity = (s: string) => {
    const i = severityOrder.indexOf(s);
    return i === -1 ? severityOrder.length : i;
  };

  return {
    schemaVersion: 1,
    runKey: meta.runId,
    prefix,
    workflow: meta.suite,
    workflowSlug: meta.suite,
    // GitHub run ids exceed Number.MAX_SAFE_INTEGER territory only in theory, but
    // they are always integers, so this is safe to display and to sort on.
    runNumber: /^\d+$/.test(meta.runId) ? Number(meta.runId) : 0,
    ciRunId: meta.runId,
    ciUrl: config.ciRunUrlTemplate
      ? config.ciRunUrlTemplate.replace('{runId}', meta.runId)
      : '',
    environment: env.environment,
    branch: env.branch,
    commit: env.commit,
    commitShort: env.commit.slice(0, 7),
    trigger: '',
    actor: '',
    generatedAt: iso(stop) ?? '',
    reportPath: 'index.html',

    totals,
    passRate: executed > 0 ? Number((totals.passed / executed).toFixed(4)) : 0,
    failRate: executed > 0 ? Number((totals.impacted / executed).toFixed(4)) : 0,
    startedAt: iso(start),
    finishedAt: iso(stop),
    wallClockMs:
      Number.isFinite(start) && Number.isFinite(stop) ? (stop as number) - (start as number) : 0,

    domains: rowsFrom(byDomain, 'domain'),
    suites: rowsFrom(byFeature, 'suite'),
    layers: rowsFrom(byLayer, 'layer'),
    tags: rowsFrom(byTag, 'tag'),
    severities: rowsFrom(bySeverity, 'severity').sort(
      (a, b) => rankSeverity(a.severity) - rankSeverity(b.severity),
    ),
    clusters: [],
    failures,
    failureCount: failures.length,
  };
}

// --------------------------------------------------------------------------- //
// Lazy failure detail
// --------------------------------------------------------------------------- //

const RE_URL = /https?:\/\/\S+/g;
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_HEX = /\b[0-9a-f]{8,}\b/gi;
const RE_QUOTED = /'[^']{0,80}'|"[^"]{0,80}"/g;
const RE_NUM = /\b\d+\b/g;

/**
 * Collapse an error message to a cluster key, so one root cause is one row
 * rather than one row per affected test.
 */
export function fingerprint(message: string): string {
  if (!message) return 'no-message';
  return (
    message
      .trim()
      .split('\n', 1)[0]
      .replace(RE_URL, '<url>')
      .replace(RE_UUID, '<uuid>')
      .replace(RE_HEX, '<hash>')
      .replace(RE_QUOTED, '<literal>')
      .replace(RE_NUM, '<n>')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 160) || 'no-message'
  );
}

/**
 * Fill in failure messages and build this run's clusters.
 *
 * Messages live in one `data/test-cases/<uid>.json` per test, so this is the
 * expensive part and is deliberately kept off the initial load: it runs for a few
 * recent runs only, capped per run, and its results are cached with the run.
 */
export async function enrichWithFailureDetail(
  config: AppConfig,
  run: RunSummary,
  maxFailures = 40,
): Promise<RunSummary> {
  if (run.failures.length === 0 || run.failures[0].message) return run;

  const targets = run.failures.slice(0, maxFailures);
  const base = config.dataBaseUrl;

  const details = await Promise.all(
    targets.map((failure) =>
      fetchJson<AllureTestCase>(joinUrl(base, `${run.prefix}/data/test-cases/${failure.uuid}.json`)),
    ),
  );

  const clusters = new Map<string, FailureCluster>();

  targets.forEach((failure, index) => {
    const detail = details[index];
    const message = (
      detail?.statusMessage ??
      detail?.statusDetails?.message ??
      ''
    ).trim();

    failure.message = message.slice(0, 600);
    failure.fingerprint = fingerprint(message);
    // fullName is nicer for display when the report carries one.
    if (detail?.fullName) failure.fullName = detail.fullName;
    if (detail?.historyId) failure.historyId = detail.historyId;

    let cluster = clusters.get(failure.fingerprint);
    if (!cluster) {
      cluster = {
        fingerprint: failure.fingerprint,
        count: 0,
        example: message.slice(0, 400),
        domains: [],
        suites: [],
        tests: [],
      };
      clusters.set(failure.fingerprint, cluster);
    }
    cluster.count += 1;
    for (const slug of failure.domains.length ? failure.domains : [failure.domain]) {
      if (!cluster.domains.includes(slug)) cluster.domains.push(slug);
    }
    if (!cluster.suites.includes(failure.suite)) cluster.suites.push(failure.suite);
    if (cluster.tests.length < 10) cluster.tests.push(failure.name);
  });

  run.clusters = [...clusters.values()].sort((a, b) => b.count - a.count);
  return run;
}

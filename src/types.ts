/**
 * Shapes shared between the CI summariser (ci/qa-summary.mjs) and the SPA.
 * Keep in sync with SCHEMA_VERSION in that file.
 */

export const STATUSES = ['passed', 'failed', 'broken', 'skipped', 'unknown'] as const;
export type Status = (typeof STATUSES)[number];

/** Counts + duration for any slice of a run (a domain, a suite, a severity…). */
export interface Bucket {
  total: number;
  durationMs: number;
  passed: number;
  failed: number;
  broken: number;
  skipped: number;
  unknown: number;
  /** failed + broken — "someone must look at this". */
  impacted: number;
  /** impacted / (total - skipped) */
  failRate: number;
}

export interface DomainRow extends Bucket {
  domain: string;
}
export interface SuiteRow extends Bucket {
  suite: string;
}
export interface LayerRow extends Bucket {
  layer: string;
}
export interface TagRow extends Bucket {
  tag: string;
}
export interface SeverityRow extends Bucket {
  severity: string;
}

export interface FailureCluster {
  fingerprint: string;
  count: number;
  example: string;
  domains: string[];
  suites: string[];
  tests: string[];
}

export interface Failure {
  name: string;
  fullName: string;
  feature: string;
  suite: string;
  domain: string;
  domains: string[];
  status: Status;
  severity: string;
  message: string;
  fingerprint: string;
  durationMs: number;
  historyId: string;
  uuid: string;
  flaky: boolean;
}

/** One `qa-summary.json`, i.e. one CI run. */
export interface RunSummary {
  schemaVersion: number;
  runKey: string;
  /** S3 prefix this run lives under, e.g. `runs/smoke-tests/20260818T130000Z-142`. */
  prefix: string;
  workflow: string;
  workflowSlug: string;
  runNumber: number;
  ciRunId: string;
  ciUrl: string;
  environment: string;
  branch: string;
  commit: string;
  commitShort: string;
  trigger: string;
  actor: string;
  generatedAt: string;
  reportPath: string;

  totals: Omit<Bucket, 'failRate'>;
  passRate: number;
  failRate: number;
  startedAt: string | null;
  finishedAt: string | null;
  wallClockMs: number;

  domains: DomainRow[];
  suites: SuiteRow[];
  layers: LayerRow[];
  /** Per-tag rows. Overlapping by nature — see GroupBy. */
  tags: TagRow[];
  severities: SeverityRow[];
  clusters: FailureCluster[];
  failures: Failure[];
  failureCount: number;
  flakyCount: number;
}

/**
 * How the "most affected area" charts slice a run.
 *
 * `domain` and `tag` are both tag-derived but differ in an important way:
 * `domain` folds tags into tag_map's business areas and attributes each scenario
 * to exactly one, so the rows partition the run. `tag` counts a scenario under
 * every tag it carries, so those rows OVERLAP and do not sum to the run total.
 */
export type GroupBy = 'domain' | 'tag' | 'suite' | 'layer';

/** Runtime config, fetched from /config.json so the bucket can change without a rebuild. */
export interface AppConfig {
  /**
   * Origin the S3 ListObjectsV2 calls and run JSON are fetched from.
   * Empty string = same origin as the dashboard (CloudFront in front of the bucket).
   */
  dataBaseUrl: string;
  /** Origin for deep links into the hosted Allure HTML. Defaults to dataBaseUrl. */
  reportBaseUrl: string;
  /** Root prefix runs are published under. */
  runsPrefix: string;
  /** Most recent runs to load per suite. Keeps a 500-run bucket responsive. */
  maxRunsPerWorkflow: number;
  /**
   * How many recent runs get their failure messages fetched.
   *
   * Messages live in one file per test, so this is the expensive part of loading
   * a raw Allure report. Clustering across a few recent runs is worth the cost;
   * across sixty is not.
   */
  clusterRuns: number;
  /**
   * Link template for a CI run, with `{runId}` substituted — e.g.
   * `https://github.com/cargomatic/playwright-automation/actions/runs/{runId}`.
   * Empty disables the CI link.
   */
  ciRunUrlTemplate: string;
}

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
  severities: SeverityRow[];
  clusters: FailureCluster[];
  failures: Failure[];
  failureCount: number;
  flakyCount: number;
}

/** How the "most affected area" charts slice a run. */
export type GroupBy = 'domain' | 'suite' | 'layer';

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
  /** Most recent runs to load per workflow. Keeps a 500-run bucket responsive. */
  maxRunsPerWorkflow: number;
}

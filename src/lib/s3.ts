/**
 * Run discovery.
 *
 * The dashboard has no database and no index file to keep in sync — it finds runs
 * by listing the bucket with S3's ListObjectsV2 REST API, the same call the AWS
 * CLI makes. Served through CloudFront in front of the same bucket, these are
 * same-origin requests, so no CORS is involved.
 *
 * Published layout (one prefix per suite):
 *
 *   runs/<suite>/<run_id>/   full Allure report — index.html, data/, widgets/
 *   runs/<suite>/latest/     mirror of the newest run for that suite
 *
 * Two details drive the code below:
 *
 *   - `latest/` is a *duplicate* of a run that is already listed under its own id.
 *     It must be skipped or the newest run is counted twice, which would dent the
 *     trend line and double every one of its failures in the area charts.
 *   - `<run_id>` is a GitHub run id — a big integer, not a timestamp. Sorting
 *     those as strings puts "9999999" after "10000000", so ordering is numeric.
 *     Wall-clock time comes from the report's own widgets/summary.json.
 */

import { loadAllureRun } from './allure';
import type { AppConfig, RunSummary } from '../types';

export class ListingError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'ListingError';
  }
}

/** A run located in the bucket, before its report has been read. */
export interface RunRef {
  /** Full S3 prefix, no trailing slash. */
  prefix: string;
  /** Suite slug — the folder under runs/. */
  suite: string;
  /** The run id folder name. */
  runId: string;
}

const joinUrl = (base: string, path: string) =>
  base ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : `/${path.replace(/^\//, '')}`;

/** Mirror folders that duplicate a real run and must not be listed as runs. */
const MIRROR_FOLDERS = new Set(['latest', 'current']);

// --------------------------------------------------------------------------- //
// Listing
// --------------------------------------------------------------------------- //

async function listPage(
  config: AppConfig,
  prefix: string,
  continuationToken?: string,
): Promise<{ prefixes: string[]; next?: string }> {
  const params = new URLSearchParams({
    'list-type': '2',
    prefix,
    delimiter: '/',
    'max-keys': '1000',
  });
  if (continuationToken) params.set('continuation-token', continuationToken);

  const base = config.dataBaseUrl.replace(/\/$/, '');
  const url = `${base || ''}/?${params.toString()}`;

  let response: Response;
  try {
    response = await fetch(url, { headers: { Accept: 'application/xml' } });
  } catch (err) {
    throw new ListingError(
      `Could not reach the bucket at ${base || window.location.origin}. ` +
        `If the dashboard and the reports are on different origins, the bucket needs a CORS rule. (${String(err)})`,
    );
  }

  if (!response.ok) {
    throw new ListingError(
      response.status === 403
        ? 'S3 returned 403 for the bucket listing. The bucket policy needs s3:ListBucket for this to work.'
        : `Bucket listing failed with HTTP ${response.status}.`,
      response.status,
    );
  }

  const doc = new DOMParser().parseFromString(await response.text(), 'application/xml');

  // Check for the actual S3 envelope rather than trusting the parse to fail: a
  // CloudFront distribution with a default root object answers `/?list-type=2`
  // with index.html, which is itself well-formed XML and parses without error.
  if (doc.querySelector('parsererror') || !doc.getElementsByTagName('ListBucketResult').length) {
    throw new ListingError(
      'That URL did not return an S3 bucket listing. CloudFront is probably rewriting `/` to ' +
        'index.html — see infra/cloudfront-function.js for the fix.',
    );
  }

  const prefixes = Array.from(doc.getElementsByTagName('CommonPrefixes'))
    .map((el) => el.getElementsByTagName('Prefix')[0]?.textContent ?? '')
    .filter(Boolean);

  const truncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
  const next = truncated
    ? (doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined)
    : undefined;

  return { prefixes, next };
}

/** Every child "folder" under a prefix, following pagination. */
async function listAllPrefixes(config: AppConfig, prefix: string): Promise<string[]> {
  const all: string[] = [];
  let token: string | undefined;
  // Bounded so a pathological bucket can't spin forever; 20 pages = 20k entries.
  for (let page = 0; page < 20; page += 1) {
    const { prefixes, next } = await listPage(config, prefix, token);
    all.push(...prefixes);
    if (!next) break;
    token = next;
  }
  return all;
}

const lastSegment = (prefix: string) => prefix.replace(/\/$/, '').split('/').pop() ?? '';

/**
 * Newest-first ordering for run ids.
 *
 * Ids are GitHub run ids: integers where larger means newer. Non-numeric folder
 * names can still appear (an older timestamped layout, a manual upload), so those
 * fall back to reverse-lexical and sort after the numeric ones.
 */
function compareRunIdsDescending(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const diff = Number(b) - Number(a);
    if (diff !== 0) return diff;
    return 0;
  }
  if (aNum) return -1;
  if (bNum) return 1;
  return b.localeCompare(a);
}

/**
 * Discover runs across every suite, newest first within each suite.
 *
 * Capped per suite rather than globally so a noisy hourly smoke job cannot push a
 * weekly regression off the dashboard entirely.
 */
export async function discoverRunRefs(config: AppConfig): Promise<RunRef[]> {
  const root = config.runsPrefix.endsWith('/') ? config.runsPrefix : `${config.runsPrefix}/`;
  const suitePrefixes = await listAllPrefixes(config, root);

  const perSuite = await Promise.all(
    suitePrefixes.map(async (suitePrefix) => {
      const suite = lastSegment(suitePrefix);
      const runPrefixes = await listAllPrefixes(config, suitePrefix);

      return runPrefixes
        .map((prefix) => ({ prefix: prefix.replace(/\/$/, ''), suite, runId: lastSegment(prefix) }))
        .filter((ref) => !MIRROR_FOLDERS.has(ref.runId.toLowerCase()))
        .sort((a, b) => compareRunIdsDescending(a.runId, b.runId))
        .slice(0, config.maxRunsPerWorkflow);
    }),
  );

  return perSuite.flat();
}

/**
 * Fallback for buckets that do not allow public listing.
 * `runs/index.json` is a plain array of run prefixes.
 */
async function discoverFromIndex(config: AppConfig): Promise<RunRef[]> {
  const url = joinUrl(config.dataBaseUrl, `${config.runsPrefix.replace(/\/$/, '')}/index.json`);
  const response = await fetch(url);
  if (!response.ok) throw new ListingError(`No fallback index at ${url}`, response.status);

  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new ListingError('runs/index.json is not an array');

  return data
    .filter((v): v is string => typeof v === 'string')
    .map((raw) => {
      const prefix = raw.replace(/\/$/, '');
      const parts = prefix.split('/');
      return { prefix, suite: parts[parts.length - 2] ?? 'unknown', runId: parts[parts.length - 1] };
    })
    .filter((ref) => !MIRROR_FOLDERS.has(ref.runId.toLowerCase()));
}

/** Try bucket listing, then the optional static index. */
export async function discoverRuns(config: AppConfig): Promise<{
  refs: RunRef[];
  method: 'listing' | 'index';
}> {
  let listingError: unknown = null;
  try {
    const refs = await discoverRunRefs(config);
    if (refs.length > 0) return { refs, method: 'listing' };
  } catch (err) {
    listingError = err;
  }

  // Reached when listing failed *or* returned nothing. The second case covers
  // local dev against `public/runs`, where there is no S3 to list.
  try {
    const refs = await discoverFromIndex(config);
    if (refs.length > 0) return { refs, method: 'index' };
  } catch {
    if (listingError) throw listingError;
  }

  if (listingError) throw listingError;
  // Listing worked and found nothing — an empty bucket, not an error.
  return { refs: [], method: 'listing' };
}

// --------------------------------------------------------------------------- //
// Loading
// --------------------------------------------------------------------------- //

/**
 * Run data is immutable once written, so it is cached in sessionStorage. Only the
 * newest run changes between visits; everything older is a free hit.
 *
 * BUMP THIS whenever RunSummary gains a field the UI reads. A cache entry written
 * by an older build parses fine but is missing the new field, and the dashboard
 * then renders it as *absent data* rather than as a cache miss — which is exactly
 * how a returning visitor ended up with an empty "most affected areas" while the
 * failures table beside it listed 402 failures.
 */
const CACHE_VERSION = 3;

/**
 * Reject a cache entry that predates a field the current build needs.
 *
 * The version bump above is the primary guard; this is the backstop for when
 * someone forgets it. Better a redundant fetch than a silently half-empty page.
 */
function isUsableCacheEntry(value: unknown): value is RunSummary {
  const run = value as RunSummary | null;
  return (
    !!run &&
    typeof run === 'object' &&
    !!run.totals &&
    Array.isArray(run.domains) &&
    Array.isArray(run.tags) &&
    Array.isArray(run.suites) &&
    Array.isArray(run.layers) &&
    Array.isArray(run.severities) &&
    Array.isArray(run.failures)
  );
}

const memoryCache = new Map<string, RunSummary>();

/**
 * Drop entries written by older builds. Without this they sit in sessionStorage
 * unread until they push the quota over and start rejecting current writes.
 */
function evictStaleCacheVersions(): void {
  const current = `qa-run:v${CACHE_VERSION}:`;
  try {
    for (const key of Object.keys(sessionStorage)) {
      if (key.startsWith('qa-run:') && !key.startsWith(current)) sessionStorage.removeItem(key);
    }
  } catch {
    // sessionStorage unavailable (private mode, disabled) — nothing to evict.
  }
}
evictStaleCacheVersions();

function readCache(key: string): RunSummary | null {
  const cached = memoryCache.get(key);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    if (!isUsableCacheEntry(parsed)) {
      sessionStorage.removeItem(key);
      return null;
    }
    memoryCache.set(key, parsed);
    return parsed;
  } catch {
    return null;
  }
}

function writeCache(key: string, value: RunSummary): void {
  memoryCache.set(key, value);
  try {
    sessionStorage.setItem(key, JSON.stringify(value));
  } catch {
    // Quota exceeded — the in-memory cache still serves this session.
  }
}

/**
 * Load one run.
 *
 * Two publishing shapes are supported, checked cheapest-first:
 *
 *   1. `qa-summary.json` at the run root — the precomputed summary produced by
 *      ci/qa-summary.mjs. Richest (it carries failure messages) and one fetch.
 *   2. A raw Allure report at the run root — what CI publishes today. Parsed
 *      client-side by lib/allure.ts.
 */
export async function fetchRunSummary(
  config: AppConfig,
  ref: RunRef,
): Promise<RunSummary | null> {
  const cacheKey = `qa-run:v${CACHE_VERSION}:${ref.prefix}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  try {
    const response = await fetch(joinUrl(config.dataBaseUrl, `${ref.prefix}/qa-summary.json`));
    if (response.ok) {
      const summary = (await response.json()) as RunSummary;
      summary.prefix = ref.prefix;
      // Older uploads nested the report; newer ones put it at the run root.
      if (!summary.reportPath) summary.reportPath = 'allure-report/index.html';
      writeCache(cacheKey, summary);
      return summary;
    }
  } catch {
    // Fall through to the Allure reader.
  }

  const summary = await loadAllureRun(config, ref.prefix, {
    suite: ref.suite,
    runId: ref.runId,
  });
  if (summary) writeCache(cacheKey, summary);
  return summary;
}

/** Fetch many runs with bounded concurrency, skipping any that fail. */
export async function fetchRunSummaries(
  config: AppConfig,
  refs: RunRef[],
  onProgress?: (loaded: number, total: number) => void,
  concurrency = 10,
): Promise<RunSummary[]> {
  const results: RunSummary[] = [];
  let index = 0;
  let loaded = 0;

  const worker = async () => {
    while (index < refs.length) {
      const current = refs[index];
      index += 1;
      try {
        const summary = await fetchRunSummary(config, current);
        if (summary) results.push(summary);
      } catch {
        // One malformed run must not take out the dashboard.
      }
      loaded += 1;
      onProgress?.(loaded, refs.length);
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, refs.length) }, () => worker()));

  // Newest first. Runs come from several suites, so order on the report's own
  // wall-clock time rather than on the run id, which is only comparable within
  // a suite.
  return results.sort((a, b) => finishedMs(b) - finishedMs(a) || b.runKey.localeCompare(a.runKey));
}

const finishedMs = (run: RunSummary): number => {
  const at = Date.parse(run.finishedAt ?? run.generatedAt ?? '');
  return Number.isFinite(at) ? at : 0;
};

/** Absolute URL of a run's hosted Allure report. */
export function reportUrl(config: AppConfig, run: RunSummary): string {
  const base = config.reportBaseUrl || config.dataBaseUrl;
  return joinUrl(base, `${run.prefix}/${run.reportPath || 'index.html'}`);
}

/** URL of a suite's `latest/` mirror — a stable link that always shows the newest run. */
export function latestReportUrl(config: AppConfig, suite: string): string {
  const base = config.reportBaseUrl || config.dataBaseUrl;
  const root = config.runsPrefix.replace(/\/$/, '');
  return joinUrl(base, `${root}/${suite}/latest/index.html`);
}

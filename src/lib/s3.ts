/**
 * Run discovery.
 *
 * The dashboard has no database and no index file to keep in sync — it finds
 * runs by listing the bucket with S3's ListObjectsV2 REST API, the same call the
 * AWS CLI makes. Served through CloudFront in front of the same bucket, these are
 * same-origin requests, so no CORS is involved.
 *
 * Two properties make this cheap enough to do from a browser:
 *
 *   1. `delimiter=/` makes S3 return *folders* (CommonPrefixes) rather than every
 *      object. Listing `runs/` returns ~10 workflows; listing `runs/smoke-tests/`
 *      returns one entry per run, not the thousands of files inside each report.
 *   2. Run keys start with a UTC timestamp, so lexical descending order is newest
 *      first — we can take the newest N without reading any of them.
 *
 * If listing is unavailable (bucket policy without s3:ListBucket, or CloudFront
 * swallowing the query string), we fall back to an optional `runs/index.json`.
 */

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

const joinUrl = (base: string, path: string) =>
  base ? `${base.replace(/\/$/, '')}/${path.replace(/^\//, '')}` : `/${path.replace(/^\//, '')}`;

/**
 * One page of a ListObjectsV2 call.
 * Returns the child "folders" plus, when asked, the object keys at this level.
 */
async function listPage(
  config: AppConfig,
  prefix: string,
  continuationToken?: string,
): Promise<{ prefixes: string[]; keys: string[]; next?: string }> {
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

  const text = await response.text();
  const doc = new DOMParser().parseFromString(text, 'application/xml');

  // Check for the actual S3 envelope rather than trusting the parse to fail:
  // a CloudFront distribution with a default root object answers `/?list-type=2`
  // with index.html, which is itself well-formed XML and parses without error.
  if (doc.querySelector('parsererror') || !doc.getElementsByTagName('ListBucketResult').length) {
    throw new ListingError(
      'That URL did not return an S3 bucket listing. CloudFront is probably rewriting `/` to ' +
        'index.html — see infra/cloudfront-function.js for the fix.',
    );
  }

  const textOf = (el: Element, tag: string) => el.getElementsByTagName(tag)[0]?.textContent ?? '';

  const prefixes = Array.from(doc.getElementsByTagName('CommonPrefixes'))
    .map((el) => textOf(el, 'Prefix'))
    .filter(Boolean);

  const keys = Array.from(doc.getElementsByTagName('Contents'))
    .map((el) => textOf(el, 'Key'))
    .filter(Boolean);

  const truncated = doc.getElementsByTagName('IsTruncated')[0]?.textContent === 'true';
  const next = truncated
    ? (doc.getElementsByTagName('NextContinuationToken')[0]?.textContent ?? undefined)
    : undefined;

  return { prefixes, keys, next };
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
 * Discover run prefixes across every workflow, newest first.
 *
 * Capped per workflow rather than globally so a noisy hourly smoke job can't
 * push a weekly regression off the dashboard entirely.
 */
export async function discoverRunPrefixes(config: AppConfig): Promise<string[]> {
  const root = config.runsPrefix.endsWith('/') ? config.runsPrefix : `${config.runsPrefix}/`;
  const workflowPrefixes = await listAllPrefixes(config, root);

  const perWorkflow = await Promise.all(
    workflowPrefixes.map(async (workflowPrefix) => {
      const runs = await listAllPrefixes(config, workflowPrefix);
      // Run keys are `<ISO-ish timestamp>-<run number>`, so lexical desc == newest first.
      return runs
        .sort((a, b) => lastSegment(b).localeCompare(lastSegment(a)))
        .slice(0, config.maxRunsPerWorkflow);
    }),
  );

  return perWorkflow.flat();
}

/**
 * Fallback discovery for buckets that do not allow public listing.
 * `runs/index.json` is a plain array of run prefixes.
 */
async function discoverFromIndex(config: AppConfig): Promise<string[]> {
  const url = joinUrl(config.dataBaseUrl, `${config.runsPrefix.replace(/\/$/, '')}/index.json`);
  const response = await fetch(url);
  if (!response.ok) throw new ListingError(`No fallback index at ${url}`, response.status);
  const data: unknown = await response.json();
  if (!Array.isArray(data)) throw new ListingError('runs/index.json is not an array');
  return data.filter((v): v is string => typeof v === 'string');
}

/** Try bucket listing, then the optional static index. */
export async function discoverRuns(config: AppConfig): Promise<{
  prefixes: string[];
  method: 'listing' | 'index';
}> {
  let listingError: unknown = null;
  try {
    const prefixes = await discoverRunPrefixes(config);
    if (prefixes.length > 0) return { prefixes, method: 'listing' };
  } catch (err) {
    listingError = err;
  }

  // Reached when listing failed *or* returned nothing. The second case covers
  // local dev against `public/runs`, where there is no S3 to list.
  try {
    const prefixes = await discoverFromIndex(config);
    if (prefixes.length > 0) return { prefixes, method: 'index' };
  } catch {
    if (listingError) throw listingError;
  }

  if (listingError) throw listingError;
  // Listing worked and found nothing — an empty bucket, not an error.
  return { prefixes: [], method: 'listing' };
}

/**
 * Run summaries are immutable once written, so they are cached in sessionStorage.
 * Only the newest run changes between visits; everything older is a free hit.
 */
const memoryCache = new Map<string, RunSummary>();

function readCache(key: string): RunSummary | null {
  const cached = memoryCache.get(key);
  if (cached) return cached;
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RunSummary;
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

export async function fetchRunSummary(
  config: AppConfig,
  prefix: string,
): Promise<RunSummary | null> {
  const cacheKey = `qa-run:${prefix}`;
  const cached = readCache(cacheKey);
  if (cached) return cached;

  const url = joinUrl(config.dataBaseUrl, `${prefix.replace(/\/$/, '')}/qa-summary.json`);
  const response = await fetch(url);
  // A run whose upload was interrupted has no summary. Skip it rather than
  // failing the whole dashboard.
  if (!response.ok) return null;

  const summary = (await response.json()) as RunSummary;
  // Older uploads predate `prefix`; trust the location we found it at.
  summary.prefix = prefix.replace(/\/$/, '');
  writeCache(cacheKey, summary);
  return summary;
}

/** Fetch many summaries with bounded concurrency, skipping any that fail. */
export async function fetchRunSummaries(
  config: AppConfig,
  prefixes: string[],
  onProgress?: (loaded: number, total: number) => void,
  concurrency = 12,
): Promise<RunSummary[]> {
  const results: RunSummary[] = [];
  let index = 0;
  let loaded = 0;

  const worker = async () => {
    while (index < prefixes.length) {
      const current = prefixes[index];
      index += 1;
      try {
        const summary = await fetchRunSummary(config, current);
        if (summary) results.push(summary);
      } catch {
        // Malformed JSON in one run must not take out the dashboard.
      }
      loaded += 1;
      onProgress?.(loaded, prefixes.length);
    }
  };

  await Promise.all(
    Array.from({ length: Math.min(concurrency, prefixes.length) }, () => worker()),
  );

  // Newest first, by the timestamp embedded in the run key.
  return results.sort(
    (a, b) => b.runKey.localeCompare(a.runKey) || b.prefix.localeCompare(a.prefix),
  );
}

/** Absolute URL of a run's hosted Allure report. */
export function reportUrl(config: AppConfig, run: RunSummary): string {
  const base = config.reportBaseUrl || config.dataBaseUrl;
  return joinUrl(base, `${run.prefix}/${run.reportPath || 'allure-report/index.html'}`);
}

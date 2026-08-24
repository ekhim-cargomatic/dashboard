#!/usr/bin/env node
/**
 * Compile a run of raw Allure results into the compact `qa-summary.json` the
 * QA dashboard reads.
 *
 * The dashboard discovers runs by listing the S3 bucket, then fetches one of
 * these files per run. Keeping the aggregation here — rather than in the browser
 * — is what lets the SPA stay static: a 381-feature regression produces thousands
 * of Allure JSON files, and this collapses them to a few tens of KB.
 *
 * Zero dependencies on purpose: CI only needs `actions/setup-node`, no install.
 *
 * Usage (from the playwright-automation repo, after `allure generate`):
 *
 *   node qa-summary.mjs \
 *     --results reports/allure-results \
 *     --out     reports/allure-report/qa-summary.json \
 *     --workflow "Smoke Tests" --run-number 142
 *
 * Every metadata flag falls back to the matching GitHub Actions environment
 * variable, so in CI most of them can be omitted.
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const SCHEMA_VERSION = 1;

/** Allure's status vocabulary. Anything else is folded into "unknown". */
const STATUSES = ['passed', 'failed', 'broken', 'skipped', 'unknown'];

/** Statuses meaning "this did not pass and someone must look at it". */
const BAD_STATUSES = ['failed', 'broken'];

const HERE = dirname(fileURLToPath(import.meta.url));

// --------------------------------------------------------------------------- //
// Domain attribution
// --------------------------------------------------------------------------- //

/**
 * Maps a scenario's behave tags onto the risk domains defined in tag_map.yaml.
 */
class DomainResolver {
  constructor(domainMap) {
    this.tagToDomains = domainMap.tagToDomains ?? {};
    this.meta = Object.fromEntries((domainMap.domains ?? []).map((d) => [d.slug, d]));
  }

  /**
   * Returns { matched, primary }.
   *
   * A scenario tagged `@pagination @invoices` legitimately touches both the
   * generic `tables` bucket and `invoices`. For "which area is worst" we need one
   * bucket per scenario or the totals double-count, so the primary is the least
   * generic match, tie-broken by tag_map declaration order.
   */
  resolve(tags) {
    const matched = [];
    for (const tag of tags) {
      for (const slug of this.tagToDomains[tag.toLowerCase()] ?? []) {
        if (!matched.includes(slug)) matched.push(slug);
      }
    }
    if (matched.length === 0) return { matched: [], primary: 'unmapped' };

    const primary = matched.reduce((best, slug) => {
      const a = this.meta[slug];
      const b = this.meta[best];
      if (!b) return slug;
      if (!a) return best;
      if (a.genericity !== b.genericity) return a.genericity < b.genericity ? slug : best;
      return a.order < b.order ? slug : best;
    }, matched[0]);

    return { matched, primary };
  }
}

/**
 * Tags that describe an *area*, as opposed to bookkeeping (scope selectors, layer
 * tags, execution gates, and the traceability ids tag_map lists under
 * non_routing). Keeping those in would swamp a per-tag breakdown: every test in a
 * smoke run carries @smoke, and each case id appears exactly once.
 */
class AreaTagFilter {
  constructor(domainMap) {
    this.bookkeeping = new Set([
      ...(domainMap.scopes ?? []),
      ...(domainMap.layers ?? []),
      ...(domainMap.excludeAlways ?? []),
      ...(domainMap.authRoles ?? []),
    ]);
    // tag_map writes these uppercase; tags arrive lowercased, so match loosely.
    this.nonRouting = (domainMap.nonRoutingPatterns ?? []).map((p) => new RegExp(p, 'i'));
  }

  isArea(tag) {
    const t = String(tag).toLowerCase();
    if (!t || this.bookkeeping.has(t)) return false;
    return !this.nonRouting.some((re) => re.test(t));
  }
}

// --------------------------------------------------------------------------- //
// Failure fingerprinting
// --------------------------------------------------------------------------- //

const RE_URL = /https?:\/\/\S+/g;
const RE_UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
const RE_HEX = /\b[0-9a-f]{8,}\b/gi;
const RE_QUOTED = /'[^']{0,80}'|"[^"]{0,80}"/g;
const RE_NUM = /\b\d+\b/g;

/**
 * Collapse an error message to a cluster key.
 *
 * Two failures belong to the same cluster when they differ only in the IDs,
 * timestamps, URLs and quoted literals that vary run to run. Without this the
 * "top failure reasons" list degenerates into one row per test.
 */
function fingerprint(message) {
  if (!message) return 'no-message';
  // The first line carries the assertion; the traceback below it is noise.
  const firstLine = message.trim().split('\n', 1)[0];
  const collapsed = firstLine
    .replace(RE_URL, '<url>')
    .replace(RE_UUID, '<uuid>')
    .replace(RE_HEX, '<hash>')
    .replace(RE_QUOTED, '<literal>')
    .replace(RE_NUM, '<n>')
    .replace(/\s+/g, ' ')
    .trim();
  return collapsed.slice(0, 160) || 'no-message';
}

// --------------------------------------------------------------------------- //
// Allure parsing
// --------------------------------------------------------------------------- //

const labelsOf = (result, name) =>
  (result.labels ?? [])
    .filter((l) => l?.name === name && l?.value != null)
    .map((l) => String(l.value));

const firstLabel = (result, name, fallback = '') => labelsOf(result, name)[0] ?? fallback;

/**
 * A slash-joined feature-file path, e.g. `admin/booking_details`.
 *
 * allure-behave puts the feature file's directory chain in `titlePath` with a
 * leading "features" element and the feature name as the last element; we want
 * the directories in between as the code-area key.
 */
function suitePath(result) {
  let parts = (result.titlePath ?? []).filter(Boolean).map(String);
  if (parts[0] === 'features') parts = parts.slice(1);
  if (parts.length > 1) parts = parts.slice(0, -1); // drop the feature title
  return parts.length ? parts.join('/') : '(root)';
}

function* iterResults(resultsDir) {
  let entries;
  try {
    entries = readdirSync(resultsDir).filter((f) => f.endsWith('-result.json')).sort();
  } catch (err) {
    console.error(`warning: cannot read ${resultsDir}: ${err.message}`);
    return;
  }
  for (const entry of entries) {
    try {
      yield JSON.parse(readFileSync(join(resultsDir, entry), 'utf8'));
    } catch (err) {
      console.error(`warning: skipping ${entry}: ${err.message}`);
    }
  }
}

const blankBucket = () => ({
  total: 0,
  durationMs: 0,
  ...Object.fromEntries(STATUSES.map((s) => [s, 0])),
});

// --------------------------------------------------------------------------- //
// Aggregation
// --------------------------------------------------------------------------- //

function summarize(resultsDir, resolver, tagFilter, maxFailures) {
  const totals = blankBucket();
  const byDomain = new Map();
  const bySuite = new Map();
  const bySeverity = new Map();
  const byLayer = new Map();
  const byTag = new Map();

  const clusters = new Map();
  const failures = [];

  // historyId -> statuses seen, so a test that both failed and passed inside one
  // run (a retry) is reported as flaky rather than as a hard failure.
  const historyStatuses = new Map();

  const starts = [];
  const stops = [];
  let seen = 0;

  const bucketFor = (map, key) => {
    let bucket = map.get(key);
    if (!bucket) {
      bucket = blankBucket();
      map.set(key, bucket);
    }
    return bucket;
  };

  for (const result of iterResults(resultsDir)) {
    seen += 1;
    const status = STATUSES.includes(result.status) ? result.status : 'unknown';

    const { start, stop } = result;
    const hasSpan = Number.isFinite(start) && Number.isFinite(stop);
    const duration = hasSpan ? Math.max(0, stop - start) : 0;
    if (Number.isFinite(start)) starts.push(start);
    if (Number.isFinite(stop)) stops.push(stop);

    const tags = labelsOf(result, 'tag').map((t) => t.toLowerCase());
    const { matched, primary } = resolver.resolve(tags);
    const suite = suitePath(result);
    const severity = firstLabel(result, 'severity', 'normal');
    const layers = tags.filter((t) => ['api', 'ui', 'e2e', 'portal'].includes(t));
    if (layers.length === 0) layers.push('untagged');

    const historyId = result.historyId || result.uuid || '';
    if (!historyStatuses.has(historyId)) historyStatuses.set(historyId, new Set());
    historyStatuses.get(historyId).add(status);

    const bump = (bucket) => {
      bucket.total += 1;
      bucket[status] += 1;
      bucket.durationMs += duration;
    };

    bump(totals);
    bump(bucketFor(byDomain, primary));
    bump(bucketFor(bySuite, suite));
    bump(bucketFor(bySeverity, severity));
    for (const layer of layers) bump(bucketFor(byLayer, layer));
    // Overlapping by design: a scenario counts under each area tag it carries.
    for (const tag of tags) {
      if (tagFilter.isArea(tag)) bump(bucketFor(byTag, tag));
    }

    if (BAD_STATUSES.includes(status)) {
      const message = String(result.statusDetails?.message ?? '').trim();
      const key = fingerprint(message);

      let cluster = clusters.get(key);
      if (!cluster) {
        cluster = {
          fingerprint: key,
          count: 0,
          example: message.slice(0, 400),
          domains: [],
          suites: [],
          tests: [],
        };
        clusters.set(key, cluster);
      }
      cluster.count += 1;
      for (const slug of matched.length ? matched : [primary]) {
        if (!cluster.domains.includes(slug)) cluster.domains.push(slug);
      }
      if (!cluster.suites.includes(suite)) cluster.suites.push(suite);
      if (cluster.tests.length < 10) cluster.tests.push(String(result.name ?? '').slice(0, 160));

      failures.push({
        name: String(result.name ?? '').slice(0, 200),
        fullName: String(result.fullName ?? '').slice(0, 300),
        feature: firstLabel(result, 'feature', ''),
        suite,
        domain: primary,
        domains: matched,
        status,
        severity,
        message: message.slice(0, 600),
        fingerprint: key,
        durationMs: duration,
        historyId,
        uuid: result.uuid ?? '',
      });
    }
  }

  if (seen === 0) {
    console.error(`warning: no *-result.json files found in ${resultsDir}`);
  }

  const flaky = [...historyStatuses.entries()]
    .filter(([, set]) => set.has('passed') && BAD_STATUSES.some((s) => set.has(s)))
    .map(([hid]) => hid);
  const flakySet = new Set(flaky);
  for (const failure of failures) failure.flaky = flakySet.has(failure.historyId);

  const asRows = (map, keyName) =>
    [...map.entries()]
      .map(([key, bucket]) => {
        const impacted = bucket.failed + bucket.broken;
        const executed = bucket.total - bucket.skipped;
        return {
          [keyName]: key,
          ...bucket,
          impacted,
          failRate: executed ? Number((impacted / executed).toFixed(4)) : 0,
        };
      })
      // Worst area first — that ordering is the whole point of these tables.
      .sort(
        (a, b) =>
          b.impacted - a.impacted ||
          b.failRate - a.failRate ||
          String(a[keyName]).localeCompare(String(b[keyName])),
      );

  const executed = totals.total - totals.skipped;
  const impacted = totals.failed + totals.broken;

  // Severity ranks worst-first so the dashboard can render it without a lookup.
  const severityOrder = ['blocker', 'critical', 'normal', 'minor', 'trivial'];
  const rankSeverity = (s) => {
    const i = severityOrder.indexOf(s);
    return i === -1 ? severityOrder.length : i;
  };

  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

  return {
    totals: { ...totals, impacted },
    passRate: executed ? Number((totals.passed / executed).toFixed(4)) : 0,
    failRate: executed ? Number((impacted / executed).toFixed(4)) : 0,
    startedAt: starts.length ? iso(Math.min(...starts)) : null,
    finishedAt: stops.length ? iso(Math.max(...stops)) : null,
    wallClockMs: starts.length && stops.length ? Math.max(...stops) - Math.min(...starts) : 0,
    domains: asRows(byDomain, 'domain'),
    suites: asRows(bySuite, 'suite'),
    layers: asRows(byLayer, 'layer'),
    tags: asRows(byTag, 'tag'),
    severities: asRows(bySeverity, 'severity').sort(
      (a, b) => rankSeverity(a.severity) - rankSeverity(b.severity),
    ),
    clusters: [...clusters.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    failures: failures
      .sort(
        (a, b) =>
          Number(a.status !== 'failed') - Number(b.status !== 'failed') ||
          a.domain.localeCompare(b.domain) ||
          a.name.localeCompare(b.name),
      )
      .slice(0, maxFailures),
    failureCount: failures.length,
    flakyCount: flaky.length,
  };
}

// --------------------------------------------------------------------------- //
// Entry point
// --------------------------------------------------------------------------- //

const slugify = (value) =>
  String(value).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'run';

const envDefault = (...names) => {
  for (const name of names) {
    if (process.env[name]) return process.env[name];
  }
  return '';
};

const { values: args } = parseArgs({
  options: {
    results: { type: 'string', default: 'reports/allure-results' },
    out: { type: 'string', default: 'qa-summary.json' },
    'domain-map': { type: 'string', default: join(HERE, 'domains.generated.json') },
    workflow: { type: 'string' },
    'run-number': { type: 'string' },
    'run-id': { type: 'string' },
    environment: { type: 'string' },
    branch: { type: 'string' },
    commit: { type: 'string' },
    trigger: { type: 'string' },
    actor: { type: 'string' },
    repo: { type: 'string' },
    'server-url': { type: 'string' },
    'max-failures': { type: 'string', default: '400' },
    'print-key': { type: 'boolean', default: false },
  },
});

const workflow = args.workflow || envDefault('WORKFLOW_NAME', 'GITHUB_WORKFLOW') || 'local';
const runNumber = args['run-number'] || envDefault('GITHUB_RUN_NUMBER') || '0';
const workflowSlug = slugify(workflow);
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
const runKey = `${stamp}-${runNumber}`;
const prefix = `runs/${workflowSlug}/${runKey}`;

// `--print-key` lets the upload step learn the destination without re-deriving
// the timestamp, which would drift between the two invocations.
if (args['print-key']) {
  console.log(prefix);
  process.exit(0);
}

let domainMap;
const domainMapPath = resolve(args['domain-map']);
try {
  domainMap = JSON.parse(readFileSync(domainMapPath, 'utf8'));
} catch (err) {
  console.error(
    `domain map not readable at ${domainMapPath}: ${err.message}\n` +
      'Generate it first: npm run gen:domains -- --tag-map <path to tag_map.yaml>',
  );
  process.exit(1);
}

const resolver = new DomainResolver(domainMap);
const tagFilter = new AreaTagFilter(domainMap);
const summary = summarize(
  resolve(args.results),
  resolver,
  tagFilter,
  Number(args['max-failures']) || 400,
);

const repo = args.repo || envDefault('GITHUB_REPOSITORY');
const runId = args['run-id'] || envDefault('GITHUB_RUN_ID');
const serverUrl = args['server-url'] || envDefault('GITHUB_SERVER_URL') || 'https://github.com';
const commit = args.commit || envDefault('GITHUB_SHA');

const document = {
  schemaVersion: SCHEMA_VERSION,
  runKey,
  prefix,
  workflow,
  workflowSlug,
  runNumber: /^\d+$/.test(runNumber) ? Number(runNumber) : 0,
  ciRunId: runId,
  ciUrl: repo && runId ? `${serverUrl}/${repo}/actions/runs/${runId}` : '',
  environment: args.environment || envDefault('RUN_ENV', 'ENVIRONMENT') || 'unknown',
  branch: args.branch || envDefault('GITHUB_REF_NAME'),
  commit,
  commitShort: commit.slice(0, 7),
  trigger: args.trigger || envDefault('GITHUB_EVENT_NAME'),
  actor: args.actor || envDefault('GITHUB_ACTOR'),
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  reportPath: 'index.html',
  ...summary,
};

mkdirSync(dirname(resolve(args.out)), { recursive: true });
writeFileSync(resolve(args.out), JSON.stringify(document));

const t = document.totals;
console.log(
  `${args.out}: ${t.total} tests (${t.passed}P/${t.failed}F/${t.broken}B/${t.skipped}S) ` +
    `pass rate ${(document.passRate * 100).toFixed(1)}%, ${document.domains.length} domains, ` +
    `${document.clusters.length} failure clusters`,
);
const worst = document.domains.filter((d) => d.impacted > 0).slice(0, 5);
if (worst.length) {
  console.log(`  most affected: ${worst.map((d) => `${d.domain}(${d.impacted})`).join(', ')}`);
}

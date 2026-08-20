#!/usr/bin/env node
/**
 * Generate realistic fixture runs into `public/runs/` for local development.
 *
 * These are *Allure-shaped* — the same files CI publishes — so `npm run dev`
 * exercises the real parsing path in lib/allure.ts rather than a convenient
 * stand-in:
 *
 *   runs/<suite>/<run_id>/widgets/summary.json
 *                        /widgets/severity.json
 *                        /data/suites.json          (tests + tags)
 *                        /data/behaviors.json       (feature grouping)
 *                        /data/test-cases/<uid>.json (failure messages)
 *   runs/<suite>/latest/  mirror of the newest run
 *
 * The data deliberately contains the shapes the dashboard exists to surface:
 *   - a sustained regression in one domain starting partway through the window
 *   - a genuinely flaky test that flips most runs
 *   - one bad night that recovers
 *   - a suite that only covers a few domains (exercises "not run" hatching)
 *   - run ids that straddle a digit-count boundary, so lexical sorting would
 *     visibly mis-order them and numeric sorting is actually proven
 *   - a `latest/` mirror, which must be skipped rather than double-counted
 *
 * Deterministic: same output every run, so screenshots and diffs stay stable.
 */

import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const PUBLIC = join(ROOT, 'public');
const OUT = join(PUBLIC, 'runs');

const domainMap = JSON.parse(readFileSync(join(ROOT, 'ci', 'domains.generated.json'), 'utf8'));
const ALL_DOMAINS = domainMap.domains.map((d) => d.slug);
/** domain slug -> a representative tag, so fixtures carry tags the map resolves. */
const TAG_FOR = Object.fromEntries(domainMap.domains.map((d) => [d.slug, d.tags[0] ?? d.slug]));

/** Deterministic PRNG (mulberry32) — Math.random would break reproducibility. */
function rng(seed) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const FEATURE_FOR = {
  invoices: 'Invoice details',
  payouts: 'AP payouts',
  order_billing: 'Order billing status',
  order_booking: 'Order details',
  booking: 'Command booking flow',
  shipments: 'Shipment details',
  drayage: 'Drayage orders',
  unified_view: 'UV Explore',
  tariffs: 'Tariff management',
  quotes: 'Quotes API',
  accessorials: 'Accessorial management',
  shipper: 'Shipper profile',
  carrier: 'Carrier profile',
  auth: 'Login',
  markets: 'Markets',
  amazon: 'Amazon EDI',
};
const featureFor = (domain) => FEATURE_FOR[domain] ?? `${domain} feature`;

const ERRORS = [
  'TimeoutError: locator.click: Timeout 30000ms exceeded waiting for selector "[data-test=save-btn]"',
  'AssertionError: expected billing status to be "Ready to Bill" but was "Incomplete"',
  'playwright._impl._errors.Error: Element is not visible: [data-test=invoice-row-0]',
  'AssertionError: expected 200 but got 502 from POST /api/v2/orders',
  'StaleElementReferenceError: element is not attached to the page document',
  'AssertionError: expected total weight 42150 but was 41980',
];

const SEVERITIES = ['critical', 'normal', 'normal', 'minor'];

const SUITES = [
  { slug: 'smoke', size: 96, perDay: 2, domains: ALL_DOMAINS },
  { slug: 'regression', size: 381, perDay: 1, domains: ALL_DOMAINS },
  // Only touches a few areas — this is what puts "not run" cells in the heatmap.
  { slug: 'booking', size: 44, perDay: 1, domains: ['order_billing', 'invoices', 'payouts', 'tariffs'] },
];

const DAYS = 30;
const NOW = Date.UTC(2026, 7, 20, 14, 0, 0); // fixed clock keeps output stable
const DAY_MS = 86_400_000;

/**
 * Base run id chosen so the sequence crosses from 10 to 11 digits partway
 * through. Sorted as strings these interleave wrongly; the dashboard must sort
 * them numerically.
 */
const RUN_ID_BASE = 9_999_999_960;

const WEIGHTS = {
  unified_view: 5, order_billing: 4.5, shipments: 3.5, order_booking: 3, invoices: 3,
  booking: 2.5, accessorials: 2, drayage: 2, payouts: 2, tariffs: 1.5,
  shipment_leg_management: 1.5, carrier: 1.5, shipper: 1.5, quotes: 1,
  auth: 0.6, fsc: 0.4, routing: 0.4, exceptions: 0.4,
};
const weightOf = (domain) => WEIGHTS[domain] ?? 1;
const baseFailRate = (domain, random) =>
  0.005 + random() * 0.02 + (domain === 'unified_view' ? 0.02 : 0);

let uidCounter = 0;
const nextUid = () => (uidCounter++).toString(16).padStart(16, '0');

function buildRun(suite, dayIndex, runOfDay, runId, random) {
  const finishedAt = NOW - (DAYS - dayIndex) * DAY_MS + runOfDay * 6 * 3600_000;

  const regressionActive = dayIndex >= 18 && suite.domains.includes('order_billing');
  const badNight = dayIndex === 11;

  const domains = suite.domains;
  const totalWeight = domains.reduce((sum, d) => sum + weightOf(d), 0);
  const sizeOf = (domain) => Math.max(2, Math.round((weightOf(domain) / totalWeight) * suite.size));

  const tests = [];
  const statistic = { failed: 0, broken: 0, skipped: 0, passed: 0, unknown: 0, total: 0 };
  let cursor = finishedAt - 20 * 60_000;

  for (const domain of domains) {
    const total = sizeOf(domain) + Math.floor(random() * 3);
    const skipped = random() < 0.25 ? Math.floor(random() * 2) : 0;
    const executed = total - skipped;

    let rate = baseFailRate(domain, random);
    if (regressionActive && domain === 'order_billing') rate = 0.42 + random() * 0.12;
    if (badNight) rate += 0.18;

    const impacted = Math.max(
      0,
      Math.min(executed, Math.round(executed * rate + (random() < 0.3 ? 1 : 0))),
    );
    const broken = Math.floor(impacted * (random() < 0.4 ? 0.4 : 0.15));
    const failed = impacted - broken;

    for (let i = 0; i < total; i += 1) {
      let status = 'passed';
      if (i < skipped) status = 'skipped';
      else if (i < skipped + broken) status = 'broken';
      else if (i < skipped + broken + failed) status = 'failed';

      // One designated flaky test flips with the run id's parity.
      const isFlakyCandidate = domain === 'unified_view' && i === skipped;
      if (isFlakyCandidate && Number(runId) % 2 === 0 && status !== 'passed') status = 'passed';

      const duration = status === 'skipped' ? 0 : 2000 + Math.floor(random() * 22000);
      const start = cursor;
      cursor += Math.floor(duration / 8);

      statistic[status] += 1;
      statistic.total += 1;

      const failing = status === 'failed' || status === 'broken';
      const errorIndex =
        regressionActive && domain === 'order_billing' ? 1 : Math.floor(random() * ERRORS.length);

      tests.push({
        uid: nextUid(),
        name: isFlakyCandidate
          ? 'UV Explore: column totals match the summary row'
          : `${featureFor(domain)}: scenario ${i + 1}`,
        feature: featureFor(domain),
        status,
        time: { start, stop: start + duration, duration },
        flaky: isFlakyCandidate,
        retriesCount: isFlakyCandidate ? 1 : 0,
        retriesStatusChange: isFlakyCandidate,
        // Tags the domain map actually resolves, plus a layer tag.
        tags: [TAG_FOR[domain], domain === 'quotes' || domain === 'amazon' ? 'api' : 'ui'].filter(
          Boolean,
        ),
        severity: SEVERITIES[Math.floor(random() * SEVERITIES.length)],
        message: failing ? ERRORS[errorIndex] : '',
      });
    }
  }

  return { tests, statistic, finishedAt, startedAt: finishedAt - 20 * 60_000 };
}

function writeReport(dir, run, suite, runId) {
  mkdirSync(join(dir, 'widgets'), { recursive: true });
  mkdirSync(join(dir, 'data', 'test-cases'), { recursive: true });

  const leaf = (t) => ({
    name: t.name,
    uid: t.uid,
    parentUid: 'fixture',
    status: t.status,
    time: t.time,
    flaky: t.flaky,
    newFailed: false,
    newPassed: false,
    newBroken: false,
    retriesCount: t.retriesCount,
    retriesStatusChange: t.retriesStatusChange,
    parameters: [],
    tags: t.tags,
  });

  writeFileSync(
    join(dir, 'widgets', 'summary.json'),
    JSON.stringify({
      reportName: 'Allure Report',
      testRuns: [],
      statistic: run.statistic,
      time: {
        start: run.startedAt,
        stop: run.finishedAt,
        duration: run.finishedAt - run.startedAt,
      },
    }),
  );

  // Flat under the synthetic root, which is what allure-behave actually produces
  // when scenarios carry no parentSuite/suite labels.
  writeFileSync(
    join(dir, 'data', 'suites.json'),
    JSON.stringify({ name: 'suites', uid: 'suites', children: run.tests.map(leaf) }),
  );

  const byFeature = new Map();
  for (const t of run.tests) {
    if (!byFeature.has(t.feature)) byFeature.set(t.feature, []);
    byFeature.get(t.feature).push(t);
  }
  writeFileSync(
    join(dir, 'data', 'behaviors.json'),
    JSON.stringify({
      name: 'behaviors',
      uid: 'behaviors',
      children: [...byFeature.entries()].map(([name, items], i) => ({
        name,
        uid: `feature-${i}`,
        children: items.map(leaf),
      })),
    }),
  );

  writeFileSync(
    join(dir, 'widgets', 'severity.json'),
    JSON.stringify(
      run.tests.map((t) => ({
        uid: t.uid,
        name: t.name,
        time: t.time,
        status: t.status,
        severity: t.severity,
      })),
    ),
  );

  writeFileSync(join(dir, 'widgets', 'environment.json'), JSON.stringify([]));

  for (const t of run.tests) {
    if (t.status !== 'failed' && t.status !== 'broken') continue;
    writeFileSync(
      join(dir, 'data', 'test-cases', `${t.uid}.json`),
      JSON.stringify({
        uid: t.uid,
        name: t.name,
        fullName: `${t.feature}: ${t.name}`,
        historyId: t.name,
        status: t.status,
        statusMessage: t.message,
        statusTrace: 'Traceback (most recent call last):\n  ...',
      }),
    );
  }

  writeFileSync(
    join(dir, 'index.html'),
    `<!doctype html><title>Allure — ${suite} ${runId}</title>` +
      `<body style="font-family:system-ui;padding:40px">` +
      `<h1>Allure report placeholder</h1>` +
      `<p>${suite} run ${runId} — in production this is the real generated report.</p>`,
  );
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const prefixes = [];
const random = rng(20260820);
let idCursor = 0;

for (const suite of SUITES) {
  let newestDir = null;
  let newestId = null;

  for (let day = 0; day < DAYS; day += 1) {
    for (let runOfDay = 0; runOfDay < suite.perDay; runOfDay += 1) {
      const runId = String(RUN_ID_BASE + idCursor * 37);
      idCursor += 1;

      const run = buildRun(suite, day, runOfDay, runId, random);
      const prefix = `runs/${suite.slug}/${runId}`;
      const dir = join(PUBLIC, prefix);
      writeReport(dir, run, suite.slug, runId);

      prefixes.push(prefix);
      newestDir = dir;
      newestId = runId;
    }
  }

  // The mirror CI maintains. The dashboard must skip it — if it doesn't, the
  // newest run of every suite is counted twice and its failures double.
  if (newestDir) {
    cpSync(newestDir, join(PUBLIC, `runs/${suite.slug}/latest`), { recursive: true });
    console.log(`  ${suite.slug}: newest run ${newestId} mirrored to latest/`);
  }
}

// Fallback index for local dev, where there is no S3 to list. Deliberately
// includes `latest/` so the skip logic is exercised on this path too.
const withMirrors = [...prefixes, ...SUITES.map((s) => `runs/${s.slug}/latest`)];
writeFileSync(join(OUT, 'index.json'), JSON.stringify(withMirrors.sort().reverse(), null, 2));

writeFileSync(
  join(PUBLIC, 'config.json'),
  `${JSON.stringify(
    {
      dataBaseUrl: '',
      reportBaseUrl: '',
      runsPrefix: 'runs/',
      maxRunsPerWorkflow: 60,
      clusterRuns: 5,
      ciRunUrlTemplate: '',
    },
    null,
    2,
  )}\n`,
);

console.log(`wrote ${prefixes.length} Allure-shaped fixture runs to public/runs/`);
console.log('run `npm run dev` to view them');

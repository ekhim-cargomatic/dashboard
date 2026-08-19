#!/usr/bin/env node
/**
 * Generate realistic fixture runs into `public/runs/` for local development.
 *
 * `npm run dev` then serves them through the same code path production uses:
 * bucket listing is unavailable against Vite's static server, so the SPA falls
 * back to `runs/index.json`, which this script also writes.
 *
 * The data is deliberately not uniform noise — it contains the shapes the
 * dashboard exists to surface:
 *   - a sustained regression in one domain starting partway through the window
 *   - a genuinely flaky test that flips most runs
 *   - one bad night that recovers, so "regression vs flake" has something to separate
 *   - a targeted workflow that only covers a few domains, exercising the
 *     heatmap's "not run" hatching
 *
 * Deterministic: same output every run, so screenshots and diffs stay stable.
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const OUT = join(ROOT, 'public', 'runs');

const domainMap = JSON.parse(readFileSync(join(ROOT, 'ci', 'domains.generated.json'), 'utf8'));
const ALL_DOMAINS = domainMap.domains.map((d) => d.slug);

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

const SUITES = {
  invoices: 'admin/invoices',
  payouts: 'admin/payouts',
  order_billing: 'admin/order_billing',
  order_booking: 'admin/order_details',
  booking: 'admin/booking',
  shipments: 'admin/shipments',
  drayage: 'api/unified_view',
  unified_view: 'admin/unifiedview/drayage',
  tariffs: 'admin/tariffs',
  quotes: 'api/quotes',
  accessorials: 'admin/accessorials',
  shipper: 'ui/shipper',
  carrier: 'ui/carrier',
  auth: 'admin/admin_login',
  markets: 'admin/markets',
  amazon: 'api/amazon',
};
const suiteFor = (domain) => SUITES[domain] ?? `admin/${domain}`;

const ERRORS = [
  'TimeoutError: locator.click: Timeout 30000ms exceeded waiting for selector "[data-test=save-btn]"',
  'AssertionError: expected billing status to be "Ready to Bill" but was "Incomplete"',
  'playwright._impl._errors.Error: Element is not visible: [data-test=invoice-row-0]',
  'AssertionError: expected 200 but got 502 from POST /api/v2/orders',
  'StaleElementReferenceError: element is not attached to the page document',
  'AssertionError: expected total weight 42150 but was 41980',
];

const WORKFLOWS = [
  { name: 'Smoke Tests', slug: 'smoke-tests', size: 96, perDay: 2, envs: ['staging'], domains: ALL_DOMAINS },
  { name: 'Regression', slug: 'regression', size: 381, perDay: 1, envs: ['staging'], domains: ALL_DOMAINS },
  {
    name: 'Targeted',
    slug: 'targeted',
    size: 44,
    perDay: 1,
    envs: ['staging', 'dev'],
    // Only touches a few areas — this is what puts "not run" cells in the heatmap.
    domains: ['order_billing', 'invoices', 'payouts', 'tariffs'],
  },
];

const DAYS = 30;
const NOW = Date.UTC(2026, 7, 18, 14, 0, 0); // fixed clock keeps output stable
const DAY_MS = 86_400_000;

/** Baseline flakiness per domain, so some areas are chronically noisier. */
const baseFailRate = (domain, random) => 0.005 + random() * 0.02 + (domain === 'unified_view' ? 0.02 : 0);

/**
 * Relative test counts. Real suites are lumpy — unified_view and order_billing
 * carry far more scenarios than fsc or routing. The unevenness is the point: it
 * makes "by volume" and "by fail rate" rank areas differently, which is exactly
 * the disagreement the two-metric toggle exists to expose.
 */
const WEIGHTS = {
  unified_view: 5,
  order_billing: 4.5,
  shipments: 3.5,
  order_booking: 3,
  invoices: 3,
  booking: 2.5,
  accessorials: 2,
  drayage: 2,
  payouts: 2,
  tariffs: 1.5,
  shipment_leg_management: 1.5,
  carrier: 1.5,
  shipper: 1.5,
  quotes: 1,
  auth: 0.6,
  fsc: 0.4,
  routing: 0.4,
  exceptions: 0.4,
};
const weightOf = (domain) => WEIGHTS[domain] ?? 1;

function buildRun(workflow, dayIndex, runOfDay, random) {
  const finishedAt = NOW - (DAYS - dayIndex) * DAY_MS + runOfDay * 6 * 3600_000;
  const runNumber = dayIndex * workflow.perDay + runOfDay + 100;
  const stamp = new Date(finishedAt).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
  const runKey = `${stamp}-${runNumber}`;
  const prefix = `runs/${workflow.slug}/${runKey}`;

  // The injected narrative.
  const regressionActive = dayIndex >= 18 && workflow.domains.includes('order_billing');
  const badNight = dayIndex === 11;

  const perDomain = [];
  const failures = [];
  const clusterCounts = new Map();

  const domains = workflow.domains;
  const totalWeight = domains.reduce((sum, domain) => sum + weightOf(domain), 0);
  const sizeOf = (domain) =>
    Math.max(2, Math.round((weightOf(domain) / totalWeight) * workflow.size));

  let totals = { total: 0, passed: 0, failed: 0, broken: 0, skipped: 0, unknown: 0, durationMs: 0 };

  for (const domain of domains) {
    const total = sizeOf(domain) + Math.floor(random() * 3);
    const skipped = random() < 0.25 ? Math.floor(random() * 2) : 0;
    const executed = total - skipped;

    let rate = baseFailRate(domain, random);
    if (regressionActive && domain === 'order_billing') rate = 0.42 + random() * 0.12;
    if (badNight) rate += 0.18;

    let impacted = Math.min(executed, Math.round(executed * rate + (random() < 0.3 ? 1 : 0)));
    if (impacted < 0) impacted = 0;

    const broken = Math.floor(impacted * (random() < 0.4 ? 0.4 : 0.15));
    const failed = impacted - broken;
    const passed = executed - impacted;
    const durationMs = executed * (4000 + Math.floor(random() * 9000));

    totals.total += total;
    totals.passed += passed;
    totals.failed += failed;
    totals.broken += broken;
    totals.skipped += skipped;
    totals.durationMs += durationMs;

    perDomain.push({
      domain,
      total,
      durationMs,
      passed,
      failed,
      broken,
      skipped,
      unknown: 0,
      impacted,
      failRate: executed ? Number((impacted / executed).toFixed(4)) : 0,
    });

    for (let i = 0; i < impacted; i += 1) {
      const status = i < broken ? 'broken' : 'failed';
      const errorIndex =
        regressionActive && domain === 'order_billing' ? 1 : Math.floor(random() * ERRORS.length);
      const message = ERRORS[errorIndex];
      const fingerprint = message.replace(/\b\d+\b/g, '<n>').replace(/"[^"]*"/g, '<literal>').slice(0, 160);

      // One designated flaky test flips based on the run number's parity.
      const isFlakyCandidate = domain === 'unified_view' && i === 0;
      if (isFlakyCandidate && runNumber % 2 === 0) continue;

      const name = isFlakyCandidate
        ? 'UV Explore: column totals match the summary row'
        : `${domain} scenario ${i + 1}`;

      failures.push({
        name,
        fullName: `${domain}: ${name}`,
        feature: domain,
        suite: suiteFor(domain),
        domain,
        domains: [domain],
        status,
        severity: random() < 0.2 ? 'critical' : random() < 0.5 ? 'normal' : 'minor',
        message,
        fingerprint,
        durationMs: 3000 + Math.floor(random() * 20000),
        historyId: isFlakyCandidate ? 'flaky-uv-columns' : `${domain}-${i}`,
        uuid: `${runKey}-${domain}-${i}`,
        flaky: isFlakyCandidate,
      });

      const cluster = clusterCounts.get(fingerprint) ?? {
        fingerprint,
        count: 0,
        example: message,
        domains: [],
        suites: [],
        tests: [],
      };
      cluster.count += 1;
      if (!cluster.domains.includes(domain)) cluster.domains.push(domain);
      if (!cluster.suites.includes(suiteFor(domain))) cluster.suites.push(suiteFor(domain));
      if (cluster.tests.length < 10) cluster.tests.push(name);
      clusterCounts.set(fingerprint, cluster);
    }
  }

  const impacted = totals.failed + totals.broken;
  const executed = totals.total - totals.skipped;

  const bySuite = new Map();
  for (const row of perDomain) {
    const suite = suiteFor(row.domain);
    const entry = bySuite.get(suite) ?? {
      suite,
      total: 0,
      durationMs: 0,
      passed: 0,
      failed: 0,
      broken: 0,
      skipped: 0,
      unknown: 0,
      impacted: 0,
      failRate: 0,
    };
    for (const key of ['total', 'durationMs', 'passed', 'failed', 'broken', 'skipped', 'impacted']) {
      entry[key] += row[key];
    }
    bySuite.set(suite, entry);
  }
  for (const entry of bySuite.values()) {
    const ex = entry.total - entry.skipped;
    entry.failRate = ex ? Number((entry.impacted / ex).toFixed(4)) : 0;
  }

  const layerRow = (layer, share) => {
    const total = Math.round(totals.total * share);
    const imp = Math.round(impacted * share);
    return {
      layer,
      total,
      durationMs: Math.round(totals.durationMs * share),
      passed: total - imp,
      failed: imp,
      broken: 0,
      skipped: 0,
      unknown: 0,
      impacted: imp,
      failRate: total ? Number((imp / total).toFixed(4)) : 0,
    };
  };

  const severityRow = (severity, share) => {
    const total = Math.round(totals.total * share);
    const imp = Math.round(impacted * share);
    return {
      severity,
      total,
      durationMs: 0,
      passed: total - imp,
      failed: imp,
      broken: 0,
      skipped: 0,
      unknown: 0,
      impacted: imp,
      failRate: total ? Number((imp / total).toFixed(4)) : 0,
    };
  };

  const wallClockMs = Math.round(totals.durationMs / 3); // three shards in parallel

  return {
    schemaVersion: 1,
    runKey,
    prefix,
    workflow: workflow.name,
    workflowSlug: workflow.slug,
    runNumber,
    ciRunId: String(9_000_000 + runNumber),
    ciUrl: `https://github.com/example/playwright-automation/actions/runs/${9_000_000 + runNumber}`,
    environment: workflow.envs[runOfDay % workflow.envs.length],
    branch: 'main',
    commit: `${runKey.slice(-7)}abcdef0123456789`,
    commitShort: `${runKey.slice(-7)}`,
    trigger: 'schedule',
    actor: 'qa-bot',
    generatedAt: new Date(finishedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    reportPath: 'allure-report/index.html',
    totals: { ...totals, impacted },
    passRate: executed ? Number((totals.passed / executed).toFixed(4)) : 0,
    failRate: executed ? Number((impacted / executed).toFixed(4)) : 0,
    startedAt: new Date(finishedAt - wallClockMs).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    finishedAt: new Date(finishedAt).toISOString().replace(/\.\d{3}Z$/, 'Z'),
    wallClockMs,
    domains: perDomain.sort((a, b) => b.impacted - a.impacted || b.failRate - a.failRate),
    suites: [...bySuite.values()].sort((a, b) => b.impacted - a.impacted),
    layers: [layerRow('ui', 0.6), layerRow('api', 0.3), layerRow('e2e', 0.1)],
    severities: [
      severityRow('critical', 0.15),
      severityRow('normal', 0.6),
      severityRow('minor', 0.25),
    ],
    clusters: [...clusterCounts.values()].sort((a, b) => b.count - a.count).slice(0, 40),
    failures: failures.slice(0, 400),
    failureCount: failures.length,
    flakyCount: failures.filter((f) => f.flaky).length,
  };
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const prefixes = [];
const random = rng(20260818);

for (const workflow of WORKFLOWS) {
  for (let day = 0; day < DAYS; day += 1) {
    for (let runOfDay = 0; runOfDay < workflow.perDay; runOfDay += 1) {
      const run = buildRun(workflow, day, runOfDay, random);
      const dir = join(ROOT, 'public', run.prefix);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'qa-summary.json'), JSON.stringify(run));

      // A placeholder so the "Allure ↗" links resolve locally.
      mkdirSync(join(dir, 'allure-report'), { recursive: true });
      writeFileSync(
        join(dir, 'allure-report', 'index.html'),
        `<!doctype html><title>Allure — ${run.workflow} #${run.runNumber}</title>` +
          `<body style="font-family:system-ui;padding:40px">` +
          `<h1>Allure report placeholder</h1>` +
          `<p>${run.workflow} run #${run.runNumber} — in production this is the real generated report.</p>`,
      );

      prefixes.push(run.prefix);
    }
  }
}

// Newest first, matching what bucket listing returns.
prefixes.sort((a, b) => b.localeCompare(a));
writeFileSync(join(OUT, 'index.json'), JSON.stringify(prefixes, null, 2));

writeFileSync(
  join(ROOT, 'public', 'config.json'),
  `${JSON.stringify({ dataBaseUrl: '', reportBaseUrl: '', runsPrefix: 'runs/', maxRunsPerWorkflow: 60 }, null, 2)}\n`,
);

console.log(`wrote ${prefixes.length} fixture runs to public/runs/`);
console.log('run `npm run dev` to view them');

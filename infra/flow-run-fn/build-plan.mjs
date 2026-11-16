#!/usr/bin/env node
/**
 * Build a plan exactly the way the Lambda does, and print it, so a flow can be
 * run locally with run_plan.py — no deploy, no CodeBuild, no AWS credentials.
 *
 * The Lambda writes `JSON.stringify(buildPlan(...))` to S3 and the runner reads
 * it back, so a plan built here is byte-for-byte what production would hand the
 * browser. That makes this the loop for checking a selector or a value: change
 * cargomatic.json, rebuild, run, look.
 *
 *   node infra/flow-run-fn/build-plan.mjs sh2.acc.total > /tmp/plan.json
 *   python3 infra/flow-runner/run_plan.py --plan /tmp/plan.json \
 *     --repo ../playwright-automation --env staging --headless false
 *
 * `--headless false` opens a real window, which is the point: you watch the
 * step that fails instead of reading about it afterwards.
 *
 * A second argument fixes the run suffix. Leave it off and it comes from the
 * clock, which is what keeps per-run-unique values (equipment numbers) unique.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { indexFlow, buildPlan } from './plan.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const [, , target, runArg] = process.argv;

if (!target) {
  console.error('usage: build-plan.mjs <targetId> [runSuffix]');
  console.error('   eg: build-plan.mjs sh2.acc.total > /tmp/plan.json');
  process.exit(2);
}

const run = runArg || String(Date.now()).slice(-4);
const mapPath = resolve(here, '../../public/qa-flow/cargomatic.json');
const ix = indexFlow(JSON.parse(readFileSync(mapPath, 'utf8')));
const plan = buildPlan(ix, target, { run });

if (plan.error) {
  console.error(`${target}: ${plan.error}`);
  process.exit(1);
}
if (!plan.runnable) {
  console.error(`${target} cannot be run yet:`);
  for (const b of plan.blockers ?? []) console.error('  - ' + (b.why ?? b.name ?? JSON.stringify(b)));
  process.exit(1);
}

console.error(`${plan.chunkName} — ${plan.targetName}: ${plan.steps.length} steps (run ${run})`);
process.stdout.write(JSON.stringify(plan, null, 1) + '\n');

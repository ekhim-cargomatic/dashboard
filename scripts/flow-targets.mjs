/**
 * What on the flow map can actually be run, and why the rest cannot.
 *
 * The map describes far more than a browser can be driven through, and the
 * difference matters: a play button that fails on a third of what it offers is
 * worse than one that is honest about its reach. This resolves a plan for every
 * node and reports the split — the same resolver the Lambda uses, so the number
 * is the real one rather than an estimate of it.
 *
 *   node scripts/flow-targets.mjs             the summary
 *   node scripts/flow-targets.mjs <node id>   one plan, step by step
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { buildPlan, editableFields, indexFlow } from '../infra/flow-run-fn/plan.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const flow = JSON.parse(readFileSync(join(ROOT, 'public/qa-flow/cargomatic.json'), 'utf8'));
const ix = indexFlow(flow);

const [, , one] = process.argv;

if (one) {
  const plan = buildPlan(ix, one, { run: '0000' });
  if (plan.error) {
    console.error(plan.error);
    process.exit(1);
  }
  console.log(`${plan.chunkName} — ${plan.targetName}`);
  console.log(`${plan.chunks.join(' → ')}   ·   ${plan.portal} portal\n`);
  for (const [i, step] of plan.steps.entries()) {
    const value = step.value !== undefined ? `  = ${JSON.stringify(step.value)}` : '';
    console.log(
      `${String(i + 1).padStart(3)}  ${step.verb.padEnd(12)} ${String(step.name).slice(0, 32).padEnd(33)}`
      + `${String(step.path ?? step.selector ?? '').slice(0, 44).padEnd(45)}${value}`,
    );
  }
  if (plan.blockers.length > 0) {
    console.log('\ncannot run:');
    for (const b of plan.blockers) console.log(`  ${b.node}: ${b.why}`);
  }
  process.exit(plan.runnable ? 0 : 1);
}

const reasons = new Map();
const chunks = new Set();
let runnable = 0;
let steps = 0;
let editable = 0;

for (const id of ix.nodes.keys()) {
  const plan = buildPlan(ix, id, { run: '0000' });
  if (plan.runnable) {
    runnable += 1;
    chunks.add(plan.chunk);
    steps += plan.steps.length;
    if (editableFields(plan).length > 0) editable += 1;
    continue;
  }
  for (const b of plan.blockers) {
    // Collapse the specifics — "control \"file\"" and "control \"chips\"" are
    // one reason with two instances, and the count is what is being asked for.
    const why = b.why.replace(/"[^"]*"/g, '…').replace(/\s+—.*/, '').trim();
    reasons.set(why, (reasons.get(why) ?? 0) + 1);
  }
}

const total = ix.nodes.size;
console.log(`${runnable} of ${total} points on the map can be run`);
console.log(`${chunks.size} of ${ix.chunks.size} chunks have at least one`);
console.log(`${(steps / runnable).toFixed(1)} steps in an average plan · ${editable} plans take a value you can edit\n`);
console.log('why the rest cannot:');
for (const [why, n] of [...reasons].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${String(n).padStart(5)}  ${why}`);
}

#!/usr/bin/env node
/**
 * Run the flow-run function locally, against a simulated CodeBuild.
 *
 * Wraps the REAL index.mjs rather than reimplementing it, so the plans the
 * dialog shows here are resolved by the same resolver production uses, and the
 * validation it meets — node ids, env check, value checks, body limits, the
 * one-at-a-time rule — is the same code. Only the AWS calls are faked, by
 * patching each SDK client's send() before the handler imports it.
 *
 *   npm i --no-save @aws-sdk/client-codebuild @aws-sdk/client-s3 \
 *                   @aws-sdk/client-cloudwatch-logs                # once
 *   node infra/flow-run-fn/local-server.mjs
 *
 * Then point the SPA at it, in public/config.json (gitignored):
 *
 *   { "runFlowUrl": "http://localhost:8788/api/run-flow" }
 *
 * The fake build walks the real phase sequence over ~20s so the dialog's
 * polling, phase labels and completion state can all be seen without spending
 * CodeBuild minutes or writing to staging. `--fail` makes it end FAILED instead.
 */

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = Number(process.env.PORT || 8788);
const PROJECT = 'qa-flow-runner';
const FAIL = process.argv.includes('--fail');

// --real stops simulating and runs the plan in a browser, here, with the same
// run_plan.py the CodeBuild image uses. The fake build is for working on the
// dialog; this is for finding out whether a selector or a value is right,
// which no amount of simulated phases will ever tell you.
const REAL = process.argv.includes('--real');
// Visible by default in --real: watching the step go wrong is the whole point.
const HEADLESS = process.argv.includes('--headless');
const PY = process.env.FLOW_PY || '../playwright-automation/.venv/bin/python';
const REPO = process.env.FLOW_REPO || '../playwright-automation';
const ENV = process.env.FLOW_ENV || 'staging';

// ---------------------------------------------------------------- fake AWS --

/** Phases in the order CodeBuild really reports them, with how long each lasts. */
const SCRIPT = [
  ['QUEUED', 1500],
  ['PROVISIONING', 3000],
  ['PRE_BUILD', 4000],
  ['BUILD', 8000],
  ['POST_BUILD', 3000],
  ['COMPLETED', 0],
];

const builds = new Map();

function phaseAt(build) {
  // A real run is as long as it is: the phase follows the child process.
  if (build.child) {
    if (build.exitCode === null) return build.lines.length ? 'BUILD' : 'PROVISIONING';
    return 'COMPLETED';
  }
  let elapsed = Date.now() - build.startedAt;
  for (const [name, ms] of SCRIPT) {
    if (elapsed < ms || ms === 0) return name;
    elapsed -= ms;
  }
  return 'COMPLETED';
}

function snapshot(id) {
  const build = builds.get(id);
  if (!build) return null;
  const phase = phaseAt(build);
  const done = phase === 'COMPLETED';
  return {
    id,
    currentPhase: phase,
    buildStatus: done
      ? (build.child ? (build.exitCode === 0 ? 'SUCCEEDED' : 'FAILED') : (FAIL ? 'FAILED' : 'SUCCEEDED'))
      : 'IN_PROGRESS',
    // groupName and streamName as well as the link: the handler tails the log
    // through them, and a fake build without them silently returns no output —
    // which looks exactly like a build that printed nothing.
    logs: {
      deepLink: `http://localhost:${PORT}/fake-logs/${encodeURIComponent(id)}`,
      groupName: `/aws/codebuild/${PROJECT}`,
      streamName: id.split(':')[1],
    },
    exportedEnvironmentVariables: done
      ? [{ name: 'RUN_PREFIX', value: `runs/flow-run/20261028T120000Z-${build.number}` }]
      : [],
  };
}

let sdk;
let s3sdk;
let logsSdk;
try {
  sdk = await import('@aws-sdk/client-codebuild');
  s3sdk = await import('@aws-sdk/client-s3');
  logsSdk = await import('@aws-sdk/client-cloudwatch-logs');
} catch {
  console.error(
    'error: the AWS SDK clients are not installed.\n'
    + '       npm i --no-save @aws-sdk/client-codebuild @aws-sdk/client-s3'
    + ' @aws-sdk/client-cloudwatch-logs',
  );
  process.exit(1);
}

/** The plan the function hands over. Kept so the fake log can narrate it. */
let lastPlan = null;

s3sdk.S3Client.prototype.send = async function send(command) {
  if (command.constructor.name === 'PutObjectCommand') {
    lastPlan = JSON.parse(command.input.Body);
    console.log(`plan   ${command.input.Key}  (${lastPlan.steps.length} steps)`);
    return {};
  }
  throw new Error(`local-server does not simulate ${command.constructor.name}`);
};

/**
 * Run the plan the handler just "uploaded", in a browser on this machine.
 *
 * The plan goes to a temp file because that is all run_plan.py wants — the
 * Lambda's S3 round trip exists for size, not for ceremony, and the bytes are
 * identical either way.
 */
function startRunner(build) {
  build.lines = [];
  build.exitCode = null;
  const planPath = join(mkdtempSync(join(tmpdir(), 'flow-plan-')), 'plan.json');
  writeFileSync(planPath, JSON.stringify(lastPlan));

  const args = [
    'infra/flow-runner/run_plan.py',
    '--plan', planPath,
    '--repo', REPO,
    '--env', ENV,
    '--headless', HEADLESS ? 'true' : 'false',
  ];
  console.log(`run    ${PY} ${args.join(' ')}`);
  const child = spawn(PY, args, { cwd: process.cwd() });
  build.child = child;

  const take = (buf) => {
    for (const line of String(buf).split('\n')) {
      if (!line.trim()) continue;
      build.lines.push(line);
      console.log(`     | ${line}`);
    }
  };
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  child.on('error', (err) => {
    build.lines.push(`could not start ${PY}: ${err.message}`,
      'set FLOW_PY to the python that has playwright installed.');
    build.exitCode = 127;
  });
  child.on('close', (code) => {
    build.exitCode = code ?? 1;
    build.lines.push('', `runner exited ${code}`);
  });
}

let counter = 0;
// The handler builds its client at module scope, so this has to be in place
// before the import below — hence the patch on the prototype rather than on an
// instance.
sdk.CodeBuildClient.prototype.send = async function send(command) {
  const name = command.constructor.name;

  if (name === 'StartBuildCommand') {
    const id = `${PROJECT}:${crypto.randomUUID()}`;
    const build = { startedAt: Date.now(), number: ++counter };
    builds.set(id, build);
    if (REAL) startRunner(build);
    console.log(
      `start  ${id}\n`
      + `       ${command.input.environmentVariablesOverride.map((v) => `${v.name}=${v.value}`).join(' ')}`,
    );
    return { build: snapshot(id) };
  }

  if (name === 'ListBuildsForProjectCommand') {
    return { ids: [...builds.keys()].reverse() };
  }

  if (name === 'BatchGetBuildsCommand') {
    return { builds: command.input.ids.map(snapshot).filter(Boolean) };
  }

  throw new Error(`local-server does not simulate ${name}`);
};

/**
 * The log, narrated from the plan at the pace the fake build runs.
 *
 * Not decoration: the dialog's log panel is the part hardest to get right —
 * following the tail, releasing it when you scroll, colouring the ✓ and ✗ — and
 * none of that can be seen against a build that prints nothing.
 */
logsSdk.CloudWatchLogsClient.prototype.send = async function send(command) {
  if (command.constructor.name !== 'GetLogEventsCommand') {
    throw new Error(`local-server does not simulate ${command.constructor.name}`);
  }
  if (!lastPlan) return { events: [], nextForwardToken: 'f/0' };

  const live = [...builds.values()].pop();
  if (live?.child) {
    const at = Number(String(command.input.nextToken ?? 'f/0').slice(2));
    const next = live.lines.slice(at);
    return {
      events: next.map((message) => ({ message })),
      nextForwardToken: `f/${at + next.length}`,
    };
  }

  const build = live;
  const elapsed = build ? Date.now() - build.startedAt : 0;
  // Start printing once the fake build reaches BUILD, then one step per 400ms.
  const reached = Math.max(0, Math.floor((elapsed - 8500) / 400));

  const lines = [
    `flow: ${lastPlan.chunkName} — ${lastPlan.targetName}`,
    `target ${lastPlan.target} · ${lastPlan.steps.length} steps · staging`,
    `chunks: ${lastPlan.chunks.join(' -> ')}`,
    '',
    ...lastPlan.steps.slice(0, reached).map((step, i) =>
      `${String(i + 1).padStart(2)}/${lastPlan.steps.length}  ${step.verb.padEnd(13)} ${step.name}`
      + `  ${FAIL && i === lastPlan.steps.length - 1 ? '✗  never became visible' : '✓'}`),
  ];
  if (reached >= lastPlan.steps.length) {
    const passed = FAIL ? lastPlan.steps.length - 1 : lastPlan.steps.length;
    lines.push('', `${passed}/${lastPlan.steps.length} steps passed in 12.0s — ${FAIL ? 'failed' : 'passed'}`);
  }

  const from = Number(String(command.input.nextToken ?? 'f/0').slice(2));
  const fresh = lines.slice(from);
  return {
    events: fresh.map((message) => ({ message })),
    nextForwardToken: `f/${from + fresh.length}`,
  };
};

// ---------------------------------------------------------------- the app --

process.env.PROJECT_NAME ??= PROJECT;
process.env.DASHBOARD_BUCKET ??= 'local-bucket';
process.env.PLAN_BUCKET ??= 'local-plans';
process.env.ALLOWED_ORIGIN ??= 'http://localhost:5173';
// No copy of the flow map is made here. There used to be one, written beside
// index.mjs only `if (!existsSync(...))` — so the first run took a snapshot of
// public/qa-flow/cargomatic.json and every run after it resolved plans from
// that snapshot, however far the real map had moved on. Editing the map and
// watching the runner do the old thing anyway is the symptom; a gitignored
// file nobody remembers writing is the cause. The handler now reads the
// repo's map directly when no deployed copy is beside it, so there is nothing
// left to go stale.
{
  const { existsSync, rmSync } = await import('node:fs');
  const snapshot = new URL('./cargomatic.json', import.meta.url);
  if (existsSync(snapshot)) {
    rmSync(snapshot);
    console.log('removed a stale cargomatic.json snapshot beside index.mjs');
  }
}

const { handler } = await import('./index.mjs');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (c) => chunks.push(c));
  req.on('end', async () => {
    const url = new URL(req.url, `http://localhost:${PORT}`);
    const event = {
      headers: req.headers,
      requestContext: { http: { method: req.method } },
      queryStringParameters: Object.fromEntries(url.searchParams),
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false,
    };

    try {
      const result = await handler(event);
      res.writeHead(result.statusCode, result.headers ?? {});
      res.end(result.body ?? '');
      if (req.method !== 'GET') console.log(`${req.method} ${url.pathname} -> ${result.statusCode}`);
    } catch (err) {
      console.error(err);
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err?.message ?? err) }));
    }
  });
}).listen(PORT, () => {
  console.log(
    REAL
      ? `flow-run function on http://localhost:${PORT}  (REAL runs)\n`
        + `  ${PY} · repo ${REPO} · env ${ENV} · ${HEADLESS ? 'headless' : 'visible browser'}\n`
        + `  a run drives a browser on this machine and writes to ${ENV}`
      : `flow-run function on http://localhost:${PORT}  (simulated CodeBuild`
        + `${FAIL ? ', builds FAIL' : ''})\n`
        + `  plans resolved from the real flow map · a run takes ~20s · NO browser starts\n`
        + `  pass --real to actually run the plan in a browser`,
  );
});

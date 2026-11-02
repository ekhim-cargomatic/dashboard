#!/usr/bin/env node
/**
 * Run the flow-run function locally, against a simulated CodeBuild.
 *
 * Wraps the REAL index.mjs rather than reimplementing it, so the validation the
 * dialog meets here — tag allowlist, env check, body limits, the one-at-a-time
 * rule — is the same code that will meet it in production. Only the AWS calls
 * are faked, by patching the SDK client's send() before the handler imports it.
 *
 *   npm i --no-save @aws-sdk/client-codebuild   # once
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

const PORT = Number(process.env.PORT || 8788);
const PROJECT = 'qa-flow-runner';
const FAIL = process.argv.includes('--fail');

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
    buildStatus: done ? (FAIL ? 'FAILED' : 'SUCCEEDED') : 'IN_PROGRESS',
    logs: { deepLink: `http://localhost:${PORT}/fake-logs/${encodeURIComponent(id)}` },
    exportedEnvironmentVariables: done
      ? [{ name: 'RUN_PREFIX', value: `runs/flow-run/20261028T120000Z-${build.number}` }]
      : [],
  };
}

let sdk;
try {
  sdk = await import('@aws-sdk/client-codebuild');
} catch {
  console.error(
    'error: @aws-sdk/client-codebuild is not installed.\n'
    + '       npm i --no-save @aws-sdk/client-codebuild',
  );
  process.exit(1);
}

let counter = 0;
// The handler builds its client at module scope, so this has to be in place
// before the import below — hence the patch on the prototype rather than on an
// instance.
sdk.CodeBuildClient.prototype.send = async function send(command) {
  const name = command.constructor.name;

  if (name === 'StartBuildCommand') {
    const id = `${PROJECT}:${crypto.randomUUID()}`;
    builds.set(id, { startedAt: Date.now(), number: ++counter });
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

// ---------------------------------------------------------------- the app --

process.env.PROJECT_NAME ??= PROJECT;
process.env.DASHBOARD_BUCKET ??= 'local-bucket';
process.env.ALLOWED_ORIGIN ??= 'http://localhost:5173';
// The real allowlist, so a tag the deployed function would reject is rejected
// here too. Falls back to the flow map's tags if the generated file is absent.
if (!process.env.ALLOWED_TAGS) {
  const { readFileSync } = await import('node:fs');
  try {
    const tags = JSON.parse(readFileSync('ci/flow-tags.generated.json', 'utf8')).tags;
    const domains = JSON.parse(readFileSync('ci/domains.generated.json', 'utf8'));
    const flow = JSON.parse(readFileSync('public/qa-flow/cargomatic.json', 'utf8'));
    const generic = new Set([...(domains.scopes ?? []), ...(domains.layers ?? [])]);
    const out = new Set();
    for (const chunk of flow.chunks ?? []) {
      for (const raw of chunk.tags ?? []) {
        const bare = raw.replace(/^@/, '');
        if (generic.has(bare.toLowerCase()) || bare.startsWith('auth.')) continue;
        if (tags[bare.toLowerCase()]) out.add(bare);
      }
    }
    process.env.ALLOWED_TAGS = [...out].sort().join(',');
  } catch {
    console.error('warning: could not build the tag allowlist — run `npm run gen:flow-tags`');
    process.env.ALLOWED_TAGS = '';
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
  const count = process.env.ALLOWED_TAGS.split(',').filter(Boolean).length;
  console.log(
    `flow-run function on http://localhost:${PORT}  (simulated CodeBuild`
    + `${FAIL ? ', builds FAIL' : ''})\n`
    + `  ${count} tags allowed · a run takes ~20s · origin ${process.env.ALLOWED_ORIGIN}\n`
    + `  point public/config.json at: "runFlowUrl": "http://localhost:${PORT}/api/run-flow"`,
  );
});

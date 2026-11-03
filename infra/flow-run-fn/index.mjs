/**
 * Start one flow chunk's test run, and report on it.
 *
 * The dashboard is a static SPA with no AWS credentials, so it cannot call
 * CodeBuild itself. This function is the only thing that can — and it is
 * deliberately only able to do one thing.
 *
 * Reached same-origin through the dashboard's own CloudFront distribution at
 * /api/run-flow (see infra/deploy-flow-fn.sh). Requests:
 *
 *   GET  /api/run-flow?plan=<node id>
 *   -> { steps, blockers, fields, runnable }   the plan, for the dialog to show
 *
 *   POST /api/run-flow
 *   { "target": "us.admin.modal.submit", "env": "staging", "values": {...} }
 *   -> { buildId, phase, status, logsUrl }
 *
 *   GET  /api/run-flow?build=<id>&since=<token>
 *   -> { buildId, phase, status, runPrefix?, logsUrl, lines, logToken }
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *
 * This route is UNAUTHENTICATED and will stay that way: a static page has no
 * credential to sign with, and DASHBOARD_TOKEN ships in a world-readable
 * config.json, so it is a speed bump and nothing more. The real control is that
 * this handler can only ever do one narrow thing:
 *
 *   - the CodeBuild project name comes from the environment, never the caller
 *   - the caller names a *node on the map* and nothing else. The plan — every
 *     selector, every gesture, every page — is resolved here, from the copy of
 *     the map deployed beside this file. A selector never crosses the wire, so
 *     the endpoint cannot be asked to drive the browser somewhere the map does
 *     not already describe
 *   - field values are the one caller-supplied thing, and they are checked:
 *     bounded length, no control characters, and never applied to a credential
 *   - the environment must be staging or dev; prod is not reachable from here
 *   - one build at a time, which caps spend and stops two runs colliding on the
 *     same staging data
 *
 * Worst case if the URL leaks: someone runs tagged staging tests you did not
 * ask for, serially, from a fixed list.
 *
 * Environment:
 *   PROJECT_NAME     (required) the CodeBuild project to start
 *   PLAN_BUCKET      (required) private bucket the resolved plan is handed over in
 *   DASHBOARD_BUCKET (required) passed through to the build for the upload
 *   ALLOWED_ORIGIN   (required) exact origin allowed to call this
 *   DASHBOARD_TOKEN  (optional) if set, callers must send x-dashboard-token
 *   AWS_REGION       (provided by Lambda) used to build the console log link
 */

import { readFileSync } from 'node:fs';
import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { buildPlan, cleanValues, editableFields, indexFlow } from './plan.mjs';
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const client = new CodeBuildClient({});
const logs = new CloudWatchLogsClient({});
const s3 = new S3Client({});

/**
 * The flow map, deployed inside this function.
 *
 * It is the allowlist. A caller names a node, and a node only exists if the map
 * says so — which is a better bound than a list of tags, because it is
 * regenerated from the same file the dashboard draws and cannot drift from it.
 */
const flow = JSON.parse(readFileSync(new URL('./cargomatic.json', import.meta.url), 'utf8'));
const ix = indexFlow(flow);

/** Log lines returned per poll. A behave run prints a few hundred; this keeps
 *  one slow poll from returning a megabyte. */
const LOG_LIMIT = 600;

/**
 * Best-effort scrub of anything credential-shaped before it leaves AWS.
 *
 * The build log is returned through a public endpoint, and a failing scenario
 * can print an API response or a request header. This will not catch a secret
 * that looks like ordinary text, so it is a reduction in exposure rather than a
 * guarantee — the real control is that the runner only ever touches staging.
 */
const SECRETS = [
  [/((?:password|passwd|pwd|secret|token|api[-_]?key|authorization)["'\s]*[=:]\s*)(\S+)/gi, '$1[redacted]'],
  [/(Bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, '$1[redacted]'],
  [/\beyJ[A-Za-z0-9._-]{20,}/g, '[redacted jwt]'],
];

const redact = (line) => SECRETS.reduce((acc, [re, to]) => acc.replace(re, to), line);

/**
 * CodeBuild's agent narrates every phase into the same stream. The dialog
 * already shows the phase, so that chatter just pushes the scenario results out
 * of view — and it is what lands last, so a finished run would end on
 * "Assembling file list" instead of "2 scenarios passed". Dropped, except where
 * it is reporting a failure, which is the one time it says something the phase
 * label does not.
 */
const isAgentNoise = (line) =>
  /^\[Container\]/.test(line) && !/\b(FAILED|FAULT|TIMED_OUT|ERROR)\b/.test(line);

/** Environments the runner may target. Production is absent on purpose. */
const ENVS = new Set(['staging', 'dev']);

/** Refuse oversized bodies rather than parsing them. */
const MAX_BODY_BYTES = 8 * 1024;

/** A flow node id is a dotted slug; anything else did not come from the map. */
const NODE_ID = /^[A-Za-z0-9]+(?:[.\-][A-Za-z0-9]+)*$/;

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-dashboard-token',
});

const reply = (statusCode, body, origin) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  body: JSON.stringify(body),
});

const logsUrlFor = (build) =>
  build?.logs?.deepLink
  || (build?.id
    ? `https://${process.env.AWS_REGION}.console.aws.amazon.com/codesuite/codebuild/projects/`
      + `${encodeURIComponent(process.env.PROJECT_NAME)}/build/${encodeURIComponent(build.id)}`
    : '');

/** The shape the dashboard polls for. */
function describe(build) {
  const exported = build.exportedEnvironmentVariables ?? [];
  const prefix = exported.find((v) => v.name === 'RUN_PREFIX')?.value;
  return {
    buildId: build.id,
    phase: build.currentPhase ?? 'COMPLETED',
    status: build.buildStatus ?? 'IN_PROGRESS',
    ...(prefix ? { runPrefix: prefix } : {}),
    logsUrl: logsUrlFor(build),
  };
}

/**
 * Is a build already running?
 *
 * Doubles as the rate limiter and as the guard against two runs fighting over
 * the same staging records — which is the failure mode that would waste the
 * most time, because it looks like a product bug.
 */
async function runningBuild(project) {
  const { ids = [] } = await client.send(
    new ListBuildsForProjectCommand({ projectName: project, sortOrder: 'DESCENDING' }),
  );
  if (ids.length === 0) return null;

  // Only the most recent few can plausibly still be running.
  const { builds = [] } = await client.send(
    new BatchGetBuildsCommand({ ids: ids.slice(0, 5) }),
  );
  return builds.find((b) => b.buildStatus === 'IN_PROGRESS') ?? null;
}

async function start(event, origin) {
  const project = process.env.PROJECT_NAME;
  const bucket = process.env.DASHBOARD_BUCKET;
  const planBucket = process.env.PLAN_BUCKET;
  if (!project || !bucket || !planBucket) {
    return reply(500, { error: 'Runner is not configured.' }, origin);
  }

  const raw = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { error: 'Request too large.' }, origin);
  }

  let body;
  try {
    body = JSON.parse(raw || '{}');
  } catch {
    return reply(400, { error: 'Body is not valid JSON.' }, origin);
  }

  const target = String(body.target ?? '').trim();
  const env = String(body.env ?? 'staging').trim();

  if (!NODE_ID.test(target) || target.length > 80) {
    return reply(400, { error: 'target is not a flow node id.' }, origin);
  }
  if (!ENVS.has(env)) {
    return reply(400, { error: `env must be one of ${[...ENVS].join(', ')}.` }, origin);
  }

  const { values, rejected } = cleanValues(body.values);
  if (rejected.length > 0) {
    return reply(400, { error: `These values are not usable: ${rejected.join(', ')}.` }, origin);
  }

  // Resolved here, never taken from the caller. A plan the resolver refuses to
  // build is one the runner must not be handed.
  const run = String(Date.now()).slice(-4);
  const plan = buildPlan(ix, target, { run, values });
  if (plan.error) return reply(404, { error: plan.error }, origin);
  if (!plan.runnable) {
    return reply(409, { error: 'This step cannot be run yet.', blockers: plan.blockers }, origin);
  }

  const inFlight = await runningBuild(project);
  if (inFlight) {
    return reply(409, {
      error: 'A run is already in progress. Only one runs at a time, so they cannot collide on staging data.',
      ...describe(inFlight),
    }, origin);
  }

  // The plan travels through S3 rather than an environment variable: a long one
  // is tens of kilobytes, and a build's environment is the wrong place to find
  // out there is a size limit.
  const key = `plans/${Date.now()}-${target}.json`;
  await s3.send(new PutObjectCommand({
    Bucket: planBucket,
    Key: key,
    Body: JSON.stringify(plan),
    ContentType: 'application/json',
  }));

  const { build } = await client.send(new StartBuildCommand({
    projectName: project,
    environmentVariablesOverride: [
      { name: 'FLOW_PLAN_BUCKET', value: planBucket, type: 'PLAINTEXT' },
      { name: 'FLOW_PLAN_KEY', value: key, type: 'PLAINTEXT' },
      { name: 'FLOW_ENV', value: env, type: 'PLAINTEXT' },
      { name: 'FLOW_TARGET', value: target, type: 'PLAINTEXT' },
      { name: 'FLOW_CHUNK', value: plan.chunk, type: 'PLAINTEXT' },
      { name: 'DASHBOARD_BUCKET', value: bucket, type: 'PLAINTEXT' },
    ],
  }));

  return reply(202, { ...describe(build), steps: plan.steps.length }, origin);
}

/**
 * The plan for a node, without running it.
 *
 * The dialog shows this before anything happens: which steps, in which order,
 * with which values — and, when it cannot run, exactly what is missing. It is
 * resolved by the same call the run uses, so the preview cannot disagree with
 * what the browser will do.
 */
function preview(event, origin) {
  const target = String(event.queryStringParameters?.plan ?? '').trim();
  if (!NODE_ID.test(target) || target.length > 80) {
    return reply(400, { error: 'plan must be a flow node id.' }, origin);
  }
  const plan = buildPlan(ix, target, { run: '0000' });
  if (plan.error) return reply(404, { error: plan.error }, origin);
  return reply(200, {
    target: plan.target,
    targetName: plan.targetName,
    chunk: plan.chunk,
    chunkName: plan.chunkName,
    chunks: plan.chunks,
    portal: plan.portal,
    runnable: plan.runnable,
    blockers: plan.blockers,
    fields: editableFields(plan),
    steps: plan.steps.map((s) => ({
      verb: s.verb, name: s.name, node: s.node, chunk: s.chunk, why: s.why,
      ...(s.path ? { path: s.path } : {}),
      ...(s.value !== undefined ? { value: s.value, secret: Boolean(s.secret) } : {}),
      ...(s.await ? { await: s.await } : {}),
      ...(s.destructive ? { destructive: true } : {}),
    })),
  }, origin);
}

/**
 * The build's own output, tailed forward from wherever the caller left off.
 *
 * CloudWatch's nextForwardToken is the cursor: handing back the one we were
 * given returns only what has arrived since, so a dialog polling every few
 * seconds reads the log once rather than re-reading it from the top.
 */
async function tail(build, token) {
  const group = build.logs?.groupName;
  const stream = build.logs?.streamName;
  if (!group || !stream) return { lines: [], logToken: token };

  try {
    const page = await logs.send(new GetLogEventsCommand({
      logGroupName: group,
      logStreamName: stream,
      startFromHead: true,
      limit: LOG_LIMIT,
      ...(token ? { nextToken: token } : {}),
    }));

    return {
      // CodeBuild emits one event per line, usually with the newline still on.
      lines: (page.events ?? [])
        .map((e) => redact(String(e.message ?? '').replace(/\s+$/, '')))
        .filter((line) => !isAgentNoise(line)),
      logToken: page.nextForwardToken ?? token,
    };
  } catch (err) {
    // A stream that does not exist yet is the normal state for the first few
    // seconds of a build; it is not worth failing the poll over.
    if (err?.name === 'ResourceNotFoundException') return { lines: [], logToken: token };
    throw err;
  }
}

async function status(event, origin) {
  const project = process.env.PROJECT_NAME;
  const id = event.queryStringParameters?.build ?? '';
  const token = event.queryStringParameters?.since || '';

  // A build id is `<project>:<uuid>`. Checking the project prefix keeps this
  // from reporting on builds that are none of the dashboard's business.
  if (!id || !id.startsWith(`${project}:`)) {
    return reply(400, { error: 'Unknown build.' }, origin);
  }

  const { builds = [] } = await client.send(new BatchGetBuildsCommand({ ids: [id] }));
  if (builds.length === 0) return reply(404, { error: 'No such build.' }, origin);

  const build = builds[0];
  return reply(200, { ...describe(build), ...(await tail(build, token)) }, origin);
}

export const handler = async (event) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const requestOrigin = event.headers?.origin || event.headers?.Origin || '';
  const method = event.requestContext?.http?.method || 'POST';

  // Only ever echo an origin we actually allow, so the browser refuses anything else.
  const echoOrigin = requestOrigin && requestOrigin === allowedOrigin ? requestOrigin : allowedOrigin;

  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(echoOrigin), body: '' };
  if (allowedOrigin && requestOrigin && requestOrigin !== allowedOrigin) {
    return reply(403, { error: 'Origin not allowed' }, echoOrigin);
  }

  const sharedToken = process.env.DASHBOARD_TOKEN;
  if (sharedToken) {
    const sent = event.headers?.['x-dashboard-token'] || event.headers?.['X-Dashboard-Token'];
    if (sent !== sharedToken) return reply(401, { error: 'Bad or missing dashboard token.' }, echoOrigin);
  }

  try {
      if (method === 'GET') {
      return event.queryStringParameters?.plan
        ? preview(event, echoOrigin)
        : await status(event, echoOrigin);
    }
    if (method === 'POST') return await start(event, echoOrigin);
    return reply(405, { error: 'Method not allowed' }, echoOrigin);
  } catch (err) {
    // Surface the AWS error name but not its full text — it can carry account
    // detail, and this response is world-readable.
    console.error(err);
    return reply(502, { error: `Runner error (${err?.name ?? 'unknown'}).` }, echoOrigin);
  }
};

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
 *   POST /api/run-flow
 *   { "chunkId": "order.create", "selector": "@orderBooking", "env": "staging" }
 *   -> { buildId, phase, status, logsUrl }
 *
 *   GET /api/run-flow?build=<id>
 *   -> { buildId, phase, status, runPrefix?, logsUrl }
 *
 * ── Security ────────────────────────────────────────────────────────────────
 *
 * This route is UNAUTHENTICATED and will stay that way: a static page has no
 * credential to sign with, and DASHBOARD_TOKEN ships in a world-readable
 * config.json, so it is a speed bump and nothing more. The real control is that
 * this handler can only ever do one narrow thing:
 *
 *   - the CodeBuild project name comes from the environment, never the caller
 *   - the selector must be a single tag from ALLOWED_TAGS, baked in at deploy
 *     time from the flow map — so no arbitrary behave expression can be run
 *   - the environment must be staging or dev; prod is not reachable from here
 *   - one build at a time, which caps spend and stops two runs colliding on the
 *     same staging data
 *
 * Worst case if the URL leaks: someone runs tagged staging tests you did not
 * ask for, serially, from a fixed list.
 *
 * Environment:
 *   PROJECT_NAME     (required) the CodeBuild project to start
 *   ALLOWED_TAGS     (required) comma-separated behave tags this may run
 *   DASHBOARD_BUCKET (required) passed through to the build for the upload
 *   ALLOWED_ORIGIN   (required) exact origin allowed to call this
 *   DASHBOARD_TOKEN  (optional) if set, callers must send x-dashboard-token
 *   AWS_REGION       (provided by Lambda) used to build the console log link
 */

import {
  BatchGetBuildsCommand,
  CodeBuildClient,
  ListBuildsForProjectCommand,
  StartBuildCommand,
} from '@aws-sdk/client-codebuild';
import {
  CloudWatchLogsClient,
  GetLogEventsCommand,
} from '@aws-sdk/client-cloudwatch-logs';

const client = new CodeBuildClient({});
const logs = new CloudWatchLogsClient({});

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

/** A chunk id is a dotted slug — anything else is not from the flow map. */
const CHUNK_ID = /^[a-z0-9]+(?:[.\-][a-z0-9]+)*$/i;

/** A selector is exactly one tag. Commas, spaces and `~` are all rejected. */
const SELECTOR = /^@[A-Za-z0-9_.\-]+$/;

const allowedTags = () =>
  new Set(
    String(process.env.ALLOWED_TAGS || '')
      .split(',')
      .map((t) => t.trim().toLowerCase())
      .filter(Boolean),
  );

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
  if (!project || !bucket) return reply(500, { error: 'Runner is not configured.' }, origin);

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

  const chunkId = String(body.chunkId ?? '').trim();
  const selector = String(body.selector ?? '').trim();
  const env = String(body.env ?? 'staging').trim();

  if (!CHUNK_ID.test(chunkId) || chunkId.length > 64) {
    return reply(400, { error: 'chunkId is not a flow chunk id.' }, origin);
  }
  if (!SELECTOR.test(selector)) {
    return reply(400, { error: 'selector must be a single tag, e.g. "@orderBooking".' }, origin);
  }
  if (!allowedTags().has(selector.slice(1).toLowerCase())) {
    return reply(403, { error: `${selector} is not a tag this runner will run.` }, origin);
  }
  if (!ENVS.has(env)) {
    return reply(400, { error: `env must be one of ${[...ENVS].join(', ')}.` }, origin);
  }

  const inFlight = await runningBuild(project);
  if (inFlight) {
    return reply(409, {
      error: 'A run is already in progress. Only one runs at a time, so they cannot collide on staging data.',
      ...describe(inFlight),
    }, origin);
  }

  const { build } = await client.send(new StartBuildCommand({
    projectName: project,
    environmentVariablesOverride: [
      { name: 'FLOW_TAGS', value: selector, type: 'PLAINTEXT' },
      { name: 'FLOW_ENV', value: env, type: 'PLAINTEXT' },
      { name: 'FLOW_CHUNK', value: chunkId, type: 'PLAINTEXT' },
      { name: 'DASHBOARD_BUCKET', value: bucket, type: 'PLAINTEXT' },
    ],
  }));

  return reply(202, describe(build), origin);
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
    if (method === 'GET') return await status(event, echoOrigin);
    if (method === 'POST') return await start(event, echoOrigin);
    return reply(405, { error: 'Method not allowed' }, echoOrigin);
  } catch (err) {
    // Surface the AWS error name but not its full text — it can carry account
    // detail, and this response is world-readable.
    console.error(err);
    return reply(502, { error: `Runner error (${err?.name ?? 'unknown'}).` }, echoOrigin);
  }
};

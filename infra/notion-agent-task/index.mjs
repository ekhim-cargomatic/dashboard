/**
 * Create an "Agent Development" task in Notion from one failing test.
 *
 * The dashboard is a static SPA, so it cannot call api.notion.com itself: Notion
 * sends no CORS headers, and the integration token would ship inside a publicly
 * readable bundle. This function is the only place the token lives.
 *
 * Invoked via a Lambda Function URL. Request:
 *
 *   POST /
 *   { "prompt":  "<what the user typed>",
 *     "repo":    "playwright-automation" | "appium-automation" | ...,
 *     "failure": { name, fullName, suite, domain, status, message, tags[] },
 *     "run":     { runKey, workflow, runNumber, environment, branch, commit,
 *                  ciUrl, reportUrl } }
 *
 * Response: { "url": "https://www.notion.so/...", "id": "<page id>" }
 *
 * Environment:
 *   NOTION_TOKEN        (required) internal integration secret, shared with Tasks
 *   NOTION_TASKS_DB_ID  (required) Tasks database id
 *   ALLOWED_ORIGIN      (required) exact origin allowed to call this, e.g.
 *                       https://d34o4mvhjdaxkf.cloudfront.net
 *   DASHBOARD_TOKEN     (optional) if set, callers must send it as
 *                       x-dashboard-token. See the security note in the README:
 *                       this deters drive-by use, it is NOT authentication.
 *   NOTION_ASSIGNEE_ID  (optional) Notion user id to put in Assignee
 *   NOTION_VERSION      (optional) API version, default 2022-06-28
 */

const NOTION_API = 'https://api.notion.com/v1/pages';
const NOTION_VERSION = process.env.NOTION_VERSION || '2022-06-28';

/** Notion rejects any rich_text item longer than this. */
const RICH_TEXT_LIMIT = 2000;
/** Titles become PR titles verbatim, so keep them short (per the template). */
const TITLE_LIMIT = 80;
/** Refuse oversized bodies rather than passing them to Notion. */
const MAX_BODY_BYTES = 128 * 1024;

const REPOS = new Set([
  'lorax',
  'dbt-analytics',
  'admin-client-legacy',
  'monolith',
  'documents-service',
  'pricing-engine',
  'unified-view',
  'playwright-automation',
  'appium-automation',
  'perfmatic',
  'monopoly',
]);

const truncate = (value, max) => {
  const text = String(value ?? '');
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
};

/**
 * The feature file the scenario lives in.
 *
 * ci/qa-summary.mjs builds `suite` as a slash-joined feature-file path with the
 * leading "features" element and the feature title stripped — "admin/booking_details"
 * — so the file is that path plus the extension. Returns '' when there is no
 * usable path (allure-behave reports "(root)" for features at the top level).
 */
function featureFile(failure) {
  const suite = String(failure.suite ?? '').trim();
  if (!suite || suite === '(root)') return '';
  return `features/${suite}.feature`;
}

/**
 * `[repo][fix] scenario` — the prefix is fixed width and always survives, so a
 * long scenario name loses its tail rather than the tag that makes the ticket
 * scannable in a list.
 */
function buildTitle(failure, repo) {
  const prefix = repo ? `[${repo}][fix] ` : '[fix] ';
  const subject = failure.name || featureFile(failure) || failure.fullName || 'failing test';
  return `${prefix}${truncate(subject, Math.max(20, TITLE_LIMIT - prefix.length))}`;
}

/**
 * One rich_text array, split so no single item exceeds Notion's limit.
 * A block still caps at 100 items, which at 2000 chars each is far more than
 * any failure message we would want to paste.
 */
function richText(value) {
  const text = String(value ?? '');
  if (!text) return [];
  const chunks = [];
  for (let i = 0; i < text.length && chunks.length < 100; i += RICH_TEXT_LIMIT) {
    chunks.push({ type: 'text', text: { content: text.slice(i, i + RICH_TEXT_LIMIT) } });
  }
  return chunks;
}

const heading = (text) => ({
  object: 'block',
  type: 'heading_2',
  heading_2: { rich_text: richText(text) },
});

const paragraph = (text) => ({
  object: 'block',
  type: 'paragraph',
  paragraph: { rich_text: richText(text) },
});

const bullet = (text) => ({
  object: 'block',
  type: 'bulleted_list_item',
  bulleted_list_item: { rich_text: richText(text) },
});

const code = (text, language = 'plain text') => ({
  object: 'block',
  type: 'code',
  code: { rich_text: richText(text || '—'), language },
});

/**
 * Page body, following the shape of the "Agent Development" page template so a
 * ticket opened from here reads the same as one written by hand.
 */
function buildBlocks({ prompt, failure, run, repo }) {
  const blocks = [];

  blocks.push(heading('Intent'));
  blocks.push(
    paragraph(
      prompt?.trim() ||
        `Investigate and fix the failing automated test \`${failure.name}\`, which failed in ${run.workflow ?? 'CI'} run ${run.runNumber ?? ''}.`.trim(),
    ),
  );

  blocks.push(heading('Context'));
  blocks.push(paragraph('Reported from the QA automation dashboard. Run details:'));
  // Deliberately short. "Status" is always failed/broken on a ticket that exists
  // because something failed, and the repo is already in the title — lines that
  // are constant carry no information and push the useful ones off the screen.
  const context = [
    ['Scenario', failure.name],
    ['Feature', failure.feature],
    ['Feature file', featureFile(failure)],
    ['Area', failure.domain],
    ['Tags', (failure.tags ?? []).join(', ')],
    ['Workflow', run.workflow],
    ['Run', run.runNumber ? `#${run.runNumber}` : null],
    ['Environment', run.environment],
    ['Branch', run.branch],
    ['Commit', run.commit],
  ].filter(([, value]) => value);
  for (const [label, value] of context) blocks.push(bullet(`${label}: ${value}`));

  if (run.reportUrl) blocks.push(bullet(`Allure report: ${run.reportUrl}`));
  if (run.ciUrl) blocks.push(bullet(`CI run: ${run.ciUrl}`));

  blocks.push(heading('Failure output'));
  blocks.push(code(truncate(failure.message || '—', RICH_TEXT_LIMIT * 4)));

  blocks.push(heading('Acceptance criteria'));
  blocks.push(bullet(`R1. \`${failure.name}\` passes against ${run.environment || 'staging'}.`));
  blocks.push(
    bullet(
      'R2. The root cause is identified as either a product defect or a test defect, and stated in the PR description.',
    ),
  );
  blocks.push(
    bullet(
      'R3. If the cause is a product defect, the fix is in product code. The test is not weakened to accommodate the bug.',
    ),
  );
  blocks.push(
    bullet(
      'R4. The test still fails if the behaviour it covers regresses. A change that cannot fail has not fixed anything.',
    ),
  );

  // The failure mode this exists to prevent: an agent wrapping the failing
  // interaction in try/except and passing either way. That turns a red test
  // green while removing the only thing it was there to detect, and it reads as
  // a fix in review, so it has to be ruled out explicitly rather than implied.
  blocks.push(heading('How NOT to fix it'));
  blocks.push(
    paragraph(
      'These are automated checks. Each one must have exactly one passing outcome — if the code cannot distinguish a working app from a broken one, it is not a test. The following are rejected on sight, whatever the commit message says:',
    ),
  );
  blocks.push(
    bullet(
      'try/except (or try/catch) around an interaction or assertion that swallows the error — `except Exception: pass`, `except: continue`, or an empty handler. If a step can legitimately no-op, assert that it did.',
    ),
  );
  blocks.push(
    bullet(
      'A branch where both sides count as success — `if dialog.is_visible(): confirm() else: pass`. Decide which state is correct for THIS scenario and assert it. If it genuinely varies, the scenario needs splitting, not branching.',
    ),
  );
  blocks.push(
    bullet(
      'Reaching green by waiting harder: longer timeouts, added sleeps, retries, reloads or re-running the step. Those hide a race rather than fixing it.',
    ),
  );
  blocks.push(
    bullet(
      'Deleting or softening the assertion, marking the scenario @wip/@bug/@skip, or narrowing it so the failing path is no longer exercised.',
    ),
  );
  blocks.push(
    bullet(
      'Catching an exception only to log it and carry on. A swallowed failure in CI is a false green, which is worse than a red build.',
    ),
  );
  blocks.push(
    paragraph(
      'If you cannot make it pass without one of the above, stop and report that in the PR description instead. An accurate "this is a real defect and here is why" is a better outcome than a green test that checks nothing.',
    ),
  );

  blocks.push(heading('Out of scope'));
  blocks.push(bullet('Unrelated failures in the same run — each is filed separately.'));
  blocks.push(bullet('Refactoring the surrounding page objects or step definitions beyond what the fix requires.'));

  blocks.push(heading('Files likely touched'));
  blocks.push(bullet('Agent to discover.'));

  return blocks;
}

function buildProperties({ failure, run, repo, title }) {
  const properties = {
    Discovery: { title: richText(title) },
    Type: { select: { name: 'Bug' } },
    'Sub-Type': { select: { name: 'Bug' } },
    status: { status: { name: 'Ready For Agent Work' } },
    Agent: { select: { name: 'agent' } },
    'Agent Status': { select: { name: 'Ready' } },
    'Detected By': { select: { name: 'QA' } },
    Labels: {
      multi_select: [{ name: 'agent-eligible' }, { name: 'ready-for-agent' }, { name: 'QA' }],
    },
    'Failure Summary': {
      rich_text: richText(
        truncate(
          [featureFile(failure), failure.name].filter(Boolean).join(' · ') +
            ` — ${failure.message || 'no message'}`,
          RICH_TEXT_LIMIT,
        ),
      ),
    },
  };

  // Who owns triage. Set explicitly rather than left to the database's default,
  // so the ticket lands in a real person's queue the moment it is created.
  const assignee = process.env.NOTION_ASSIGNEE_ID;
  if (assignee) properties.Assignee = { people: [{ object: 'user', id: assignee }] };

  if (repo) properties.Repo = { select: { name: repo } };

  // Deliberately NOT setting "Run ID": the agent pipeline claims the ticket and
  // overwrites that column with its own run ULID, so a CI run id there survives
  // only seconds. The run is recorded in the Context block instead, which nothing
  // downstream rewrites.

  return properties;
}

const corsHeaders = (origin) => ({
  'Access-Control-Allow-Origin': origin,
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'content-type, x-dashboard-token',
  'Access-Control-Max-Age': '86400',
  Vary: 'Origin',
});

const reply = (statusCode, body, origin) => ({
  statusCode,
  headers: { 'content-type': 'application/json', ...corsHeaders(origin) },
  body: JSON.stringify(body),
});

export const handler = async (event) => {
  const allowedOrigin = process.env.ALLOWED_ORIGIN || '';
  const requestOrigin = event.headers?.origin || event.headers?.Origin || '';
  const method = event.requestContext?.http?.method || 'POST';

  // Only ever echo an origin we actually allow, so the browser refuses anything else.
  const echoOrigin = requestOrigin && requestOrigin === allowedOrigin ? requestOrigin : allowedOrigin;

  if (method === 'OPTIONS') return { statusCode: 204, headers: corsHeaders(echoOrigin), body: '' };
  if (method !== 'POST') return reply(405, { error: 'Method not allowed' }, echoOrigin);

  if (allowedOrigin && requestOrigin && requestOrigin !== allowedOrigin) {
    return reply(403, { error: 'Origin not allowed' }, echoOrigin);
  }

  const sharedToken = process.env.DASHBOARD_TOKEN;
  if (sharedToken) {
    const sent = event.headers?.['x-dashboard-token'] || event.headers?.['X-Dashboard-Token'];
    if (sent !== sharedToken) return reply(401, { error: 'Bad or missing dashboard token' }, echoOrigin);
  }

  const token = process.env.NOTION_TOKEN;
  const databaseId = process.env.NOTION_TASKS_DB_ID;
  if (!token || !databaseId) {
    console.error('Missing NOTION_TOKEN or NOTION_TASKS_DB_ID');
    return reply(500, { error: 'Function is not configured' }, echoOrigin);
  }

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
    : (event.body ?? '');
  if (Buffer.byteLength(rawBody, 'utf8') > MAX_BODY_BYTES) {
    return reply(413, { error: 'Payload too large' }, echoOrigin);
  }

  let payload;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    return reply(400, { error: 'Body is not valid JSON' }, echoOrigin);
  }

  const failure = payload.failure;
  if (!failure?.name) return reply(400, { error: 'failure.name is required' }, echoOrigin);

  const run = payload.run ?? {};
  // Only accept a repo the database actually offers — an unknown select value
  // makes Notion reject the whole page.
  const repo = REPOS.has(payload.repo) ? payload.repo : undefined;

  const title = buildTitle(failure, repo);

  const page = {
    parent: { database_id: databaseId },
    icon: { type: 'emoji', emoji: '🤖' },
    properties: buildProperties({ failure, run, repo, title }),
    children: buildBlocks({ prompt: payload.prompt, failure, run, repo }),
  };

  let response;
  try {
    response = await fetch(NOTION_API, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        'notion-version': NOTION_VERSION,
      },
      body: JSON.stringify(page),
    });
  } catch (error) {
    console.error('Notion request failed', error);
    return reply(502, { error: 'Could not reach Notion' }, echoOrigin);
  }

  const result = await response.json().catch(() => ({}));

  if (!response.ok) {
    // Notion's message names the offending property, which is what you need when
    // a select option has been renamed in the database.
    console.error('Notion rejected the page', response.status, JSON.stringify(result));
    return reply(
      response.status === 401 || response.status === 403 ? 502 : 400,
      { error: result.message || `Notion returned ${response.status}` },
      echoOrigin,
    );
  }

  return reply(200, { id: result.id, url: result.url }, echoOrigin);
};

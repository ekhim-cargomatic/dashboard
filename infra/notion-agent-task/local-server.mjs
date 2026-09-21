/**
 * Run the Notion task handler locally, so the dashboard's "Send to agent-dev"
 * button can be exercised end to end without deploying anything.
 *
 * This wraps the *same* index.mjs that runs in Lambda in a Function-URL-shaped
 * event, so a green run here means the deployed function behaves the same way.
 *
 *   npm run notion:local                 # dry run — no token needed, nothing written
 *   npm run notion:local -- --live       # really create pages in Notion
 *
 * The token is read from infra/.notion-token (gitignored) or $NOTION_TOKEN.
 *
 * Point the SPA at it by setting this in public/config.json (also gitignored):
 *
 *   "notionFnUrl": "http://localhost:8787/"
 *
 * then `npm run dev` and open the dashboard with ?ff=notion-on.
 */

import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = dirname(dirname(HERE));

const PORT = Number(process.env.PORT || 8787);
const ORIGIN = process.env.ALLOWED_ORIGIN || 'http://localhost:5173';
const LIVE = process.argv.includes('--live');

function readToken() {
  if (process.env.NOTION_TOKEN) return process.env.NOTION_TOKEN;
  try {
    return readFileSync(join(REPO, 'infra/.notion-token'), 'utf8').trim();
  } catch {
    return '';
  }
}

const token = readToken();

if (LIVE && !token) {
  console.error(
    '\nerror: --live needs a token.\n' +
      '  Put it in infra/.notion-token, or export NOTION_TOKEN.\n',
  );
  process.exit(1);
}

// In dry-run the handler still builds the full Notion payload — we just never let
// it leave the machine. That exercises every property and block builder, which is
// where mistakes actually live.
if (!LIVE) {
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (typeof url === 'string' && url.startsWith('https://api.notion.com')) {
      const payload = JSON.parse(options.body);
      console.log('\n─── would POST to Notion ───────────────────────────────');
      console.log('title     ', payload.properties.Discovery.title[0]?.text.content);
      console.log('database  ', payload.parent.database_id);
      for (const [name, value] of Object.entries(payload.properties)) {
        if (name === 'Discovery') continue;
        const shown =
          value.select?.name ??
          value.status?.name ??
          value.multi_select?.map((o) => o.name).join(', ') ??
          value.rich_text?.map((t) => t.text.content).join('').slice(0, 80);
        console.log(`  ${name.padEnd(16)} ${shown}`);
      }
      console.log('blocks    ', payload.children.length);
      for (const block of payload.children.filter((b) => b.type === 'heading_2')) {
        console.log('  ##', block.heading_2.rich_text[0]?.text.content);
      }
      console.log('────────────────────────────────────────────────────────\n');
      return {
        ok: true,
        status: 200,
        json: async () => ({
          id: 'dry-run-page-id',
          url: 'https://www.notion.so/dry-run-nothing-was-created',
        }),
      };
    }
    return realFetch(url, options);
  };
}

process.env.NOTION_TOKEN = token || 'dry-run-placeholder';
process.env.NOTION_TASKS_DB_ID =
  process.env.NOTION_TASKS_DB_ID || '278aa858-283a-803a-8a91-e682f86b1f8a';
process.env.NOTION_ASSIGNEE_ID =
  process.env.NOTION_ASSIGNEE_ID || '277d872b-594c-8119-ac3c-0002bb5fa349'; // Everett Khim
process.env.ALLOWED_ORIGIN = ORIGIN;

const { handler } = await import('./index.mjs');

createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', async () => {
    const event = {
      headers: req.headers,
      requestContext: { http: { method: req.method } },
      body: Buffer.concat(chunks).toString('utf8'),
      isBase64Encoded: false,
    };

    let result;
    try {
      result = await handler(event);
    } catch (error) {
      console.error(error);
      result = { statusCode: 500, headers: {}, body: JSON.stringify({ error: String(error) }) };
    }

    if (req.method !== 'OPTIONS') {
      console.log(`${req.method} ${req.url} → ${result.statusCode}`);
    }
    res.writeHead(result.statusCode, result.headers ?? {});
    res.end(result.body ?? '');
  });
}).listen(PORT, () => {
  console.log(`
  Notion task handler — ${LIVE ? 'LIVE (pages will be created)' : 'DRY RUN (nothing is written)'}

    listening   http://localhost:${PORT}/
    accepts     ${ORIGIN}
    token       ${token ? 'loaded' : 'none (dry run only)'}

  Set "notionFnUrl": "http://localhost:${PORT}/" in public/config.json,
  then open the dashboard with ?ff=notion-on
`);
});

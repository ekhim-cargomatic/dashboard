#!/usr/bin/env node
/**
 * Build the Automation Atlas dataset by scanning the playwright-automation tree.
 *
 * The Atlas is the structural counterpart to the rest of this dashboard: the
 * dashboard shows what *happened* in a run, the Atlas shows what *exists* — which
 * portals and feature areas the suite covers, how deep that coverage goes, and
 * which Linear tickets it verifies.
 *
 * Deliberately a generator rather than a hand-written snapshot: the suite moves,
 * and a coverage map that silently goes stale is worse than none. Re-run it and
 * republish.
 *
 *   node scripts/build-atlas.mjs --repo ../playwright-automation --out atlas.json
 *
 * Reads only .feature and .py files; emits counts, tags and ticket ids. No
 * scenario bodies or step text are included, so the output carries structure
 * rather than the test content itself.
 */

import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';
import { parseArgs } from 'node:util';

/** Tags that describe how a test runs; everything else is noise for this view. */
const KIND_TAGS = ['smoke', 'regression', 'e2e', 'wip'];
const TICKET_RE = /^CAR-\d+$/i;

function walk(dir, predicate, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (entry.name === '__pycache__' || entry.name.startsWith('.')) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (predicate(entry.name)) out.push(full);
  }
  return out;
}

/**
 * Portal and area from a feature file's path.
 *
 * `features/ui/admin/order_billing/x.feature` -> portal admin, area admin/order_billing
 * `features/api/tariffs/x.feature`            -> portal api,   area api/tariffs
 *
 * The `ui/` segment is dropped: it says how the test drives the app, not which
 * part of the product it covers, and keeping it would prefix every area alike.
 */
function locate(relPath) {
  let parts = relPath.split(sep);
  if (parts[0] === 'features') parts = parts.slice(1);
  parts = parts.slice(0, -1); // drop the filename
  if (parts[0] === 'ui') parts = parts.slice(1);

  const portal = parts[0] ?? 'root';
  const area = parts.length ? parts.join('/') : portal;
  return { portal, area };
}

/**
 * Pull scenario count and tags out of a .feature file.
 *
 * Tags are unioned across the file — a tag above `Feature:` applies to every
 * scenario in it, and for a coverage map "does this file touch CAR-2998" is the
 * question, not which individual scenario does.
 */
function parseFeature(text) {
  let scenarios = 0;
  const tags = new Set();
  let title = '';

  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('@')) {
      for (const tag of line.split(/\s+/)) {
        if (tag.startsWith('@')) tags.add(tag.slice(1));
      }
    } else if (/^Scenario(\s+Outline)?\s*:/i.test(line)) {
      scenarios += 1;
    } else if (!title && /^Feature\s*:/i.test(line)) {
      title = line.replace(/^Feature\s*:\s*/i, '').trim();
    }
  }
  return { scenarios, tags: [...tags], title };
}

const { values: args } = parseArgs({
  options: {
    repo: { type: 'string', default: '../playwright-automation' },
    out: { type: 'string', default: 'atlas.json' },
    // Inject the dataset into the page template and emit a standalone artifact.
    html: { type: 'string' },
  },
});

const repo = args.repo;
const featuresDir = join(repo, 'features');

const featureFiles = walk(featuresDir, (n) => n.endsWith('.feature'));
if (featureFiles.length === 0) {
  console.error(`No .feature files under ${featuresDir} — is --repo correct?`);
  process.exit(1);
}

const byPortal = new Map();
const ticketCounts = new Map();
let totalScenarios = 0;

for (const file of featureFiles) {
  const rel = relative(repo, file);
  const { portal, area } = locate(relative(featuresDir, file));
  const { scenarios, tags, title } = parseFeature(readFileSync(file, 'utf8'));
  totalScenarios += scenarios;

  const tickets = tags.filter((t) => TICKET_RE.test(t)).map((t) => t.toUpperCase());
  const kinds = tags.filter((t) => KIND_TAGS.includes(t.toLowerCase()));

  for (const ticket of tickets) ticketCounts.set(ticket, (ticketCounts.get(ticket) ?? 0) + 1);

  let p = byPortal.get(portal);
  if (!p) {
    p = { name: portal, nf: 0, ns: 0, tickets: new Set(), areas: new Map() };
    byPortal.set(portal, p);
  }
  let a = p.areas.get(area);
  if (!a) {
    a = { name: area, nf: 0, ns: 0, tickets: new Set(), features: [] };
    p.areas.set(area, a);
  }

  const name = rel.split(sep).pop().replace(/\.feature$/, '');
  a.features.push({ n: name, t: tickets.sort(), s: scenarios, k: kinds.sort(), title });
  a.nf += 1;
  a.ns += scenarios;
  p.nf += 1;
  p.ns += scenarios;
  for (const ticket of tickets) {
    a.tickets.add(ticket);
    p.tickets.add(ticket);
  }
}

const pages = walk(join(repo, 'pages'), (n) => n.endsWith('.py') && n !== '__init__.py').length;
const stepFiles = walk(join(featuresDir, 'steps'), (n) => n.endsWith('.py') && n !== '__init__.py');
const stepDefs = stepFiles.reduce((sum, file) => {
  const matches = readFileSync(file, 'utf8').match(/^\s*@(given|when|then|step)\(/gim);
  return sum + (matches ? matches.length : 0);
}, 0);

const sortTickets = (set) =>
  [...set].sort((a, b) => Number(a.slice(4)) - Number(b.slice(4)));

const portals = [...byPortal.values()]
  .map((p) => ({
    name: p.name,
    nf: p.nf,
    ns: p.ns,
    nt: p.tickets.size,
    tickets: sortTickets(p.tickets),
    areas: [...p.areas.values()]
      .map((a) => ({
        name: a.name,
        nf: a.nf,
        ns: a.ns,
        tickets: sortTickets(a.tickets),
        features: a.features.sort((x, y) => y.s - x.s || x.n.localeCompare(y.n)),
      }))
      .sort((x, y) => y.nf - x.nf || x.name.localeCompare(y.name)),
  }))
  .sort((a, b) => b.nf - a.nf || a.name.localeCompare(b.name));

const atlas = {
  generatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  totals: {
    features: featureFiles.length,
    scenarios: totalScenarios,
    pages,
    steps: stepFiles.length,
    tickets: ticketCounts.size,
    step_defs: stepDefs,
  },
  tickets: [...ticketCounts.entries()]
    .map(([id, count]) => ({ id, count }))
    .sort((a, b) => b.count - a.count || Number(a.id.slice(4)) - Number(b.id.slice(4))),
  portals,
};

mkdirSync(dirname(args.out) || '.', { recursive: true });
writeFileSync(args.out, JSON.stringify(atlas));

if (args.html) {
  const template = readFileSync(new URL('./atlas-template.html', import.meta.url), 'utf8');
  // `</script>` inside a JSON string would close the host <script> tag early, so
  // escape the sequence rather than trusting the data never contains it.
  const payload = JSON.stringify(atlas).replace(/<\//g, '<\\/');
  mkdirSync(dirname(args.html) || '.', { recursive: true });
  writeFileSync(args.html, template.replace('__ATLAS_JSON__', () => payload));
  console.log(`  page: ${args.html}`);
}

const t = atlas.totals;
console.log(
  `${args.out}: ${t.features} features, ${t.scenarios} scenarios, ${t.tickets} tickets, ` +
    `${t.pages} pages, ${t.steps} step files, ${t.step_defs} step defs`,
);
console.log(
  '  portals: ' + portals.map((p) => `${p.name}(${p.nf})`).join(', '),
);

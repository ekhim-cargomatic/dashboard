/**
 * Headless checks for the flow tree (behind ?qa=1).
 *
 * The map is only useful if the picture is true, and the thing it has to be
 * true about is independence: booking a shorthaul does not wait on drayage, so
 * shorthaul must not hang off anything under order.*. That is the check this
 * file exists for; the rest guard the invariants that make it meaningful —
 * one parent per chunk, every chunk reaching the root, and every declared data
 * dependency actually sitting in the ancestry it is drawn in.
 *
 * It reads the drawn SVG rather than the layout module, so it fails if the
 * renderer and the layout disagree.
 *
 *   npm run build && npx vite preview --port 4178 --strictPort &
 *   npm i -D playwright && npx playwright install chromium
 *   node scripts/check-flow-ui.mjs
 *
 * BASE overrides the URL, CHROMIUM an executable path, SHOT writes a PNG.
 */
import { chromium } from 'playwright';

const BASE = process.env.BASE ?? 'http://127.0.0.1:4178';
const out = [];
const ok = (n, d = '') => out.push(['PASS', n, d]);
const bad = (n, d = '') => out.push(['FAIL', n, d]);

const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
const errs = [];
page.on('pageerror', (e) => errs.push(String(e)));
page.on('console', (m) => {
  // 'Failed to load resource' is the console echo of an HTTP status; the
  // response listener below judges those, with the URL in hand.
  if (m.type() === 'error' && !m.text().includes('Failed to load resource')) errs.push(m.text());
});
// The S3 run listing 404s in a local preview — nothing to do with the flow tab.
page.on('response', (r) => {
  if (r.status() >= 400 && !r.url().includes('list-type=2')) errs.push(`${r.status()} ${r.url()}`);
});

await page.goto(`${BASE}/?qa=1`, { waitUntil: 'networkidle' });
await page.getByRole('button', { name: 'App flow' }).click();
await page.waitForSelector('.fg-node', { timeout: 15000 });

const chunks = await page.$$eval('.fg-node', (ns) => ns.length);
chunks === 30 ? ok('every chunk is a node', String(chunks)) : bad('every chunk is a node', String(chunks));

// Reconstruct the drawn graph from edge titles.
const edges = await page.$$eval('.fg-edges > g', (gs) => gs.map((g) => ({
  cls: g.getAttribute('class') ?? '',
  title: g.querySelector('title')?.textContent ?? '',
  d: g.querySelector('path')?.getAttribute('d') ?? '',
})));
const parse = (t) => { const m = t.match(/^([\w.]+) → ([\w.]+)/); return m ? [m[1], m[2]] : null; };
const tree = edges.filter((e) => e.cls.includes('is-tree')).map((e) => parse(e.title)).filter(Boolean);
const cross = edges.filter((e) => e.cls.includes('is-cross')).map((e) => parse(e.title)).filter(Boolean);

tree.length === 29 ? ok('tree has one parent per chunk', `${tree.length} tree edges, 30 chunks`)
                   : bad('tree has one parent per chunk', `${tree.length} tree edges`);
cross.length > 0 ? ok('cross-links drawn separately', String(cross.length)) : bad('cross-links drawn separately');

const parent = new Map(tree.map(([a, b]) => [b, a]));
const roots = [...new Set(tree.flatMap(([a, b]) => [a, b]))].filter((id) => !parent.has(id));
roots.length === 1 ? ok('single root', roots.join(',')) : bad('single root', roots.join(','));

const chain = (id) => { const c = []; for (let x = parent.get(id); x; x = parent.get(x)) c.push(x); return c; };

// The point of the rewrite.
const sh = chain('shorthaul.book');
sh.some((id) => id.startsWith('order.')) || sh.includes('documents')
  ? bad('shorthaul does not sit behind drayage', sh.join(' ← '))
  : ok('shorthaul does not sit behind drayage', `shorthaul.book ← ${sh.join(' ← ')}`);
const shs = chain('shorthaul.shipment');
shs.some((id) => id.startsWith('order.'))
  ? bad('shorthaul shipment likewise', shs.join(' ← '))
  : ok('shorthaul shipment likewise', `shorthaul.shipment ← ${shs.join(' ← ')}`);

// Shorthaul and drayage are siblings under the root, not one under the other.
const branchOf = (id) => { const c = [id, ...chain(id)]; return c[c.length - 2] ?? id; };
branchOf('shorthaul.book') !== branchOf('order.create')
  ? ok('separate top-level branches', `${branchOf('shorthaul.book')} vs ${branchOf('order.create')}`)
  : bad('separate top-level branches', branchOf('shorthaul.book'));

// Every chunk reaches the root, no cycles.
let reaches = 0;
const ids = await page.$$eval('.fg-node .fg-id', (ts) => ts.map((t) => t.textContent));
for (const id of ids) {
  const c = chain(id);
  if (id === roots[0] || c[c.length - 1] === roots[0]) reaches += 1;
}
reaches === ids.length ? ok('every chunk walks up to the root', `${reaches}/${ids.length}`)
                       : bad('every chunk walks up to the root', `${reaches}/${ids.length}`);

// Declared data dependencies must be tree ancestors, or the picture lies.
const flow = await (await fetch(`${BASE}/qa-flow/cargomatic.json`)).json();
const liars = [];
for (const c of flow.chunks) {
  const anc = new Set(chain(c.id));
  for (const d of c.dependsOn ?? []) {
    if (d.kind === 'data' && d.chunk && !anc.has(d.chunk)) liars.push(`${c.id} needs ${d.chunk}`);
  }
}
liars.length === 0 ? ok('data dependencies are tree ancestors', `${flow.chunks.length} chunks`)
                   : bad('data dependencies are tree ancestors', liars.join('; '));

// Every node is left of its parent's column + 1, i.e. one level per edge.
const xs = await page.$$eval('.fg-node', (ns) => Object.fromEntries(ns.map((n) => [
  n.querySelector('.fg-id').textContent,
  Number(/translate\(([-\d.]+)/.exec(n.getAttribute('transform'))[1]),
])));
const stepped = tree.every(([a, b]) => Math.abs((xs[b] - xs[a]) - 292) < 1);
stepped ? ok('tree edges span exactly one column') : bad('tree edges span exactly one column');

// Elbows for the tree, curves for cross-links.
const elbows = edges.filter((e) => e.cls.includes('is-tree')).every((e) => e.d.includes('Q') || e.d.startsWith('M'));
const curves = edges.filter((e) => e.cls.includes('is-cross')).every((e) => e.d.includes('C'));
elbows && curves ? ok('elbow tree, bowed cross-links') : bad('elbow tree, bowed cross-links');

// Cross-link toggle.
await page.getByLabel(/cross-links/).uncheck();
const afterOff = await page.$$eval('.fg-edges > g.is-cross', (gs) => gs.length);
afterOff === 0 ? ok('cross-links can be hidden') : bad('cross-links can be hidden', String(afterOff));
await page.getByLabel(/cross-links/).check();

// Selecting lights the ancestry.
await page.locator('.fg-node', { hasText: 'invoice.lifecycle' }).first().click();
await page.waitForTimeout(400);
const up = await page.$$eval('.fg-node.is-upstream .fg-id', (ts) => ts.map((t) => t.textContent));
up.includes('auth') && up.includes('order.create')
  ? ok('ancestry highlighted', `${up.length} upstream`)
  : bad('ancestry highlighted', up.join(','));
const runOrder = await page.$$eval('.fm-run-order li, .fm-run-order code', (ns) => ns.map((n) => n.textContent));
runOrder.length > 0 ? ok('run order still listed', runOrder.join(' → ')) : bad('run order still listed');

// A shorthaul chunk must not claim a drayage prerequisite.
await page.locator('.fg-node', { hasText: 'shorthaul.shipment' }).first().click();
await page.waitForTimeout(400);
const up2 = await page.$$eval('.fg-node.is-upstream .fg-id', (ts) => ts.map((t) => t.textContent));
up2.some((id) => id.startsWith('order.')) ? bad('shorthaul ancestry is clean', up2.join(','))
                                          : ok('shorthaul ancestry is clean', up2.join(', '));

errs.length === 0 ? ok('no page errors') : bad('no page errors', errs.slice(0, 3).join(' | '));

await page.locator('.fg-node', { hasText: 'shorthaul.book' }).first().click();
await page.waitForTimeout(500);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

await browser.close();
for (const [s, n, d] of out) console.log(`${s}  ${n}${d ? '  — ' + d : ''}`);
const fails = out.filter((o) => o[0] === 'FAIL').length;
console.log(`\n${out.length - fails}/${out.length} checks passed`);
process.exit(fails ? 1 : 0);

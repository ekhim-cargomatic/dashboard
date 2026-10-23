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
const expected = (await (await fetch(`${BASE}/qa-flow/cargomatic.json`)).json()).chunks.length;
chunks === expected ? ok('every chunk is a node', String(chunks)) : bad('every chunk is a node', `${chunks} of ${expected}`);

// Reconstruct the drawn graph from edge titles.
const edges = await page.$$eval('.fg-edges > g', (gs) => gs.map((g) => ({
  cls: g.getAttribute('class') ?? '',
  title: g.querySelector('title')?.textContent ?? '',
  d: g.querySelector('path')?.getAttribute('d') ?? '',
})));
const parse = (t) => { const m = t.match(/^([\w.]+) → ([\w.]+)/); return m ? [m[1], m[2]] : null; };
const tree = edges.filter((e) => e.cls.includes('is-tree')).map((e) => parse(e.title)).filter(Boolean);
const cross = edges.filter((e) => e.cls.includes('is-cross')).map((e) => parse(e.title)).filter(Boolean);

tree.length === chunks - 4 ? ok('one parent per chunk, four roots', `${tree.length} tree edges, ${chunks} chunks`)
                   : bad('one parent per chunk, four roots', `${tree.length} tree edges, ${chunks} chunks`);
cross.length > 0 ? ok('cross-links drawn separately', String(cross.length)) : bad('cross-links drawn separately');

const parent = new Map(tree.map(([a, b]) => [b, a]));
const ids0 = await page.$$eval('.fg-node .fg-id', (ts) => ts.map((t) => t.textContent));
const roots = ids0.filter((id) => !parent.has(id));
roots.length === 4 && roots.includes('auth') && roots.includes('carrier.auth')
  && roots.includes('shipper.auth') && roots.includes('driver.auth')
  ? ok('one root per portal', roots.join(', '))
  : bad('one root per portal', roots.join(', '));

const chain = (id) => { const c = []; for (let x = parent.get(id); x; x = parent.get(x)) c.push(x); return c; };

// A sign-in must not hang off another sign-in.
const signIns = ['auth', 'carrier.auth', 'shipper.auth', 'driver.auth'];
signIns.every((id) => chain(id).length === 0)
  ? ok('no sign-in sits under another')
  : bad('no sign-in sits under another', signIns.map((id) => `${id} ← ${chain(id).join(' ← ')}`).join(' | '));

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
  if (roots.includes(id) || roots.includes(c[c.length - 1])) reaches += 1;
}
reaches === ids.length ? ok('every chunk walks up to a portal root', `${reaches}/${ids.length}`)
                       : bad('every chunk walks up to a portal root', `${reaches}/${ids.length}`);

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

// Access panel: a role-gated chunk shows its guards, an ungated one says so.
await page.locator('.fg-node', { hasText: 'order.billing' }).first().click();
await page.waitForTimeout(400);
const roles = await page.$$eval('.fm-role', (ns) => ns.map((x) => x.textContent));
roles.includes('billing_status_admin') ? ok('role requirements shown', roles.join(', '))
                                       : bad('role requirements shown', roles.join(', '));
const srcs = await page.$$eval('.fm-access-src', (ns) => ns.map((x) => x.textContent));
srcs.every((t) => /:\d+$/.test(t)) && srcs.length > 0
  ? ok('every role cites a file and line', `${srcs.length} citations`)
  : bad('every role cites a file and line', srcs.join(' | '));
await page.locator('.fg-node', { hasText: 'documents' }).first().click();
await page.waitForTimeout(400);
const open = await page.$$eval('.fm-access-open', (ns) => ns.length);
open === 1 ? ok('ungated chunks say so') : bad('ungated chunks say so', String(open));
const portals = await page.$$eval('.fg-node', (ns) => ns.filter((x) => /fg-portal-/.test(x.getAttribute('class'))).length);
portals === chunks ? ok('every node carries a portal', String(portals)) : bad('every node carries a portal', String(portals));
const mobile = await page.$$eval('.fg-node.is-mobile', (ns) => ns.length);
mobile >= 5 ? ok('mobile chunks marked', String(mobile)) : bad('mobile chunks marked', String(mobile));

// Leg management is v2 only: it must not hang off the legacy order screen.
const legsParent = parent.get('order.legs');
legsParent === 'order.detail.v2' || !chain('order.legs').includes('order.detail.v1')
  ? ok('leg management is not under the legacy order', `order.legs ← ${chain('order.legs').join(' ← ')}`)
  : bad('leg management is not under the legacy order', String(legsParent));
await page.locator('.fg-node', { hasText: 'order.legs' }).first().click();
await page.waitForTimeout(400);
const variant = await page.$$eval('.fm-variant-test', (ns) => ns.map((x) => x.textContent));
variant.some((t) => t.includes('leg_management_version'))
  ? ok('the version switch is stated', variant.join(', '))
  : bad('the version switch is stated', variant.join(', '));
const dashed = await page.$$eval('.fg-node.is-variant', (ns) => ns.length);
dashed >= 3 ? ok('version-gated chunks marked on the tree', String(dashed))
            : bad('version-gated chunks marked on the tree', String(dashed));

// Node labels must not sit on top of each other. Measure the two that share
// line 2 — the chunk id and the variant badge — and assert they don't overlap.
const collisions = await page.$$eval('.fg-node', (ns) => ns.flatMap((node) => {
  const id = node.querySelector('.fg-id');
  const badge = node.querySelector('.fg-variant');
  if (!id || !badge) return [];
  const a = id.getBoundingClientRect();
  const b = badge.getBoundingClientRect();
  return a.right > b.left + 0.5 ? [`${id.textContent} / ${badge.textContent}`] : [];
}));
collisions.length === 0
  ? ok('no overlapping node labels')
  : bad('no overlapping node labels', collisions.join(' | '));

// Permissions have to be readable from the tree itself, not only the panel.
const byId = (id) => page.locator('.fg-node')
  .filter({ has: page.locator('.fg-id', { hasText: new RegExp(`^${id.replace(/\./g, '\\.')}$`) }) })
  .first();
await byId('tariffs').click();
await page.waitForTimeout(400);
const card = await page.$$eval('.fg-perm .fm-role', (ns) => ns.map((x) => x.textContent));
card.length === 2 && card.includes('admin') && card.includes('tariff')
  ? ok('permissions shown on the tree', card.join(', '))
  : bad('permissions shown on the tree', card.join(', '));
await byId('documents').click();
await page.waitForTimeout(400);
const openCard = await page.$$eval('.fg-perm-open', (ns) => ns.length);
openCard === 1 ? ok('ungated chunks say so on the tree') : bad('ungated chunks say so on the tree', String(openCard));
await byId('markets').click();
await page.waitForTimeout(400);
const mk = await page.$$eval('.fg-perm .fm-role', (ns) => ns.map((x) => x.textContent));
mk.length === 1 && mk[0] === 'admin' ? ok('markets is admin-gated', mk.join(', ')) : bad('markets is admin-gated', mk.join(', '));

errs.length === 0 ? ok('no page errors') : bad('no page errors', errs.slice(0, 3).join(' | '));

await page.locator('.fg-node', { hasText: 'shorthaul.book' }).first().click();
await page.waitForTimeout(500);
if (process.env.SHOT) await page.screenshot({ path: process.env.SHOT });

await browser.close();
for (const [s, n, d] of out) console.log(`${s}  ${n}${d ? '  — ' + d : ''}`);
const fails = out.filter((o) => o[0] === 'FAIL').length;
console.log(`\n${out.length - fails}/${out.length} checks passed`);
process.exit(fails ? 1 : 0);

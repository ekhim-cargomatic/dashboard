/**
 * QA flow maps — the app's screens as a graph, with the selector and the API
 * round-trip behind every step.
 *
 * Loaded from /qa-flow/ at runtime rather than bundled, for the same reason
 * config.json is: the map changes when the product changes, and that should not
 * need a rebuild of the dashboard. `scripts/validate-flow.py` is what keeps the
 * selectors honest against playwright-automation.
 */

export type NodeKind = 'page' | 'section' | 'modal' | 'field' | 'action' | 'assert';

/** One HTTP call a step depends on. */
export interface ApiCall {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  status?: number[];
  timeoutMs?: number;
  /** Re-read scope: the whole entity, one field, or the list it belongs to. */
  scope?: 'record' | 'field' | 'collection';
  field?: string;
  query?: Record<string, string>;
  /** A typeahead call that fires per keystroke — settle before asserting. */
  debounced?: boolean;
  /** A POST that queries rather than writes, so it is not a mutation. */
  reads?: boolean;
  assert?: ApiAssert[];
  note?: string;
}

export interface ApiAssert {
  pointer?: string;
  equals?: unknown;
  equalsInput?: boolean;
  equalsRendered?: unknown;
  present?: boolean;
  greaterThan?: number;
  minLength?: number;
  increasedBy?: string;
  decreasedBy?: string;
  note?: string;
}

export interface ApiSpec {
  /** The write the step fires. The step is not finished until this settles. */
  await?: ApiCall;
  /** The read-back that proves it persisted. This is the real pass condition. */
  verify?: ApiCall;
  /** JSON Pointers lifted into flow variables, referenced elsewhere as {name}. */
  capture?: Record<string, string>;
  /** Why no read-back exists. Set only when none does — it clears the gap flag. */
  verifyNotApplicable?: string;
  /** Extra quiet time after await before verify — these pages re-fetch slowly. */
  settleMs?: number;
  note?: string;
}

export interface FollowUp {
  action: string;
  selector?: string;
  source?: string;
  note?: string;
}

export interface FlowNode {
  id: string;
  name: string;
  kind: NodeKind;
  parent?: string;
  /** CSS/Playwright selector, byte-identical to the page-object constant named in `source`. */
  selector?: string;
  /** `Class.CONSTANT` in playwright-automation. */
  source?: string;
  /** Same, but the selector here is deliberately scoped/derived from that constant. */
  sourceComposed?: string;
  /** The constant that supplies `path` on a page node. */
  pathSource?: string;
  path?: string;
  control?: string;
  action?: string;
  required?: boolean;
  secret?: boolean;
  destructive?: boolean;
  async?: boolean;
  repeatable?: boolean;
  scopedToRow?: boolean;
  expect?: string;
  opens?: string;
  /** Lives in another chunk's UI but belongs to this chunk's story. */
  attachesTo?: string;
  menuItemText?: string;
  tabText?: string;
  byRole?: { role: string; name: string };
  fallback?: { selector: string; source?: string };
  title?: { selector?: string; text?: string; source?: string };
  then?: FollowUp[];
  capture?: Record<string, string>;
  api?: ApiSpec;
  note?: string;
}

/** What must already have happened before a chunk can run. */
export interface ChunkDependency {
  /** 'session' — a sign-in; 'data' — another chunk captured a variable this
   *  one needs; 'seeded' — the fixture supplies it, no chunk does. */
  kind: 'session' | 'data' | 'seeded';
  /** The chunk that satisfies it (absent for 'seeded'). */
  chunk?: string;
  /** The variable a 'seeded' dependency needs. */
  variable?: string;
  /** Variables `chunk` captures that this one consumes. */
  provides?: string[];
  /** Other chunks that could satisfy it instead. */
  alternatives?: string[];
  required?: boolean;
  why?: string;
}

export interface FlowChunk {
  id: string;
  name: string;
  tags?: string[];
  page?: string;
  sourceFile?: string;
  entry: string;
  exit: string;
  requires?: string[];
  /** Flow variables this chunk captures for later chunks. */
  provides?: string[];
  /** Hard prerequisites. Distinct from `edges`, which is narrative order. */
  dependsOn?: ChunkDependency[];
  nodes: FlowNode[];
}

export type FlowEdge = [string, string] | [string, string, string];

export interface Flow {
  id: string;
  name: string;
  version: number;
  description?: string;
  env?: { baseUrl?: string; apiPrefix?: string; apiPrefixNote?: string };
  sources?: { repo: string; what: string; path?: string; note?: string }[];
  legend?: Record<string, unknown>;
  variables?: Record<string, string>;
  chunks: FlowChunk[];
  edges: FlowEdge[];
}

export interface FlowIndex {
  flows: { file: string; id: string; name: string; status?: string; note?: string }[];
  planned?: { id: string; name: string; source?: string }[];
}

const BASE = '/qa-flow';

export async function loadFlowIndex(): Promise<FlowIndex> {
  const response = await fetch(`${BASE}/index.json`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`No flow index at ${BASE}/index.json (${response.status})`);
  return (await response.json()) as FlowIndex;
}

export async function loadFlow(file: string): Promise<Flow> {
  const response = await fetch(`${BASE}/${file}`, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not read ${BASE}/${file} (${response.status})`);
  return (await response.json()) as Flow;
}

/** Children of a node, in authored order. */
export function childrenOf(chunk: FlowChunk, parentId: string | undefined): FlowNode[] {
  return chunk.nodes.filter((node) => node.parent === parentId);
}

/** Roots of a chunk — nodes nobody claims as a child. */
export function rootsOf(chunk: FlowChunk): FlowNode[] {
  const ids = new Set(chunk.nodes.map((node) => node.id));
  return chunk.nodes.filter((node) => !node.parent || !ids.has(node.parent));
}

/**
 * Nodes that fire a write — the ones worth a verify GET.
 *
 * Method alone is not enough: this codebase POSTs to query in several places
 * (Unified View's grid, the invoice and payout change logs, the distance and
 * price quotes), and counting those as writes made the gap number noise.
 */
export function mutatingNodes(chunk: FlowChunk): FlowNode[] {
  return chunk.nodes.filter(
    (node) => node.api?.await && node.api.await.method !== 'GET' && !node.api.await.reads,
  );
}

/**
 * Writes with nothing proving they landed — the gap worth closing first.
 * A write that declares `verifyNotApplicable` is excluded: an email send has
 * nothing to read back, and leaving it in the count only teaches people to
 * ignore the count.
 */
export function unverifiedWrites(chunk: FlowChunk): FlowNode[] {
  return mutatingNodes(chunk).filter(
    (node) => !node.api?.verify && !node.api?.verifyNotApplicable,
  );
}

export function fullPath(flow: Flow, call: ApiCall): string {
  const prefix = flow.env?.apiPrefix ?? '';
  const query = call.query
    ? `?${Object.entries(call.query).map(([k, v]) => `${k}=${v}`).join('&')}`
    : '';
  return `${prefix}${call.path}${query}`;
}

// ──────────────────────────────────────────────────────────── dependencies ──

/** Chunk ids this one needs directly (session + data, not alternatives). */
export function directDeps(chunk: FlowChunk): string[] {
  return (chunk.dependsOn ?? [])
    .map((d) => d.chunk)
    .filter((id): id is string => Boolean(id));
}

/**
 * Every chunk that must run before `id`, nearest-first by depth.
 *
 * Follows `dependsOn` rather than `edges`: edges say where a tester goes next,
 * dependencies say what must already be true. Cycles are tolerated — the graph
 * is authored by hand and one bad entry should not hang the page.
 */
export function dependencyClosure(flow: Flow, id: string): string[] {
  const byId = new Map(flow.chunks.map((c) => [c.id, c]));
  const seen = new Set<string>();
  const out: string[] = [];
  const visit = (cur: string) => {
    for (const dep of directDeps(byId.get(cur) ?? ({ dependsOn: [] } as unknown as FlowChunk))) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      visit(dep);
      out.push(dep);
    }
  };
  visit(id);
  return out;
}

/** Narrative edges in and out of a chunk, with their labels. */
export function neighbours(flow: Flow, id: string): {
  from: { id: string; label?: string }[];
  to: { id: string; label?: string }[];
} {
  return {
    from: flow.edges.filter((e) => e[1] === id).map((e) => ({ id: e[0], label: e[2] })),
    to: flow.edges.filter((e) => e[0] === id).map((e) => ({ id: e[1], label: e[2] })),
  };
}

/** Chunks that depend on `id`, directly. */
export function dependents(flow: Flow, id: string): string[] {
  return flow.chunks.filter((c) => directDeps(c).includes(id)).map((c) => c.id);
}

/**
 * A runnable order for `id` and everything it needs: dependencies first,
 * the chunk itself last. This is the answer to "what do I run to exercise
 * this chunk on its own".
 */
export function runOrder(flow: Flow, id: string): string[] {
  return [...dependencyClosure(flow, id), id];
}

// ─────────────────────────────────────────────────────────────────── layout ──

export interface GraphNode {
  id: string;
  chunk: FlowChunk;
  /** Distance from the root in levels. One level is one column. */
  depth: number;
  /** The single chunk this one hangs off; null for the root of a tree. */
  parent: string | null;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  label?: string;
  /** A parent → child edge: part of the tree itself, drawn as a solid elbow. */
  tree: boolean;
  /** A cross-link that skips a level, drawn with a wider bow. */
  long: boolean;
}

export interface GraphLayout {
  nodes: GraphNode[];
  edges: GraphEdge[];
  roots: string[];
  width: number;
  height: number;
  depth: number;
}

export const NODE_W = 188;
export const NODE_H = 68;
const GAP_X = 104;
const GAP_Y = 26;
/** Extra air between the top-level branches, so they read as separate work. */
const BRANCH_GAP = 30;
const PAD = 24;

/**
 * Tidy tree layout, left to right.
 *
 * Layering by longest path was the wrong model. It placed a chunk at the far
 * end of the longest route that happens to reach it, so independent work came
 * out looking sequential: booking a shorthaul sat level with the drayage
 * accounting chain only because closing a shipment eventually joins back up to
 * billing. You can book a shorthaul without touching drayage at all, and the
 * picture has to say that.
 *
 * So every chunk gets exactly one parent, the result is packed as a tree, and
 * everything else becomes a cross-link. Branches fan out from the sign-in and
 * meet again only where a cross-link says they do.
 *
 * Picking the parent, in order:
 *   1. candidates are the chunk's own data dependencies, whatever leads to it
 *      in the narrative graph, and its session chunk;
 *   2. the deepest candidate wins — what must happen immediately before, not
 *      the earliest thing that happens at all;
 *   3. ties go to a data dependency over a narrative edge over a session.
 *
 * A chunk with no dependencies at all is a portal entry (admin, carrier and
 * shipper sign-in) and may only hang off another portal, so a sign-in never
 * ends up buried inside somebody else's branch.
 *
 * Every parent is strictly shallower than its child, so the parent links
 * cannot cycle and every chunk walks up to a root — a cycle in hand-authored
 * data degrades to an extra cross-link rather than a hang.
 */
export function layoutTree(flow: Flow): GraphLayout {
  const ids = flow.chunks.map((c) => c.id);
  const idSet = new Set(ids);
  const byId = new Map(flow.chunks.map((c) => [c.id, c]));
  const edges = flow.edges
    .filter((e) => idSet.has(e[0]) && idSet.has(e[1]))
    .map((e) => ({ from: e[0], to: e[1], label: e[2] }));

  const isPortal = (id: string) => (byId.get(id)?.dependsOn?.length ?? 0) === 0;

  // Candidate parents, each with a tier: 0 data dep, 1 narrative edge, 2 session.
  const cands = new Map<string, Map<string, number>>(ids.map((id) => [id, new Map()]));
  const offer = (to: string, from: string, tier: number) => {
    if (from === to || !idSet.has(from) || !idSet.has(to)) return;
    if (isPortal(to) && !isPortal(from)) return;
    const m = cands.get(to)!;
    const cur = m.get(from);
    if (cur === undefined || tier < cur) m.set(from, tier);
  };
  for (const c of flow.chunks) {
    for (const d of c.dependsOn ?? []) {
      if (d.chunk) offer(c.id, d.chunk, d.kind === 'data' ? 0 : 2);
    }
  }
  for (const e of edges) offer(e.to, e.from, 1);

  // Longest path over the candidate graph, iterated to a fixed point.
  const depth = new Map<string, number>(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass += 1) {
    let moved = false;
    for (const id of ids) {
      for (const from of cands.get(id)!.keys()) {
        const want = depth.get(from)! + 1;
        if (want > depth.get(id)!) {
          depth.set(id, want);
          moved = true;
        }
      }
    }
    if (!moved) break;
  }

  const parent = new Map<string, string | null>();
  for (const id of ids) {
    const opts = [...cands.get(id)!.entries()]
      .filter(([from]) => depth.get(from)! < depth.get(id)!)
      .sort((a, b) =>
        depth.get(b[0])! - depth.get(a[0])! || a[1] - b[1] || a[0].localeCompare(b[0]));
    parent.set(id, opts.length > 0 ? opts[0][0] : null);
  }

  const children = new Map<string, string[]>(ids.map((id) => [id, []]));
  const roots: string[] = [];
  for (const id of ids) {
    const p = parent.get(id)!;
    if (p === null) roots.push(id);
    else children.get(p)!.push(id);
  }
  const order = (a: string, b: string) => a.localeCompare(b);
  for (const list of children.values()) list.sort(order);
  roots.sort(order);

  // Leaves take the next free row; a parent centres on its own children.
  const y = new Map<string, number>();
  let cursor = PAD;
  const place = (id: string) => {
    const kids = children.get(id)!;
    if (kids.length === 0) {
      y.set(id, cursor);
      cursor += NODE_H + GAP_Y;
      return;
    }
    const spaced = roots.includes(id);
    kids.forEach((k, i) => {
      if (i > 0 && spaced) cursor += BRANCH_GAP;
      place(k);
    });
    y.set(id, (y.get(kids[0])! + y.get(kids[kids.length - 1])!) / 2);
  };
  for (const r of roots) {
    place(r);
    cursor += BRANCH_GAP * 2;
  }

  const maxDepth = Math.max(0, ...ids.map((id) => depth.get(id)!));
  const nodes: GraphNode[] = ids.map((id) => ({
    id,
    chunk: byId.get(id)!,
    depth: depth.get(id)!,
    parent: parent.get(id)!,
    x: PAD + depth.get(id)! * (NODE_W + GAP_X),
    y: y.get(id) ?? PAD,
  }));

  const label = new Map(edges.map((e) => [`${e.from}>${e.to}`, e.label]));
  const out: GraphEdge[] = [];
  for (const id of ids) {
    const p = parent.get(id);
    if (!p) continue;
    out.push({ from: p, to: id, label: label.get(`${p}>${id}`), tree: true, long: false });
  }
  for (const e of edges) {
    if (parent.get(e.to) === e.from) continue;
    out.push({
      ...e,
      tree: false,
      long: Math.abs(depth.get(e.to)! - depth.get(e.from)!) !== 1,
    });
  }

  return {
    nodes,
    edges: out,
    roots,
    width: PAD * 2 + (maxDepth + 1) * (NODE_W + GAP_X) - GAP_X,
    height: Math.max(...nodes.map((n) => n.y)) + NODE_H + PAD,
    depth: maxDepth + 1,
  };
}

/**
 * Flatten one chunk into an ordered step list — the shape a generated test wants.
 * Parents come before their children, which is the order a run touches them.
 */
export function flatten(chunk: FlowChunk): { node: FlowNode; depth: number }[] {
  const out: { node: FlowNode; depth: number }[] = [];
  const visit = (node: FlowNode, depth: number) => {
    out.push({ node, depth });
    for (const child of childrenOf(chunk, node.id)) visit(child, depth + 1);
  };
  for (const root of rootsOf(chunk)) visit(root, 0);
  return out;
}

/**
 * Turning a point on the flow map into a list of browser steps.
 *
 * This is the piece that makes the map executable rather than descriptive. Given
 * a target node id — a field, a button, an assertion — it works out everything
 * that must happen first and emits an ordered plan a browser can follow.
 *
 * It lives in the Lambda, not the dashboard, on purpose. The plan contains
 * selectors, and /api/run-flow is public: if the browser composed the plan, the
 * endpoint would accept arbitrary selectors and the runner would execute them
 * against a signed-in staging admin. So the caller names a node and nothing
 * else, and this resolves it from the function's own copy of the map. The
 * dashboard's preview comes from here too, which is also what stops a preview
 * from quietly disagreeing with what actually runs.
 *
 * Four relationships in the map carry the traversal:
 *
 *   dependsOn  the chunks that must already have happened — mostly a sign-in
 *   parent     containment: a field is inside a section is inside a page
 *   opens      the 66 buttons that open a modal; the reverse link to its contents
 *   edges      how you reach the 13 chunks that have no page node of their own
 */

/** Verbs the runner knows. Anything else is a blocker, not a guess. */
export const VERBS = new Set([
  'goto', 'click', 'fill', 'select', 'check', 'assert',
  'clickMenuItem', 'clickTab', 'pickOption',
]);

/** Values are the one thing a caller may supply, so they are bounded. */
export const MAX_VALUE_LEN = 200;

export function indexFlow(flow) {
  const chunks = new Map(flow.chunks.map((c) => [c.id, c]));
  const nodes = new Map();
  const chunkOf = new Map();
  const order = new Map();
  const openerOf = new Map();
  const preds = new Map();

  for (const chunk of flow.chunks) {
    chunk.nodes.forEach((node, i) => {
      nodes.set(node.id, node);
      chunkOf.set(node.id, chunk.id);
      order.set(node.id, i);
      if (node.opens && !openerOf.has(node.opens)) openerOf.set(node.opens, node.id);
    });
  }
  for (const edge of flow.edges) {
    if (!preds.has(edge[1])) preds.set(edge[1], []);
    preds.get(edge[1]).push(edge[0]);
  }

  // The chunks other chunks name as their session. Fields inside one of these
  // are credentials, not data — the map says so only by implication, and
  // inventing an email for a login is the difference between signing in and
  // testing that a wrong address is rejected.
  const signIn = new Set();
  for (const chunk of flow.chunks) {
    for (const dep of chunk.dependsOn ?? []) {
      if (dep.kind === 'session' && dep.chunk) signIn.add(dep.chunk);
    }
  }
  return { flow, chunks, nodes, chunkOf, order, openerOf, preds, signIn };
}

const portalOf = (chunk) => chunk?.access?.portal ?? 'admin';

/**
 * The page a chunk is reached through.
 *
 * 13 chunks have no page node: they are sections and modals that live on
 * someone else's screen — documents hangs off the order, accounting off the
 * shipment. The edge graph says whose, so the page is inherited from a
 * predecessor. Crossing a portal boundary is not inheritance: the carrier
 * portal is a different sign-in at a different host, not a route away.
 */
export function pageFor(ix, chunkId, seen = new Set()) {
  if (seen.has(chunkId) || !ix.chunks.has(chunkId)) return null;
  seen.add(chunkId);
  const chunk = ix.chunks.get(chunkId);

  const own = chunk.nodes.find((n) => n.kind === 'page' && n.path);
  if (own) return own;

  // Same portal first. The four portals share one host and one /login — what
  // differs is which credentials go into it — so a cross-portal predecessor is
  // still a real route, just a worse first guess than a sibling screen.
  const sorted = [...(ix.preds.get(chunkId) ?? [])].sort(
    (a, b) => Number(portalOf(ix.chunks.get(b)) === portalOf(chunk))
            - Number(portalOf(ix.chunks.get(a)) === portalOf(chunk)),
  );
  for (const pred of sorted) {
    const inherited = pageFor(ix, pred, seen);
    if (inherited) return inherited;
  }
  return null;
}

/**
 * The containers a node sits inside, outermost first.
 *
 * Follows `parent` where there is one. A modal usually has no parent — it is a
 * root in the chunk, with its contents hanging off it — so the way in is the
 * button that opens it, and that button has containers of its own.
 */
export function containerChain(ix, nodeId, guard = new Set()) {
  if (guard.has(nodeId)) return [];
  guard.add(nodeId);
  const node = ix.nodes.get(nodeId);
  if (!node) return [];

  // `attachesTo` is the map's word for a control that lives inside another
  // control's UI — the items in a Radix menu, which are portaled out of the
  // card and do not exist in the DOM until the menu is open. The button that
  // owns the menu has to be clicked first, and it is not this node's parent:
  // the parent is the card both of them belong to.
  if (node.attachesTo && ix.nodes.has(node.attachesTo)) {
    return [...containerChain(ix, node.attachesTo, guard), node.attachesTo];
  }
  if (node.parent && ix.nodes.has(node.parent)) {
    return [...containerChain(ix, node.parent, guard), node.parent];
  }
  const opener = ix.openerOf.get(nodeId);
  if (opener && ix.nodes.has(opener)) {
    return [...containerChain(ix, opener, guard), opener];
  }
  return [];
}

const isPrefix = (short, long) =>
  short.length <= long.length && short.every((id, i) => long[i] === id);

/**
 * Is `node` on the target's branch of the chunk?
 *
 * Either it is one of the containers the target sits in — a prefix of the
 * target's chain — or it is deeper inside a container the target also sits in,
 * which is how a chunk's exit assertion relates to the form that produces it:
 * "Create order" exits on the order details page, and getting there means
 * filling in the modal the assertion itself is not inside. A sibling branch is
 * neither, which is what keeps the shipper form out of the carrier form's plan.
 */
const onSameBranch = (nodeChain, targetChain) =>
  isPrefix(nodeChain, targetChain) || isPrefix(targetChain, nodeChain);

/**
 * The selector to drive a node with.
 *
 * An item in a menu is the one case the map leaves implicit. It carries no
 * selector because it has no stable one — a Radix menu is portaled out of the
 * card and does not exist in the DOM until the menu opens — so the map
 * identifies it by the words on it instead, in `menuItemText` or, where the
 * node's own name is already the label, in `name`.
 */
export function selectorFor(node) {
  if (node.selector) return node.selector;
  if (node.attachesTo || node.menuItemText) {
    const label = node.menuItemText ?? node.name;
    if (label) return `[role="menuitem"]:has-text("${label.replace(/"/g, '\\"')}")`;
  }
  return undefined;
}

/** Why a node cannot be a step. Empty means it can. */
function nodeBlockers(ix, node) {
  const out = [];
  const chunk = ix.chunks.get(ix.chunkOf.get(node.id));
  if (chunk?.platform) out.push('a mobile screen — Playwright cannot drive Appium locators');
  if (node.template) out.push('the selector has a parameter the map does not fill');
  if (node.control === 'file') out.push('a file upload — the runner has nothing to upload');
  if (!selectorFor(node) && node.kind !== 'page') out.push('no selector is authored for it');
  return out.map((why) => ({ node: node.id, name: node.name, why }));
}

// ──────────────────────────────────────────────────────────────── values ──

/**
 * What the runner does with a control.
 *
 * The map names 22 control types. Grouping them by the gesture they need is
 * what keeps the runner from carrying 22 branches — and an unmapped control is
 * reported as a blocker rather than guessed at, because a wrong gesture on a
 * combobox looks like a product bug.
 */
const VERB_FOR_CONTROL = {
  text: 'fill', textarea: 'fill', email: 'fill', tel: 'fill', number: 'fill',
  money: 'fill', password: 'fill', date: 'fill', time: 'fill', datetime: 'fill',
  select: 'select', dropdown: 'select',
  checkbox: 'check', switch: 'check', toggleTile: 'check', radio: 'check',
  combobox: 'pickOption', autocomplete: 'pickOption', multiselect: 'pickOption',
  chips: 'pickOption',
};

const today = () => new Date().toISOString().slice(0, 10);

/**
 * A plausible value for a field, from its control type and its name.
 *
 * Everything typed is prefixed `QA` and carries the run's suffix, so a record
 * this leaves behind on staging is obvious and traceable. These are defaults,
 * not decisions: the dialog shows every one of them before anything runs.
 */
export function synthesize(node, run) {
  // A secret outside a sign-in screen is a password being set on an account
  // the run is creating. It still comes from the fixture, because the suite
  // registers accounts with the password it will later sign in as.
  if (node.secret) return { value: '{{cred:default.password}}', secret: true };
  if (Array.isArray(node.enum) && node.enum.length > 0) return { value: String(node.enum[0]) };

  const name = String(node.name ?? '').toLowerCase();
  const control = node.control ?? 'text';

  if (control === 'email' || name.includes('email')) return { value: `qa+${run}@cargomatic.com` };
  if (control === 'tel' || name.includes('phone')) return { value: '5551234567' };
  if (control === 'number') return { value: '1' };
  if (control === 'money' || name.includes('rate') || name.includes('amount')) return { value: '100' };
  if (control === 'date') return { value: today() };
  if (control === 'time') return { value: '09:00' };
  if (control === 'datetime') return { value: `${today()}T09:00` };
  if (control === 'checkbox' || control === 'switch' || control === 'toggleTile' || control === 'radio') {
    return { value: 'true' };
  }
  // A select is driven by position: the map knows the control, not the
  // account's data, and "the first real option" is the only choice that is
  // right on every environment.
  if (VERB_FOR_CONTROL[control] === 'select') return { value: '', byIndex: 1 };

  // A typeahead is different — it shows nothing until what you type matches a
  // record that exists. "QA" matches no shipper on staging, so the list never
  // opens and the step fails as if the selector were wrong. The suite's own
  // fixtures are the records guaranteed to be there, and configs/<env>.yaml
  // names them, so a search box for a party searches for that party.
  if (VERB_FOR_CONTROL[control] === 'pickOption') {
    for (const role of ['shipper', 'carrier', 'driver']) {
      if (name.includes(role)) return { value: `{{cred:${role}.first_name}}`, fixture: true };
    }
    if (name.includes('customer') || name.includes('master') || name.includes('account')) {
      return { value: '{{cred:shipper.first_name}}', fixture: true };
    }
    return { value: 'QA', byIndex: 0 };
  }

  if (name.includes('first')) return { value: 'QA' };
  if (name.includes('last')) return { value: 'Test' };
  if (name.includes('company')) return { value: `QA Co ${run}` };
  if (name.includes('zip') || name.includes('postal')) return { value: '90802' };
  if (name.includes('city')) return { value: 'Long Beach' };
  if (name.includes('state')) return { value: 'CA' };
  return { value: `QA ${run}` };
}

// ────────────────────────────────────────────────────────────────── plan ──

/** Map's action verbs to the runner's. Absent means "not a browser gesture". */
const VERB_FOR_ACTION = {
  click: 'click', submit: 'click',
  clickMenuItem: 'clickMenuItem', clickTab: 'clickTab', select: 'select',
};

/**
 * Does this action change something?
 *
 * The map marks a step's write in `api.await`, and flags the POSTs that are
 * really queries — this codebase POSTs to search in several places — with
 * `reads`. An action with a write behind it is one that moves the chunk
 * forward; one without is a button that reveals, expands or navigates, and on a
 * busy screen there are dozens of those.
 */
const isWrite = (node) => {
  const call = node.api?.await;
  return Boolean(call) && call.method !== 'GET' && !call.reads;
};

/**
 * Buttons that undo rather than advance.
 *
 * These fire no write, so `isWrite` already excludes them — but Cancel sitting
 * between a submit and the assertion it produces is the one mistake that would
 * look like a product failure rather than a planning one, so it is named
 * explicitly as well.
 */
const DISMISS = /^(cancel|close|dismiss|discard|back|reset|clear)\b/i;

/**
 * Chunks that must already have happened, nearest-first, cycles tolerated.
 *
 * Carries each dependency's `provides` with it, because *why* a chunk is needed
 * changes how far into it to run. A session dependency needs the chunk to
 * finish; a data dependency only needs to get as far as the step that captures
 * the variable, and running past that does work nobody asked for.
 */
export function chunkDeps(ix, chunkId, seen = new Set()) {
  const out = [];
  for (const dep of ix.chunks.get(chunkId)?.dependsOn ?? []) {
    const id = dep.chunk;
    if (!id || seen.has(id) || !ix.chunks.has(id)) continue;
    seen.add(id);
    out.push(...chunkDeps(ix, id, seen), { chunk: id, provides: dep.provides ?? [] });
  }
  return out;
}

/** The step in `chunkId` that captures `variable`, if one does. */
function captureNode(ix, chunkId, variable) {
  return ix.chunks.get(chunkId)?.nodes.find((n) => {
    const capture = n.api?.capture ?? n.capture;
    return capture && Object.prototype.hasOwnProperty.call(capture, variable);
  });
}

function stepFor(ix, node, why, run, overrides) {
  const portal = portalOf(ix.chunks.get(ix.chunkOf.get(node.id)));
  const credential = ix.signIn.has(ix.chunkOf.get(node.id));
  const base = { node: node.id, name: node.name, selector: selectorFor(node), why, chunk: ix.chunkOf.get(node.id) };
  if (node.api?.await) {
    base.await = { method: node.api.await.method, path: node.api.await.path, timeoutMs: node.api.await.timeoutMs };
  }
  if (node.settleMs ?? node.api?.settleMs) base.settleMs = node.api?.settleMs ?? node.settleMs;
  // Flow variables this step produces. Two shapes: a JSON Pointer into the
  // response the step awaited, or `href:<regex>` read off the element itself,
  // for the steps that navigate rather than write.
  const capture = node.api?.capture ?? node.capture;
  if (capture) base.capture = capture;
  // `then` is the map's record of what a control needs after the first gesture:
  // which list the suggestions appear in, and what to click in it. Every
  // typeahead in this app draws its own, so there is no generic option selector
  // worth guessing at — and guessing produced a timeout that named the input
  // rather than the list, which sent me looking in the wrong place entirely.
  if (node.then?.length) {
    base.follow = node.then.map((f) => ({ action: f.action, selector: f.selector }));
  }

  if (node.kind === 'page') return { ...base, verb: 'goto', path: node.path, selector: undefined };

  if (node.kind === 'field') {
    const verb = VERB_FOR_CONTROL[node.control ?? 'text'];
    if (!verb) return { ...base, verb: 'unsupported', detail: `control "${node.control}"` };
    if (verb === 'pickOption' && !base.follow) {
      return { ...base, verb: 'unsupported', detail: `a ${node.control} with no "then" saying which list its suggestions appear in` };
    }
    // Every field on a sign-in screen is a credential, including the one that
    // is only an email address. These resolve on the runner from the suite's
    // own configs/<env>.yaml, so no credential is ever in the plan, in the
    // dialog, or in the log.
    const synthesized = credential
      ? { value: `{{cred:${portal}.${node.secret ? 'password' : 'username'}}}`, secret: true }
      : synthesize(node, run);
    const given = Object.prototype.hasOwnProperty.call(overrides, node.id) ? overrides[node.id] : null;
    return {
      ...base,
      verb,
      control: node.control ?? 'text',
      ...synthesized,
      ...(given !== null && !synthesized.secret ? { value: String(given) } : {}),
    };
  }

  if (node.kind === 'assert') {
    return { ...base, verb: 'assert', expect: node.expect ?? 'visible' };
  }

  if (node.kind === 'action') {
    const verb = VERB_FOR_ACTION[node.action ?? 'click'];
    if (!verb) return { ...base, verb: 'unsupported', detail: `action "${node.action}"` };
    return {
      ...base,
      verb,
      ...(node.menuItemText ? { text: node.menuItemText } : {}),
      ...(node.tabText ? { text: node.tabText } : {}),
      ...(node.destructive ? { destructive: true } : {}),
    };
  }
  // A section or a modal, reached as a target in its own right: prove it rendered.
  return { ...base, verb: 'assert', expect: 'visible' };
}

/**
 * Steps inside one chunk, up to and including `targetId`.
 *
 * Authored order is the running order — the map is written the way a tester
 * walks the screen. What gets included is everything on the target's own branch
 * that precedes it: the containers it sits in, the buttons that open them, and
 * the fields the form will refuse to submit without.
 *
 * Optional fields are left alone. Preceding *actions* come along only when the
 * target is an assertion, because that is the "show me this screen reaches this
 * state" case — a sign-in is exactly that, and `auth`'s exit is an assert on the
 * nav. When the target is itself an action, its siblings are other buttons on
 * the same form and pressing them would be someone else's test.
 */
function stepsWithin(ix, chunkId, targetId, run, overrides, isTarget = true) {
  const chunk = ix.chunks.get(chunkId);
  const target = ix.nodes.get(targetId);
  const steps = [];
  const blockers = [];

  const page = pageFor(ix, chunkId);
  if (!page) {
    blockers.push({
      node: targetId,
      name: chunk.name,
      why: `no route to a page — ${chunkId} has no page node and nothing on the ${portalOf(chunk)} portal leads to it`,
    });
    return { steps, blockers };
  }
  if (target.kind !== 'page') steps.push(stepFor(ix, page, `the ${chunk.name} screen`, run, overrides));

  const chain = containerChain(ix, targetId);
  const inChain = new Set(chain);
  const targetIsAssert = target.kind === 'assert';
  const targetOrder = ix.order.get(targetId);
  let skippedOptional = null;

  // Anything the map authors *before* the chunk's own page node is a way in
  // from somewhere else — the nav link that opens Order Booking, say. Having
  // already navigated straight there, clicking the link again is at best a
  // reload and at worst a click on something this screen does not show.
  const ownPage = chunk.nodes.find((n) => n.kind === 'page' && n.path);
  const entryOrder = ownPage ? ix.order.get(ownPage.id) : -1;

  for (const node of chunk.nodes) {
    if (ix.order.get(node.id) >= targetOrder) break;
    if (node.kind === 'page') continue;
    if (ix.order.get(node.id) < entryOrder && !inChain.has(node.id)) continue;
    if (!onSameBranch(containerChain(ix, node.id), chain) && !inChain.has(node.id)) continue;

    if (inChain.has(node.id)) {
      // Containers themselves need no gesture; the button that opens one does.
      if (node.kind === 'action') {
        blockers.push(...nodeBlockers(ix, node));
        steps.push(stepFor(ix, node, 'opens the next layer', run, overrides));
      }
      continue;
    }

    if (node.kind === 'field') {
      // Only a typeahead we skipped can orphan a following action. Any other
      // optional field is just a field, and treating it as a guard swallowed
      // "Add equipment row" — the button that creates the required inputs
      // directly below an optional free-text box.
      if (!node.required) {
        skippedOptional = VERB_FOR_CONTROL[node.control ?? 'text'] === 'pickOption' ? node.id : null;
        continue;
      }
      blockers.push(...nodeBlockers(ix, node));
      steps.push(stepFor(ix, node, 'the form requires it', run, overrides));
      skippedOptional = null;
      continue;
    }

    if (node.kind === 'action') {
      // An action right after an optional field we skipped is that field's
      // follow-through — picking an autocomplete result nobody typed into.
      if (skippedOptional && node.parent === ix.nodes.get(skippedOptional)?.parent) continue;
      if (node.destructive || node.template || node.scopedToRow || node.repeatable) continue;
      if (DISMISS.test(node.name ?? '')) continue;

      // A button standing between us and a field we have to fill is part of
      // getting to that field, not a step of its own: "Add equipment row" is
      // what creates the inputs the form then refuses to submit without.
      const opensAField = chunk.nodes.some(
        (n) => n.parent === node.parent && n.kind === 'field' && n.required
          && ix.order.get(n.id) > ix.order.get(node.id) && ix.order.get(n.id) < targetOrder,
      );
      if (!opensAField && !(targetIsAssert && isWrite(node))) continue;

      blockers.push(...nodeBlockers(ix, node));
      steps.push(stepFor(ix, node, opensAField ? 'reveals the fields below it' : 'the write that produces this state', run, overrides));
    }
  }

  blockers.push(...nodeBlockers(ix, target));
  steps.push(stepFor(
    ix,
    target,
    isTarget ? 'the step you picked' : `proves ${chunk.name} got where it needed to`,
    run,
    overrides,
  ));
  return { steps, blockers };
}

/**
 * The whole plan for a target: prerequisites first, the step you picked last.
 *
 * A prerequisite chunk is run to its own exit node, which is the map's statement
 * of "this chunk finished successfully" — for `auth` that is the nav bar being
 * present, so running `auth` to its exit is a sign-in.
 */
export function buildPlan(ix, targetId, { run = '0000', values = {} } = {}) {
  const target = ix.nodes.get(targetId);
  if (!target) return { error: `No node "${targetId}" in the flow map.` };

  const chunkId = ix.chunkOf.get(targetId);
  const chunk = ix.chunks.get(chunkId);
  const steps = [];
  const blockers = [];

  for (const seed of chunk.dependsOn ?? []) {
    if (seed.kind === 'seeded') {
      blockers.push({
        node: targetId,
        name: chunk.name,
        why: `needs ${seed.variable ?? 'data'} to already exist — ${seed.why ?? 'the fixture supplies it, no chunk does'}`,
      });
    }
  }

  const chain = [...chunkDeps(ix, chunkId), { chunk: chunkId, provides: [] }];
  for (const { chunk: id, provides } of chain) {
    const isTargetChunk = id === chunkId;
    let stop = isTargetChunk ? targetId : ix.chunks.get(id)?.exit;

    // A chunk depended on for a variable is run to the step that produces it.
    // That step is often past the exit — the exit of "Leg management" is the
    // table being rendered, but {jobId} only exists once a row has been opened.
    if (!isTargetChunk && provides.length > 0) {
      const producer = provides.map((v) => captureNode(ix, id, v)).find(Boolean);
      if (producer) stop = producer.id;
    }

    if (!stop || !ix.nodes.has(stop)) {
      blockers.push({ node: id, name: ix.chunks.get(id)?.name ?? id, why: 'the chunk declares no exit node to run to' });
      continue;
    }
    const got = stepsWithin(ix, id, stop, run, values, isTargetChunk);
    steps.push(...got.steps);
    blockers.push(...got.blockers);
  }

  // A goto that repeats the page we are already on is a reload that throws away
  // the state the previous steps just built.
  const compact = [];
  for (const step of steps) {
    const last = compact[compact.length - 1];
    if (step.verb === 'goto' && compact.some((s) => s.verb === 'goto' && s.path === step.path)
        && !compact.slice(compact.findIndex((s) => s.verb === 'goto' && s.path === step.path)).some((s) => s.verb === 'goto' && s.path !== step.path)) {
      continue;
    }
    if (last && last.verb === 'goto' && step.verb === 'goto' && last.path === step.path) continue;
    compact.push(step);
  }

  for (const step of compact) {
    if (step.verb === 'unsupported') {
      blockers.push({ node: step.node, name: step.name, why: `${step.detail} is not a gesture the runner knows` });
    }
  }

  // A plan that still mentions {orderId} by the time it runs has nothing to put
  // there. Variables are produced by earlier steps, so the check is positional:
  // captured before it is referenced, or it is a hole.
  const produced = new Set();
  for (const step of compact) {
    for (const [, name] of String(step.path ?? '').matchAll(/\{([a-zA-Z][\w]*)\}/g)) {
      if (!produced.has(name)) {
        blockers.push({ node: step.node, name: step.name, why: `needs {${name}}, which no earlier step captures` });
      }
    }
    for (const [, name] of String(step.selector ?? '').matchAll(/\{([a-zA-Z][\w]*)\}/g)) {
      if (!produced.has(name)) {
        blockers.push({ node: step.node, name: step.name, why: `needs {${name}}, which no earlier step captures` });
      }
    }
    for (const name of Object.keys(step.capture ?? {})) produced.add(name);
  }

  const seen = new Set();
  const unique = blockers.filter((b) => {
    const key = `${b.node}|${b.why}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  return {
    target: targetId,
    targetName: target.name,
    chunk: chunkId,
    chunkName: chunk.name,
    portal: portalOf(chunk),
    baseUrl: ix.flow.env?.baseUrl,
    chunks: chain.map((c) => c.chunk),
    steps: compact,
    blockers: unique,
    runnable: unique.length === 0,
  };
}

/** Fields in a plan a person may reasonably want to change before running. */
export function editableFields(plan) {
  return plan.steps
    .filter((s) => s.value !== undefined && !s.secret && s.verb !== 'goto')
    .map((s) => ({ node: s.node, name: s.name, control: s.control, value: s.value, chunk: s.chunk }));
}

/**
 * Values are the only thing a caller supplies, so they are checked rather than
 * trusted: they go into a browser the runner has signed in as an admin, and a
 * newline or a control character is how a typed value stops being just a value.
 */
export function cleanValues(raw) {
  const out = {};
  const rejected = [];
  for (const [key, value] of Object.entries(raw ?? {})) {
    if (!/^[A-Za-z0-9_.-]{1,80}$/.test(key)) { rejected.push(key); continue; }
    const text = String(value ?? '');
    if (text.length > MAX_VALUE_LEN) { rejected.push(key); continue; }
    if (/[\u0000-\u001f\u007f]/.test(text)) { rejected.push(key); continue; }
    out[key] = text;
  }
  return { values: out, rejected };
}

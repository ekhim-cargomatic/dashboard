import { useEffect, useMemo, useRef, useState } from 'react';
import {
  NODE_H,
  NODE_W,
  dependencyClosure,
  dependents,
  directDeps,
  layoutTree,
  mutatingNodes,
  unverifiedWrites,
  type Flow,
  type GraphNode,
} from '../lib/flow';

/**
 * The chunk graph, drawn as a tree.
 *
 * Layering every chunk by its longest path made parallel work look sequential:
 * shorthaul booking landed deep in the picture because closing a shorthaul
 * shipment eventually reaches billing, even though you can book one without
 * touching drayage at all. A tree says the true thing — one parent each,
 * branches that fan out from the sign-in — and the joins that do exist are
 * drawn as cross-links on top rather than folded into the spine.
 *
 * Solid elbows are the tree. Dashed curves are cross-links: a real connection
 * between branches that is not a prerequisite. Selecting a chunk lights its
 * ancestry and everything that hangs off it.
 */

interface Props {
  flow: Flow;
  selected: string | null;
  onSelect: (id: string) => void;
}

/** Org-chart elbow: out of the parent, across the gutter, down to the child. */
function elbow(x1: number, y1: number, x2: number, y2: number): string {
  const mx = (x1 + x2) / 2;
  if (Math.abs(y1 - y2) < 1) return `M ${x1} ${y1} L ${x2} ${y2}`;
  const dir = y2 > y1 ? 1 : -1;
  const r = Math.min(10, Math.abs(y2 - y1) / 2, Math.abs(mx - x1));
  return [
    `M ${x1} ${y1}`,
    `L ${mx - r} ${y1}`,
    `Q ${mx} ${y1} ${mx} ${y1 + dir * r}`,
    `L ${mx} ${y2 - dir * r}`,
    `Q ${mx} ${y2} ${mx + r} ${y2}`,
    `L ${x2} ${y2}`,
  ].join(' ');
}

/** Cross-links bow out of the way of the tree they are drawn over. */
function bow(x1: number, y1: number, x2: number, y2: number, long: boolean): string {
  const dx = Math.max(48, (x2 - x1) * (long ? 0.5 : 0.4));
  return `M ${x1} ${y1} C ${x1 + dx} ${y1}, ${x2 - dx} ${y2}, ${x2} ${y2}`;
}

/**
 * The variant as a badge, not a sentence.
 *
 * `leg_management_version === 2` is 28 characters and the chunk id sits on the
 * same line, so printed in full it lands on top of it. Initials and the value
 * fit; the tooltip and the detail panel carry the real thing.
 */
function variantBadge(variant: { field: string; test: string }): string {
  const initials = variant.field
    .split(/[_\s]+|(?=[A-Z])/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase())
    .join('');
  const value = variant.test.replace(/[=\s]+/g, '').replace('!', '≠');
  return `${initials} ${value || variant.test}`;
}

/** The bottom-left line of a node. */
function meta(chunk: { nodes: unknown[] }, writes: number, gaps: number): string {
  return `${chunk.nodes.length} steps · ${writes}w${gaps > 0 ? ` · ${gaps} unverified` : ''}`;
}

/**
 * Captured variables, right-aligned on the same line as the meta — so it has to
 * give way rather than overprint it. Two variables and a long step count do not
 * both fit in 188px; the tooltip carries the full list either way.
 */
/** Trim a label to the pixels available, with an ellipsis if it had to give. */
function fit(text: string, room: number, charWidth: number): string {
  const max = Math.floor(room / charWidth);
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

function providesLabel(provides: string[], metaText: string): string {
  const CH = 5.6;
  const room = NODE_W - 24 - metaText.length * 5.9 - 8;
  const full = provides.map((v) => `{${v}}`).join(' ');
  if (full.length * CH <= room) return full;
  const short = provides.length > 1 ? `{${provides[0]}} +${provides.length - 1}` : full;
  if (short.length * CH <= room) return short;
  return `+${provides.length}`;
}

/**
 * Who can run the selected chunk, on the canvas.
 *
 * The detail panel below already lists the role checks, but answering "can this
 * person do this" meant selecting a node, looking away from the tree, reading,
 * and looking back — and the question is usually asked about several chunks in
 * a row. This puts the answer next to the node you just clicked. It is an HTML
 * overlay rather than SVG so it can wrap text and sit above everything without
 * fighting the node z-order.
 */
function PermissionCard({ node }: { node: GraphNode }) {
  const access = node.chunk.access;
  if (!access) return null;
  const roles = [...new Set((access.requires ?? []).flatMap((r) => r.roles))];
  return (
    <div
      className="fg-perm"
      style={{ left: node.x, top: node.y + NODE_H + 10, width: NODE_W * 2 }}
      role="note"
    >
      <div className="fg-perm-head">
        <span className={`fm-portal fm-portal-${access.portal}`}>{access.portal}</span>
        {node.chunk.platform && <span className="fm-platform">{node.chunk.platform}</span>}
        {node.chunk.variant && (
          <code className="fm-variant-test">
            {node.chunk.variant.field} {node.chunk.variant.test}
          </code>
        )}
      </div>
      {roles.length > 0 ? (
        <>
          <div className="fg-perm-roles">
            {roles.map((role) => <code key={role} className="fm-role">{role}</code>)}
          </div>
          <ul className="fg-perm-list">
            {(access.requires ?? []).map((req) => (
              <li key={`${req.guard}-${req.source}`}>
                <span className="fg-perm-gates">{req.gates}</span>
                <code>{req.guard}</code>
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="fg-perm-open">No role check in the code — any signed-in user of this portal.</p>
      )}
    </div>
  );
}

export function FlowGraph({ flow, selected, onSelect }: Props) {
  const layout = useMemo(() => layoutTree(flow), [flow]);
  const scroller = useRef<HTMLDivElement>(null);
  const [showCross, setShowCross] = useState(true);

  const parentOf = useMemo(
    () => new Map(layout.nodes.map((n) => [n.id, n.parent])),
    [layout],
  );
  const kidsOf = useMemo(() => {
    const m = new Map<string, string[]>(layout.nodes.map((n) => [n.id, []]));
    for (const n of layout.nodes) if (n.parent) m.get(n.parent)!.push(n.id);
    return m;
  }, [layout]);

  // Upstream is the tree ancestry plus anything the chunk declares it needs;
  // downstream is its subtree plus anything that declares it needs this chunk.
  const { upstream, downstream } = useMemo(() => {
    if (!selected) return { upstream: new Set<string>(), downstream: new Set<string>() };
    const up = new Set(dependencyClosure(flow, selected));
    for (let cur = parentOf.get(selected) ?? null; cur; cur = parentOf.get(cur) ?? null) {
      if (up.has(cur)) break;
      up.add(cur);
    }
    const down = new Set(dependents(flow, selected));
    const stack = [...(kidsOf.get(selected) ?? [])];
    while (stack.length > 0) {
      const id = stack.pop()!;
      if (down.has(id)) continue;
      down.add(id);
      stack.push(...(kidsOf.get(id) ?? []));
    }
    return { upstream: up, downstream: down };
  }, [flow, selected, parentOf, kidsOf]);

  const pos = useMemo(() => new Map(layout.nodes.map((n) => [n.id, n])), [layout]);

  // Selection often arrives from a dependency link in the detail panel rather
  // than from a click on the canvas, and the target is usually off-screen —
  // the tree is several screens wide. Bring it into view.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !selected) return;
    const node = pos.get(selected);
    if (!node) return;
    box.scrollTo({
      left: Math.max(0, node.x + NODE_W / 2 - box.clientWidth / 2),
      top: Math.max(0, node.y + NODE_H / 2 - box.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [selected, pos]);

  const dimmed = (id: string) =>
    Boolean(selected) && id !== selected && !upstream.has(id) && !downstream.has(id);

  const drawn = showCross ? layout.edges : layout.edges.filter((e) => e.tree);
  const crossCount = layout.edges.filter((e) => !e.tree).length;

  return (
    <div className="fg-wrap">
      <div className="fg-tools">
        <span className="fg-legend">
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="25" y2="4" className="fg-key-tree" />
          </svg>
          runs next
        </span>
        <label className="fg-toggle">
          <input
            type="checkbox"
            checked={showCross}
            onChange={(ev) => setShowCross(ev.target.checked)}
          />
          <svg width="26" height="8" aria-hidden="true">
            <line x1="1" y1="4" x2="25" y2="4" className="fg-key-cross" />
          </svg>
          cross-links ({crossCount})
        </label>
        <span className="muted fg-hint">
          {layout.nodes.length} chunks · {layout.depth} levels · branches are independent
        </span>
      </div>

      <div className="fg-scroll" ref={scroller}>
        <div className="fg-canvas" style={{ width: layout.width, height: layout.height }}>
        <svg
          className="fg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          role="img"
          aria-label={`${flow.chunks.length} chunks as a tree, ${layout.depth} levels deep`}
        >
          <defs>
            <marker id="fg-arrow" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fg-arrowhead" />
            </marker>
            <marker id="fg-arrow-hot" viewBox="0 0 8 8" refX="7" refY="4"
                    markerWidth="7" markerHeight="7" orient="auto-start-reverse">
              <path d="M0,0 L8,4 L0,8 z" className="fg-arrowhead-hot" />
            </marker>
          </defs>

          <g className="fg-edges">
            {drawn.map((e, i) => {
              const a = pos.get(e.from);
              const b = pos.get(e.to);
              if (!a || !b) return null;
              const x1 = a.x + NODE_W;
              const y1 = a.y + NODE_H / 2;
              const x2 = b.x;
              const y2 = b.y + NODE_H / 2;
              const hot = selected !== null && (e.from === selected || e.to === selected);
              const faded = Boolean(selected) && !hot;
              const cls = [
                e.tree ? 'is-tree' : 'is-cross',
                hot ? 'is-hot' : faded ? 'is-faded' : '',
              ].join(' ');
              return (
                <g key={`${e.from}->${e.to}-${i}`} className={cls}>
                  <path
                    d={e.tree ? elbow(x1, y1, x2, y2) : bow(x1, y1, x2, y2, e.long)}
                    className="fg-edge"
                    markerEnd={`url(#${hot ? 'fg-arrow-hot' : 'fg-arrow'})`}
                  />
                  <title>
                    {`${e.from} → ${e.to}${e.label ? `: ${e.label}` : ''}`
                      + (e.tree ? '' : '\ncross-link — a connection, not a prerequisite')}
                  </title>
                </g>
              );
            })}
          </g>

          <g className="fg-nodes">
            {layout.nodes.map((n) => {
              const writes = mutatingNodes(n.chunk).length;
              const gaps = unverifiedWrites(n.chunk).length;
              const deps = directDeps(n.chunk).length;
              const state = n.id === selected
                ? 'is-selected'
                : upstream.has(n.id)
                  ? 'is-upstream'
                  : downstream.has(n.id)
                    ? 'is-downstream'
                    : dimmed(n.id)
                      ? 'is-dimmed'
                      : '';
              return (
                <g
                  key={n.id}
                  className={`fg-node fg-portal-${n.chunk.access?.portal ?? 'admin'}`
                    + `${n.chunk.platform ? ' is-mobile' : ''}`
                    + `${n.chunk.variant ? ' is-variant' : ''} ${state}`}
                  transform={`translate(${n.x} ${n.y})`}
                  onClick={() => onSelect(n.id)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(ev) => {
                    if (ev.key === 'Enter' || ev.key === ' ') {
                      ev.preventDefault();
                      onSelect(n.id);
                    }
                  }}
                >
                  <title>
                    {`${n.chunk.name}\n${n.chunk.nodes.length} steps · ${writes} writes`
                      + (deps ? `\nneeds ${deps} chunk${deps === 1 ? '' : 's'}` : '')
                      + (n.chunk.provides?.length ? `\nprovides ${n.chunk.provides.join(', ')}` : '')
                      + (n.chunk.access ? `\n${n.chunk.access.portal} portal`
                          + (n.chunk.access.gated
                              ? ` · roles: ${[...new Set((n.chunk.access.requires ?? [])
                                  .flatMap((r) => r.roles))].join(', ')}`
                              : ' · no role check')
                        : '')
                      + (n.chunk.variant
                          ? `\nonly when ${n.chunk.variant.field} ${n.chunk.variant.test}`
                          : '')}
                  </title>
                  <rect className="fg-box" width={NODE_W} height={NODE_H} rx="10" />
                  <rect className="fg-portal-bar" width="4" height={NODE_H} rx="2" />
                  {n.chunk.variant && (
                    <text className="fg-variant" x={NODE_W - 12} y="41" textAnchor="end">
                      {variantBadge(n.chunk.variant)}
                    </text>
                  )}
                  {n.chunk.platform && (
                    <text className="fg-platform" x={NODE_W - 12} y="24" textAnchor="end">mobile</text>
                  )}
                  <text className="fg-title" x="12" y="24">
                    {n.chunk.name.length > 26 ? `${n.chunk.name.slice(0, 25)}…` : n.chunk.name}
                  </text>
                  <text className="fg-id" x="12" y="41">
                    {n.chunk.variant
                      ? fit(n.id, NODE_W - 24 - variantBadge(n.chunk.variant).length * 5.6 - 8, 5.9)
                      : n.id}
                  </text>
                  <text className="fg-meta" x="12" y="57">{meta(n.chunk, writes, gaps)}</text>
                  {n.chunk.provides?.length ? (
                    <text className="fg-provides" x={NODE_W - 12} y="57" textAnchor="end">
                      {providesLabel(n.chunk.provides, meta(n.chunk, writes, gaps))}
                    </text>
                  ) : null}
                </g>
              );
            })}
          </g>
        </svg>
        {selected && pos.get(selected) && <PermissionCard node={pos.get(selected)!} />}
        </div>
      </div>
    </div>
  );
}

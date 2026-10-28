import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
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
 *
 * At 49 chunks the tree is several screens wide at 1:1, so it pans and zooms.
 * Zoom is a transform on the canvas rather than a viewBox change, because the
 * scroll container then keeps real scrollbars and the browser keeps doing the
 * panning — a viewBox would mean reimplementing both.
 */

interface Props {
  flow: Flow;
  selected: string | null;
  onSelect: (id: string) => void;
}

const MIN_SCALE = 0.12;
const MAX_SCALE = 2.5;
/** One notch of the +/− buttons. A ratio, so every step feels the same size. */
const STEP = 1.25;

const clamp = (n: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, n));

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
 * fit; the tooltip and the detail dialog carry the real thing.
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

export function FlowGraph({ flow, selected, onSelect }: Props) {
  const layout = useMemo(() => layoutTree(flow), [flow]);
  const wrap = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLDivElement>(null);
  const [showCross, setShowCross] = useState(true);
  const [scale, setScale] = useState(1);
  const [panning, setPanning] = useState(false);
  const [isFullscreen, setFullscreen] = useState(false);

  // Wheel runs off a native listener (it has to preventDefault, which React's
  // passive listener cannot), so it reads the scale from a ref rather than
  // from a closure that would be one render stale.
  const scaleRef = useRef(scale);
  scaleRef.current = scale;

  /**
   * Where to put the scroll after a zoom, in graph coordinates.
   *
   * Scaling about the top-left corner moves whatever you were looking at, so
   * every zoom records the graph point under the cursor and the pixel it sat
   * at; the layout effect below puts it back there once React has resized the
   * canvas. Doing it in a rAF instead raced the repaint and flickered.
   */
  const anchor = useRef<{ gx: number; gy: number; ax: number; ay: number } | null>(null);

  useLayoutEffect(() => {
    const box = scroller.current;
    const a = anchor.current;
    anchor.current = null;
    if (!box || !a) return;
    box.scrollLeft = a.gx * scale - a.ax;
    box.scrollTop = a.gy * scale - a.ay;
  }, [scale]);

  /** Zoom to `next`, holding the client point (default: the view's centre). */
  const zoomTo = useCallback((next: number, clientX?: number, clientY?: number) => {
    const box = scroller.current;
    if (!box) return;
    const target = clamp(next);
    if (Math.abs(target - scaleRef.current) < 0.0005) return;
    const rect = box.getBoundingClientRect();
    const ax = clientX === undefined ? box.clientWidth / 2 : clientX - rect.left;
    const ay = clientY === undefined ? box.clientHeight / 2 : clientY - rect.top;
    anchor.current = {
      gx: (box.scrollLeft + ax) / scaleRef.current,
      gy: (box.scrollTop + ay) / scaleRef.current,
      ax,
      ay,
    };
    setScale(target);
  }, []);

  /** Whole tree in view. Rarely readable at 49 chunks, but it orients you. */
  const zoomToFit = useCallback(() => {
    const box = scroller.current;
    if (!box) return;
    const pad = 16;
    zoomTo(Math.min(
      (box.clientWidth - pad) / layout.width,
      (box.clientHeight - pad) / layout.height,
    ));
  }, [layout.width, layout.height, zoomTo]);

  // ⌘/ctrl + wheel, and trackpad pinch, which arrives as a ctrlKey wheel.
  useEffect(() => {
    const box = scroller.current;
    if (!box) return;
    const onWheel = (ev: WheelEvent) => {
      if (!ev.ctrlKey && !ev.metaKey) return; // a plain wheel still scrolls
      ev.preventDefault();
      zoomTo(scaleRef.current * Math.exp(-ev.deltaY / 300), ev.clientX, ev.clientY);
    };
    box.addEventListener('wheel', onWheel, { passive: false });
    return () => box.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  useEffect(() => {
    const onChange = () => setFullscreen(document.fullscreenElement === wrap.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  const toggleFullscreen = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void wrap.current?.requestFullscreen?.().catch(() => undefined);
  };

  /** Drag the background to pan. A drag that starts on a node is a click. */
  const startPan = (ev: React.PointerEvent) => {
    const box = scroller.current;
    if (!box || ev.button !== 0) return;
    if ((ev.target as Element).closest('.fg-node')) return;
    const fromX = ev.clientX;
    const fromY = ev.clientY;
    const { scrollLeft, scrollTop } = box;
    setPanning(true);
    const move = (e: PointerEvent) => {
      box.scrollLeft = scrollLeft - (e.clientX - fromX);
      box.scrollTop = scrollTop - (e.clientY - fromY);
    };
    const stop = () => {
      setPanning(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
  };

  const onKeyDown = (ev: React.KeyboardEvent) => {
    if (ev.target instanceof HTMLInputElement) return;
    if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); zoomTo(scale * STEP); }
    else if (ev.key === '-' || ev.key === '_') { ev.preventDefault(); zoomTo(scale / STEP); }
    else if (ev.key === '0') { ev.preventDefault(); zoomTo(1); }
    else if (ev.key === 'f') { ev.preventDefault(); zoomToFit(); }
  };

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

  // Selection often arrives from a dependency link in the dialog rather than
  // from a click on the canvas, and the target is usually off-screen — the tree
  // is several screens wide. Bring it into view, in whatever zoom is current.
  useEffect(() => {
    const box = scroller.current;
    if (!box || !selected) return;
    const node = pos.get(selected);
    if (!node) return;
    const z = scaleRef.current;
    box.scrollTo({
      left: Math.max(0, (node.x + NODE_W / 2) * z - box.clientWidth / 2),
      top: Math.max(0, (node.y + NODE_H / 2) * z - box.clientHeight / 2),
      behavior: 'smooth',
    });
  }, [selected, pos]);

  const dimmed = (id: string) =>
    Boolean(selected) && id !== selected && !upstream.has(id) && !downstream.has(id);

  const drawn = showCross ? layout.edges : layout.edges.filter((e) => e.tree);
  const crossCount = layout.edges.filter((e) => !e.tree).length;

  return (
    <div className={`fg-wrap${isFullscreen ? ' is-fullscreen' : ''}`} ref={wrap}>
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

        <span className="fg-zoom" role="group" aria-label="Zoom">
          <button type="button" onClick={() => zoomTo(scale / STEP)} title="Zoom out (−)" aria-label="Zoom out">−</button>
          <button type="button" className="fg-zoom-level" onClick={() => zoomTo(1)} title="Reset to 100% (0)">
            {Math.round(scale * 100)}%
          </button>
          <button type="button" onClick={() => zoomTo(scale * STEP)} title="Zoom in (+)" aria-label="Zoom in">+</button>
          <button type="button" className="fg-zoom-fit" onClick={zoomToFit} title="Fit the whole tree (f)">fit</button>
        </span>
        <button
          type="button"
          className="fg-fullscreen"
          onClick={toggleFullscreen}
          aria-pressed={isFullscreen}
        >
          {isFullscreen ? 'exit full screen' : 'full screen'}
        </button>

        <span className="muted fg-hint">
          {layout.nodes.length} chunks · {layout.depth} levels · drag to pan · ⌘-scroll to zoom
        </span>
      </div>

      <div
        className={`fg-scroll${panning ? ' is-panning' : ''}`}
        ref={scroller}
        onPointerDown={startPan}
        onKeyDown={onKeyDown}
        tabIndex={0}
        role="application"
        aria-label="Flow chunk tree"
      >
        <div
          className="fg-canvas"
          style={{ width: layout.width * scale, height: layout.height * scale }}
        >
        <svg
          className="fg"
          width={layout.width}
          height={layout.height}
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          style={{ transform: `scale(${scale})`, transformOrigin: '0 0' }}
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
        </div>
      </div>
    </div>
  );
}

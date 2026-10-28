import { useEffect, useMemo, useRef, useState } from 'react';
import { FlowGraph } from './FlowGraph';
import { ChunkDialog } from './ChunkDialog';
import {
  loadFlow,
  loadFlowIndex,
  mutatingNodes,
  unverifiedWrites,
  type Flow,
  type FlowIndex,
  type FlowNode,
} from '../lib/flow';

/**
 * The app as a graph, behind ?qa=1.
 *
 * Two views over the same file. The map answers "what is the shape of the
 * product and which pieces can I test on their own"; the detail answers "what
 * exactly does this piece touch". Each chunk is written to be runnable alone —
 * the point of the file is to be read by a generator later, so everything a
 * generator needs (selector, control type, the write, the read-back that proves
 * the write) lives on the node rather than in prose next to it.
 *
 * The map is the page: it takes whatever height the window has left, and the
 * detail opens over it. Side by side, neither fitted — the tree is several
 * screens wide and a chunk's steps run to a few hundred lines — so the two were
 * permanently fighting for the same pixels.
 */

/**
 * The reading matter: what the map is, what the variables mean, what is not in
 * it yet. All three are things you read once and then want out of the way, so
 * they live behind a button rather than above the graph taking a fifth of it.
 */
function AboutDialog({ flow, index, onClose }: {
  flow: Flow; index: FlowIndex; onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); }, []);

  return (
    <dialog
      className="fm-dialog fm-dialog-about"
      ref={ref}
      onClose={onClose}
      onClick={(ev) => { if (ev.target === ref.current) ref.current?.close(); }}
      aria-label="About this flow map"
    >
      <div className="fm-dialog-panel">
        <div className="fm-detail-head">
          <h3>{flow.name}</h3>
          <button
            type="button"
            className="fm-dialog-close"
            onClick={() => ref.current?.close()}
            aria-label="Close"
            title="Close (Esc)"
          >
            ✕
          </button>
        </div>
        <div className="fm-dialog-body fm-about">
          {flow.description && <p className="fm-desc">{flow.description}</p>}
          <p className="muted">
            Each chunk is written to run on its own: an <code>entry</code>, an{' '}
            <code>exit</code>, and whatever earlier nodes it needs listed in{' '}
            <code>requires</code>. The selector on every step is byte-identical to the
            page-object constant named beside it, so a generator can emit a test without
            guessing.
          </p>

          {flow.variables && Object.keys(flow.variables).length > 0 && (
            <>
              <h4>Variables</h4>
              <dl className="fm-vars">
                {Object.entries(flow.variables).map(([k, v]) => (
                  <div key={k}><dt><code>{`{${k}}`}</code></dt><dd>{v}</dd></div>
                ))}
              </dl>
            </>
          )}

          {index.planned && index.planned.length > 0 && (
            <>
              <h4>Not mapped yet</h4>
              <ul className="fm-planned-list">
                {index.planned.map((p) => <li key={p.id}>{p.name}</li>)}
              </ul>
            </>
          )}
        </div>
      </div>
    </dialog>
  );
}

export function FlowMap() {
  const [index, setIndex] = useState<FlowIndex | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(false);
  const [about, setAbout] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadFlowIndex()
      .then(async (idx) => {
        if (cancelled) return;
        setIndex(idx);
        if (idx.flows[0]) setFlow(await loadFlow(idx.flows[0].file));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
    return () => { cancelled = true; };
  }, []);

  const chunk = useMemo(
    () => flow?.chunks.find((c) => c.id === selected) ?? null,
    [flow, selected],
  );

  const needle = query.trim().toLowerCase();
  const matches = (node: FlowNode) =>
    needle.length > 1 &&
    (node.name.toLowerCase().includes(needle) ||
      node.id.toLowerCase().includes(needle) ||
      (node.selector ?? '').toLowerCase().includes(needle) ||
      (node.api?.await?.path ?? '').toLowerCase().includes(needle) ||
      (node.api?.verify?.path ?? '').toLowerCase().includes(needle));

  const hits = useMemo(() => {
    if (!flow || needle.length < 2) return [];
    return flow.chunks.flatMap((c) =>
      c.nodes.filter(matches).map((n) => ({ chunk: c, node: n })),
    );
  }, [flow, needle]);

  if (error) {
    return (
      <div className="state">
        <h2>No flow map found</h2>
        <p className="muted">{error}</p>
        <pre>{`Expected
  public/qa-flow/index.json        the list of flow files
  public/qa-flow/admin-core.json   the map itself

Re-check selectors against the Playwright page objects with
  python3 scripts/validate-flow.py ~/Documents/Automation/playwright-automation`}</pre>
      </div>
    );
  }

  if (!flow || !index) return <div className="state"><h2>Loading flow map…</h2></div>;

  const totals = flow.chunks.reduce(
    (acc, c) => {
      acc.nodes += c.nodes.length;
      acc.writes += mutatingNodes(c).length;
      acc.gaps += unverifiedWrites(c).length;
      return acc;
    },
    { nodes: 0, writes: 0, gaps: 0 },
  );

  return (
    <div className="fm">
      <header className="fm-head">
        <div>
          <h2>{flow.name}</h2>
          <p className="fm-sub">
            {flow.chunks.length} chunks · {totals.nodes} steps · {totals.writes} writes ·{' '}
            {totals.gaps === 0
              ? 'every write has a read-back'
              : `${totals.gaps} writes with no read-back`}
            {flow.env?.baseUrl && <> · <code>{flow.env.baseUrl}</code></>}
            {flow.env?.apiPrefix && <> · API under <code>{flow.env.apiPrefix}</code></>}
          </p>
        </div>
        <div className="fm-head-controls">
          <input
            className="fm-search"
            type="search"
            placeholder="Find a step, selector or endpoint…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <label className="fm-toggle">
            <input type="checkbox" checked={onlyGaps} onChange={(e) => setOnlyGaps(e.target.checked)} />
            Only unverified writes
          </label>
          <button type="button" className="fm-about-btn" onClick={() => setAbout(true)}>
            about
          </button>
        </div>
      </header>

      {needle.length > 1 && (
        <div className="fm-hits">
          <strong>{hits.length}</strong> match{hits.length === 1 ? '' : 'es'}
          {hits.slice(0, 40).map(({ chunk: c, node }) => (
            <button
              key={node.id}
              type="button"
              className="fm-hit"
              onClick={() => {
                setSelected(c.id);
                // The dialog mounts this tick; the step it is scrolling to is
                // only in the DOM after it has.
                setTimeout(
                  () => document.getElementById(`fm-${node.id}`)?.scrollIntoView({ block: 'center' }),
                  0,
                );
              }}
            >
              <code>{c.id}</code> {node.name}
            </button>
          ))}
        </div>
      )}

      <div className="fm-stage" aria-label="Flow chunks">
        <FlowGraph
          flow={flow}
          selected={selected}
          onSelect={(id) => setSelected(id === selected ? null : id)}
        />
      </div>

      {chunk && (
        <ChunkDialog
          flow={flow}
          chunk={chunk}
          onlyGaps={onlyGaps}
          matches={matches}
          onSelect={setSelected}
          onClose={() => setSelected(null)}
        />
      )}

      {about && <AboutDialog flow={flow} index={index} onClose={() => setAbout(false)} />}
    </div>
  );
}

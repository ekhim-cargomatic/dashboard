import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { FlowGraph } from './FlowGraph';
import {
  dependencyClosure,
  dependents,
  flatten,
  neighbours,
  runOrder,
  fullPath,
  loadFlow,
  loadFlowIndex,
  mutatingNodes,
  unverifiedWrites,
  type ApiCall,
  type ChunkDependency,
  type Flow,
  type FlowChunk,
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
 */

function Badge({ kind }: { kind: string }) {
  return <span className={`fm-kind fm-kind-${kind}`}>{kind}</span>;
}

function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="fm-copy"
      title={`Copy ${label}`}
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => { setDone(true); setTimeout(() => setDone(false), 1200); },
          () => undefined,
        );
      }}
    >
      {done ? 'copied' : 'copy'}
    </button>
  );
}

function ApiRow({ flow, call, role }: { flow: Flow; call: ApiCall; role: 'await' | 'verify' }) {
  return (
    <div className={`fm-api fm-api-${role}`}>
      <span className="fm-api-role">{role === 'await' ? 'fires' : 'then GET'}</span>
      <span className={`fm-method fm-method-${call.method}`}>{call.method}</span>
      <code className="fm-api-path">{fullPath(flow, call)}</code>
      {call.scope && <span className="fm-chip">{call.scope}{call.field ? `: ${call.field}` : ''}</span>}
      {call.status && <span className="fm-chip dim">{call.status.join('/')}</span>}
      {call.timeoutMs && <span className="fm-chip dim">{Math.round(call.timeoutMs / 1000)}s</span>}
      {call.debounced && <span className="fm-chip dim">debounced</span>}
      {call.reads && <span className="fm-chip dim">query, not a write</span>}
      {call.assert?.map((a, i) => (
        <span key={i} className="fm-assert">
          {a.pointer ?? 'response'}
          {a.equals !== undefined && ` == ${JSON.stringify(a.equals)}`}
          {a.equalsInput && ' == input'}
          {a.equalsRendered !== undefined && ' == rendered'}
          {a.present && ' present'}
          {a.greaterThan !== undefined && ` > ${a.greaterThan}`}
          {a.minLength !== undefined && ` length ≥ ${a.minLength}`}
          {a.increasedBy && ` += ${a.increasedBy}`}
          {a.decreasedBy && ` -= ${a.decreasedBy}`}
        </span>
      ))}
      {call.note && <p className="fm-note">{call.note}</p>}
    </div>
  );
}

function NodeRow({ flow, node, depth, match }: {
  flow: Flow; node: FlowNode; depth: number; match: boolean;
}) {
  const api = node.api;
  const gap = Boolean(
    api?.await &&
      api.await.method !== 'GET' &&
      !api.await.reads &&
      !api.verify &&
      !api.verifyNotApplicable,
  );
  return (
    <li
      className={`fm-node fm-node-${node.kind}${match ? ' is-match' : ''}${gap ? ' has-gap' : ''}`}
      style={{ '--depth': depth } as CSSProperties}
      id={`fm-${node.id}`}
    >
      <div className="fm-node-head">
        <Badge kind={node.kind} />
        <span className="fm-node-name">{node.name}</span>
        {node.required && <span className="fm-chip req">required</span>}
        {node.control && <span className="fm-chip dim">{node.control}</span>}
        {node.action && <span className="fm-chip dim">{node.action}</span>}
        {node.expect && <span className="fm-chip dim">expect {node.expect}</span>}
        {node.repeatable && <span className="fm-chip dim">repeatable</span>}
        {node.scopedToRow && <span className="fm-chip dim">per row</span>}
        {node.async && <span className="fm-chip wait">async</span>}
        {node.destructive && <span className="fm-chip danger">sends / destructive</span>}
        {node.secret && <span className="fm-chip danger">secret</span>}
        <code className="fm-id">{node.id}</code>
      </div>

      {node.path && (
        <div className="fm-line">
          <span className="fm-label">path</span>
          <code>{node.path}</code>
          {node.pathSource && <span className="fm-src">{node.pathSource}</span>}
        </div>
      )}

      {node.selector && (
        <div className="fm-line">
          <span className="fm-label">selector</span>
          <code className="fm-selector">{node.selector}</code>
          <Copy text={node.selector} label="selector" />
          {node.source && <span className="fm-src" title="verified byte-identical">{node.source} ✓</span>}
          {node.sourceComposed && <span className="fm-src dim" title="scoped from this constant">{node.sourceComposed} ~</span>}
        </div>
      )}

      {node.byRole && (
        <div className="fm-line">
          <span className="fm-label">by role</span>
          <code>{node.byRole.role} “{node.byRole.name}”</code>
        </div>
      )}

      {node.title?.selector && (
        <div className="fm-line">
          <span className="fm-label">title</span>
          <code className="fm-selector">{node.title.selector}</code>
        </div>
      )}
      {node.title?.text && !node.title.selector && (
        <div className="fm-line"><span className="fm-label">title</span><code>{node.title.text}</code></div>
      )}

      {node.fallback && (
        <div className="fm-line">
          <span className="fm-label">fallback</span>
          <code className="fm-selector">{node.fallback.selector}</code>
        </div>
      )}

      {node.then?.map((step, i) => (
        <div className="fm-line fm-then" key={i}>
          <span className="fm-label">then</span>
          <span className="fm-chip dim">{step.action}</span>
          {step.selector && <code className="fm-selector">{step.selector}</code>}
          {step.note && <p className="fm-note">{step.note}</p>}
        </div>
      ))}

      {node.attachesTo && (
        <div className="fm-line">
          <span className="fm-label">on</span>
          <a href={`#fm-${node.attachesTo}`}><code>{node.attachesTo}</code></a>
          <span className="fm-chip dim">another chunk's UI</span>
        </div>
      )}

      {node.opens && (
        <div className="fm-line">
          <span className="fm-label">opens</span>
          <a href={`#fm-${node.opens}`}><code>{node.opens}</code></a>
        </div>
      )}

      {node.capture && Object.entries(node.capture).map(([k, v]) => (
        <div className="fm-line" key={k}>
          <span className="fm-label">capture</span><code>{k} ← {v}</code>
        </div>
      ))}

      {api?.await && <ApiRow flow={flow} call={api.await} role="await" />}
      {api?.verify && <ApiRow flow={flow} call={api.verify} role="verify" />}
      {api?.capture && Object.entries(api.capture).map(([k, v]) => (
        <div className="fm-line" key={k}>
          <span className="fm-label">capture</span><code>{`{${k}}`} ← {v}</code>
        </div>
      ))}
      {api?.settleMs && (
        <div className="fm-line">
          <span className="fm-label">settle</span>
          <code>{Math.round(api.settleMs / 1000)}s quiet before reading the page back</code>
        </div>
      )}
      {api?.verifyNotApplicable && (
        <p className="fm-note">No read-back: {api.verifyNotApplicable}</p>
      )}
      {gap && (
        <p className="fm-gap">
          Writes but nothing reads it back. The modal closing is not proof — add a verify GET.
        </p>
      )}
      {api?.note && <p className="fm-note">{api.note}</p>}
      {node.note && <p className="fm-note">{node.note}</p>}
    </li>
  );
}

function DepLine({ dep, onSelect }: { dep: ChunkDependency; onSelect: (id: string) => void }) {
  if (dep.kind === 'seeded') {
    return (
      <li className="fm-dep fm-dep-seeded">
        <span className="fm-chip dim">fixture</span>
        <code>{`{${dep.variable}}`}</code>
        <span className="fm-dep-why">{dep.why}</span>
      </li>
    );
  }
  return (
    <li className={`fm-dep fm-dep-${dep.kind}`}>
      <span className={`fm-chip ${dep.kind === 'session' ? 'req' : 'dim'}`}>{dep.kind}</span>
      <button type="button" className="fm-dep-link" onClick={() => dep.chunk && onSelect(dep.chunk)}>
        {dep.chunk}
      </button>
      {dep.provides?.length ? <code>{dep.provides.map((v) => `{${v}}`).join(' ')}</code> : null}
      {dep.alternatives?.length ? (
        <span className="fm-dep-alt">
          or {dep.alternatives.map((a) => (
            <button key={a} type="button" className="fm-dep-link" onClick={() => onSelect(a)}>{a}</button>
          ))}
        </span>
      ) : null}
      {!dep.alternatives?.length && dep.why ? <span className="fm-dep-why">{dep.why}</span> : null}
    </li>
  );
}

/**
 * What a chunk needs, what it hands on, and the order to run it in.
 *
 * The run order is the practical payoff: it answers "what do I have to run to
 * exercise this chunk on its own", which is the question the chunking exists
 * to make answerable.
 */
function Dependencies({ flow, chunk, onSelect }: {
  flow: Flow; chunk: FlowChunk; onSelect: (id: string) => void;
}) {
  const deps = chunk.dependsOn ?? [];
  const order = runOrder(flow, chunk.id);
  const needed = dependencyClosure(flow, chunk.id);
  const used = dependents(flow, chunk.id);
  const { from: flowIn, to: flowOut } = neighbours(flow, chunk.id);

  return (
    <div className="fm-deps">
      <div className="fm-deps-col">
        <h4>Depends on</h4>
        {deps.length === 0 ? (
          <p className="muted">Nothing — this chunk starts a flow.</p>
        ) : (
          <ul className="fm-dep-list">
            {deps.map((d, i) => <DepLine key={i} dep={d} onSelect={onSelect} />)}
          </ul>
        )}
      </div>

      <div className="fm-deps-col">
        <h4>Provides</h4>
        {chunk.provides?.length ? (
          <p className="fm-provides-list">
            {chunk.provides.map((v) => <code key={v}>{`{${v}}`}</code>)}
          </p>
        ) : (
          <p className="muted">No variables for later chunks.</p>
        )}
        {used.length > 0 && (
          <>
            <h4>Needed by</h4>
            <p className="fm-dep-chips">
              {used.map((u) => (
                <button key={u} type="button" className="fm-dep-link" onClick={() => onSelect(u)}>{u}</button>
              ))}
            </p>
          </>
        )}
      </div>

      <div className="fm-deps-col">
        <h4>Comes from</h4>
        {flowIn.length === 0 ? (
          <p className="muted">An entry point.</p>
        ) : (
          <ul className="fm-flow-list">
            {flowIn.map((n) => (
              <li key={n.id}>
                <button type="button" className="fm-dep-link" onClick={() => onSelect(n.id)}>{n.id}</button>
                {n.label && <span className="fm-dep-why">{n.label}</span>}
              </li>
            ))}
          </ul>
        )}
        <h4>Leads to</h4>
        {flowOut.length === 0 ? (
          <p className="muted">End of this path.</p>
        ) : (
          <ul className="fm-flow-list">
            {flowOut.map((n) => (
              <li key={n.id}>
                <button type="button" className="fm-dep-link" onClick={() => onSelect(n.id)}>{n.id}</button>
                {n.label && <span className="fm-dep-why">{n.label}</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="fm-deps-col fm-deps-order">
        <h4>Run order {needed.length > 0 && <span className="hint">{order.length} chunks</span>}</h4>
        {needed.length === 0 ? (
          <p className="muted">Runs standalone.</p>
        ) : (
          <ol className="fm-run-order">
            {order.map((id, i) => (
              <li key={id} className={id === chunk.id ? 'is-target' : ''}>
                <button type="button" className="fm-dep-link" onClick={() => onSelect(id)}>{id}</button>
                {i < order.length - 1 && <span className="fm-run-arrow" aria-hidden="true">→</span>}
              </li>
            ))}
          </ol>
        )}
      </div>
    </div>
  );
}

export function FlowMap() {
  const [index, setIndex] = useState<FlowIndex | null>(null);
  const [flow, setFlow] = useState<Flow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [onlyGaps, setOnlyGaps] = useState(false);
  const detailRef = useRef<HTMLDivElement>(null);

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

  const steps = useMemo(() => {
    if (!chunk) return [];
    const all = flatten(chunk);
    if (!onlyGaps) return all;
    const gapIds = new Set(unverifiedWrites(chunk).map((n) => n.id));
    return all.filter((s) => gapIds.has(s.node.id));
  }, [chunk, onlyGaps]);

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

  useEffect(() => { detailRef.current?.scrollTo({ top: 0 }); }, [selected]);

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
        </div>
      </header>

      {flow.description && <p className="fm-desc">{flow.description}</p>}

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
                setTimeout(() => document.getElementById(`fm-${node.id}`)?.scrollIntoView({ block: 'center' }), 0);
              }}
            >
              <code>{c.id}</code> {node.name}
            </button>
          ))}
        </div>
      )}

      <div className="fm-body">
        <div className="fm-graph" aria-label="Flow chunks">
          <FlowGraph
            flow={flow}
            selected={selected}
            onSelect={(id) => setSelected(id === selected ? null : id)}
          />
          {index.planned && index.planned.length > 0 && (
            <div className="fm-planned">
              <h3>Not mapped yet</h3>
              <ul>{index.planned.map((p) => <li key={p.id}>{p.name}</li>)}</ul>
            </div>
          )}
        </div>

        <div className="fm-detail" ref={detailRef}>
          {!chunk ? (
            <div className="fm-empty">
              <h3>Pick a chunk</h3>
              <p className="muted">
                Each one is written to run on its own: an <code>entry</code>, an{' '}
                <code>exit</code>, and whatever earlier nodes it needs listed in{' '}
                <code>requires</code>. The selector on every step is byte-identical to the
                page-object constant named beside it, so a generator can emit a test without
                guessing.
              </p>
              <dl className="fm-vars">
                {flow.variables && Object.entries(flow.variables).map(([k, v]) => (
                  <div key={k}><dt><code>{`{${k}}`}</code></dt><dd>{v}</dd></div>
                ))}
              </dl>
            </div>
          ) : (
            <>
              <div className="fm-detail-head">
                <div>
                  <h3>{chunk.name}</h3>
                  <p className="fm-sub">
                    <code>{chunk.id}</code>
                    {chunk.page && <> · {chunk.page}</>}
                    {chunk.sourceFile && <> · <code>{chunk.sourceFile}</code></>}
                  </p>
                  <p className="fm-sub">
                    entry <code>{chunk.entry}</code> · exit <code>{chunk.exit}</code>
                    {chunk.requires && <> · requires {chunk.requires.map((r) => <code key={r}>{r}</code>)}</>}
                  </p>
                </div>
                <Copy text={JSON.stringify(chunk, null, 2)} label="chunk JSON" />
              </div>
              <Dependencies flow={flow} chunk={chunk} onSelect={setSelected} />
              <ol className="fm-nodes">
                {steps.map(({ node, depth }) => (
                  <NodeRow key={node.id} flow={flow} node={node} depth={depth} match={matches(node)} />
                ))}
              </ol>
              {steps.length === 0 && (
                <p className="muted" style={{ padding: 16 }}>
                  Nothing unverified in this chunk — every write reads itself back.
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

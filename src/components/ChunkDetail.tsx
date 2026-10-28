import { useState, type CSSProperties } from 'react';
import {
  dependencyClosure,
  dependents,
  flatten,
  neighbours,
  runOrder,
  unverifiedWrites,
  fullPath,
  type ApiCall,
  type ChunkAccess,
  type ChunkVariant,
  type ChunkDependency,
  type Flow,
  type FlowChunk,
  type FlowNode,
} from '../lib/flow';

/**
 * Everything one chunk touches — the half of the flow map that answers "what
 * exactly does this piece do", as opposed to the graph's "where does it sit".
 *
 * It lived inside FlowMap until the graph went full-window and the detail moved
 * into a dialog over it. Nothing here changed in the move; it is a file of its
 * own so the dialog and the page are rendering the same thing rather than two
 * drifting copies of it.
 */

function Badge({ kind }: { kind: string }) {
  return <span className={`fm-kind fm-kind-${kind}`}>{kind}</span>;
}

export function Copy({ text, label }: { text: string; label: string }) {
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

/**
 * Who can run this chunk.
 *
 * The roles are not a guess at who ought to have access — each one is a guard
 * the admin client really calls, with the line that calls it, so a role that
 * quietly stopped being checked shows up as a validator failure rather than as
 * a test that passes for the wrong reason. A chunk with no guard says so
 * plainly instead of being left blank.
 */
/**
 * A chunk that only exists for one value of a field.
 *
 * Worth its own band rather than a line in the note: a fixture seeded on the
 * wrong side of the switch makes the chunk look broken when it is simply not
 * rendered, and that is a slow thing to work out from a failing selector.
 */
function Variant({ variant }: { variant?: ChunkVariant }) {
  if (!variant) return null;
  return (
    <div className="fm-variant">
      <span className="fm-variant-tag">only when</span>
      <code className="fm-variant-test">{variant.field} {variant.test}</code>
      <span className="fm-variant-why">
        <code>{variant.guard}</code>
        {variant.renders && <> · renders {variant.renders}</>}
      </span>
      <span className="fm-variant-src muted">{variant.source}</span>
    </div>
  );
}

function Access({ access }: { access?: ChunkAccess }) {
  if (!access) return null;
  return (
    <div className="fm-access">
      <div className="fm-access-head">
        <span className={`fm-portal fm-portal-${access.portal}`}>{access.portal}</span>
        {access.gated ? (
          <span className="fm-access-count">
            {access.requires?.length} role check{access.requires?.length === 1 ? '' : 's'}
          </span>
        ) : (
          <span className="fm-access-open">no role check in the code</span>
        )}
      </div>
      {access.note && <p className="fm-access-note muted">{access.note}</p>}
      {access.requires && access.requires.length > 0 && (
        <ul className="fm-access-list">
          {access.requires.map((req) => (
            <li key={`${req.guard}-${req.source}`}>
              <div className="fm-access-roles">
                {req.roles.map((role) => <code key={role} className="fm-role">{role}</code>)}
              </div>
              <div className="fm-access-why">
                {req.gates} · <code>{req.guard}</code>
              </div>
              <div className="fm-access-src muted">{req.source}</div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

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

/** Everything about one chunk: what gates it, what it needs, and every step. */
export function ChunkDetail({ flow, chunk, onlyGaps, matches, onSelect }: {
  flow: Flow;
  chunk: FlowChunk;
  onlyGaps: boolean;
  matches: (node: FlowNode) => boolean;
  onSelect: (id: string) => void;
}) {
  const all = flatten(chunk);
  const gapIds = new Set(unverifiedWrites(chunk).map((n) => n.id));
  const steps = onlyGaps ? all.filter((s) => gapIds.has(s.node.id)) : all;

  return (
    <>
      <Variant variant={chunk.variant} />
      <Access access={chunk.access} />
      <Dependencies flow={flow} chunk={chunk} onSelect={onSelect} />
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
  );
}

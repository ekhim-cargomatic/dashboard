import { useEffect, useRef, useState } from 'react';
import { ChunkDetail, Copy } from './ChunkDetail';
import { RunFlowDialog } from './RunFlowDialog';
import { canRunFlow, resolve } from '../lib/flowRun';
import type { Flow, FlowChunk, FlowNode } from '../lib/flow';
import type { AppConfig } from '../types';

/**
 * One chunk's detail, as a drawer off the right edge of the map.
 *
 * The detail used to be a panel below the graph. Once the graph took the whole
 * window that panel was a screen away from the node you clicked, and the two
 * were never legible at once anyway — the graph is wide and the detail is long.
 * The drawer gets the shape right: tall and narrow, like the content, and it
 * leaves the map on screen beside it rather than covering the node you just
 * clicked. Close it and your pan, zoom and selection are exactly as they were.
 *
 * It is a real <dialog> on purpose. Escape, the backdrop, focus trapping and
 * returning focus to whatever opened it are things the element already does
 * correctly, and a div with role="dialog" is where hand-rolled versions of all
 * four go subtly wrong. Modal rather than show() specifically: only showModal()
 * puts the drawer in the top layer, which is what keeps it above the canvas
 * when the map is in native full screen.
 */

interface Props {
  /** Null until config.json has loaded; the play button stays hidden until then. */
  config: AppConfig | null;
  flow: Flow;
  chunk: FlowChunk;
  onlyGaps: boolean;
  matches: (node: FlowNode) => boolean;
  /** Following a dependency link swaps the dialog's subject — it does not close. */
  onSelect: (id: string) => void;
  onClose: () => void;
}

export function ChunkDialog({ config, flow, chunk, onlyGaps, matches, onSelect, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const [running, setRunning] = useState(false);

  // Hidden rather than disabled when the runner is not provisioned: a button
  // that can never work is worse than no button. `resolve` then says whether
  // this particular chunk has anything to run.
  const runnable = config && canRunFlow(config);
  const plan = runnable ? resolve(chunk) : null;

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  // A different chunk is a different document: start it at the top, the way
  // the panel used to, rather than halfway down the previous chunk's steps.
  useEffect(() => { body.current?.scrollTo({ top: 0 }); setRunning(false); }, [chunk.id]);

  return (
    <dialog
      className="fm-dialog fm-drawer"
      ref={ref}
      onClose={onClose}
      // The backdrop is not a child, so a click on it lands on the dialog
      // itself; anything inside stops at the panel below.
      onClick={(ev) => { if (ev.target === ref.current) ref.current?.close(); }}
      aria-label={chunk.name}
    >
      <div className="fm-dialog-panel">
        <div className="fm-detail-head">
          <div>
            <h3>{chunk.name}</h3>
            <p className="fm-sub">
              <code>{chunk.id}</code>
              {chunk.page && <> · {chunk.page}</>}
              {chunk.sourceFile && <> · <code>{chunk.sourceFile}</code></>}
              {chunk.platform && <> · <span className="fm-platform">{chunk.platform}</span></>}
            </p>
            <p className="fm-sub">
              entry <code>{chunk.entry}</code> · exit <code>{chunk.exit}</code>
              {chunk.requires && <> · requires {chunk.requires.map((r) => <code key={r}>{r}</code>)}</>}
            </p>
          </div>
          <div className="fm-dialog-actions">
            {plan && (
              <button
                type="button"
                className={`fm-run-play${plan.fitness === 'none' ? ' is-empty' : ''}`}
                onClick={() => setRunning(true)}
                title={plan.summary}
              >
                ▶ {plan.fitness === 'none' ? 'no tests' : `run ${plan.selector}`}
              </button>
            )}
            <Copy text={JSON.stringify(chunk, null, 2)} label="chunk JSON" />
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
        </div>

        <div className="fm-dialog-body" ref={body}>
          <ChunkDetail
            flow={flow}
            chunk={chunk}
            onlyGaps={onlyGaps}
            matches={matches}
            onSelect={onSelect}
          />
        </div>
      </div>

      {running && config && (
        <RunFlowDialog config={config} chunk={chunk} onClose={() => setRunning(false)} />
      )}
    </dialog>
  );
}

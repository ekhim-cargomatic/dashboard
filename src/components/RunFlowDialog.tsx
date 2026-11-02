/**
 * Starting a chunk's tests, and watching the build that runs them.
 *
 * A real <dialog> rather than the `modal-*` div pattern the failures table
 * uses: this opens from inside the chunk drawer, which is already a modal
 * dialog in the top layer, and a positioned div would render underneath it.
 *
 * The dialog is deliberately slow to commit. Pressing play spends money and
 * writes to staging with real logins, so what will run is spelled out — which
 * tag, how many scenarios, which environment — before the button does anything.
 */

import { useEffect, useRef, useState } from 'react';
import {
  RUN_ENVS,
  resolve,
  startRun,
  watchRun,
  type RunEnv,
  type RunHandle,
} from '../lib/flowRun';
import type { FlowChunk } from '../lib/flow';
import type { AppConfig } from '../types';

type Phase =
  | { status: 'editing' }
  | { status: 'starting' }
  | { status: 'running'; handle: RunHandle }
  | { status: 'done'; handle: RunHandle }
  | { status: 'error'; message: string; handle?: RunHandle };

/** CodeBuild's phase names, in words that mean something to a reader. */
const PHASE_TEXT: Record<string, string> = {
  SUBMITTED: 'queued',
  QUEUED: 'queued',
  PROVISIONING: 'starting a runner',
  DOWNLOAD_SOURCE: 'starting a runner',
  INSTALL: 'starting a runner',
  PRE_BUILD: 'cloning and installing',
  BUILD: 'running tests',
  POST_BUILD: 'building the report',
  UPLOAD_ARTIFACTS: 'publishing',
  FINALIZING: 'publishing',
  COMPLETED: 'finished',
};

export function RunFlowDialog({
  config,
  chunk,
  onClose,
}: {
  config: AppConfig;
  chunk: FlowChunk;
  onClose: () => void;
}) {
  const plan = resolve(chunk);
  const [selector, setSelector] = useState(plan.selector);
  const [env, setEnv] = useState<RunEnv>('staging');
  const [phase, setPhase] = useState<Phase>({ status: 'editing' });
  const ref = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);

  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); }, []);
  useEffect(() => () => abort.current?.abort(), []);

  const chosen = plan.candidates.find((c) => `@${c.tag}` === selector) ?? plan.coverage;
  const busy = phase.status === 'starting' || phase.status === 'running';

  async function run() {
    setPhase({ status: 'starting' });
    abort.current = new AbortController();
    const { signal } = abort.current;

    try {
      const started = await startRun(config, { chunkId: chunk.id, selector, env }, signal);
      setPhase({ status: 'running', handle: started });

      const final = await watchRun(
        config,
        started.buildId,
        (handle) => setPhase({ status: 'running', handle }),
        signal,
      );
      setPhase({ status: 'done', handle: final });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setPhase({ status: 'error', message: (error as Error).message });
    }
  }

  return (
    <dialog
      className="fm-dialog fm-dialog-run"
      ref={ref}
      onClose={onClose}
      // Closing mid-run would hide a build that is still burning minutes.
      onClick={(ev) => { if (ev.target === ref.current && !busy) ref.current?.close(); }}
      aria-label={`Run tests for ${chunk.name}`}
    >
      <div className="fm-dialog-panel">
        <div className="fm-detail-head">
          <div>
            <h3>Run {chunk.name}</h3>
            <p className="fm-sub"><code>{chunk.id}</code></p>
          </div>
          <button
            type="button"
            className="fm-dialog-close"
            onClick={() => ref.current?.close()}
            disabled={busy}
            aria-label="Close"
            title={busy ? 'A run is in progress' : 'Close (Esc)'}
          >
            ✕
          </button>
        </div>

        <div className="fm-dialog-body fm-run">
          {plan.fitness === 'none' ? (
            <>
              <p className="fm-run-none">{plan.summary}</p>
              <p className="muted">
                The map and the test suite meet only through tags. This chunk's tags
                either name no business area, or name one no feature file carries — so
                there is nothing to select. Writing a test tagged{' '}
                {plan.missing.length > 0
                  ? <code>{plan.missing[0]}</code>
                  : <>for this area</>}{' '}
                is what would make it runnable.
              </p>
            </>
          ) : (
            <>
              <p className="fm-run-what">
                This runs the <strong>existing tests tagged for this area</strong> — not
                the {chunk.nodes.length} steps described on the left. Tags are the only
                link between the map and the suite.
              </p>

              <label className="fm-run-label" htmlFor="run-selector">Tag to run</label>
              {plan.candidates.length > 1 ? (
                <select
                  id="run-selector"
                  className="fm-run-select"
                  value={selector}
                  disabled={busy}
                  onChange={(e) => setSelector(e.target.value)}
                >
                  {plan.candidates.map((c) => (
                    <option key={c.tag} value={`@${c.tag}`}>
                      @{c.tag} — {c.runs} scenario{c.runs === 1 ? '' : 's'} in {c.files} file
                      {c.files === 1 ? '' : 's'}
                    </option>
                  ))}
                </select>
              ) : (
                <p className="fm-run-single"><code>{selector}</code></p>
              )}

              {chosen && (
                <p className={chosen.runs > 120 ? 'fm-run-warn' : 'muted'}>
                  {chosen.runs > 120
                    ? `${chosen.runs} scenarios across ${chosen.files} feature files — this is most of the suite, not one chunk. Expect a long run.`
                    : `${chosen.runs} scenario${chosen.runs === 1 ? '' : 's'} across ${chosen.files} feature file${chosen.files === 1 ? '' : 's'}.`}
                </p>
              )}

              {plan.missing.length > 0 && (
                <p className="muted">
                  No tests carry {plan.missing.map((t) => <code key={t}>{t}</code>)} — the part of
                  this chunk those tags describe is not covered.
                </p>
              )}

              <label className="fm-run-label" htmlFor="run-env">Environment</label>
              <select
                id="run-env"
                className="fm-run-select"
                value={env}
                disabled={busy}
                onChange={(e) => setEnv(e.target.value as RunEnv)}
              >
                {RUN_ENVS.map((e) => <option key={e} value={e}>{e}</option>)}
              </select>
              <p className="muted">
                Real logins against {env}. One run at a time, so two cannot collide on the
                same records.
              </p>

              {phase.status === 'running' && (
                <p className="fm-run-status">
                  <span className="fm-run-spin" aria-hidden="true" />
                  {PHASE_TEXT[phase.handle.phase] ?? phase.handle.phase.toLowerCase()}…
                  {phase.handle.logsUrl && (
                    <> · <a href={phase.handle.logsUrl} target="_blank" rel="noreferrer">logs</a></>
                  )}
                </p>
              )}

              {phase.status === 'done' && (
                <p className={phase.handle.status === 'SUCCEEDED' ? 'fm-run-ok' : 'fm-run-warn'}>
                  Run {phase.handle.status === 'SUCCEEDED' ? 'finished' : `ended ${phase.handle.status}`}.
                  {' '}The report is in the runs list.
                  {phase.handle.logsUrl && (
                    <> · <a href={phase.handle.logsUrl} target="_blank" rel="noreferrer">logs</a></>
                  )}
                </p>
              )}

              {phase.status === 'error' && <p className="fm-run-err">{phase.message}</p>}
            </>
          )}
        </div>

        {plan.fitness !== 'none' && (
          <div className="fm-run-foot">
            <button type="button" className="fm-run-btn" onClick={() => ref.current?.close()} disabled={busy}>
              {phase.status === 'done' ? 'Close' : 'Cancel'}
            </button>
            {phase.status !== 'done' && (
              <button
                type="button"
                className="fm-run-btn primary"
                onClick={() => void run()}
                disabled={busy || !selector}
              >
                {phase.status === 'starting' ? 'Starting…'
                  : phase.status === 'running' ? 'Running…'
                  : `Run ${selector}`}
              </button>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}

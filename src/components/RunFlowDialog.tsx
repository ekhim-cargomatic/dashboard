/**
 * Running one point on the flow map, and watching it happen.
 *
 * A real <dialog> rather than the `modal-*` div pattern the failures table
 * uses: this opens from inside the chunk drawer, which is already a modal
 * dialog in the top layer, and a positioned div would render underneath it.
 *
 * The dialog is deliberately slow to commit. Pressing run spends money and
 * writes to staging with real logins, so what will happen is spelled out first
 * — every step, in order, with the values it will type — and the plan comes
 * from the function that will perform it rather than from this page, so what
 * is shown cannot drift from what runs.
 */

import { useEffect, useRef, useState } from 'react';
import {
  RUN_ENVS,
  fetchPlan,
  startRun,
  watchRun,
  type FlowPlan,
  type PlanStep,
  type RunEnv,
  type RunHandle,
} from '../lib/flowRun';
import type { AppConfig } from '../types';

type Phase =
  | { status: 'loading' }
  | { status: 'editing' }
  | { status: 'starting' }
  | { status: 'running'; handle: RunHandle }
  | { status: 'done'; handle: RunHandle }
  | { status: 'error'; message: string };

/** CodeBuild's phase names, in words that mean something to a reader. */
const PHASE_TEXT: Record<string, string> = {
  SUBMITTED: 'queued',
  QUEUED: 'queued',
  PROVISIONING: 'starting a runner',
  DOWNLOAD_SOURCE: 'starting a runner',
  INSTALL: 'starting a runner',
  PRE_BUILD: 'installing',
  BUILD: 'walking the map',
  POST_BUILD: 'building the report',
  UPLOAD_ARTIFACTS: 'publishing',
  FINALIZING: 'publishing',
  COMPLETED: 'finished',
};

/** The gesture, in the words someone testing by hand would use. */
const VERB_TEXT: Record<string, string> = {
  goto: 'go to',
  click: 'click',
  clickMenuItem: 'choose',
  clickTab: 'open tab',
  fill: 'type into',
  select: 'choose in',
  check: 'tick',
  pickOption: 'search and pick',
  assert: 'check',
};

/**
 * Colour the few lines worth spotting in a wall of output: the step results
 * that say where the run got to, and the failure that says why it stopped.
 * Everything else stays plain — highlighting most of a log highlights nothing.
 */
function lineClass(line: string): string {
  if (/✗/.test(line)) return 'fg-bad';
  if (/✓/.test(line)) return 'fg-good';
  if (/^(flow|target|chunks):/.test(line)) return 'fg-head';
  if (/\b(FAILED|AssertionError|Traceback|Error:|error:)/.test(line)) return 'fg-bad';
  if (/steps passed .* — passed$/.test(line)) return 'fg-good';
  if (/steps passed .* — failed$/.test(line)) return 'fg-bad';
  return '';
}

export function RunFlowDialog({
  config,
  target,
  onClose,
}: {
  config: AppConfig;
  target: string;
  onClose: () => void;
}) {
  const [plan, setPlan] = useState<FlowPlan | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [env, setEnv] = useState<RunEnv>('staging');
  const [phase, setPhase] = useState<Phase>({ status: 'loading' });
  const [log, setLog] = useState<string[]>([]);
  const [showSteps, setShowSteps] = useState(true);

  const ref = useRef<HTMLDialogElement>(null);
  const abort = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLPreElement>(null);

  // Follow the tail by default, and stop the moment the reader scrolls up —
  // yanking the view back down while they are reading an earlier failure is
  // what makes streamed logs annoying. Intent is tracked rather than inferred
  // from position: on the first render scrollTop is 0 and the content already
  // overflows, so a position check reads as "not at the bottom" and the panel
  // would never follow at all.
  const follow = useRef(true);

  useEffect(() => {
    const el = logRef.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => { const el = ref.current; if (el && !el.open) el.showModal(); }, []);
  useEffect(() => () => abort.current?.abort(), []);

  useEffect(() => {
    const controller = new AbortController();
    fetchPlan(config, target, controller.signal)
      .then((got) => {
        setPlan(got);
        setValues(Object.fromEntries(got.fields.map((f) => [f.node, f.value])));
        setPhase({ status: 'editing' });
      })
      .catch((err: Error) => {
        if (err.name === 'AbortError') return;
        setPhase({ status: 'error', message: err.message });
      });
    return () => controller.abort();
  }, [config, target]);

  const busy = phase.status === 'starting' || phase.status === 'running';

  /** Keep the tail bounded: the DOM is the expensive part, not the memory. */
  const append = (handle: RunHandle) => {
    if (handle.lines?.length) setLog((prev) => [...prev, ...handle.lines!].slice(-1500));
  };

  async function run() {
    setPhase({ status: 'starting' });
    setLog([]);
    setShowSteps(false);
    abort.current = new AbortController();
    const { signal } = abort.current;

    try {
      const started = await startRun(config, { target, env, values }, signal);
      setPhase({ status: 'running', handle: started });

      const final = await watchRun(
        config,
        started.buildId,
        (handle) => { append(handle); setPhase({ status: 'running', handle }); },
        signal,
      );
      setPhase({ status: 'done', handle: final });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setPhase({ status: 'error', message: (error as Error).message });
    }
  }

  const writes = plan?.steps.filter((s) => s.await && s.await.method !== 'GET').length ?? 0;

  return (
    <dialog
      className="fm-dialog fm-dialog-run"
      ref={ref}
      onClose={onClose}
      // Closing mid-run would hide a build that is still burning minutes.
      onClick={(ev) => { if (ev.target === ref.current && !busy) ref.current?.close(); }}
      aria-label={`Run ${plan?.targetName ?? target}`}
    >
      <div className="fm-dialog-panel">
        <div className="fm-detail-head">
          <div>
            <h3>Run {plan?.targetName ?? '…'}</h3>
            <p className="fm-sub"><code>{target}</code></p>
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
          {phase.status === 'loading' && <p className="muted">Working out what this would do…</p>}

          {phase.status === 'error' && !plan && <p className="fm-run-err">{phase.message}</p>}

          {plan && !plan.runnable && (
            <>
              <p className="fm-run-none">This step cannot be run from the map.</p>
              <ul className="fm-run-blockers">
                {plan.blockers.map((b, i) => (
                  <li key={i}><code>{b.node}</code> {b.why}</li>
                ))}
              </ul>
              <p className="muted">
                The map describes this step, but not completely enough to perform it.
                Filling the gap above in <code>public/qa-flow/cargomatic.json</code> is
                what would make it runnable.
              </p>
            </>
          )}

          {plan && plan.runnable && (
            <>
              <p className="fm-run-what">
                This walks the map to <strong>{plan.targetName}</strong> — {plan.steps.length} steps
                across {plan.chunks.length} {plan.chunks.length === 1 ? 'chunk' : 'chunks'}
                {writes > 0 && <>, {writes} of which {writes === 1 ? 'writes' : 'write'} to {env}</>}.
              </p>
              <p className="fm-run-chain">
                {plan.chunks.map((c, i) => (
                  <span key={c}>
                    {i > 0 && <span className="fm-run-arrow"> → </span>}
                    <code>{c}</code>
                  </span>
                ))}
              </p>

              <button
                type="button"
                className="fm-run-toggle"
                onClick={() => setShowSteps((v) => !v)}
                aria-expanded={showSteps}
              >
                {showSteps ? '▾' : '▸'} {plan.steps.length} steps
              </button>

              {showSteps && <StepList steps={plan.steps} values={values} />}

              {plan.fields.length > 0 && (
                <>
                  <label className="fm-run-label">Values</label>
                  <p className="muted">
                    Made up from each field's type and name, and from the suite's own
                    fixtures where a search box needs a record that exists. Change any of
                    them before you run.
                  </p>
                  {plan.fields.map((field) => (
                    <div className="fm-run-field" key={field.node}>
                      <label htmlFor={`v-${field.node}`}>
                        {field.name}
                        {field.control && <span className="fm-chip dim">{field.control}</span>}
                      </label>
                      <input
                        id={`v-${field.node}`}
                        className="fm-run-input"
                        value={values[field.node] ?? ''}
                        disabled={busy}
                        maxLength={200}
                        onChange={(e) => setValues((v) => ({ ...v, [field.node]: e.target.value }))}
                      />
                    </div>
                  ))}
                </>
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
                Real logins against {env}, from the suite's own credential fixture. One run
                at a time, so two cannot collide on the same records.
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

              {log.length > 0 && (
                <>
                  <label className="fm-run-label">Output</label>
                  <pre
                    className="fm-run-log"
                    ref={logRef}
                    aria-live="polite"
                    onScroll={(ev) => {
                      const el = ev.currentTarget;
                      follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
                    }}
                  >
                    {log.map((line, i) => (
                      <span key={i} className={lineClass(line)}>{line || ' '}{'\n'}</span>
                    ))}
                  </pre>
                </>
              )}
            </>
          )}
        </div>

        {plan?.runnable && (
          <div className="fm-run-foot">
            <button type="button" className="fm-run-btn" onClick={() => ref.current?.close()} disabled={busy}>
              {phase.status === 'done' ? 'Close' : 'Cancel'}
            </button>
            {phase.status !== 'done' && (
              <button
                type="button"
                className="fm-run-btn primary"
                onClick={() => void run()}
                disabled={busy}
              >
                {phase.status === 'starting' ? 'Starting…'
                  : phase.status === 'running' ? 'Running…'
                  : `Run ${plan.steps.length} steps`}
              </button>
            )}
          </div>
        )}
      </div>
    </dialog>
  );
}

/**
 * The plan, step by step.
 *
 * Shown by default rather than hidden behind a disclosure: the whole argument
 * for this button is that you can see what it will do, and a collapsed list
 * makes that something you have to go looking for.
 */
function StepList({ steps, values }: { steps: PlanStep[]; values: Record<string, string> }) {
  return (
    <ol className="fm-run-steps">
      {steps.map((step, i) => {
        const shown = step.secret
          ? 'from the credential fixture'
          : values[step.node] ?? step.value;
        return (
          <li key={`${step.node}-${i}`} className={step.destructive ? 'is-destructive' : undefined}>
            <span className="fm-run-verb">{VERB_TEXT[step.verb] ?? step.verb}</span>
            <span className="fm-run-step-name">{step.path ?? step.name}</span>
            {shown !== undefined && (
              <code className={`fm-run-value${step.secret ? ' is-secret' : ''}`}>{shown}</code>
            )}
            {step.await && step.await.method !== 'GET' && (
              <span className="fm-chip wait">{step.await.method} {step.await.path}</span>
            )}
            <span className="fm-run-why">{step.why}</span>
          </li>
        );
      })}
    </ol>
  );
}

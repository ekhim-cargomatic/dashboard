/**
 * "Send to agent-dev" — files one failing test as a task in the Notion Tasks
 * database, with a prompt the user writes first.
 *
 * One dialog instance serves the whole failures table: the table renders a button
 * per row and sets which failure is open, so there is a single piece of send
 * state rather than one per row.
 */

import { useEffect, useRef, useState } from 'react';
import type { AppConfig, Failure, RunSummary } from '../types';
import { REPOS, defaultPrompt, guessRepo, sendFailureToAgent, type Repo } from '../lib/notion';

type Phase = { status: 'editing' } | { status: 'sending' } | { status: 'sent'; url: string } | { status: 'error'; message: string };

export function SendToAgentDialog({
  config,
  run,
  failure,
  onClose,
}: {
  config: AppConfig;
  run: RunSummary;
  failure: Failure;
  onClose: () => void;
}) {
  const [prompt, setPrompt] = useState(() => defaultPrompt(failure, run));
  const [repo, setRepo] = useState<Repo>(() => guessRepo(run, failure));
  const [phase, setPhase] = useState<Phase>({ status: 'editing' });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
    textareaRef.current?.select();
  }, []);

  // Escape closes, except mid-send where it would leave the page half-created.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && phase.status !== 'sending') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, phase.status]);

  useEffect(() => () => abortRef.current?.abort(), []);

  async function send() {
    setPhase({ status: 'sending' });
    abortRef.current = new AbortController();
    try {
      const result = await sendFailureToAgent({
        config,
        run,
        failure,
        prompt,
        repo,
        signal: abortRef.current.signal,
      });
      setPhase({ status: 'sent', url: result.url });
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      setPhase({ status: 'error', message: (error as Error).message });
    }
  }

  const sending = phase.status === 'sending';

  return (
    <div className="modal-backdrop" onMouseDown={() => !sending && onClose()}>
      <div
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="send-agent-title"
        onMouseDown={(event) => event.stopPropagation()}
      >
        <div className="modal-head">
          <h2 id="send-agent-title">Send to agent-dev</h2>
          <button type="button" className="modal-close" onClick={onClose} disabled={sending} aria-label="Close">
            ×
          </button>
        </div>

        {phase.status === 'sent' ? (
          <div className="modal-body">
            <p className="modal-success">Task created in Notion.</p>
            <p>
              <a href={phase.url} target="_blank" rel="noopener noreferrer">
                Open the task →
              </a>
            </p>
            <p className="dim" style={{ fontSize: 12 }}>
              It is filed as <strong>Ready For Agent Work</strong> with Agent Status <strong>Ready</strong>, so
              the agent picks it up from there.
            </p>
          </div>
        ) : (
          <div className="modal-body">
            <dl className="modal-facts">
              <dt>Test</dt>
              <dd>{failure.name}</dd>
              <dt>Suite</dt>
              <dd>{failure.suite || '—'}</dd>
              <dt>Run</dt>
              <dd>
                {run.workflow}
                {run.runNumber ? ` #${run.runNumber}` : ''}
                {run.environment ? ` · ${run.environment}` : ''}
              </dd>
            </dl>

            {failure.message && (
              <pre className="modal-error-preview mono">{failure.message.slice(0, 600)}</pre>
            )}

            <label className="modal-label" htmlFor="send-agent-repo">
              Repo
            </label>
            <select
              id="send-agent-repo"
              className="modal-select"
              value={repo}
              disabled={sending}
              onChange={(event) => setRepo(event.target.value as Repo)}
            >
              {REPOS.map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </select>

            <label className="modal-label" htmlFor="send-agent-prompt">
              Prompt for the agent
            </label>
            <textarea
              id="send-agent-prompt"
              ref={textareaRef}
              className="modal-textarea"
              rows={6}
              value={prompt}
              disabled={sending}
              onChange={(event) => setPrompt(event.target.value)}
              placeholder="What should the agent do? Name the entry points and the behaviour you expect."
            />
            <p className="dim" style={{ fontSize: 12 }}>
              This becomes the <strong>Intent</strong> section. The failure output, run details and acceptance
              criteria are attached automatically.
            </p>

            {phase.status === 'error' && <p className="modal-failure">{phase.message}</p>}
          </div>
        )}

        <div className="modal-foot">
          {phase.status === 'sent' ? (
            <button type="button" className="modal-btn primary" onClick={onClose}>
              Done
            </button>
          ) : (
            <>
              <button type="button" className="modal-btn" onClick={onClose} disabled={sending}>
                Cancel
              </button>
              <button
                type="button"
                className="modal-btn primary"
                onClick={send}
                disabled={sending || !prompt.trim()}
              >
                {sending ? 'Sending…' : 'Create task'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

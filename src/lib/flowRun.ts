/**
 * Running a point on the flow map, from the browser.
 *
 * The dashboard holds no credentials and composes no plan. It names a node and
 * asks the function what that would do; the function resolves the plan from its
 * own copy of the map and answers with the steps. Pressing run sends the same
 * node id back, and the function resolves it again rather than trusting what it
 * handed out — so nothing the page could be tricked into sending can change
 * which selectors a signed-in staging browser is driven through.
 *
 * It follows that the preview and the run cannot disagree. That is worth more
 * than the round trip costs: a preview resolved here, against the map the page
 * happens to have loaded, would drift from the runner the first time either
 * side changed.
 */

import type { AppConfig } from '../types';

export const RUN_ENVS = ['staging', 'dev'] as const;
export type RunEnv = (typeof RUN_ENVS)[number];

/** Hidden rather than broken when the runner was never deployed. */
export const canRunFlow = (config: AppConfig): boolean => Boolean(config.runFlowUrl);

/** One gesture in a plan, as the function resolved it. */
export interface PlanStep {
  verb: string;
  name: string;
  node: string;
  chunk: string;
  /** Why this step is in the plan, in words — "the form requires it". */
  why: string;
  path?: string;
  value?: string;
  /** A credential, resolved on the runner. Shown, never sent, never editable. */
  secret?: boolean;
  await?: { method: string; path: string };
  destructive?: boolean;
}

/** A field in the plan whose value can be changed before running. */
export interface PlanField {
  node: string;
  name: string;
  control?: string;
  value: string;
  chunk: string;
}

/** Something that stops a point on the map being runnable at all. */
export interface PlanBlocker {
  node: string;
  name: string;
  why: string;
}

export interface FlowPlan {
  target: string;
  targetName: string;
  chunk: string;
  chunkName: string;
  /** The chunks crossed to get here, in order — usually starting with a sign-in. */
  chunks: string[];
  portal: string;
  runnable: boolean;
  blockers: PlanBlocker[];
  fields: PlanField[];
  steps: PlanStep[];
}

async function get<T>(config: AppConfig, query: string, signal?: AbortSignal): Promise<T> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.runFlowToken) headers['x-dashboard-token'] = config.runFlowToken;

  let response: Response;
  try {
    response = await fetch(`${config.runFlowUrl}${query}`, { method: 'GET', headers, signal });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new Error('Could not reach the run function. Check the network, or that it is deployed.');
  }
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (HTTP ${response.status})`);
  return body;
}

/** What pressing run on this node would do, before anything happens. */
export function fetchPlan(
  config: AppConfig,
  target: string,
  signal?: AbortSignal,
): Promise<FlowPlan> {
  return get<FlowPlan>(config, `?plan=${encodeURIComponent(target)}`, signal);
}

export interface RunHandle {
  buildId: string;
  /** New log lines since the last poll — not the whole log. */
  lines?: string[];
  /** CloudWatch's forward cursor. Hand it back next poll to get only what is new. */
  logToken?: string;
  /** CodeBuild's own phase — PROVISIONING, BUILD, COMPLETED … */
  phase: string;
  /** SUCCEEDED | FAILED | FAULT | TIMED_OUT | STOPPED | IN_PROGRESS */
  status: string;
  /** Where the Allure report landed, once the build has published it. */
  runPrefix?: string;
  logsUrl?: string;
}

const isDone = (status: string) => status !== 'IN_PROGRESS';

async function call(
  config: AppConfig,
  init: RequestInit & { query?: string },
): Promise<RunHandle> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.runFlowToken) headers['x-dashboard-token'] = config.runFlowToken;

  let response: Response;
  try {
    response = await fetch(`${config.runFlowUrl}${init.query ?? ''}`, { ...init, headers });
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') throw err;
    throw new Error('Could not reach the run function. Check the network, or that it is deployed.');
  }

  const body = (await response.json().catch(() => ({}))) as Partial<RunHandle> & { error?: string };
  if (!response.ok) throw new Error(body.error || `Run failed (HTTP ${response.status})`);
  if (!body.buildId) throw new Error('The function returned no build id.');

  return {
    buildId: body.buildId,
    phase: body.phase ?? 'QUEUED',
    status: body.status ?? 'IN_PROGRESS',
    runPrefix: body.runPrefix,
    logsUrl: body.logsUrl,
    lines: body.lines ?? [],
    logToken: body.logToken,
  };
}

export function startRun(
  config: AppConfig,
  args: { target: string; env: RunEnv; values?: Record<string, string> },
  signal?: AbortSignal,
): Promise<RunHandle> {
  return call(config, {
    method: 'POST',
    signal,
    body: JSON.stringify(args),
  });
}

export function pollRun(
  config: AppConfig,
  buildId: string,
  logToken?: string,
  signal?: AbortSignal,
): Promise<RunHandle> {
  const since = logToken ? `&since=${encodeURIComponent(logToken)}` : '';
  return call(config, {
    method: 'GET',
    signal,
    query: `?build=${encodeURIComponent(buildId)}${since}`,
  });
}

/**
 * Poll until the build finishes, reporting each change.
 *
 * Every 3s: a plan is tens of steps and each one prints as it happens, so a
 * looser interval makes the dialog feel stuck on a run that is moving. Resolves
 * with the final handle; rejects only if the caller aborts.
 */
export async function watchRun(
  config: AppConfig,
  buildId: string,
  onUpdate: (handle: RunHandle) => void,
  signal: AbortSignal,
  intervalMs = 3000,
): Promise<RunHandle> {
  let logToken: string | undefined;

  for (;;) {
    await new Promise((done, fail) => {
      const timer = setTimeout(done, intervalMs);
      signal.addEventListener('abort', () => { clearTimeout(timer); fail(signal.reason); }, { once: true });
    });

    const handle = await pollRun(config, buildId, logToken, signal);
    logToken = handle.logToken ?? logToken;
    onUpdate(handle);

    // One last read after the build reports done: the final lines — the
    // scenario summary and the publish path — usually land in CloudWatch a
    // beat after CodeBuild flips the status.
    if (isDone(handle.status)) {
      try {
        const last = await pollRun(config, buildId, logToken, signal);
        if (last.lines?.length) onUpdate(last);
      } catch { /* the status is what matters; a missed tail is not an error */ }
      return handle;
    }
  }
}

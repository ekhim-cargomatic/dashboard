/**
 * Running a flow chunk's automation.
 *
 * The request does NOT start anything in the browser. It goes to a Lambda that
 * holds the AWS credentials and starts a CodeBuild project, which clones
 * playwright-automation, runs behave, and syncs the Allure report back into the
 * same `runs/` prefix this dashboard already reads. See infra/flow-run-fn.
 *
 * `config.runFlowUrl` being empty is the normal state for a dashboard that has
 * not provisioned the runner: `canRunFlow()` is false and the UI hides the
 * button rather than offering something that would fail.
 *
 * ── What a run actually covers ──────────────────────────────────────────────
 *
 * A chunk's `tags` and a feature file's tags are the same vocabulary, and that
 * is the ONLY bridge between the map and the suite. So pressing play runs the
 * existing tests tagged for this area — it does not execute the chunk's steps.
 * Nothing here pretends otherwise: `resolve()` reports which of three states a
 * chunk is in, and the UI is expected to show it before anything starts.
 */

import { SCOPE_TAGS, LAYER_TAGS } from './domains.generated';
import { BROAD_RUNS, FEATURE_TAGS, type TagCoverage } from './flow-tags.generated';
import type { FlowChunk } from './flow';
import type { AppConfig } from '../types';

/** Environments the runner accepts. Production is deliberately not one of them. */
export const RUN_ENVS = ['staging', 'dev'] as const;
export type RunEnv = (typeof RUN_ENVS)[number];

export const canRunFlow = (config: AppConfig): boolean => Boolean(config.runFlowUrl);

/**
 * Tags that say *when* a test runs or *how* it is written rather than what
 * business area it covers. `@smoke` matches 20 scenarios drawn from all over
 * the suite and `@ui` matches 1107 — neither one names a chunk, so neither can
 * stand in for one however few scenarios it happens to select.
 *
 * `@auth.<role>` is excluded for the same reason: it says who logs in.
 */
const GENERIC = new Set([...SCOPE_TAGS, ...LAYER_TAGS]);

const isAreaTag = (tag: string): boolean => {
  const bare = tag.replace(/^@/, '');
  return !GENERIC.has(bare.toLowerCase()) && !bare.startsWith('auth.');
};

export type RunFitness =
  /** One area tag names this chunk and selects a sane number of scenarios. */
  | 'runnable'
  /** An area tag matched, but it covers most of the suite. Runnable, with a warning. */
  | 'broad'
  /** Every area tag on this chunk is absent from the suite. Nothing to run. */
  | 'none';

export interface RunPlan {
  fitness: RunFitness;
  /** The behave selector, with the casing the feature files use. Empty when `none`. */
  selector: string;
  coverage: TagCoverage | null;
  /**
   * Every area tag on the chunk that the suite actually carries, narrowest
   * first. More than one means there is a real choice to offer rather than a
   * guess to make on the user's behalf.
   */
  candidates: TagCoverage[];
  /** Area tags on the chunk that exist in no feature file — the honest gap. */
  missing: string[];
  /** One line naming what will happen, for the button title and the dialog. */
  summary: string;
}

/**
 * What pressing play on this chunk would run.
 *
 * Picks the *narrowest area tag that actually exists in the suite*. Narrowest
 * because a chunk is one screen and the tag closest to it is the most useful
 * run; OR-ing a chunk's three tags would collect hundreds of scenarios, and
 * AND-ing them would usually collect none — the map's tag sets describe the
 * chunk, not any single scenario.
 */
export function resolve(chunk: FlowChunk): RunPlan {
  const area = (chunk.tags ?? []).filter(isAreaTag);
  const missing: string[] = [];
  const hits: TagCoverage[] = [];

  for (const tag of area) {
    const found = FEATURE_TAGS[tag.replace(/^@/, '').toLowerCase()];
    if (found) hits.push(found);
    else missing.push(tag);
  }

  if (hits.length === 0) {
    const absent = missing.length > 0;
    return {
      fitness: 'none',
      selector: '',
      coverage: null,
      candidates: [],
      missing,
      summary: absent
        ? `No tests carry ${missing.join(' or ')}. Nothing to run for this chunk yet.`
        : 'This chunk has no area tag, only scope or layer tags — nothing identifies its tests.',
    };
  }

  const candidates = [...hits].sort((a, b) => a.runs - b.runs);
  const best = candidates[0];
  const selector = `@${best.tag}`;
  const broad = best.runs > BROAD_RUNS;

  return {
    fitness: broad ? 'broad' : 'runnable',
    selector,
    coverage: best,
    candidates,
    missing,
    summary: broad
      ? `${selector} is the narrowest tag this chunk has, but it covers ${best.runs} scenarios `
        + `across ${best.files} feature files — far more than this one chunk.`
      : `${best.runs} scenario${best.runs === 1 ? '' : 's'} tagged ${selector}`
        + `, across ${best.files} feature file${best.files === 1 ? '' : 's'}.`,
  };
}

/** A build in flight, or the record of one that finished. */
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
  args: { chunkId: string; selector: string; env: RunEnv },
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
 * Every 5s: a behave run is minutes long, so anything tighter is just load on
 * the function, and anything looser makes the dialog feel stuck. Resolves with
 * the final handle; rejects only if the caller aborts.
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

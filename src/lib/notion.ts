/**
 * Filing a failing test as an agent-dev task in Notion.
 *
 * The request does NOT go to Notion directly. api.notion.com sends no CORS
 * headers, and an integration token in this bundle would be world-readable at the
 * CloudFront URL — so the call goes to a Lambda Function URL that holds the token
 * and creates the page. See infra/notion-agent-task/index.mjs.
 *
 * `config.notionFnUrl` being empty is the normal state for a dashboard that has
 * not provisioned the function: `canSendToAgent()` is false and the UI hides the
 * button rather than offering something that would fail.
 */

import type { AppConfig, Failure, RunSummary } from '../types';
import { reportUrl } from './s3';
import { isAreaTag } from './domains';

/** Repos the Tasks database offers. A value outside this list makes Notion reject the page. */
export const REPOS = [
  'playwright-automation',
  'appium-automation',
  'monopoly',
  'monolith',
  'unified-view',
  'admin-client-legacy',
  'pricing-engine',
  'documents-service',
  'perfmatic',
  'lorax',
  'dbt-analytics',
] as const;

export type Repo = (typeof REPOS)[number];

export const canSendToAgent = (config: AppConfig): boolean => Boolean(config.notionFnUrl);

/**
 * Which repo a run most likely came from.
 *
 * Mobile runs come out of appium-automation and everything else out of
 * playwright-automation. Only a default — the dialog lets you change it, because
 * the failure may well belong to the product repo rather than the test repo.
 */
export function guessRepo(run: RunSummary, failure: Failure): Repo {
  const haystack = [run.workflow, run.workflowSlug, failure.suite, ...(failure.tags ?? [])]
    .join(' ')
    .toLowerCase();
  return /appium|android|ios|mobile/.test(haystack) ? 'appium-automation' : 'playwright-automation';
}

/** The default prompt, so the dialog opens with something worth sending. */
export function defaultPrompt(failure: Failure, run: RunSummary): string {
  return [
    `\`${failure.name}\` is failing in ${run.workflow}${run.runNumber ? ` #${run.runNumber}` : ''}`,
    run.environment ? ` against ${run.environment}` : '',
    '. Work out whether this is a product defect or a test defect, and fix the cause.',
  ].join('');
}

/**
 * Same-origin config leaves `reportUrl()` returning a root-relative path, which
 * is right inside the dashboard and useless in Notion — nothing there can resolve
 * it. Absolutise against wherever the dashboard is actually being served from.
 */
function absolute(url: string): string {
  try {
    return new URL(url, window.location.origin).toString();
  } catch {
    return url;
  }
}

export interface SendResult {
  id: string;
  url: string;
}

export async function sendFailureToAgent(options: {
  config: AppConfig;
  run: RunSummary;
  failure: Failure;
  prompt: string;
  repo: Repo;
  signal?: AbortSignal;
}): Promise<SendResult> {
  const { config, run, failure, prompt, repo, signal } = options;
  if (!config.notionFnUrl) throw new Error('No Notion function is configured for this dashboard.');

  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (config.notionFnToken) headers['x-dashboard-token'] = config.notionFnToken;

  let response: Response;
  try {
    response = await fetch(config.notionFnUrl, {
      method: 'POST',
      headers,
      signal,
      body: JSON.stringify({
        prompt,
        repo,
        failure: {
          name: failure.name,
          fullName: failure.fullName,
          feature: failure.feature,
          // Documented in ci/qa-summary.mjs as a slash-joined feature-file path
          // ("admin/booking_details"), which is what the ticket needs to locate
          // the file — not just a display label.
          suite: failure.suite,
          domain: failure.domain,
          status: failure.status,
          message: failure.message,
          // Only the tags that say something about the product. The same filter
          // the area charts use, so the ticket doesn't carry `car-1482`, `tee7`
          // and the auth-role selectors into a human's reading queue.
          tags: (failure.tags ?? []).filter(isAreaTag),
        },
        run: {
          runKey: run.runKey,
          workflow: run.workflow,
          runNumber: run.runNumber,
          environment: run.environment,
          branch: run.branch,
          commit: run.commitShort || run.commit,
          ciUrl: run.ciUrl,
          reportUrl: absolute(reportUrl(config, run)),
        },
      }),
    });
  } catch (error) {
    if ((error as Error).name === 'AbortError') throw error;
    // A blocked CORS preflight and an offline network look identical here.
    throw new Error('Could not reach the send function. Check the network, or that it is deployed.');
  }

  const body = (await response.json().catch(() => ({}))) as Partial<SendResult> & { error?: string };

  if (!response.ok) throw new Error(body.error || `Send failed (HTTP ${response.status}).`);
  if (!body.url || !body.id) throw new Error('The function returned no page URL.');

  return { id: body.id, url: body.url };
}

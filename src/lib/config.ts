/**
 * Runtime configuration.
 *
 * Read from `/config.json` at startup rather than baked in at build time, so the
 * bucket, the reports origin or the run cap can change without rebuilding and
 * redeploying the bundle. `infra/deploy.sh` writes this file.
 *
 * Defaults assume the dashboard and the reports are served from the same
 * CloudFront distribution in front of the same bucket, which makes the S3
 * listing calls same-origin and removes CORS from the picture entirely.
 */

import type { AppConfig } from '../types';

export const DEFAULT_CONFIG: AppConfig = {
  dataBaseUrl: '',
  reportBaseUrl: '',
  runsPrefix: 'runs/',
  maxRunsPerWorkflow: 60,
  clusterRuns: 5,
  ciRunUrlTemplate: '',
};

export async function loadConfig(): Promise<AppConfig> {
  try {
    const response = await fetch('/config.json', { cache: 'no-cache' });
    if (!response.ok) return DEFAULT_CONFIG;

    const raw = (await response.json()) as Partial<AppConfig>;
    return {
      dataBaseUrl: raw.dataBaseUrl ?? DEFAULT_CONFIG.dataBaseUrl,
      // Reports usually live beside the data; only override when they don't.
      reportBaseUrl: raw.reportBaseUrl || raw.dataBaseUrl || DEFAULT_CONFIG.reportBaseUrl,
      runsPrefix: raw.runsPrefix ?? DEFAULT_CONFIG.runsPrefix,
      maxRunsPerWorkflow: raw.maxRunsPerWorkflow ?? DEFAULT_CONFIG.maxRunsPerWorkflow,
      clusterRuns: raw.clusterRuns ?? DEFAULT_CONFIG.clusterRuns,
      ciRunUrlTemplate: raw.ciRunUrlTemplate ?? DEFAULT_CONFIG.ciRunUrlTemplate,
    };
  } catch {
    // No config.json deployed — same-origin defaults are the right guess.
    return DEFAULT_CONFIG;
  }
}

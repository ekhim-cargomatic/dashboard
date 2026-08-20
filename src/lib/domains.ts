/**
 * Tag → risk-domain resolution, in the browser.
 *
 * The same rule the CI summariser applies (ci/qa-summary.mjs). It lives here too
 * because the dashboard now reads raw Allure reports directly: the tags come from
 * `data/suites.json` and the mapping has to happen client-side.
 */

import { DOMAIN_BY_SLUG, TAG_TO_DOMAINS, UNMAPPED_DOMAIN } from './domains.generated';

export { labelForDomain, UNMAPPED_DOMAIN } from './domains.generated';

export interface DomainMatch {
  /** Every domain whose tags this scenario carries. */
  matched: string[];
  /** The single domain it is counted under. */
  primary: string;
}

/**
 * A scenario tagged `@pagination @invoices` legitimately touches both the generic
 * `tables` bucket and `invoices`. Counting it in both would double-count the
 * totals, so "which area is worst" needs exactly one bucket per scenario: the
 * least generic match, tie-broken by declaration order in tag_map.yaml.
 */
export function resolveDomains(tags: readonly string[]): DomainMatch {
  const matched: string[] = [];

  for (const tag of tags) {
    for (const slug of TAG_TO_DOMAINS[tag.toLowerCase()] ?? []) {
      if (!matched.includes(slug)) matched.push(slug);
    }
  }

  if (matched.length === 0) return { matched: [], primary: UNMAPPED_DOMAIN };

  const primary = matched.reduce((best, slug) => {
    const candidate = DOMAIN_BY_SLUG[slug];
    const incumbent = DOMAIN_BY_SLUG[best];
    if (!incumbent) return slug;
    if (!candidate) return best;
    if (candidate.genericity !== incumbent.genericity) {
      return candidate.genericity < incumbent.genericity ? slug : best;
    }
    return candidate.order < incumbent.order ? slug : best;
  }, matched[0]);

  return { matched, primary };
}

/** Layer tags are descriptive, not routing — pulled out separately. */
export const LAYERS = ['api', 'ui', 'e2e', 'portal'] as const;

export function resolveLayers(tags: readonly string[]): string[] {
  const found = tags.map((t) => t.toLowerCase()).filter((t) => (LAYERS as readonly string[]).includes(t));
  return found.length > 0 ? found : ['untagged'];
}

/**
 * Tag → risk-domain resolution, in the browser.
 *
 * The same rule the CI summariser applies (ci/qa-summary.mjs). It lives here too
 * because the dashboard now reads raw Allure reports directly: the tags come from
 * `data/suites.json` and the mapping has to happen client-side.
 */

import {
  AUTH_ROLE_TAGS,
  DOMAIN_BY_SLUG,
  EXCLUDE_TAGS,
  LAYER_TAGS,
  NON_ROUTING_PATTERNS,
  SCOPE_TAGS,
  TAG_TO_DOMAINS,
  UNMAPPED_DOMAIN,
} from './domains.generated';

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

/**
 * Tags that describe an *area*, as opposed to bookkeeping.
 *
 * Grouping by raw tag is the most direct answer to "which area is affected",
 * because it does not depend on tag_map being current. But behave tags carry
 * several other jobs, and leaving those in swamps the chart:
 *
 *   scope      @smoke, @regression      every test in the run has one
 *   layer      @ui, @api, @e2e          already its own grouping
 *   gates      @wip, @bug, @skip        execution control
 *   auth role  @auth.admin              who logs in, not what is covered — and in
 *                                       practice it shadows @admin exactly
 *   trace ids  @C22747, @CAR-1234       one tag per test, so one row per test
 *
 * The trace-id patterns come from tag_map's own non_routing section rather than
 * being guessed here, so they stay correct as conventions change. Matched
 * case-insensitively: tag_map writes them uppercase, tags arrive lowercased.
 */
const NON_ROUTING = NON_ROUTING_PATTERNS.map((pattern) => new RegExp(pattern, 'i'));
const BOOKKEEPING = new Set<string>([
  ...SCOPE_TAGS,
  ...LAYER_TAGS,
  ...EXCLUDE_TAGS,
  ...AUTH_ROLE_TAGS,
]);

export function isAreaTag(tag: string): boolean {
  const normalised = tag.toLowerCase();
  if (!normalised || BOOKKEEPING.has(normalised)) return false;
  return !NON_ROUTING.some((pattern) => pattern.test(normalised));
}

/** Layer tags are descriptive, not routing — pulled out separately. */
export const LAYERS = ['api', 'ui', 'e2e', 'portal'] as const;

export function resolveLayers(tags: readonly string[]): string[] {
  const found = tags.map((t) => t.toLowerCase()).filter((t) => (LAYERS as readonly string[]).includes(t));
  return found.length > 0 ? found : ['untagged'];
}

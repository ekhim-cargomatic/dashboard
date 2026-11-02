#!/usr/bin/env node
/**
 * Compile what the automation suite actually covers, tag by tag.
 *
 * The flow map and the test suite meet in exactly one place: a chunk's `tags`
 * and a feature file's tags are the same vocabulary. Everything the play button
 * knows — whether a chunk can be run at all, and how much runs when you press it
 * — comes from intersecting the two. Doing that at runtime would mean shipping
 * 418 feature files to the browser, so it is compiled here instead, the same way
 * gen-domains.mjs compiles tag_map.yaml.
 *
 *   src/lib/flow-tags.generated.ts   imported by the SPA
 *   ci/flow-tags.generated.json      the Lambda's tag allowlist
 *
 * Regenerate whenever feature files are added or retagged:
 *
 *   npm run gen:flow-tags
 *   npm run gen:flow-tags -- --features ../playwright-automation/features
 *
 * The counts are what `behave -t <tag>` would really select: Scenario Outlines
 * are expanded to one per Examples row, and anything carrying a gate tag
 * (@wip, @skip, @bug …) is excluded, because behave.ini's `default_tags` drops
 * those on every run and targeted runs add tag_map's `exclude_always` on top.
 * A number that did not match what you get when you run it would be worse than
 * no number at all — the whole point is to say "41 scenarios" and be right.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { globSync } from 'node:fs';
import { parseArgs } from 'node:util';

/**
 * Gates that keep a scenario out of every run. behave.ini lists the first five
 * as `default_tags`; tag_map.yaml's `exclude_always` adds the environment ones,
 * and targeted.yml composes both. Read from the generated domains file rather
 * than hardcoded, so there is one source of truth for the list.
 */
function excludeTags(domainsJsonPath) {
  const base = ['wip', 'skip', 'bug', 'deprecated', 'needs-automation'];
  try {
    const data = JSON.parse(readFileSync(domainsJsonPath, 'utf8'));
    return [...new Set([...base, ...(data.excludeAlways ?? [])])].sort();
  } catch {
    // The suite still has gates even if tag_map has not been compiled yet.
    return base.sort();
  }
}

/**
 * Above this many scenarios a tag stops being a useful handle on one chunk and
 * becomes "most of the suite". Such a run is still allowed — it is sometimes
 * what you want — but the UI says so before you commit to it. 120 is a little
 * over an hour of wall clock, which is the point where you would rather know.
 */
const BROAD_RUNS = 120;

const KEYWORD = /^(Feature|Scenario Outline|Scenario Template|Scenario|Background|Examples|Rule)\s*:/i;

/**
 * Tags on a line, as written. Casing is preserved because behave tags are
 * case-sensitive — `-t @orderBooking` and `-t @orderbooking` are different
 * selectors, and the command we hand the runner has to be the one that works.
 */
const tagsOn = (line) => line.split(/\s+/).filter((t) => t.startsWith('@') && t.length > 1);

/**
 * One entry per scenario behave would collect from this file.
 *
 * A hand-rolled line scanner rather than a Gherkin parser: the only things that
 * matter here are tag lines, block keywords and Examples rows, and adding a
 * parser dependency to read three line shapes would be a poor trade.
 */
function parseFeature(text) {
  const scenarios = [];
  let featureTags = [];
  let pending = [];
  let current = null;
  let inExamples = false;
  let headerSeen = false;

  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;

    if (inExamples) {
      if (line.startsWith('|')) {
        // The first row names the columns; the rest are runs.
        if (headerSeen) current.rows += 1;
        else headerSeen = true;
        continue;
      }
      inExamples = false; // fall through — this line starts something new
    }

    if (line.startsWith('@')) {
      pending.push(...tagsOn(line));
      continue;
    }

    const match = KEYWORD.exec(line);
    if (!match) continue;

    switch (match[1].toLowerCase()) {
      case 'feature':
        featureTags = pending;
        break;
      case 'examples':
        inExamples = true;
        headerSeen = false;
        break;
      case 'background':
      case 'rule':
        break;
      default: {
        // Feature tags apply to every scenario under them; behave unions the two.
        const outline = match[1].toLowerCase().startsWith('scenario outline')
          || match[1].toLowerCase().startsWith('scenario template');
        current = { tags: new Set([...featureTags, ...pending]), outline, rows: 0 };
        scenarios.push(current);
      }
    }
    pending = [];
  }

  return scenarios;
}

function build(featuresDir, excluded) {
  const files = globSync('**/*.feature', { cwd: featuresDir });
  if (files.length === 0) throw new Error(`no .feature files under ${featuresDir}`);

  const gates = new Set(excluded);
  /** bare lowercase tag -> { tag (as written), scenarios, runs, files } */
  const byTag = new Map();
  let scenarioCount = 0;
  let runCount = 0;
  let gatedCount = 0;

  for (const file of files.sort()) {
    const scenarios = parseFeature(readFileSync(resolve(featuresDir, file), 'utf8'));
    for (const scenario of scenarios) {
      scenarioCount += 1;

      // An outline with no Examples rows collects nothing; counting it as 1
      // would promise a run that never happens.
      const runs = scenario.outline ? scenario.rows : 1;
      const bare = [...scenario.tags].map((t) => t.slice(1));
      if (bare.some((t) => gates.has(t.toLowerCase()))) {
        gatedCount += 1;
        continue;
      }
      runCount += runs;

      for (const tag of bare) {
        const key = tag.toLowerCase();
        const entry = byTag.get(key) ?? { tag, scenarios: 0, runs: 0, files: new Set() };
        entry.scenarios += 1;
        entry.runs += runs;
        entry.files.add(file);
        byTag.set(key, entry);
      }
    }
  }

  const tags = Object.fromEntries(
    [...byTag.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, e]) => [key, { tag: e.tag, scenarios: e.scenarios, runs: e.runs, files: e.files.size }]),
  );

  return { tags, excluded, featureFiles: files.length, scenarioCount, runCount, gatedCount };
}

function emitTs(data) {
  return `// AUTO-GENERATED by scripts/gen-flow-tags.mjs — do not edit by hand.
// Source: playwright-automation/features (${data.featureFiles} files, ${data.scenarioCount} scenarios)
//
// Regenerate with:
//   npm run gen:flow-tags

export interface TagCoverage {
  /** The tag as written in the feature files — behave tags are case-sensitive. */
  tag: string;
  /** Scenarios carrying it, after the exclude gates. */
  scenarios: number;
  /** What \`behave -t <tag>\` actually collects: Scenario Outlines expanded per Examples row. */
  runs: number;
  /** How many feature files it spans. */
  files: number;
}

/** Keyed by the bare, lowercased tag. Values carry the real casing. */
export const FEATURE_TAGS: Record<string, TagCoverage> = ${JSON.stringify(data.tags, null, 2)};

/**
 * Tags that keep a scenario out of every run — behave.ini's \`default_tags\`
 * plus tag_map.yaml's \`exclude_always\`. Scenarios carrying any of these are
 * already excluded from the counts above.
 */
export const RUN_EXCLUDE_TAGS: string[] = ${JSON.stringify(data.excluded)};

/** Totals, for the "what does the suite cover" line in the UI. */
export const SUITE_TOTALS = ${JSON.stringify(
    { featureFiles: data.featureFiles, scenarios: data.scenarioCount, runs: data.runCount, gated: data.gatedCount },
    null,
    2,
  )};

/**
 * Above this many scenarios a tag stops being a handle on one chunk and becomes
 * "most of the suite". Still runnable, but the UI warns first.
 */
export const BROAD_RUNS = ${BROAD_RUNS};

/** Coverage for a tag written either way (\`@orderBooking\` or \`orderbooking\`). */
export function coverageFor(tag: string): TagCoverage | null {
  return FEATURE_TAGS[tag.replace(/^@/, '').toLowerCase()] ?? null;
}
`;
}

const { values } = parseArgs({
  options: {
    features: { type: 'string', default: '../playwright-automation/features' },
    domains: { type: 'string', default: 'ci/domains.generated.json' },
    'ts-out': { type: 'string', default: 'src/lib/flow-tags.generated.ts' },
    'json-out': { type: 'string', default: 'ci/flow-tags.generated.json' },
    flow: { type: 'string', default: 'public/qa-flow/cargomatic.json' },
  },
});

const featuresDir = resolve(values.features);
let data;
try {
  data = build(featuresDir, excludeTags(resolve(values.domains)));
} catch (err) {
  console.error(`Failed to read feature files at ${featuresDir}\n${err.message}`);
  process.exit(1);
}

for (const [outPath, contents] of [
  [values['ts-out'], emitTs(data)],
  [values['json-out'], `${JSON.stringify(data, null, 2)}\n`],
]) {
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, contents);
  console.log(`wrote ${outPath}`);
}

console.log(
  `${data.featureFiles} feature files · ${data.scenarioCount} scenarios `
  + `(${data.gatedCount} gated) · ${data.runCount} runnable · ${Object.keys(data.tags).length} tags`,
);

// Not emitted — the flow map changes far more often than the feature files, so
// chunk resolution belongs at runtime in flowRun.ts. Printed because it is the
// number that says how much of the map the play button can actually reach.
try {
  const flow = JSON.parse(readFileSync(resolve(values.flow), 'utf8'));
  const domains = JSON.parse(readFileSync(resolve(values.domains), 'utf8'));
  // Same rule as selectorFor() in src/lib/flowRun.ts: only an *area* tag names
  // a chunk. @smoke says when a test runs and @ui says how it is written, so a
  // chunk left with nothing else is not addressable no matter how many
  // scenarios those tags match.
  const generic = new Set([...(domains.scopes ?? []), ...(domains.layers ?? [])]);
  let runnable = 0;
  let broad = 0;
  const none = [];
  for (const chunk of flow.chunks ?? []) {
    const hits = (chunk.tags ?? [])
      .map((t) => t.replace(/^@/, ''))
      .filter((t) => !generic.has(t.toLowerCase()) && !t.startsWith('auth.'))
      .map((t) => data.tags[t.toLowerCase()])
      .filter(Boolean);
    if (hits.length === 0) none.push(chunk.id);
    else if (Math.min(...hits.map((h) => h.runs)) > BROAD_RUNS) broad += 1;
    else runnable += 1;
  }
  console.log(
    `\nflow map: ${runnable} chunks runnable · ${broad} only broad tags · ${none.length} with no area tag`,
  );
  if (none.length) console.log(`  no area tag: ${none.join(', ')}`);
} catch {
  // The flow map is optional context for this script, not an input it needs.
}

/**
 * Training & SOP matrix analysis.
 *
 * Answers, for Command's training material, the same question the rest of the
 * dashboard asks of the test suite: which area is worst, and is it drifting?
 * Here "failing" means the material is stale or flagged rather than that a test
 * went red.
 *
 * DATA LOCATION IS DELIBERATE. The matrix names process owners, links internal
 * documents and records candid notes about business gaps. This repository is
 * public and the dashboard's S3 bucket is public, so the CSV is neither committed
 * nor deployed: it lives untracked at `data/training-sop-matrix.csv` and is served
 * only by a dev-only Vite middleware (see vite.config.ts). In a production build
 * the fetch 404s and the panel says so. Moving this data into `public/` or the
 * bucket would publish it to the world — a feature flag would not prevent that.
 */

export interface TrainingRow {
  persona: string;
  lifecycleStep: string;
  material: string;
  format: string;
  notes: string;
  lastUpdatedRaw: string;
  owner: string;
  businessSop: string;
  /** Parsed from lastUpdatedRaw; null when the sheet has no usable date. */
  updatedAt: Date | null;
  ageDays: number | null;
  staleness: Staleness;
  /** Notes say something other than "complete" — someone flagged it. */
  flagged: boolean;
  /** Stale or flagged: the row needs a human. */
  needsAttention: boolean;
}

export type Staleness = 'fresh' | 'aging' | 'stale' | 'unknown';

/** Thresholds in days. Training material a year old is very likely wrong. */
const AGING_AFTER = 180;
const STALE_AFTER = 365;

// --------------------------------------------------------------------------- //
// CSV
// --------------------------------------------------------------------------- //

/**
 * Minimal RFC4180 parser. The sheet contains quoted fields with embedded commas
 * ("Dated, updateds needed from GTM"), so splitting on commas silently shifts
 * columns and mislabels owners.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];

    if (inQuotes) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') inQuotes = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => r.some((cell) => cell.trim() !== ''));
}

// --------------------------------------------------------------------------- //
// Dates
// --------------------------------------------------------------------------- //

/**
 * The sheet's dates are hand-maintained and inconsistent. Observed forms:
 *
 *   2026-02-09 (drive.last_updated)   ISO with a provenance suffix
 *   7/31/2024                          M/D/YYYY
 *   02/12/2026                         MM/DD/YYYY
 *   3/26/26                            M/D/YY
 *   03-16-26                           MM-DD-YY
 *   10/2025                            M/YYYY — month precision only
 *   N/A (no metadata)                  no date at all
 *
 * Anything unrecognised returns null and is reported as "unknown" rather than
 * being guessed at — a wrong date here would silently mark stale material fresh.
 */
export function parseSheetDate(raw: string): Date | null {
  const value = (raw ?? '').trim();
  if (!value || /^n\/a/i.test(value)) return null;

  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return utc(Number(iso[1]), Number(iso[2]), Number(iso[3]));

  const mdy = value.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})/);
  if (mdy) {
    const [, m, d, y] = mdy;
    return utc(expandYear(Number(y)), Number(m), Number(d));
  }

  // Month precision: treat as the first of that month, which is the
  // conservative reading — it can only make something look older, not newer.
  const my = value.match(/^(\d{1,2})[/-](\d{4})$/);
  if (my) return utc(Number(my[2]), Number(my[1]), 1);

  return null;
}

const utc = (year: number, month: number, day: number): Date | null => {
  const date = new Date(Date.UTC(year, month - 1, day));
  return Number.isNaN(date.getTime()) ? null : date;
};

const expandYear = (year: number): number => (year < 100 ? 2000 + year : year);

// --------------------------------------------------------------------------- //
// Rows
// --------------------------------------------------------------------------- //

const COMPLETE = /^complete\b/i;

export function analyseRows(csv: string, now: Date = new Date()): TrainingRow[] {
  const [header, ...body] = parseCsv(csv);
  if (!header) return [];

  const index = (name: string) =>
    header.findIndex((h) => h.trim().toLowerCase().startsWith(name.toLowerCase()));

  const col = {
    persona: index('persona'),
    step: index('lifecycle'),
    material: index('training material'),
    format: index('format'),
    notes: index('status'),
    updated: index('last updated'),
    sop: index('business sop'),
    owner: index('process owner'),
  };

  const at = (row: string[], i: number) => (i >= 0 ? (row[i] ?? '').trim() : '');

  return body.map((row) => {
    const lastUpdatedRaw = at(row, col.updated);
    const updatedAt = parseSheetDate(lastUpdatedRaw);
    const ageDays = updatedAt
      ? Math.floor((now.getTime() - updatedAt.getTime()) / 86_400_000)
      : null;

    const staleness: Staleness =
      ageDays === null
        ? 'unknown'
        : ageDays > STALE_AFTER
          ? 'stale'
          : ageDays > AGING_AFTER
            ? 'aging'
            : 'fresh';

    const notes = at(row, col.notes);
    // An empty note is not an endorsement, but it is not a flag either; only a
    // note that says something *other* than "complete" counts as flagged.
    const flagged = notes !== '' && !COMPLETE.test(notes);

    return {
      persona: at(row, col.persona) || '(unassigned)',
      lifecycleStep: at(row, col.step) || '(none)',
      material: at(row, col.material) || at(row, col.sop) || '(untitled)',
      format: at(row, col.format) || '—',
      notes,
      lastUpdatedRaw,
      owner: at(row, col.owner) || '(unowned)',
      businessSop: at(row, col.sop),
      updatedAt,
      ageDays,
      staleness,
      flagged,
      needsAttention: flagged || staleness === 'stale' || staleness === 'unknown',
    };
  });
}

// --------------------------------------------------------------------------- //
// Rollups
// --------------------------------------------------------------------------- //

export interface TrainingGroup {
  key: string;
  total: number;
  needsAttention: number;
  stale: number;
  aging: number;
  fresh: number;
  unknown: number;
  flagged: number;
  /** needsAttention / total */
  attentionRate: number;
}

export type GroupDimension = 'lifecycleStep' | 'persona' | 'owner' | 'format';

export function groupBy(rows: TrainingRow[], dimension: GroupDimension): TrainingGroup[] {
  const acc = new Map<string, TrainingGroup>();

  for (const row of rows) {
    const key = row[dimension];
    let group = acc.get(key);
    if (!group) {
      group = {
        key,
        total: 0,
        needsAttention: 0,
        stale: 0,
        aging: 0,
        fresh: 0,
        unknown: 0,
        flagged: 0,
        attentionRate: 0,
      };
      acc.set(key, group);
    }
    group.total += 1;
    group[row.staleness] += 1;
    if (row.flagged) group.flagged += 1;
    if (row.needsAttention) group.needsAttention += 1;
  }

  const groups = [...acc.values()];
  for (const group of groups) {
    group.attentionRate = group.total > 0 ? group.needsAttention / group.total : 0;
  }

  return groups.sort(
    (a, b) => b.needsAttention - a.needsAttention || b.total - a.total || a.key.localeCompare(b.key),
  );
}

export interface TrainingTotals {
  total: number;
  needsAttention: number;
  stale: number;
  aging: number;
  fresh: number;
  unknown: number;
  flagged: number;
  /** Median age in days across rows that have a usable date. */
  medianAgeDays: number | null;
}

export function totals(rows: TrainingRow[]): TrainingTotals {
  const ages = rows
    .map((r) => r.ageDays)
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);

  return {
    total: rows.length,
    needsAttention: rows.filter((r) => r.needsAttention).length,
    stale: rows.filter((r) => r.staleness === 'stale').length,
    aging: rows.filter((r) => r.staleness === 'aging').length,
    fresh: rows.filter((r) => r.staleness === 'fresh').length,
    unknown: rows.filter((r) => r.staleness === 'unknown').length,
    flagged: rows.filter((r) => r.flagged).length,
    // Median, not mean: a handful of 2019-era rows would drag a mean badly.
    medianAgeDays: ages.length ? ages[Math.floor(ages.length / 2)] : null,
  };
}

/**
 * Fetch the matrix. Dev-only by design — see the note at the top of this file.
 * Returns null in a deployed build, where the endpoint does not exist.
 */
export async function loadTrainingMatrix(): Promise<string | null> {
  try {
    const response = await fetch('/__training-matrix.csv');
    if (!response.ok) return null;
    const text = await response.text();
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

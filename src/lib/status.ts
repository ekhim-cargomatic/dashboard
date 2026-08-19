/**
 * The reserved status palette.
 *
 * These four colours are fixed and never themed. Because green↔red is only
 * ΔE ~4 under deuteranopia, hue can never carry the meaning alone: every place a
 * status colour appears it is paired with `glyph` and `label`, and the numbers
 * are printed alongside. That pairing is the accessibility channel, not a nicety.
 */

import type { Status } from '../types';

export interface StatusMeta {
  key: Status;
  label: string;
  /** Secondary encoding — shown next to every swatch and chip. */
  glyph: string;
  color: string;
  /** Readable text colour when the status is used as a chip. */
  text: string;
}

export const STATUS_META: Record<Status, StatusMeta> = {
  passed: { key: 'passed', label: 'Passed', glyph: '✓', color: '#0ca30c', text: '#0ca30c' },
  failed: { key: 'failed', label: 'Failed', glyph: '✕', color: '#d03b3b', text: '#d03b3b' },
  broken: { key: 'broken', label: 'Broken', glyph: '!', color: '#ec835a', text: '#b45309' },
  skipped: { key: 'skipped', label: 'Skipped', glyph: '–', color: '#898781', text: '#898781' },
  unknown: { key: 'unknown', label: 'Unknown', glyph: '?', color: '#c3c2b7', text: '#898781' },
};

/**
 * Stack order for the per-run volume bars, bottom segment first.
 *
 * Deliberately not the obvious passed→broken→failed→skipped: that would seat
 * green directly against orange, the worst adjacent pair in this set (ΔE 5.6
 * under protanopia — below the floor). Seating neutral grey between them lifts
 * the worst adjacency to ΔE 7.9, which is legal alongside the secondary encoding
 * these bars already carry: a 2px surface gap between segments, glyphs in the
 * legend, and a table view of the same numbers.
 */
export const STACK_ORDER: Status[] = ['passed', 'skipped', 'broken', 'failed'];

export const statusMeta = (status: string): StatusMeta =>
  STATUS_META[status as Status] ?? STATUS_META.unknown;

/**
 * The sequential magnitude ramp — one hue, nine steps, used by every magnitude
 * encoding in the dashboard (area bars, heatmap cells, legend swatches).
 *
 * Steps resolve through CSS custom properties rather than literal hex so light
 * and dark each get their own selected values. Both directions are monotonic and
 * both put "near zero" nearest the surface; see the --ramp-* block in styles.css.
 */
export const RAMP_STEPS = 9;

/**
 * Map a 0..1 magnitude onto a ramp step index.
 *
 * `sqrt` easing because failure rates cluster near zero — a linear map would
 * render almost every cell in the step nearest the surface and hide exactly the
 * differences the chart exists to show.
 */
export function rampIndex(value: number, max: number): number {
  if (!Number.isFinite(value) || value <= 0 || max <= 0) return 0;
  const eased = Math.sqrt(Math.min(value, max) / max);
  return Math.min(RAMP_STEPS - 1, Math.round(eased * (RAMP_STEPS - 1)));
}

/** Fill for a magnitude, as a CSS custom-property reference. */
export const rampColor = (value: number, max: number): string =>
  `var(--ramp-${rampIndex(value, max)})`;

/** Label colour that stays legible on the corresponding fill. */
export const rampInk = (value: number, max: number): string =>
  `var(--ramp-${rampIndex(value, max)}-ink)`;

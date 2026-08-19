/**
 * Chart tooltip.
 *
 * Every plot in this dashboard ships a hover layer — an HTML/SVG chart is
 * interactive by nature and the alternative is labelling every mark, which is
 * unreadable at 24 runs × 12 areas.
 *
 * Positioned inside the nearest `.chart-wrap`, and flipped when it would spill
 * past the right or bottom edge so it never gets clipped.
 */

import type { ReactNode } from 'react';

export interface TooltipRow {
  label: string;
  value: string;
  /** Optional swatch + glyph, so status rows keep their secondary encoding. */
  color?: string;
  glyph?: string;
}

export interface TooltipState {
  x: number;
  y: number;
  title: string;
  subtitle?: string;
  rows: TooltipRow[];
  footer?: ReactNode;
}

interface Props {
  state: TooltipState | null;
  /** Container size, used to decide which way to flip. */
  width: number;
  height: number;
}

const TIP_WIDTH = 210;
const OFFSET = 14;

export function Tooltip({ state, width, height }: Props) {
  if (!state) return null;

  const flipX = state.x + TIP_WIDTH + OFFSET > width;
  const left = flipX ? Math.max(4, state.x - TIP_WIDTH - OFFSET) : state.x + OFFSET;
  // Rough height estimate is enough to decide the flip; the tooltip is short.
  const estimatedHeight = 48 + state.rows.length * 18;
  const top = Math.min(Math.max(4, state.y - 12), Math.max(4, height - estimatedHeight));

  return (
    <div className="tooltip" role="status" style={{ left, top, width: TIP_WIDTH }}>
      <div className="tt-title">{state.title}</div>
      {state.subtitle && (
        <div className="tt-row" style={{ marginBottom: 4 }}>
          <span className="dim">{state.subtitle}</span>
        </div>
      )}
      {state.rows.map((row) => (
        <div className="tt-row" key={row.label}>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5 }}>
            {row.color && (
              <span
                className="legend-swatch"
                style={{ background: row.color }}
                aria-hidden="true"
              />
            )}
            {row.glyph && <span aria-hidden="true">{row.glyph}</span>}
            {row.label}
          </span>
          <b>{row.value}</b>
        </div>
      ))}
      {state.footer && (
        <>
          <div className="tt-sep" />
          <div className="dim" style={{ fontSize: 11 }}>
            {state.footer}
          </div>
        </>
      )}
    </div>
  );
}

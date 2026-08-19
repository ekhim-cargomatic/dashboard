/** Small formatting helpers shared by tiles, axes and tables. */

export const pct = (value: number, digits = 1): string =>
  Number.isFinite(value) ? `${(value * 100).toFixed(digits)}%` : '—';

/** Signed percentage-point delta, e.g. "+2.4 pp". */
export const pp = (delta: number, digits = 1): string =>
  `${delta >= 0 ? '+' : '−'}${Math.abs(delta * 100).toFixed(digits)} pp`;

export const int = (value: number): string =>
  Number.isFinite(value) ? value.toLocaleString('en-US') : '—';

export function duration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const totalSeconds = Math.round(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function shortDate(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
}

export function dateTime(iso: string | null): string {
  if (!iso) return '—';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('en-US', {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function relativeTime(iso: string | null): string {
  if (!iso) return '—';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return '—';
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  return days < 30 ? `${days}d ago` : shortDate(iso);
}

/** Truncate for a table cell without cutting mid-word where avoidable. */
export function truncate(value: string, max: number): string {
  if (value.length <= max) return value;
  const clipped = value.slice(0, max);
  const lastSpace = clipped.lastIndexOf(' ');
  return `${lastSpace > max * 0.6 ? clipped.slice(0, lastSpace) : clipped}…`;
}

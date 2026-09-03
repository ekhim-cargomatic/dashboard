/**
 * Feature flags.
 *
 * Off by default. A flag is turned on for one browser via the URL and then
 * remembered, so an exploratory section can be shared with a colleague by link
 * without shipping it to everyone:
 *
 *   ?ff=training      turn on
 *   ?ff=-training     turn off
 *   ?ff=              clear all overrides
 *
 * `config.json` may also set defaults (`{"flags": {"training": true}}`), which is
 * how a flag would eventually be promoted for everyone without a rebuild.
 *
 * IMPORTANT — this is not access control. The flag hides UI; it does not hide
 * data. Anything the flagged code fetches is still fetchable by anyone, and
 * anything bundled is readable in the JS. Flagged features whose *data* must stay
 * private have to keep that data out of the deployed bundle and bucket entirely —
 * which is what lib/training.ts does.
 */

export const FLAGS = ['training'] as const;
export type FlagName = (typeof FLAGS)[number];

const STORAGE_KEY = 'qa-flags';

function readStored(): Partial<Record<FlagName, boolean>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<FlagName, boolean>>) : {};
  } catch {
    return {};
  }
}

function writeStored(value: Partial<Record<FlagName, boolean>>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
  } catch {
    // Storage unavailable — the URL override still applies for this page view.
  }
}

const isFlag = (name: string): name is FlagName => (FLAGS as readonly string[]).includes(name);

/**
 * Resolve flags once at startup: stored overrides, then anything in the URL
 * (which is also persisted so a shared link keeps working after navigation).
 */
export function resolveFlags(
  defaults: Partial<Record<FlagName, boolean>> = {},
): Record<FlagName, boolean> {
  const stored = readStored();

  const params = new URLSearchParams(window.location.search);
  if (params.has('ff')) {
    const raw = params.get('ff') ?? '';
    if (raw.trim() === '') {
      // `?ff=` with no value clears overrides rather than setting nothing.
      for (const name of FLAGS) delete stored[name];
    } else {
      for (const token of raw.split(',').map((t) => t.trim()).filter(Boolean)) {
        const off = token.startsWith('-');
        const name = off ? token.slice(1) : token;
        if (isFlag(name)) stored[name] = !off;
      }
    }
    writeStored(stored);
  }

  return Object.fromEntries(
    FLAGS.map((name) => [name, stored[name] ?? defaults[name] ?? false]),
  ) as Record<FlagName, boolean>;
}

/**
 * Feature flags.
 *
 * Off by default. A flag is turned on for one browser via the URL and then
 * remembered, so an exploratory section can be shared with a colleague by link
 * without shipping it to everyone:
 *
 *   ?ff=training-on    turn on   (also: training, training:on, training=on)
 *   ?ff=training-off   turn off  (also: -training, !training, training:off)
 *   ?ff=               clear all overrides
 *
 * Several spellings are accepted on purpose: the explicit `-on`/`-off` suffix is
 * the one worth typing and sharing, but a bare name and a `-` prefix are the
 * forms people reach for by habit, and silently ignoring them looks like the flag
 * is broken.
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

/** Parse one `ff` token into a flag and the state it requests. */
function parseToken(token: string): { name: FlagName; on: boolean } | null {
  let raw = token.trim().toLowerCase();
  if (!raw) return null;

  let on = true;

  // Prefix negation: -training, !training
  if (raw.startsWith('-') || raw.startsWith('!')) {
    on = false;
    raw = raw.slice(1);
  }

  // Suffix state: training-on, training:off, training=on
  const suffix = raw.match(/^(.*?)[-:=](on|off|true|false|1|0)$/);
  if (suffix) {
    raw = suffix[1];
    const state = suffix[2];
    const positive = state === 'on' || state === 'true' || state === '1';
    // A prefix negation combined with an explicit suffix means "not that state".
    on = on ? positive : !positive;
  }

  return isFlag(raw) ? { name: raw, on } : null;
}

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
      for (const token of raw.split(/[,\s]+/).filter(Boolean)) {
        const parsed = parseToken(token);
        if (parsed) stored[parsed.name] = parsed.on;
      }
    }
    writeStored(stored);
  }

  return Object.fromEntries(
    FLAGS.map((name) => [name, stored[name] ?? defaults[name] ?? false]),
  ) as Record<FlagName, boolean>;
}

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { AppConfig } from '../types';

/**
 * The device grid, as something you can watch and reach into.
 *
 * This is not the run drawer's LiveFrame and does not share any of its
 * machinery. That one exists because a CodeBuild container has no inbound
 * network: the only way to see the browser is for the runner to push JPEGs to
 * S3 and the page to poll one key, which is one-way by construction — you can
 * watch a run go wrong and do nothing about it.
 *
 * The grid is a long-lived host, so the browser can be connected *to*. Each
 * slot serves noVNC, and an iframe pointed at it is a real session: you can
 * click a stuck dialog, scroll, type into a field the plan got wrong, and the
 * run carries on from there. That is the whole reason the grid is worth its
 * hourly cost, so the tiles are the view rather than a sidebar next to a log.
 *
 * Nothing here fetches run data. A slot is busy or it is not — which the hub
 * knows and we ask it — and whatever is on the screen is the truth about what
 * the browser is doing.
 */

interface Props {
  config: AppConfig;
}

/** One addressable screen on the grid host. */
interface Slot {
  key: string;
  label: string;
  kind: 'chrome' | 'android';
  /** noVNC, embedded directly. */
  view: string;
  /** What a test would connect to, shown so it can be copied. */
  endpoint: string;
  busy: boolean;
}

/**
 * Ports are a convention, not a discovery protocol.
 *
 * The compose file in infra/grid publishes one noVNC port per slot precisely so
 * each session owns a screen, and these are the same numbers. A mismatch shows
 * up immediately as a tile that will not load, which is a better failure than
 * silently tiling the same session four times.
 */
const CHROME_PORTS = [7901, 7902, 7903, 7904];
const ANDROID = [
  { novnc: 6081, appium: 4723 },
  { novnc: 6082, appium: 4724 },
];

const hostOf = (base: string): string | null => {
  try {
    return new URL(base).hostname;
  } catch {
    return null;
  }
};

export function DeviceGrid({ config }: Props) {
  const host = useMemo(() => hostOf(config.gridBaseUrl), [config.gridBaseUrl]);
  // noVNC wants the password in the query string. Without it `autoconnect=1`
  // stops at a prompt and the tile paints nothing at all - a 0x0 canvas rather
  // than an error, which looks exactly like a grid that is down.
  const auth = config.gridVncPassword
    ? `&password=${encodeURIComponent(config.gridVncPassword)}`
    : '';
  const [busyCount, setBusyCount] = useState(0);
  const [reachable, setReachable] = useState<boolean | null>(null);
  const [nodes, setNodes] = useState(0);
  // Bumped to force every iframe to remount. A noVNC tile that was open while
  // the grid restarted shows a dead canvas forever otherwise, and reloading the
  // whole dashboard to clear it loses the rest of the page's state.
  const [epoch, setEpoch] = useState(0);

  const poll = useCallback(async () => {
    if (!config.gridBaseUrl) return;
    try {
      const response = await fetch(`${config.gridBaseUrl.replace(/\/$/, '')}/status`, {
        cache: 'no-store',
      });
      const body = (await response.json()) as {
        value?: { ready?: boolean; nodes?: { slots?: { session?: unknown }[] }[] };
      };
      const list = body.value?.nodes ?? [];
      setNodes(list.length);
      setBusyCount(
        list.reduce(
          (n, node) => n + (node.slots ?? []).filter((s) => s.session != null).length,
          0,
        ),
      );
      setReachable(Boolean(body.value?.ready));
    } catch {
      // The grid is behind a security group that admits one address. Not
      // reachable is the normal state from anywhere else, and from here it
      // usually means the instance is stopped — which is what it should be
      // when nobody is using it.
      setReachable(false);
    }
  }, [config.gridBaseUrl]);

  useEffect(() => {
    void poll();
    const timer = setInterval(() => void poll(), 5000);
    return () => clearInterval(timer);
  }, [poll]);

  const slots: Slot[] = useMemo(() => {
    if (!host) return [];
    const out: Slot[] = CHROME_PORTS.map((port, i) => ({
      key: `chrome-${i + 1}`,
      label: `Chrome ${i + 1}`,
      kind: 'chrome' as const,
      view: `http://${host}:${port}/?autoconnect=1&resize=scale${auth}`,
      endpoint: `${config.gridBaseUrl} (slot ${i + 1})`,
      busy: i < busyCount,
    }));
    ANDROID.forEach((a, i) => {
      out.push({
        key: `android-${i + 1}`,
        label: `Android ${i + 1}`,
        kind: 'android',
        view: `http://${host}:${a.novnc}/?autoconnect=1&resize=scale${auth}`,
        endpoint: `http://${host}:${a.appium}`,
        busy: false,
      });
    });
    return out;
    // busyCount only says HOW MANY sessions are live, not which node holds
    // them, so the first N tiles are marked rather than the right ones. The
    // screens themselves are unambiguous; this is only a hint.
  }, [host, config.gridBaseUrl, auth, busyCount]);

  if (!config.gridBaseUrl) {
    return (
      <div className="grid-empty">
        <h3>No grid configured</h3>
        <p className="muted">
          Set <code>gridBaseUrl</code> in <code>public/config.json</code> to the Selenium
          hub — <code>http://&lt;host&gt;:4444</code>. It is deliberately not in the
          deployed config: the grid admits one IP, and publishing its address on a
          world-readable page would be handing out the door number.
        </p>
        <pre className="grid-pre">{`./infra/deploy-grid.sh status   # prints the address`}</pre>
      </div>
    );
  }

  return (
    <div className="grid-wrap">
      <div className="grid-bar">
        <span className={`grid-dot ${reachable ? 'is-up' : 'is-down'}`} aria-hidden="true" />
        <strong>{reachable ? 'Grid ready' : 'Not reachable'}</strong>
        <span className="muted">
          {reachable
            ? `${nodes} Chrome ${nodes === 1 ? 'node' : 'nodes'} · ${busyCount} busy`
            : 'the instance may be stopped, or your IP changed'}
        </span>
        <span className="grid-spacer" />
        <code className="grid-url">SELENIUM_REMOTE_URL={config.gridBaseUrl}</code>
        <button type="button" className="btn" onClick={() => setEpoch((n) => n + 1)}>
          Reload views
        </button>
        <a className="btn" href={`${config.gridBaseUrl}/ui`} target="_blank" rel="noreferrer">
          Grid UI
        </a>
      </div>

      {!reachable && (
        <p className="grid-hint muted">
          Bring it up with <code>./infra/deploy-grid.sh up</code>, then{' '}
          <code>./infra/deploy-grid.sh push</code>. The public address changes on every
          stop/start, so <code>push</code> is what re-points the nodes at it — and{' '}
          <code>allow-ip</code> if you have moved network.
        </p>
      )}

      <div className="grid-tiles">
        {slots.map((slot) => (
          <figure key={slot.key} className={`grid-tile is-${slot.kind}`}>
            <figcaption>
              <span className={`grid-badge is-${slot.kind}`}>{slot.label}</span>
              {slot.busy && <span className="grid-badge is-busy">in use</span>}
              <span className="grid-spacer" />
              <a href={slot.view} target="_blank" rel="noreferrer" title="Open this screen on its own">
                ↗
              </a>
            </figcaption>
            {/*
              * No sandbox attribute. noVNC needs scripts, and the whole point of
              * the tile is that keyboard and pointer events reach the session —
              * a sandbox tight enough to be worth having would take that away.
              * The frame is same-network-only by security group, and it is the
              * reason this tab is not deployed publicly.
              */}
            <iframe
              key={`${slot.key}-${epoch}`}
              src={slot.view}
              title={`${slot.label} live session`}
              loading="lazy"
              allow="clipboard-read; clipboard-write"
            />
            <div className="grid-foot">
              <code>{slot.endpoint}</code>
            </div>
          </figure>
        ))}
      </div>
    </div>
  );
}

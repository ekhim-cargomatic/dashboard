#!/usr/bin/env bash
#
# Everything the flow map needs, locally, in one command.
#
#   npm run dev:all              # real runs, visible browser
#   npm run dev:all -- --fake    # simulated CodeBuild, no browser
#
# Starts the Vite dev server and the flow-run function together and shuts both
# down on Ctrl-C. The function is what the dashboard's play button talks to;
# without it the dialog says it cannot reach the run function.
#
# FLOW_PY / FLOW_REPO / FLOW_ENV override where the runner and the suite live.
#
# Written for bash 3.2, which is what macOS ships: no `wait -n`, no namerefs,
# and an empty array is an unbound variable under `set -u`.
set -euo pipefail
cd "$(dirname "$0")/.."

REAL=1
for arg in "$@"; do
  [ "$arg" = "--fake" ] && REAL=0
done

if [ "$REAL" = "1" ]; then
  PY="${FLOW_PY:-../playwright-automation/.venv/bin/python}"
  if [ ! -x "$PY" ]; then
    echo "dev.sh: no python at $PY" >&2
    echo "        that venv needs playwright installed (make install in playwright-automation)," >&2
    echo "        or set FLOW_PY to one that does. Use --fake to skip real runs." >&2
    exit 1
  fi
fi

fn_pid=""
vite_pid=""

cleanup() {
  trap - INT TERM EXIT
  [ -n "$fn_pid" ] && kill "$fn_pid" 2>/dev/null
  [ -n "$vite_pid" ] && kill "$vite_pid" 2>/dev/null
  # Belt and braces: anything else this shell started directly. Without it a
  # wrapper that forwards no signals leaves the real process holding the port,
  # and the next `npm run dev:all` fails on an address already in use.
  pkill -P $$ 2>/dev/null
  return 0
}
trap cleanup INT TERM EXIT

if [ "$REAL" = "1" ]; then
  node infra/flow-run-fn/local-server.mjs --real &
else
  node infra/flow-run-fn/local-server.mjs &
fi
fn_pid=$!

# The binary, not `npx`: npx is a wrapper process, so its pid is not vite's and
# killing it leaves the dev server running.
if [ -x ./node_modules/.bin/vite ]; then
  ./node_modules/.bin/vite &
else
  npx vite &
fi
vite_pid=$!

# bash 3.2 has no `wait -n`, so poll: the moment either one dies, the trap
# takes the other down with it rather than leaving half a dev environment up.
while kill -0 "$fn_pid" 2>/dev/null && kill -0 "$vite_pid" 2>/dev/null; do
  sleep 1
done

echo "dev.sh: one of the two processes exited — shutting the other down." >&2

#!/usr/bin/env bash
#
# Keep every emulator in a state a test can actually drive.
#
# Two settings, both of which cost real runs in the CAR-3184 stress sweep:
#
#   hide_error_dialogs=1   "System UI isn't responding" covered android-2's
#                          screen at login and again mid-typing. That dialog
#                          steals focus, so the next tap lands on it instead of
#                          the app, and the failure surfaces somewhere later as
#                          a missing element. Under load on a software-rendered
#                          emulator these ANRs are routine; suppressing the
#                          dialog is what the emulator is for.
#
#   *_animation_scale=0    Animations are dead time that UiAutomator2 waits
#                          through on every transition, and a running animation
#                          is also what makes a "did the view settle yet" check
#                          flaky.
#
# WHY A LOOP AND NOT A ONE-OFF
#
# These live in the guest's settings database, which is part of the emulator's
# userdata. A container restart -- or `up -d --force-recreate`, which is the
# only thing that revives a dead slot -- boots a fresh emulator with stock
# settings. Applying them once at provisioning time means they are silently
# gone from exactly the slot that just crashed and came back, which is the slot
# you are least able to afford them missing from.
#
# So: re-check every interval, apply only what drifted. `settings put` is a few
# milliseconds and the read tells us whether to bother, so the steady state is
# four cheap reads per slot per interval and no writes.
#
# Runs on the HOST, not in a sidecar, so nothing in the grid needs the docker
# socket mounted into it. Installed and enabled by deploy-grid.sh push.

set -uo pipefail

INTERVAL="${GRID_TUNE_INTERVAL:-30}"
SLOTS="${GRID_TUNE_SLOTS:-1 2 3 4}"

# setting -> wanted value
declare -A WANT=(
  [hide_error_dialogs]=1
  [window_animation_scale]=0
  [transition_animation_scale]=0
  [animator_duration_scale]=0
)

log() { printf '%s tune: %s\n' "$(date -u +%H:%M:%S)" "$*"; }

in_slot() {
  local n="$1"; shift
  # Captured, not piped onward by the callers. `in_slot ... | grep -q` makes
  # grep close the pipe on its first match, which kills `tr` with SIGPIPE and
  # fills the journal with "tr: write error: Broken pipe" on every successful
  # check. The noise is harmless and reads exactly like something going wrong.
  docker exec "qa-grid-android-$n" sh -c "$*" 2>/dev/null | tr -d '\r' || true
}

has_pkg() {
  local out
  out="$(in_slot "$1" "adb shell pm list packages 2>/dev/null")"
  [[ "$out" == *"$PKG"* ]]
}

booted() {
  local out
  out="$(in_slot "$1" 'adb shell getprop sys.boot_completed 2>/dev/null')"
  [[ "${out%%$'\n'*}" == "1" ]]
}

tune_slot() {
  local n="$1" key want got applied=0
  booted "$n" || return 0
  for key in "${!WANT[@]}"; do
    want="${WANT[$key]}"
    got="$(in_slot "$n" "adb shell settings get global $key 2>/dev/null")"
    got="${got%%$'\n'*}"
    # `null` is what a never-set global reads back as, and it is the usual
    # state on a freshly booted emulator.
    if [[ "$got" != "$want" ]]; then
      in_slot "$n" "adb shell settings put global $key $want" >/dev/null
      applied=$((applied + 1))
    fi
  done
  (( applied > 0 )) && log "android-$n: applied $applied setting(s)"
  return 0
}

# The app under test, kept beside this script by `deploy-grid.sh install-apk`.
#
# Recreating a container is the ONLY way to revive a slot whose emulator died,
# and it necessarily throws away that emulator's userdata -- which is where the
# installed app lives. So the standard recovery silently uninstalls the thing
# the slot exists to test, and the next run fails on a missing package rather
# than on anything real. Re-installing here closes that loop: a recreated slot
# puts itself back together within one interval.
APK="${GRID_TUNE_APK:-/opt/qa-grid/app.apk}"
PKG="${GRID_TUNE_PKG:-com.cargomatic.driver.android}"

ensure_apk() {
  local n="$1" out
  [[ -f "$APK" ]] || return 0
  has_pkg "$n" && return 0
  log "android-$n: $PKG missing, installing"
  docker cp "$APK" "qa-grid-android-$n:/tmp/app.apk" >/dev/null 2>&1 || return 0
  # adb's own verdict, not a package-list read taken immediately after. Right
  # after boot the package manager accepts the install and still answers an
  # incomplete list for a second or two, so the read said FAILED on installs
  # that had plainly worked -- and a log that cries wolf is a log nobody reads.
  # If it really did fail, the next pass tries again; convergence is the point
  # of the loop.
  out="$(in_slot "$n" "adb install -r -g /tmp/app.apk 2>&1 | tail -2")"
  if [[ "$out" == *Success* ]]; then
    log "android-$n: installed"
  else
    log "android-$n: install did not report Success (${out//$'\n'/ }); will retry next pass"
  fi
}

log "watching slots [$SLOTS] every ${INTERVAL}s"
while true; do
  for n in $SLOTS; do
    tune_slot "$n"
    booted "$n" && ensure_apk "$n"
  done
  sleep "$INTERVAL"
done

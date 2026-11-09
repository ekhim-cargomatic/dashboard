"""
Walk a flow-map plan in a real browser.

This is the other half of infra/flow-run-fn/plan.mjs. That file turns a point on
the map into an ordered list of steps; this one performs them. Nothing here
decides what to do — it is deliberately a dumb executor, because the plan it is
given came from a public endpoint and the only thing standing between that
endpoint and a signed-in admin browser is that this file cannot be talked into
anything the Lambda did not already authorise.

It is not behave and it loads no feature files. The map is the script.

Credentials never travel in a plan. A step that needs one carries the marker
`{{cred:<role>.<field>}}` and it is resolved here, out of the suite's own
configs/<env>.yaml — the same file and the same role names the Playwright suite
uses, so a run signs in as exactly who CI signs in as.

Output is Allure result files, one test case per run with a step per plan step.
That is what lets a flow run land in the dashboard's run list beside the CI
suites, with the same report and the same qa-summary.json, rather than needing a
second kind of result nothing else understands.
"""

from __future__ import annotations

import argparse
import base64
import json
import os
import re
import sys
import threading
import time
import uuid
from pathlib import Path

import yaml
from playwright.sync_api import Error as PlaywrightError
from playwright.sync_api import TimeoutError as PlaywrightTimeout
from playwright.sync_api import sync_playwright

CRED = re.compile(r"\{\{cred:([a-z_]+)\.([a-z_]+)\}\}", re.IGNORECASE)

# utils/config.py:_PASSWORD_PLACEHOLDER_RE — a password that looks like this is
# the *name* of an environment variable, not the password.
PLACEHOLDER = re.compile(r"^[a-z][a-z0-9_]*_pass$")

# Long enough for staging's slower screens, short enough that a wrong selector
# reports in well under a minute instead of stalling the whole run.
#
# The suite's own configs/<env>.yaml carries a `timeouts.default`, but that
# number is for a page object that has already waited for its screen. Here the
# very first gesture after a navigation often lands on a page still painting
# thousands of rows, so the floor is higher: 15s times out on controls that are
# present, correct and simply not ready, which reads as a stale selector and
# sends you looking for a bug in the map.
DEFAULT_TIMEOUT_MS = 30000


# ───────────────────────────────────────────────────────── flow variables ──

VAR = re.compile(r"\{([a-zA-Z][A-Za-z0-9_]*)\}")


def substitute(text: str, variables: dict) -> str:
    """Put captured values into a path or selector. Unknown names are left alone."""
    return VAR.sub(lambda m: str(variables.get(m.group(1), m.group(0))), text)


def pointer(doc, path: str):
    """A JSON Pointer, as the map writes them: /id, /_id, /0/_id, /user/_id."""
    cur = doc
    for part in path.strip("/").split("/"):
        if isinstance(cur, list):
            cur = cur[int(part)]
        else:
            cur = cur[part]
    return cur


def capture_from(step: dict, response, element, variables: dict) -> list[str]:
    """
    Pull the flow variables a step produces.

    Two shapes, both already in the map: a JSON Pointer into the response the
    step awaited, and `href:<regex>` read off the element — the latter for the
    steps that navigate to a record rather than create one, where the id is in
    the link and never in a response body.
    """
    taken = []
    for name, how in (step.get("capture") or {}).items():
        try:
            if str(how).startswith("href:"):
                if element is None:
                    continue
                href = element.get_attribute("href") or ""
                found = re.search(str(how)[len("href:"):], href)
                if not found:
                    continue
                variables[name] = found.group(1)
            else:
                if response is None:
                    continue
                variables[name] = str(pointer(response.json(), str(how)))
            taken.append(f"{name}={variables[name]}")
        except Exception:
            # A capture that does not land is only fatal if a later step needs
            # it, and that step will say so in its own words.
            continue
    return taken


def log(message: str) -> None:
    """Progress goes to stdout unbuffered: it is streamed into the dashboard."""
    print(message, flush=True)


# ─────────────────────────────────────────────────────────── credentials ──

def load_config(repo: Path, env: str) -> dict:
    path = repo / "configs" / f"{env}.yaml"
    if not path.exists():
        raise SystemExit(f"no config at {path} — the payload is not a playwright-automation tree")
    return yaml.safe_load(path.read_text())


def resolve_secret(config: dict, role: str, field: str) -> str:
    """
    A credential out of configs/<env>.yaml, with the suite's own indirection.

    A password there is a placeholder naming an environment variable
    (`password: "shipper_pass"` -> $SHIPPER_PASS), which is how that file stays
    committable. `default` is the password newly registered accounts are given,
    so a later sign-in as one of them finds what it expects.
    """
    creds = config.get("credentials", {})
    if role == "default":
        role, field = "shipper", "password"
    entry = creds.get(role)
    if not entry:
        raise KeyError(f"configs/<env>.yaml has no credentials for role '{role}'")
    raw = entry.get(field)
    if raw is None:
        raise KeyError(f"role '{role}' has no '{field}'")
    value = str(raw)

    # utils/config.py's rule, reproduced exactly rather than approximated: only
    # a value shaped like `shipper_pass` names an environment variable. Admin's
    # password on staging is the literal string "admin", and uppercasing that
    # into $ADMIN looks for a variable nobody sets.
    if field == "password" and PLACEHOLDER.match(value):
        resolved = os.environ.get(value.upper())
        if not resolved:
            raise KeyError(f"${value.upper()} is unset — the .env in the payload does not carry it")
        return resolved
    return value


def fill_credentials(value: str, config: dict) -> str:
    def swap(match: re.Match) -> str:
        return resolve_secret(config, match.group(1).lower(), match.group(2).lower())
    return CRED.sub(swap, value)


# ────────────────────────────────────────────────────────────── gestures ──

class LiveView:
    """
    The browser, pushed out of the container while the run is happening.

    A CodeBuild container has no inbound network path -- no public IP, nothing
    listening -- so nothing can connect *to* Chromium the way a local debugger
    would. The frames have to go the other way, and the only pipe that already
    exists is the bucket the report is published to.

    Chromium's own screencast produces them: the compositor hands over a JPEG
    on each repaint, which costs the run far less than calling screenshot() on
    a timer would, and gives frames at the moments something actually changed
    rather than on a clock that knows nothing about the page.

    Two threads, deliberately. Frames are acked on Playwright's event thread --
    the ack is the flow control, and without it Chromium sends one frame and
    stops -- while the upload happens on another, because an S3 PUT inside the
    frame handler would stall the browser between repaints. Only ever the
    newest frame is uploaded: a viewer wants to see now, not a backlog, so
    dropping the ones in between is the correct behaviour rather than a
    shortcut.

    Entirely best-effort. Every failure here is swallowed, because a run that
    works is worth more than a run you can watch.
    """

    def __init__(self, bucket: str, key: str, fps: float = 3.0):
        self.bucket, self.key = bucket, key
        self.gap = 1.0 / fps
        self._latest: bytes | None = None
        self._lock = threading.Lock()
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self._cdp = None
        self._s3 = None
        self.sent = self.dropped = 0

    def start(self, context, page) -> bool:
        try:
            import boto3
            self._s3 = boto3.client("s3")
            self._cdp = context.new_cdp_session(page)
            self._cdp.on("Page.screencastFrame", self._on_frame)
            self._cdp.send("Page.startScreencast", {
                "format": "jpeg", "quality": 55,
                # Narrower than the 1600px viewport: the panel shows this a few
                # hundred pixels wide, and a full-width frame is four times the
                # bytes for detail nothing renders.
                "maxWidth": 1200, "maxHeight": 750, "everyNthFrame": 1,
            })
        except Exception as err:
            log(f"live view unavailable ({type(err).__name__}: {err}) — the run is unaffected")
            return False
        self._thread = threading.Thread(target=self._upload_loop, daemon=True)
        self._thread.start()
        return True

    def _on_frame(self, event: dict) -> None:
        try:
            frame = base64.b64decode(event["data"])
        except Exception:
            return
        with self._lock:
            if self._latest is not None:
                self.dropped += 1
            self._latest = frame
        try:
            self._cdp.send("Page.screencastFrameAck", {"sessionId": event["sessionId"]})
        except Exception:
            pass

    def _upload_loop(self) -> None:
        while not self._stop.is_set():
            self._stop.wait(self.gap)
            self._flush()

    def _flush(self) -> None:
        with self._lock:
            frame, self._latest = self._latest, None
        if frame is None:
            return
        try:
            self._s3.put_object(
                Bucket=self.bucket, Key=self.key, Body=frame,
                ContentType="image/jpeg",
                # The panel re-reads this one key for the whole run, so a cached
                # copy anywhere between here and the browser freezes the view.
                CacheControl="no-store, max-age=0",
            )
            self.sent += 1
        except Exception:
            pass

    def stop(self) -> None:
        if self._cdp is not None:
            try:
                self._cdp.send("Page.stopScreencast")
            except Exception:
                pass
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=3)
        # One last push, so the view ends on what the browser actually last
        # showed rather than on whatever happened to be mid-interval.
        self._flush()


class StepFailed(Exception):
    def __init__(self, message: str, screenshot: str | None = None):
        super().__init__(message)
        self.screenshot = screenshot


def locator(page, step: dict):
    """
    One element from a map selector.

    `.first` on purpose: map selectors are authored to describe a control, not
    to be unique on every data set, and a list page with two matching rows
    should not fail as "strict mode violation" when the step means "the one at
    the top".
    """
    selector = step.get("selector")
    if not selector:
        raise StepFailed("the map has no selector for this step")
    return page.locator(selector).first


def ready(target, timeout: int = DEFAULT_TIMEOUT_MS, label: str = ""):
    """
    Wait for an element to be genuinely interactable.

    Attached first, then scrolled into view, then visible. The scroll is not
    politeness: this app renders screens tens of thousands of pixels tall, and a
    control far below the fold can sit at zero size until something forces a
    layout pass — at which point `wait_for(visible)` has already spent its whole
    budget on an element that was present and correct the entire time.
    """
    try:
        target.wait_for(state="attached", timeout=timeout)
        try:
            target.scroll_into_view_if_needed(timeout=timeout)
        except (PlaywrightTimeout, PlaywrightError):
            pass
        target.wait_for(state="visible", timeout=timeout)
    except PlaywrightTimeout:
        # Name what was actually being waited for. A step can wait on more than
        # one element — a typeahead waits on its input and then on its
        # suggestion list — and a message naming only the step sends you to the
        # wrong selector.
        raise StepFailed(f"never became visible{f': {label}' if label else ''}") from None
    return target


def await_response(page, step: dict):
    """
    The network call the map says this step fires.

    Matching on the path suffix rather than the whole URL is deliberate: the
    admin client calls bare /api/..., and the edge gateway serves the same route
    under /mono, so the observed URL has a prefix the map does not carry.
    """
    spec = step.get("await")
    if not spec:
        return None
    path = spec["path"]
    method = spec.get("method", "POST")
    timeout = spec.get("timeoutMs") or 30000
    return page.expect_response(
        lambda r: path in r.url and r.request.method == method,
        timeout=timeout,
    )


def perform(page, step: dict, config: dict, variables: dict) -> str:
    """Do one step. Returns a one-line description of what happened."""
    verb = step["verb"]
    value = step.get("value")
    if isinstance(value, str):
        value = fill_credentials(substitute(value, variables), config)
    if step.get("selector"):
        step["selector"] = substitute(step["selector"], variables)

    if verb == "goto":
        url = substitute(step["url"], variables)
        # "load", not "domcontentloaded": this is a single-page app whose
        # screens mount from bundles that are still arriving at DOMContentLoaded.
        # Navigating on the earlier event lands on a half-built page where the
        # controls do not exist yet and the stylesheets have not applied — which
        # reads as a stale selector rather than as the race it is.
        page.goto(url, wait_until="load", timeout=60000)
        # "load" fires when the document's own resources are in, but this app
        # fetches its stylesheets and the screen's bundle after that. Acting too
        # early finds the control in the DOM and unstyled, which has no box, so
        # Playwright reports it as hidden and the step reads as a stale
        # selector. Settling is best-effort: a screen that polls never goes
        # quiet, and waiting for it forever would be worse than acting early.
        try:
            page.wait_for_load_state("networkidle", timeout=10000)
        except PlaywrightTimeout:
            pass
        return f"at {url}"

    target = locator(page, step)

    if verb == "fill":
        ready(target)
        target.fill(value or "")
        return f"typed into {step['name']}"

    if verb == "check":
        ready(target)
        if str(value).lower() in ("false", "0", "no"):
            target.uncheck()
            return f"cleared {step['name']}"
        target.check()
        return f"ticked {step['name']}"

    if verb == "select":
        ready(target)
        if value:
            target.select_option(label=value)
        else:
            # The map knows the control, not the account's data, so "the first
            # real option" is the only choice that is right on every environment.
            target.select_option(index=step.get("byIndex", 1))
        return f"chose an option in {step['name']}"

    if verb == "pickOption":
        ready(target)
        target.click()
        if value:
            target.fill(value)
        # A typeahead fires per keystroke; the list is not the list until it settles.
        page.wait_for_timeout(step.get("settleMs") or 1200)
        for follow in step.get("follow") or []:
            nxt = page.locator(follow["selector"]).first
            if follow.get("action") == "type":
                ready(nxt, label=f"{step['name']} input")
                nxt.fill(value or "")
                page.wait_for_timeout(step.get("settleMs") or 1200)
            else:
                ready(nxt, label=f"{step['name']} suggestion list")
                nxt.click()
        return f"picked an option for {step['name']}"

    if verb in ("click", "clickMenuItem", "clickTab"):
        ready(target)
        waiter = await_response(page, step)
        if waiter is not None:
            with waiter as got:
                target.click()
            response = got.value
            settle = step.get("settleMs")
            if settle:
                page.wait_for_timeout(settle)
            taken = capture_from(step, response, target, variables)
            detail = f"clicked {step['name']} — {step['await']['method']} {step['await']['path']} {response.status}"
            return detail + (f"  captured {', '.join(taken)}" if taken else "")
        taken = capture_from(step, None, target, variables)
        target.click()
        return f"clicked {step['name']}" + (f"  captured {', '.join(taken)}" if taken else "")

    if verb == "assert":
        expect = step.get("expect", "visible")
        if expect == "absent":
            target.wait_for(state="hidden", timeout=DEFAULT_TIMEOUT_MS)
            return f"{step['name']} is absent, as expected"
        ready(target)
        if expect in ("text", "value"):
            seen = (target.input_value() if expect == "value" else target.inner_text()).strip()
            if not seen:
                raise StepFailed(f"{step['name']} is present but empty")
            return f"{step['name']} reads {seen[:60]!r}"
        return f"{step['name']} is visible"

    raise StepFailed(f"'{verb}' is not a gesture this runner knows")


# ──────────────────────────────────────────────────────────────── allure ──

def write_result(results: Path, plan: dict, steps: list[dict], status: str,
                 message: str, start_ms: int, stop_ms: int) -> None:
    """
    One Allure test case for the run, with a step per plan step.

    The labels are the ones qa-summary.mjs reads, so a flow run groups into the
    same domains and renders in the same report as a CI suite. `historyId` is
    the target node, which makes the same button pressed on two days one test
    with a history rather than two unrelated ones.
    """
    results.mkdir(parents=True, exist_ok=True)
    body = {
        "uuid": str(uuid.uuid4()),
        "historyId": f"flow:{plan['target']}",
        "name": f"{plan['chunkName']} — {plan['targetName']}",
        "fullName": f"flow.{plan['chunk']}.{plan['target']}",
        "status": status,
        "stage": "finished",
        "start": start_ms,
        "stop": stop_ms,
        "steps": steps,
        "labels": [
            {"name": "suite", "value": plan["chunkName"]},
            {"name": "feature", "value": plan["chunkName"]},
            {"name": "story", "value": plan["targetName"]},
            {"name": "framework", "value": "flow-map"},
            {"name": "tag", "value": f"flow:{plan['chunk']}"},
            {"name": "tag", "value": f"portal:{plan.get('portal', 'admin')}"},
        ],
    }
    if message:
        body["statusDetails"] = {"message": message[:2000], "trace": ""}
    (results / f"{body['uuid']}-result.json").write_text(json.dumps(body))


def main() -> int:
    parser = argparse.ArgumentParser(description="Run a flow-map plan in a browser.")
    parser.add_argument("--plan", required=True, help="the plan JSON built by the Lambda")
    parser.add_argument("--repo", default=".", help="the playwright-automation tree")
    parser.add_argument("--env", default="staging")
    parser.add_argument("--results", default="reports/allure-results")
    parser.add_argument("--screenshots", default="reports/screenshots")
    parser.add_argument("--headless", default="true")
    parser.add_argument("--live-bucket", default="", help="bucket to stream frames to")
    parser.add_argument("--live-key", default="", help="object the newest frame overwrites")
    args = parser.parse_args()

    plan = json.loads(Path(args.plan).read_text())
    repo = Path(args.repo).resolve()
    config = load_config(repo, args.env)
    base_url = str(config.get("base_url") or plan.get("baseUrl") or "").rstrip("/")
    shots = Path(args.screenshots)
    shots.mkdir(parents=True, exist_ok=True)

    log(f"flow: {plan['chunkName']} — {plan['targetName']}")
    log(f"target {plan['target']} · {len(plan['steps'])} steps · {args.env} · {base_url}")
    log(f"chunks: {' -> '.join(plan['chunks'])}")
    log("")

    allure_steps: list[dict] = []
    run_start = int(time.time() * 1000)
    status, message = "passed", ""

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=args.headless != "false")
        context = browser.new_context(viewport={"width": 1600, "height": 1000})
        context.set_default_timeout(DEFAULT_TIMEOUT_MS)
        page = context.new_page()

        # Started before the first step so the panel has something to show
        # while the plan is still on its way to /login.
        live = None
        if args.live_bucket and args.live_key:
            live = LiveView(args.live_bucket, args.live_key)
            if live.start(context, page):
                log(f"live view: s3://{args.live_bucket}/{args.live_key}")
            else:
                live = None

        variables: dict[str, str] = {}
        for i, step in enumerate(plan["steps"], start=1):
            if step["verb"] == "goto":
                step["url"] = f"{base_url}{step['path']}"
            label = f"{i:2d}/{len(plan['steps'])}  {step['verb']:<13} {step['name']}"
            started = int(time.time() * 1000)
            try:
                detail = perform(page, step, config, variables)
                log(f"{label}  ✓  {detail}")
                allure_steps.append({
                    "name": f"{step['verb']} {step['name']}",
                    "status": "passed", "stage": "finished",
                    "start": started, "stop": int(time.time() * 1000),
                })
            except (StepFailed, PlaywrightTimeout, PlaywrightError, KeyError) as err:
                shot = shots / f"{plan['target']}-step{i}.png"
                try:
                    page.screenshot(path=str(shot), full_page=True)
                except Exception:
                    shot = None
                reason = str(err).strip().splitlines()[0][:300]
                status = "failed"
                message = f"step {i} ({step['verb']} {step['name']}): {reason}"
                log(f"{label}  ✗  {reason}")
                # Every step after this one would run against a screen that is
                # not where the plan thinks it is, so their results would be
                # noise. The failure is the answer.
                log(f"       selector: {step.get('selector') or step.get('url', '')}")
                # Where the browser actually was, and whether the element was
                # missing or merely hidden — the two have different answers and
                # the message alone does not tell them apart.
                try:
                    found = page.locator(step["selector"]).count() if step.get("selector") else 0
                    log(f"       page: {page.url}  ·  matches: {found}")
                    if found:
                        el = page.locator(step["selector"]).first
                        log(f"       visible={el.is_visible()} box={el.bounding_box()} "
                            f"sheets={page.evaluate('document.styleSheets.length')}")
                except Exception:
                    pass
                if variables:
                    log(f"       variables: {variables}")
                if shot:
                    log(f"       screenshot: {shot}")
                allure_steps.append({
                    "name": f"{step['verb']} {step['name']}",
                    "status": "failed", "stage": "finished",
                    "statusDetails": {"message": reason, "trace": ""},
                    "start": started, "stop": int(time.time() * 1000),
                })
                break

        if live is not None:
            live.stop()
            log(f"live view: {live.sent} frames sent, {live.dropped} superseded")

        context.close()
        browser.close()

    run_stop = int(time.time() * 1000)
    write_result(Path(args.results), plan, allure_steps, status, message, run_start, run_stop)

    done = sum(1 for s in allure_steps if s["status"] == "passed")
    log("")
    log(f"{done}/{len(plan['steps'])} steps passed in {(run_stop - run_start) / 1000:.1f}s — {status}")
    # The build answers "did the run complete", qa-summary.json answers "did it
    # pass". A failing step is a result, not a broken runner.
    return 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
"""
What the monolith exposes, and what the flow map has not reached yet.

validate-flow.py answers "is every endpoint in the map real?". This answers the
other direction — "what is real that the map has not described?" — which is the
question you have while authoring, not while checking.

    python3 scripts/route-map.py ~/Documents/Automation/monopoly
    python3 scripts/route-map.py ~/..../monopoly --unmapped      # worklist only
    python3 scripts/route-map.py ~/..../monopoly --json out.json # machine-readable

For each registered route it reports the file and line that registers it, and
the services, models and workers the handler actually calls — resolved from the
file's requires and matched against identifiers used inside that handler body,
so a module imported but unused in this handler is not reported.

The handler walk is a brace match, not a parse. That is accurate for the
monolith's `app.verb('path', handler)` shape but will mis-scope anything that
builds a route dynamically; those come out with no `touches` rather than wrong
ones, which is the safe direction to fail in.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from collections import Counter, OrderedDict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FLOW_DIR = REPO / "public" / "qa-flow"

VERB = re.compile(r"\bapp\.(get|post|put|patch|delete)\(\s*['\"`]([^'\"`]+)['\"`]", re.I)
REQUIRE = re.compile(
    r"(?:const|var|let)\s+(\{[^}]+\}|[A-Za-z0-9_$]+)\s*=\s*require\(\s*['\"]([^'\"]+)['\"]"
)

KINDS = (("/services/", "service"), ("/models/", "model"), ("/workers/", "worker"))
MAX_HANDLER_CHARS = 60_000


def normalise(path: str) -> str:
    """`/api/orders/{orderId}` and `/api/orders/:id` are the same route."""
    path = "/" + path.strip().lstrip("/")
    path = re.sub(r"\{[^}]+\}", ":p", path)
    path = re.sub(r":[A-Za-z0-9_]+", ":p", path)
    return path.rstrip("/").lower()


def handler_source(text: str, start: int) -> str:
    """The whole `app.verb(...)` call, by balancing parens from its first one."""
    opening = text.index("(", start)
    depth = 0
    for i in range(opening, min(len(text), opening + MAX_HANDLER_CHARS)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[opening : i + 1]
    return text[opening : opening + MAX_HANDLER_CHARS]


def kind_of(module: str) -> str | None:
    for marker, kind in KINDS:
        if marker in module:
            return kind
    return None


def routes_in(path: Path, root: Path) -> list[dict]:
    text = path.read_text(errors="ignore")

    imports: dict[str, str] = {}
    for names, module in REQUIRE.findall(text):
        # Destructured `const { a, b } = require(...)` binds several names to one module.
        for name in re.findall(r"[A-Za-z0-9_$]+", names):
            imports[name] = module

    found = []
    for match in VERB.finditer(text):
        body = handler_source(text, match.start())
        touches: OrderedDict[str, str] = OrderedDict()
        for name, module in imports.items():
            kind = kind_of(module)
            # `Name.` or `Name(` — a bare mention in a comment does not count.
            if kind and re.search(rf"\b{re.escape(name)}\b\s*[.(]", body):
                touches[module.replace("@root/", "")] = kind

        found.append(
            {
                "method": match.group(1).upper(),
                "path": match.group(2),
                "file": str(path.relative_to(root)),
                "line": text.count("\n", 0, match.start()) + 1,
                "touches": [{"kind": k, "module": m} for m, k in touches.items()],
            }
        )
    return found


def mapped_endpoints() -> set[tuple[str, str]]:
    """Every method+path the flow files already describe."""
    used: set[tuple[str, str]] = set()
    for flow_file in sorted(FLOW_DIR.glob("*.json")):
        if flow_file.name == "index.json":
            continue
        data = json.loads(flow_file.read_text())
        for chunk in data.get("chunks", []):
            for node in chunk.get("nodes", []):
                api = node.get("api") or {}
                for key in ("await", "verify"):
                    entry = api.get(key)
                    if isinstance(entry, dict) and entry.get("path"):
                        used.add(
                            (entry.get("method", "GET").upper(), normalise(entry["path"]))
                        )
    return used


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("monopoly", type=Path, help="path to the monopoly checkout")
    parser.add_argument("--unmapped", action="store_true", help="only the worklist")
    parser.add_argument("--json", type=Path, help="write the full table here")
    args = parser.parse_args()

    root = args.monopoly / "apps" / "monolith"
    routes_dir = root / "app" / "routes"
    if not routes_dir.is_dir():
        print(f"error: no app/routes under {root}", file=sys.stderr)
        return 2

    routes: list[dict] = []
    for path in sorted(routes_dir.rglob("*.js")):
        routes.extend(routes_in(path, root))

    # Dynamic registrations (`app.get(`${this.base}/x`)`) are not real paths.
    routes = [r for r in routes if "${" not in r["path"]]

    deduped: dict[tuple[str, str], dict] = {}
    for route in routes:
        deduped.setdefault((route["method"], normalise(route["path"])), route)

    mapped = mapped_endpoints()
    unmapped = {k: v for k, v in deduped.items() if k not in mapped}

    if args.json:
        args.json.write_text(
            json.dumps(
                [
                    {**route, "mapped": key in mapped}
                    for key, route in sorted(deduped.items())
                ],
                indent=1,
            )
        )
        print(f"wrote {args.json}")

    if not args.unmapped:
        with_touches = [r for r in deduped.values() if r["touches"]]
        print(f"registered routes : {len(deduped)}")
        print(f"  described by map: {len(deduped) - len(unmapped)}")
        print(f"  not yet          : {len(unmapped)}")
        print(f"  resolved to a service/model/worker: {len(with_touches)}")
        print()

    print("unmapped routes, by the file that registers them:")
    by_file = Counter(r["file"] for r in unmapped.values())
    for file, count in by_file.most_common():
        print(f"  {count:>3}  {file}")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())

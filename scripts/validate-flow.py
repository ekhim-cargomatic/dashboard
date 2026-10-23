#!/usr/bin/env python3
"""
Validate public/qa-flow/*.json against the Playwright page objects.

The flow files claim, for every node, that `selector` is the current value of a
named page-object constant (`source`). That claim rots the moment someone fixes a
selector in playwright-automation, and a rotted flow file is worse than none —
it reads as authoritative while pointing at elements that no longer exist.

    python3 scripts/validate-flow.py ~/Documents/Automation/playwright-automation
    python3 scripts/validate-flow.py ~/..../playwright-automation ~/..../monopoly

Checks, in order of how much they matter:
  1. source  — the constant exists AND its value is byte-identical to `selector`.
  2. api     — every method+path names a real route in the monolith (needs the
     monopoly path as a second argument; skipped without it). An endpoint that
     looks plausible and does not exist is the easiest thing to write here and
     the hardest to notice later.
  3. sourceComposed / pathSource — the constant exists (the value is deliberately
     derived, so no equality check).
  4. dependsOn — every referenced chunk exists, nothing depends on itself, the
     dependency graph is acyclic, and `provides` names a declared variable.
  5. structure — unique node ids, parent/opens/entry/exit/requires resolve,
     edges name real chunks, every chunk is reachable from the graph.

Exit code is non-zero when anything fails, so this can gate a deploy.
"""
from __future__ import annotations

import ast
import json
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
FLOW_DIR = REPO / "public" / "qa-flow"


def fold(node: ast.AST, ns: dict[str, str]) -> str | None:
    """Best-effort constant folding — enough for the f-string composition the
    page objects use to build a scoped selector out of a container constant."""
    if isinstance(node, ast.Constant) and isinstance(node.value, str):
        return node.value
    if isinstance(node, ast.Name):
        return ns.get(node.id)
    if isinstance(node, ast.Attribute):
        return ns.get(node.attr)
    if isinstance(node, ast.JoinedStr):
        parts = []
        for piece in node.values:
            if isinstance(piece, ast.Constant):
                parts.append(str(piece.value))
            elif isinstance(piece, ast.FormattedValue):
                value = fold(piece.value, ns)
                if value is None:
                    return None
                parts.append(value)
            else:
                return None
        return "".join(parts)
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = fold(node.left, ns), fold(node.right, ns)
        return None if left is None or right is None else left + right
    return None


def read_page_objects(pages_dir: Path) -> dict[str, dict[str, str]]:
    out: dict[str, dict[str, str]] = {}
    for path in sorted(pages_dir.rglob("*.py")):
        if "__pycache__" in str(path):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            ns: dict[str, str] = {}
            for stmt in cls.body:
                if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
                    continue
                target = stmt.targets[0]
                if not isinstance(target, ast.Name) or target.id != target.id.upper():
                    continue
                value = fold(stmt.value, ns)
                if isinstance(value, str):
                    ns[target.id] = value
            if ns:
                out.setdefault(cls.name, {}).update(ns)
    return out


APPIUM_BY = {
    "ACCESSIBILITY_ID": "accessibility id", "XPATH": "xpath", "ID": "id",
    "ANDROID_UIAUTOMATOR": "android uiautomator", "CLASS_NAME": "class name",
    "CSS_SELECTOR": "css selector", "NAME": "name", "TAG_NAME": "tag name",
    "IOS_PREDICATE": "ios predicate string", "IOS_CLASS_CHAIN": "ios class chain",
}


def read_appium_page_objects(pages_dir: Path) -> dict[str, dict[str, str]]:
    """
    The mobile suite writes locators as (AppiumBy.X, "value") tuples rather than
    bare strings, so they need their own reader. The value stored here is
    "<by>=<value>" — the strategy the page object pairs the selector with, kept
    alongside it so a generator does not have to infer it from the syntax.
    Classes are keyed "mobile:Name" because the mobile and web suites both have
    a LoginPage.
    """
    out: dict[str, dict[str, str]] = {}
    for path in sorted(pages_dir.rglob("*.py")):
        if "__pycache__" in str(path):
            continue
        try:
            tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
        except SyntaxError:
            continue
        for cls in (n for n in ast.walk(tree) if isinstance(n, ast.ClassDef)):
            ns: dict[str, str] = {}
            consts: dict[str, str] = {}
            for stmt in cls.body:
                if not isinstance(stmt, ast.Assign) or len(stmt.targets) != 1:
                    continue
                target = stmt.targets[0]
                if not isinstance(target, ast.Name) or target.id != target.id.upper():
                    continue
                value = stmt.value
                if isinstance(value, ast.Tuple) and len(value.elts) == 2:
                    by, sel = value.elts
                    strategy = APPIUM_BY.get(by.attr) if isinstance(by, ast.Attribute) else None
                    folded = fold(sel, ns)
                    if strategy and isinstance(folded, str):
                        consts[target.id] = f"{strategy}={folded}"
                        ns[target.id] = folded
                else:
                    folded = fold(value, ns)
                    if isinstance(folded, str):
                        consts[target.id] = folded
                        ns[target.id] = folded
            if consts:
                out.setdefault("mobile:" + cls.name, {}).update(consts)
    return out


def read_roles(monopoly: Path) -> tuple[set[str], dict[str, list[str]]]:
    """Every role string the admin client knows, and what each guard checks."""
    base = monopoly / "apps" / "admin-client-legacy" / "src" / "main" / "js"
    consts = dict(re.findall(r"(\w+):\s*'([^']+)'",
                             (base / "constants" / "UserRoles.js").read_text()))
    src = (base / "stores" / "SessionStore.js").read_text()
    raw: dict[str, dict] = {}
    for m in re.finditer(r"\n  (\w+)\(([^)]*)\)\s*\{(.*?)\n  \},", src, re.S):
        body = m.group(3)
        vals = []
        for a, b, c, d in re.findall(
                r"ROLES\.(\w+)|hasRole\('([^']+)'\)|_type === '(\w+)'|roles\.includes\('([^']+)'\)", body):
            if a: vals.append(consts.get(a, a))
            elif b: vals.append(b)
            elif c: vals.append("_type=" + c)
            elif d: vals.append(d)
        raw[m.group(1)] = {"roles": vals,
                           "calls": [c for c in re.findall(r"this\.(\w+)\(", body)
                                     if c not in ("hasRole", "getUser", "getUserRoles")]}

    def resolve(name, seen=()):
        if name in seen or name not in raw:
            return []
        out = list(raw[name]["roles"])
        for call in raw[name]["calls"]:
            out += resolve(call, seen + (name,))
        return out

    known = set(consts.values())
    guards = {n: sorted(set(resolve(n))) for n in raw}
    for roles in guards.values():
        known |= {r for r in roles if not r.startswith("_type=")}
    return known, guards

MONOPOLY_ROOT: "Path | None" = None

ROUTE_RE = re.compile(r"""\bapp\.(get|post|put|patch|delete)\(\s*['"]([^'"]+)['"]""")
PARAM_RE = re.compile(r"\{[^}]+\}|:[A-Za-z_]+")


def read_routes(monopoly: Path) -> set[tuple[str, str]]:
    """Express route registrations from the monolith, params normalised away."""
    routes_dir = monopoly / "apps" / "monolith" / "app" / "routes"
    out: set[tuple[str, str]] = set()
    for path in routes_dir.rglob("*.js"):
        for match in ROUTE_RE.finditer(path.read_text(encoding="utf-8", errors="replace")):
            out.add((match.group(1).upper(), normalise(match.group(2))))
    return out


def normalise(path: str) -> str:
    """`/api/orders/{orderId}` and `/api/orders/:orderId` are the same route."""
    return PARAM_RE.sub(":P", path).rstrip("/")


def walk(obj, fn) -> None:
    if isinstance(obj, dict):
        fn(obj)
        for value in obj.values():
            walk(value, fn)
    elif isinstance(obj, list):
        for value in obj:
            walk(value, fn)


def validate(flow: dict, pages: dict[str, dict[str, str]],
             routes: set[tuple[str, str]] | None,
             roles: tuple[set[str], dict[str, list[str]]] | None = None) -> list[str]:
    problems: list[str] = []

    nodes: dict[str, dict] = {}
    for chunk in flow["chunks"]:
        for node in chunk["nodes"]:
            if node["id"] in nodes:
                problems.append(f'duplicate node id {node["id"]!r}')
            nodes[node["id"]] = node

    for node in nodes.values():
        for key in ("parent", "opens", "attachesTo"):
            ref = node.get(key)
            if ref and ref not in nodes:
                problems.append(f'{node["id"]}: {key} -> unknown node {ref!r}')

    chunk_ids = {c["id"] for c in flow["chunks"]}
    for chunk in flow["chunks"]:
        for key in ("entry", "exit"):
            if chunk[key] not in nodes:
                problems.append(f'chunk {chunk["id"]}: {key} -> unknown node {chunk[key]!r}')
        for ref in chunk.get("requires", []):
            if ref not in nodes:
                problems.append(f'chunk {chunk["id"]}: requires -> unknown node {ref!r}')

    # dependsOn is a separate graph from edges: it must also resolve, must not
    # be self-referential, and must not contain a cycle (the UI walks it).
    deps: dict[str, set[str]] = {}
    for chunk in flow["chunks"]:
        here: set[str] = set()
        for dep in chunk.get("dependsOn", []):
            kind = dep.get("kind")
            refs = [dep["chunk"]] if dep.get("chunk") else []
            refs += dep.get("alternatives", [])
            if kind == "seeded" and not dep.get("variable"):
                problems.append(f'chunk {chunk["id"]}: seeded dependency names no variable')
            for ref in refs:
                if ref not in chunk_ids:
                    problems.append(f'chunk {chunk["id"]}: dependsOn -> unknown chunk {ref!r}')
                elif ref == chunk["id"]:
                    problems.append(f'chunk {chunk["id"]}: depends on itself')
            if dep.get("chunk"):
                here.add(dep["chunk"])
        deps[chunk["id"]] = here

    colour: dict[str, int] = {}

    def cycle_from(node: str, trail: list[str]) -> None:
        colour[node] = 1
        for nxt in sorted(deps.get(node, ())):
            if colour.get(nxt) == 1:
                loop = trail[trail.index(nxt):] if nxt in trail else [nxt]
                problems.append("dependsOn cycle: " + " -> ".join([*loop, nxt]))
            elif colour.get(nxt, 0) == 0:
                cycle_from(nxt, [*trail, nxt])
        colour[node] = 2

    for chunk_id in sorted(deps):
        if colour.get(chunk_id, 0) == 0:
            cycle_from(chunk_id, [chunk_id])

    declared = set(flow.get("variables", {}))
    provided = {v for c in flow["chunks"] for v in c.get("provides", [])}
    for chunk in flow["chunks"]:
        for var in chunk.get("provides", []):
            if var not in declared:
                problems.append(f'chunk {chunk["id"]}: provides undeclared variable {var!r}')
    # A seeded variable is only a mistake when something this chunk already
    # depends on produces it. driverId is seeded for an admin run and captured
    # at the driver app sign-in; those are different runs, not a contradiction.
    provides_of = {c["id"]: set(c.get("provides", [])) for c in flow["chunks"]}

    def closure(start: str) -> set[str]:
        seen, stack = set(), [start]
        while stack:
            cur = stack.pop()
            for nxt in deps.get(cur, ()):
                if nxt not in seen:
                    seen.add(nxt)
                    stack.append(nxt)
        return seen

    for chunk in flow["chunks"]:
        upstream = closure(chunk["id"])
        for dep in chunk.get("dependsOn", []):
            if dep.get("kind") != "seeded":
                continue
            var = dep.get("variable")
            owners = sorted(c for c in upstream if var in provides_of.get(c, ()))
            if owners:
                problems.append(
                    f'chunk {chunk["id"]}: seeded variable {var!r} is already '
                    f'provided by {", ".join(owners)}, which it depends on'
                )

    linked = {chunk_ids and flow["chunks"][0]["id"]}
    for edge in flow.get("edges", []):
        source, target = edge[0], edge[1]
        for end in (source, target):
            if end not in chunk_ids:
                problems.append(f"edge -> unknown chunk {end!r}")
        linked |= {source, target}
    for orphan in sorted(chunk_ids - linked):
        problems.append(f"chunk {orphan!r} is not on any edge")

    # ── access ──────────────────────────────────────────────────────────────
    # A role is only worth writing down if the code really checks it, so every
    # entry has to name a role the admin client knows, a guard SessionStore
    # defines, and a line that actually calls that guard. A plausible-looking
    # role nobody enforces is worse than no role at all.
    portals = {"admin", "carrier", "shipper", "driver"}
    for chunk in flow["chunks"]:
        access = chunk.get("access")
        if not access:
            problems.append(f'chunk {chunk["id"]}: no access block')
            continue
        if access.get("portal") not in portals:
            problems.append(f'chunk {chunk["id"]}: access.portal {access.get("portal")!r} '
                            f'is not one of {sorted(portals)}')
        entries = access.get("requires", [])
        if bool(entries) != bool(access.get("gated")):
            problems.append(f'chunk {chunk["id"]}: access.gated disagrees with access.requires')
        if not entries and not access.get("note"):
            problems.append(f'chunk {chunk["id"]}: ungated access needs a note saying so')
        if roles is None:
            continue
        known, guards = roles
        for entry in entries:
            guard = (entry.get("guard") or "").replace("SessionStore.", "").rstrip("()")
            if guard not in guards:
                problems.append(f'chunk {chunk["id"]}: unknown session guard {entry.get("guard")!r}')
                continue
            expected = [r for r in guards[guard] if not r.startswith("_type=")]
            if sorted(entry.get("roles", [])) != sorted(expected):
                problems.append(f'chunk {chunk["id"]}: {entry["guard"]} checks '
                                f'{expected} but the map says {entry.get("roles")}')
            for role in entry.get("roles", []):
                if role not in known:
                    problems.append(f'chunk {chunk["id"]}: role {role!r} is not a known role')
            src = entry.get("source", "")
            path_part, _, line_no = src.rpartition(":")
            target = MONOPOLY_ROOT / path_part if MONOPOLY_ROOT else None
            if not line_no.isdigit() or target is None:
                problems.append(f'chunk {chunk["id"]}: access source {src!r} is not file:line')
                continue
            if not target.is_file():
                problems.append(f'chunk {chunk["id"]}: access source file missing — {path_part}')
                continue
            lines = target.read_text(encoding="utf-8", errors="replace").split("\n")
            idx = int(line_no) - 1
            if idx >= len(lines) or guard not in lines[idx]:
                problems.append(f'chunk {chunk["id"]}: {src} no longer calls {guard}')

    # ── variant ─────────────────────────────────────────────────────────────
    # A chunk that only exists for one value of a field has to name the code
    # that branches on it, and that line has to still contain the guard. This
    # is the check that would have caught leg management being drawn under the
    # legacy order screen.
    for chunk in flow["chunks"]:
        variant = chunk.get("variant")
        if not variant:
            continue
        for key in ("field", "test", "guard", "source"):
            if not variant.get(key):
                problems.append(f'chunk {chunk["id"]}: variant has no {key}')
        src, guard = variant.get("source", ""), variant.get("guard", "")
        if MONOPOLY_ROOT is None or not src:
            continue
        path_part, _, line_no = src.rpartition(":")
        target = MONOPOLY_ROOT / path_part
        if not line_no.isdigit() or not target.is_file():
            problems.append(f'chunk {chunk["id"]}: variant source {src!r} is not file:line')
            continue
        lines = target.read_text(encoding="utf-8", errors="replace").split("\n")
        name = guard.split("(")[0]
        if int(line_no) > len(lines) or name not in lines[int(line_no) - 1]:
            problems.append(f'chunk {chunk["id"]}: {src} no longer defines {name}')

    # ── apiSource ───────────────────────────────────────────────────────────
    # Where an endpoint names the API util that calls it, that citation has to
    # be real. This is the claim that separates "the route exists" from "this
    # button fires it", so a stale one is worse than none.
    def check_api_source(d):
        ref = d.get("apiSource")
        if not ref or MONOPOLY_ROOT is None:
            return
        path_part, _, rest = ref.partition(":")
        target = MONOPOLY_ROOT / path_part
        if not target.is_file():
            problems.append(f"apiSource file missing — {path_part}")
            return
        line_no = rest.split()[0] if rest and rest.split() and rest.split()[0].isdigit() else None
        if line_no:
            lines = target.read_text(encoding="utf-8", errors="replace").split("\n")
            if int(line_no) > len(lines):
                problems.append(f"apiSource {ref} points past the end of the file")
    walk(flow, check_api_source)

    def resolve(ref: str):
        cls, _, const = ref.rpartition(".")
        if cls not in pages:
            return None, f"unknown page-object class {cls!r} (in {ref})"
        if const not in pages[cls]:
            return None, f"unknown constant {ref!r}"
        return pages[cls][const], None

    for key in ("sourceComposed", "pathSource"):
        def check_exists(d, key=key):
            ref = d.get(key)
            if not ref:
                return
            _, err = resolve(ref)
            if err:
                problems.append(err)
        walk(flow, check_exists)

    exact = [0, 0]

    def check_exact(d):
        ref, selector = d.get("source"), d.get("selector")
        if not ref or selector is None:
            return
        exact[1] += 1
        value, err = resolve(ref)
        if err:
            problems.append(err)
        elif value != selector:
            problems.append(
                f"selector drift at {ref}\n"
                f"      flow json : {selector}\n"
                f"      page object: {value}"
            )
        else:
            exact[0] += 1

    walk(flow, check_exact)

    endpoints: set[tuple[str, str]] = set()

    def collect_endpoint(d):
        if d.get("method") and d.get("path"):
            endpoints.add((d["method"], normalise(d["path"])))

    walk(flow, collect_endpoint)

    if routes is not None:
        for method, path in sorted(endpoints - routes):
            problems.append(f"no such route in the monolith: {method} {path}")

    dep_count = sum(len(c.get("dependsOn", [])) for c in flow["chunks"])
    print(f"  nodes {len(nodes)}  chunks {len(chunk_ids)}  deps {dep_count}  "
          f"selectors verified {exact[0]}/{exact[1]}  "
          f"endpoints {len(endpoints)}"
          f"{'' if routes is None else f' ({len(endpoints & routes)} matched)'}")
    return problems


def coverage(flow: dict, pages: dict[str, dict[str, str]]) -> list[str]:
    """
    Which page objects the map has not finished reading.

    Everything else in this file checks that what is written down is true. This
    one checks the other direction: a page object with 98 constants and 19 of
    them mapped is not wrong, it is unfinished, and nothing else here would say
    so. Printed as a list, worst first, so the gap is visible without anyone
    having to go looking for it.
    """
    used: dict[str, set[str]] = {}
    for chunk in flow["chunks"]:
        for node in chunk["nodes"]:
            ref = node.get("source")
            if not ref:
                continue
            cls, _, const = ref.rpartition(".")
            used.setdefault(cls, set()).add(const)
    rows = []
    for cls, consts in pages.items():
        have = len(used.get(cls, ()))
        if have == len(consts):
            continue
        rows.append((len(consts) - have, len(consts), have, cls))
    rows.sort(reverse=True)
    return [f"{miss:4d} unmapped of {total:3d}  {cls}" for miss, total, have, cls in rows]


def route_coverage(flow: dict, routes: set[tuple[str, str]]) -> list[str]:
    """
    How much of the monolith the map actually touches.

    The selector coverage above says how much of the test suite's own page
    objects are written down. This says how much of the product's API is, which
    is the other half of "is it all ported" — a screen can be fully mapped at
    the selector level and still never exercise most of what it can call.
    Grouped by the first two path segments, worst first.
    """
    used = set()
    def collect(d):
        for role in ("await", "verify"):
            call = d.get(role)
            if isinstance(call, dict) and call.get("path"):
                used.add((call["method"], normalise(call["path"])))
    walk(flow, lambda d: collect(d.get("api", {})) if d.get("api") else None)

    groups: dict[str, list[int]] = {}
    for method, path in routes:
        key = "/".join(path.split("/")[1:3])
        hit = (method, path) in used
        tally = groups.setdefault(key, [0, 0])
        tally[0] += 1
        tally[1] += 1 if hit else 0
    rows = sorted(((total - have, total, have, key) for key, (total, have) in groups.items()),
                  reverse=True)
    covered = sum(have for _, _, have, _ in rows)
    out = [f"{covered}/{len(routes)} monolith routes exercised by the map"]
    out += [f"{miss:4d} untouched of {total:3d}  /{key}" for miss, total, have, key in rows[:10]]
    return out


def main() -> int:
    if len(sys.argv) < 2:
        print(__doc__)
        return 2
    pages_dir = Path(sys.argv[1]).expanduser() / "pages"
    if not pages_dir.is_dir():
        print(f"No pages/ directory under {pages_dir.parent}")
        return 2

    pages = read_page_objects(pages_dir)
    print(f"Loaded {sum(len(v) for v in pages.values())} constants "
          f"from {len(pages)} page objects.")

    # The mobile suite sits beside playwright-automation; mapped chunks cite it
    # as mobile:Class.CONST, so load it the same way or those go unverified.
    appium_dir = Path(sys.argv[3]).expanduser() if len(sys.argv) > 3 else \
        pages_dir.parent.parent / "appium-automation"
    if (appium_dir / "pages").is_dir():
        mobile = read_appium_page_objects(appium_dir / "pages")
        pages.update(mobile)
        print(f"Loaded {sum(len(v) for v in mobile.values())} mobile constants "
              f"from {len(mobile)} Appium page objects.")
    else:
        print(f"No Appium pages/ under {appium_dir} — mobile selectors will not be checked.")

    routes: set[tuple[str, str]] | None = None
    roles = None
    if len(sys.argv) > 2:
        monopoly = Path(sys.argv[2]).expanduser()
        globals()["MONOPOLY_ROOT"] = monopoly
        routes_dir = monopoly / "apps" / "monolith" / "app" / "routes"
        if not routes_dir.is_dir():
            print(f"No monolith routes under {monopoly} — skipping the endpoint check.")
        else:
            routes = read_routes(monopoly)
            print(f"Loaded {len(routes)} monolith routes.")
        try:
            roles = read_roles(monopoly)
            print(f"Loaded {len(roles[0])} role constants and {len(roles[1])} session guards.")
        except OSError:
            print("No admin client under this monopoly path — roles will not be checked.")
    else:
        print("No monopoly path given — endpoints will not be checked.")

    failed = False
    for flow_path in sorted(FLOW_DIR.glob("*.json")):
        if flow_path.name == "index.json":
            continue
        print(f"\n{flow_path.name}")
        problems = validate(json.loads(flow_path.read_text()), pages, routes, roles)
        if problems:
            failed = True
            for problem in problems:
                print(f"  ✗ {problem}")
        else:
            print("  ✓ clean")
        gaps = coverage(json.loads(flow_path.read_text()), pages)
        if gaps:
            total = sum(int(g.split()[0]) for g in gaps)
            print(f"\n  {total} constants still unmapped, worst first:")
            for line in gaps[:12]:
                print(f"    {line}")
            if len(gaps) > 12:
                print(f"    … and {len(gaps) - 12} more page objects")
        if routes:
            lines = route_coverage(json.loads(flow_path.read_text()), routes)
            print(f"\n  {lines[0]}:")
            for line in lines[1:]:
                print(f"    {line}")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

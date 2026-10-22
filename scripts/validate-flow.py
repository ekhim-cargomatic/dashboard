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
             routes: set[tuple[str, str]] | None) -> list[str]:
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
    for dep in (d for c in flow["chunks"] for d in c.get("dependsOn", [])):
        if dep.get("kind") == "seeded" and dep.get("variable") in provided:
            problems.append(
                f'seeded variable {dep["variable"]!r} is actually provided by a chunk'
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

    routes: set[tuple[str, str]] | None = None
    if len(sys.argv) > 2:
        monopoly = Path(sys.argv[2]).expanduser()
        routes_dir = monopoly / "apps" / "monolith" / "app" / "routes"
        if not routes_dir.is_dir():
            print(f"No monolith routes under {monopoly} — skipping the endpoint check.")
        else:
            routes = read_routes(monopoly)
            print(f"Loaded {len(routes)} monolith routes.")
    else:
        print("No monopoly path given — endpoints will not be checked.")

    failed = False
    for flow_path in sorted(FLOW_DIR.glob("*.json")):
        if flow_path.name == "index.json":
            continue
        print(f"\n{flow_path.name}")
        problems = validate(json.loads(flow_path.read_text()), pages, routes)
        if problems:
            failed = True
            for problem in problems:
                print(f"  ✗ {problem}")
        else:
            print("  ✓ clean")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())

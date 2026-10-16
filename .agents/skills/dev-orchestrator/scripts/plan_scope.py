#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Resolve a requested scope into an ordered, deterministic run plan.

Reads the JSON that `tickets.py status` prints, expands the requested scope into
tickets in build order, and derives the step chain for each ticket from its
plan status, its entry flags, and its prerequisites.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

BUILD_STATUSES = {"", "draft", "ready-for-dev", "in-progress", "in-review", "built", "blocked"}
RISK_RANK = {"": 0, "low": 1, "medium": 2, "high": 3}
THOROUGH_AT = {"never": 99, "low": 1, "medium": 2, "high": 3}

NEXT_TOKEN = re.compile(r"^next:(\d+)$")
EPIC_ID_TOKEN = re.compile(r"^epic-(\d+)$")
EPIC_RANGE_TOKEN = re.compile(r"^epic-(\d+)\.\.(?:epic-)?(\d+)$")
TICKET_RANGE_TOKEN = re.compile(r"^(\d+\.[0-9A-Za-z]+)\.\.(\d+\.[0-9A-Za-z]+)$")
CROSS_EPIC_REF = re.compile(r"^(\d+)\.([0-9A-Za-z]+)$")


def load_status(source: str) -> dict:
    text = sys.stdin.read() if source == "-" else Path(source).read_text(encoding="utf-8")
    return json.loads(text)


def rows_in_build_order(status: dict) -> list[dict]:
    rows = list(status.get("tickets") or [])
    backlog = status.get("backlog") or {}
    rows.extend(backlog.get("tickets") or [])
    return rows


def key_of(row: dict) -> str:
    return f"{row['epic']}/{row['id'] if row.get('id') is not None else row.get('file')}"


class Tree:
    def __init__(self, status: dict) -> None:
        self.rows = rows_in_build_order(status)
        self.epics = {e["slug"]: e for e in status.get("epics") or []}
        self.epic_by_id = {str(e["id"]): e["slug"] for e in self.epics.values()}
        self.by_key = {key_of(r): r for r in self.rows}
        self.by_ref = {str(r.get("ref")): r for r in self.rows if r.get("ref") is not None}
        self.order = {key_of(r): i for i, r in enumerate(self.rows)}

    def epic_done(self, slug: str) -> bool:
        return (self.epics.get(slug) or {}).get("status") == "done"

    def row_for_ref(self, token: str) -> dict | None:
        if token in self.by_ref:
            return self.by_ref[token]
        folded = token.lower()
        hits = [row for ref, row in self.by_ref.items() if ref.lower() == folded]
        return hits[0] if len(hits) == 1 else None

    def prerequisite(self, row: dict, ref) -> tuple[str, dict | None]:
        """Resolve one `after` value to ("ticket", row), ("epic", None), or ("missing", None)."""
        if isinstance(ref, int):
            return "ticket", self.by_key.get(f"{row['epic']}/{ref}")
        text = str(ref)
        # A pulled backlog ticket's prerequisite comes back as the raw key, `backlog/story-a.md`.
        if text in self.by_key:
            return "ticket", self.by_key[text]
        match = CROSS_EPIC_REF.match(text)
        if match and match.group(1) in self.epic_by_id:
            return "ticket", self.by_key.get(f"{self.epic_by_id[match.group(1)]}/{match.group(2)}")
        if text in self.epics:
            return "epic", None
        sibling = self.by_key.get(f"{row['epic']}/{text}")
        if sibling:
            return "ticket", sibling
        for other in self.rows:
            if other["epic"] == row["epic"] and text in (other.get("file"), other.get("tracker_id")):
                return "ticket", other
        return "missing", None


def ref_of(row: dict) -> str:
    return str(row.get("ref") if row.get("ref") is not None else row.get("file"))


def skip_reason(row: dict, *, offered: bool = False) -> str | None:
    """Why a ticket cannot run. `offered` is a next:N slot: leave mid-flight and held tickets to whoever has them."""
    state = row.get("state", "")
    status = row.get("status", "")
    if state == "done":
        return "already done"
    if state == "dropped":
        return "dropped"
    if row.get("hitl"):
        return "hitl: needs a person; build it with bmad-build"
    if row.get("assignee"):
        return f"assigned to {row['assignee']}"
    needs_refining = row.get("refine") or row.get("type") == "bug" or row.get("id") is None
    if needs_refining and not row.get("refined"):
        return "needs refining with bmad-ticket first"
    if status not in BUILD_STATUSES:
        return f"unknown status {status!r}"
    if offered and status in ("in-progress", "in-review"):
        return "already in progress; name it explicitly to take it"
    held_by_person = bool(row.get("blocked_at")) and status != "blocked"
    if offered and (status == "blocked" or held_by_person or row.get("unknown")):
        return "blocked; name it explicitly to take it"
    return None


def derive_steps(row: dict, cross_review: bool) -> list[str]:
    status = row.get("status", "") or ""
    # A person held this ticket with `mark <status> --blocked`. Clearing it is theirs, not a retry.
    if row.get("blocked_at") and status != "blocked":
        return ["hold"]
    tail = (["review"] if cross_review else []) + ["close"]
    if row.get("done_checkpoint"):
        tail.append("hold")
    if status == "built":
        body: list[str] = []
    elif status in ("", "draft", "blocked"):
        body = []
        if row.get("plan_checkpoint"):
            if not row.get("refined"):
                body.append("plan")
            body.append("approve")
        body.append("build")
    elif status == "ready-for-dev":
        body = ["approve"] if row.get("plan_checkpoint") else []
        body.append("build")
    else:
        body = ["build"]
    if status == "blocked" or row.get("unknown"):
        body = ["unblock", *body]
    return [*body, *tail]


def review_selection(row: dict, thorough_at: str) -> str:
    return "thorough" if RISK_RANK.get(row.get("risk", ""), 0) >= THOROUGH_AT[thorough_at] else "quick"


def plan_rows(
    tree: Tree,
    candidates: list[dict],
    cross_review: bool,
    thorough_at: str,
    limit: int | None = None,
    planned: set[str] | None = None,
    offered: bool = False,
) -> tuple[list[dict], list[dict]]:
    """Plan candidates in order. With `limit`, stop after that many items and record no skips.

    A prerequisite counts as `waits_on` only when it is earlier in build order, so the run
    finishes it first. One later in the plan is still unmet when this ticket would start.
    """
    items: list[dict] = []
    skipped: list[dict] = []
    planned = set(planned or ())
    for row in candidates:
        if limit is not None and len(items) >= limit:
            break
        reason = skip_reason(row, offered=offered)
        waits_on: list[str] = []
        if reason is None:
            unmet: list[str] = []
            for ref in row.get("after") or []:
                kind, target = tree.prerequisite(row, ref)
                if kind == "epic":
                    if not tree.epic_done(str(ref)):
                        unmet.append(str(ref))
                elif target is None:
                    unmet.append(f"{ref} (unresolved)")
                elif (
                    key_of(target) in planned
                    and tree.order[key_of(target)] < tree.order[key_of(row)]
                ):
                    waits_on.append(ref_of(target))
                elif target.get("state") not in ("done", "review"):
                    unmet.append(ref_of(target))
            for gate in row.get("gated_by") or []:
                gate = str(gate)
                if gate in tree.epics:
                    if not tree.epic_done(gate):
                        unmet.append(f"epic {gate} not done")
                elif gate in tree.by_key:
                    target = tree.by_key[gate]
                    if target.get("state") != "done":
                        unmet.append(ref_of(target))
            if unmet:
                reason = "waiting on " + ", ".join(unmet)
        if reason is not None:
            if limit is None:
                skipped.append({"ref": ref_of(row), "status": row.get("status", ""), "reason": reason})
            continue
        planned.add(key_of(row))
        item = {
            "ref": ref_of(row),
            "epic": row["epic"],
            "title": row.get("title", ""),
            "type": row.get("type", ""),
            "status": row.get("status", ""),
            "state": row.get("state", ""),
            "risk": row.get("risk", ""),
            "review": review_selection(row, thorough_at),
            "steps": derive_steps(row, cross_review),
            "waits_on": waits_on,
            "plan_checkpoint": bool(row.get("plan_checkpoint")),
            "done_checkpoint": bool(row.get("done_checkpoint")),
        }
        if item["steps"] == ["hold"] and row.get("blocked_reason"):
            item["hold_reason"] = row["blocked_reason"]
        items.append(item)
    return items, skipped


def expand_scope(tree: Tree, tokens: list[str]) -> tuple[list[dict], list[str], list[str], int | None]:
    """Return (selected rows in build order, unresolved tokens, named epics with no tickets, next-N limit)."""
    selected: dict[str, dict] = {}
    unresolved: list[str] = []
    empty_epics: list[str] = []
    next_limit: int | None = None

    for raw in tokens:
        token = raw.strip()
        folded = token.lower()
        if not token:
            continue
        matched: list[dict] = []
        epics: set[str] = set()
        if m := NEXT_TOKEN.match(folded):
            next_limit = (next_limit or 0) + int(m.group(1))
            continue
        if m := EPIC_RANGE_TOKEN.match(folded):
            lo, hi = sorted((int(m.group(1)), int(m.group(2))))
            epics = {tree.epic_by_id.get(str(n)) for n in range(lo, hi + 1)} - {None}
        elif m := EPIC_ID_TOKEN.match(folded):
            epics = {tree.epic_by_id[m.group(1)]} if m.group(1) in tree.epic_by_id else set()
        elif folded in {slug.lower() for slug in tree.epics}:
            epics = {slug for slug in tree.epics if slug.lower() == folded}
        if epics:
            matched = [r for r in tree.rows if r["epic"] in epics]
            for slug in sorted(epics - {r["epic"] for r in matched}, key=lambda s: tree.epics[s]["id"]):
                if slug not in empty_epics:
                    empty_epics.append(slug)
            if not matched:
                continue
        elif m := TICKET_RANGE_TOKEN.match(token):
            first, last = tree.row_for_ref(m.group(1)), tree.row_for_ref(m.group(2))
            if first and last:
                lo, hi = sorted((tree.order[key_of(first)], tree.order[key_of(last)]))
                matched = tree.rows[lo : hi + 1]
        elif row := tree.row_for_ref(token):
            matched = [row]
        if matched:
            for row in matched:
                selected.setdefault(key_of(row), row)
        else:
            unresolved.append(raw)

    rows = sorted(selected.values(), key=lambda r: tree.order[key_of(r)])
    return rows, unresolved, empty_epics, next_limit


def build_plan(status: dict, tokens: list[str], cross_review: bool = True, thorough_at: str = "high") -> dict:
    tree = Tree(status)
    rows, unresolved, empty_epics, next_limit = expand_scope(tree, tokens)
    items, skipped = plan_rows(tree, rows, cross_review, thorough_at)
    if next_limit:
        # Only tickets that actually entered the plan satisfy a later prerequisite. A skipped
        # explicit token must not consume a next:N slot or pretend to be someone's prerequisite.
        explicit = {key_of(r) for r in rows}
        planned_keys = {key_of(tree.by_ref[item["ref"]]) for item in items}
        rest = [r for r in tree.rows if key_of(r) not in explicit]
        more, _ = plan_rows(
            tree, rest, cross_review, thorough_at, limit=next_limit, planned=planned_keys, offered=True
        )
        wanted = explicit | {key_of(tree.by_ref[item["ref"]]) for item in more}
        ordered = [r for r in tree.rows if key_of(r) in wanted]
        items, skipped = plan_rows(tree, ordered, cross_review, thorough_at)
    skipped.extend({"ref": slug, "status": "", "reason": "epic has no tickets yet; slice it with bmad-ticket"} for slug in empty_epics)

    epics: list[str] = []
    for item in [*items, *skipped]:
        epic = tree.by_ref.get(item["ref"], {}).get("epic") or (item["ref"] if item["ref"] in tree.epics else None)
        if epic in tree.epics and epic not in epics:
            epics.append(epic)
    epics.sort(key=lambda slug: tree.epics[slug]["id"] if slug in tree.epics else 1 << 30)

    warnings = {
        key: status[key]
        for key in ("problems", "unpinned_after", "undeclared_after", "order_conflict")
        if status.get(key)
    }
    backlog = status.get("backlog") or {}
    if isinstance(backlog, dict) and backlog.get("error"):
        warnings["backlog_error"] = backlog["error"]
    if isinstance(backlog, dict) and backlog.get("problems"):
        warnings["backlog_problems"] = backlog["problems"]
    drift = [{"ref": ref_of(r), "drift": r["drift"]} for r in tree.rows if r.get("drift")]
    if drift:
        warnings["drift"] = drift
    return {
        "scope_requested": tokens,
        "epics_touched": epics,
        "items": items,
        "skipped": skipped,
        "unresolved": unresolved,
        "tree_warnings": warnings,
        "counts": {
            "items": len(items),
            "skipped": len(skipped),
            "unresolved": len(unresolved),
            "steps": sum(len(item["steps"]) for item in items),
        },
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description=(
            "Expand a requested scope into an ordered run plan of tickets and steps. "
            "Input is the JSON `tickets.py status` prints (a path, or `-` for stdin). "
            "Scope tokens: `1.3` (one ticket), `1.3..1.8` (build-order range), `epic-1` or "
            "`epic-cursor-cli` (whole epic), `epic-1..2` (epic range), `next:5` (next N tickets "
            "that can run, in build order), or a backlog ticket's file name."
        )
    )
    parser.add_argument("status_json", help="Output of `tickets.py status`, or `-` for stdin")
    parser.add_argument("--scope", nargs="+", required=True, help="One or more scope tokens")
    parser.add_argument("--no-cross-review", action="store_true", help="Leave out the cross-family review step")
    parser.add_argument(
        "--thorough-at",
        choices=sorted(THOROUGH_AT),
        default="high",
        help="Lowest ticket risk that gets a thorough build review (default: high)",
    )
    parser.add_argument("-o", "--output", help="Write JSON here instead of stdout")
    parser.add_argument("--verbose", action="store_true", help="Diagnostics to stderr")
    args = parser.parse_args(argv)

    try:
        status = load_status(args.status_json)
    except (OSError, json.JSONDecodeError) as exc:
        print(f"error: cannot read ticket status: {exc}", file=sys.stderr)
        return 2

    plan = build_plan(status, args.scope, not args.no_cross_review, args.thorough_at)
    payload = json.dumps(plan, indent=2, ensure_ascii=False)
    if args.output:
        Path(args.output).write_text(payload + "\n", encoding="utf-8")
    else:
        print(payload)

    if args.verbose:
        counts = plan["counts"]
        print(
            f"planned {counts['items']} tickets, {counts['steps']} steps, "
            f"{counts['skipped']} skipped, {counts['unresolved']} unresolved",
            file=sys.stderr,
        )

    return 1 if plan["unresolved"] or not plan["items"] else 0


if __name__ == "__main__":
    sys.exit(main())

#!/usr/bin/env python3
# /// script
# requires-python = ">=3.10"
# ///
"""Tests for plan_scope.py. Run: python3 scripts/tests/test_plan_scope.py"""

from __future__ import annotations

import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import plan_scope  # noqa: E402


def row(epic: str, epic_id: int, id_, **fields) -> dict:
    base = {
        "epic": epic,
        "id": id_,
        "file": None,
        "type": "story",
        "tracker_id": "",
        "title": f"Ticket {epic_id}.{id_}",
        "status": "",
        "tracker_status": "",
        "state": "planned",
        "assignee": "",
        "hitl": False,
        "risk": "medium",
        "refine": False,
        "refined": False,
        "blocked_at": "",
        "blocked_reason": "",
        "ref": f"{epic_id}.{id_}",
        "after": [],
    }
    base.update(fields)
    return base


A, B, C = "epic-alpha", "epic-beta", "epic-gamma"

STATUS = {
    "store": "repo",
    "tickets": [
        row(A, 1, 1, status="done", state="done"),
        row(A, 1, 2, after=[1], risk="high"),
        row(A, 1, 3, after=[2], plan_checkpoint=True),
        row(A, 1, 4, after=[1], status="built", state="review"),
        row(A, 1, 5, after=[3], status="blocked", state="in-progress", blocked_reason="intent gap"),
        row(A, 1, 6, after=[4], hitl=True),
        row(A, 1, 7, after=[4], unknown="Which port?"),
        row(A, 1, 8, after=[4], refine=True),
        row(A, 1, 9, after=[4], assignee="tim"),
        row(A, 1, 10, after=[4], status="weird", state="backlog"),
        row(A, 1, 11, after=[6], done_checkpoint=True),
        row(A, 1, 12, after=[4], status="ready-for-dev", plan_checkpoint=True, risk="low"),
        row(B, 2, 1, after=["1.4"], gated_by=[A]),
        row(B, 2, 2, after=["1.2"]),
    ],
    "epics": [
        {"slug": A, "id": 1, "status": "in-progress", "after": [], "gated_by": []},
        {"slug": B, "id": 2, "status": "", "after": [], "gated_by": []},
        {"slug": C, "id": 3, "status": "", "after": [], "gated_by": []},
    ],
    "backlog": {
        "tickets": [
            row("backlog", 0, None, file="bug-crash.md", ref="bug-crash.md", type="bug"),
            row("backlog", 0, None, file="story-docs.md", ref="story-docs.md", refined=True),
        ]
    },
    "unpinned_after": [],
    "undeclared_after": [],
    "order_conflict": [],
}


def refs(plan: dict) -> list[str]:
    return [item["ref"] for item in plan["items"]]


def item(plan: dict, ref: str) -> dict:
    return next(i for i in plan["items"] if i["ref"] == ref)


def reason(plan: dict, ref: str) -> str:
    return next(s["reason"] for s in plan["skipped"] if s["ref"] == ref)


class PlanScopeTest(unittest.TestCase):
    def plan(self, *scope: str, **kwargs) -> dict:
        return plan_scope.build_plan(json.loads(json.dumps(STATUS)), list(scope), **kwargs)

    def test_epic_scope_plans_in_build_order_and_skips_what_cannot_run(self) -> None:
        plan = self.plan("epic-1")
        self.assertEqual(refs(plan), ["1.2", "1.3", "1.4", "1.5", "1.7", "1.12"])
        self.assertEqual(reason(plan, "1.1"), "already done")
        self.assertTrue(reason(plan, "1.6").startswith("hitl"))
        self.assertTrue(reason(plan, "1.8").startswith("needs refining"))
        self.assertEqual(reason(plan, "1.9"), "assigned to tim")
        self.assertEqual(reason(plan, "1.10"), "unknown status 'weird'")
        self.assertEqual(reason(plan, "1.11"), "waiting on 1.6")
        self.assertEqual(plan["epics_touched"], [A])

    def test_steps_derive_from_plan_status_and_entry_flags(self) -> None:
        plan = self.plan("epic-1")
        self.assertEqual(item(plan, "1.2")["steps"], ["build", "review", "close"])
        self.assertEqual(item(plan, "1.3")["steps"], ["plan", "approve", "build", "review", "close"])
        self.assertEqual(item(plan, "1.4")["steps"], ["review", "close"])
        self.assertEqual(item(plan, "1.5")["steps"], ["unblock", "build", "review", "close"])
        self.assertEqual(item(plan, "1.7")["steps"], ["unblock", "build", "review", "close"])
        self.assertEqual(item(plan, "1.12")["steps"], ["approve", "build", "review", "close"])

    def test_refined_ticket_with_plan_checkpoint_is_approved_before_planning(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][2]["refined"] = True
        plan = plan_scope.build_plan(status, ["1.2", "1.3"])
        self.assertEqual(item(plan, "1.3")["steps"], ["approve", "build", "review", "close"])

    def test_done_checkpoint_adds_hold(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][10]["after"] = [4]
        plan = plan_scope.build_plan(status, ["1.11"])
        self.assertEqual(item(plan, "1.11")["steps"], ["build", "review", "close", "hold"])

    def test_no_cross_review_drops_review_step(self) -> None:
        plan = self.plan("1.2", "1.4", cross_review=False)
        self.assertEqual(item(plan, "1.2")["steps"], ["build", "close"])
        self.assertEqual(item(plan, "1.4")["steps"], ["close"])

    def test_review_selection_follows_risk(self) -> None:
        plan = self.plan("1.2", "1.3", "1.12")
        self.assertEqual(item(plan, "1.2")["review"], "thorough")
        self.assertEqual(item(plan, "1.3")["review"], "quick")
        lowered = self.plan("1.2", "1.3", "1.12", thorough_at="medium")
        self.assertEqual([i["review"] for i in lowered["items"]], ["thorough", "thorough", "quick"])
        never = self.plan("1.2", thorough_at="never")
        self.assertEqual(item(never, "1.2")["review"], "quick")

    def test_prerequisite_earlier_in_plan_becomes_waits_on(self) -> None:
        plan = self.plan("1.2", "1.3")
        self.assertEqual(item(plan, "1.3")["waits_on"], ["1.2"])
        self.assertEqual(item(plan, "1.2")["waits_on"], [])

    def test_prerequisite_outside_plan_and_not_built_skips_ticket(self) -> None:
        plan = self.plan("1.3")
        self.assertEqual(plan["items"], [])
        self.assertEqual(reason(plan, "1.3"), "waiting on 1.2")

    def test_prerequisite_in_review_counts_as_met(self) -> None:
        self.assertEqual(refs(self.plan("1.12")), ["1.12"])

    def test_ticket_range_follows_build_order(self) -> None:
        plan = self.plan("1.2..1.4")
        self.assertEqual(refs(plan), ["1.2", "1.3", "1.4"])

    def test_token_order_does_not_change_build_order(self) -> None:
        self.assertEqual(refs(self.plan("1.4", "1.2")), ["1.2", "1.4"])

    def test_epic_gate_waits_for_epic_done(self) -> None:
        plan = self.plan("2.1")
        self.assertEqual(reason(plan, "2.1"), f"waiting on epic {A} not done")

    def test_cross_epic_after_resolves_by_ref(self) -> None:
        self.assertEqual(reason(self.plan("2.2"), "2.2"), "waiting on 1.2")
        plan = self.plan("1.2", "2.2")
        self.assertEqual(item(plan, "2.2")["waits_on"], ["1.2"])
        self.assertEqual(plan["epics_touched"], [A, B])

    def test_epic_by_slug_and_range(self) -> None:
        self.assertEqual(refs(self.plan(B)), [])
        self.assertEqual(self.plan("epic-1..2")["epics_touched"], [A, B])

    def test_epic_without_tickets_is_skipped_not_unresolved(self) -> None:
        plan = self.plan("epic-3")
        self.assertEqual(plan["unresolved"], [])
        self.assertTrue(reason(plan, C).startswith("epic has no tickets"))

    def test_next_n_takes_runnable_tickets_in_build_order(self) -> None:
        self.assertEqual(refs(self.plan("next:3")), ["1.2", "1.3", "1.4"])

    def test_next_n_skips_unrunnable_without_counting_them(self) -> None:
        self.assertEqual(
            refs(self.plan("next:6")),
            ["1.2", "1.3", "1.4", "1.12", "2.2", "story-docs.md"],
        )

    def test_next_n_does_not_spend_a_slot_on_a_skipped_explicit_token(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][0]["status"] = ""
        status["tickets"][0]["state"] = "planned"
        status["tickets"][0]["hitl"] = True
        status["tickets"][2]["after"] = [4]
        plan = plan_scope.build_plan(status, ["1.1", "next:1"])
        self.assertEqual(refs(plan), ["1.3"])

    def test_next_n_leaves_in_progress_and_blocked_unless_named(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][1]["status"] = "in-progress"
        status["tickets"][1]["state"] = "in-progress"
        plan = plan_scope.build_plan(status, ["next:1"])
        self.assertEqual(refs(plan), ["1.4"])
        named = plan_scope.build_plan(status, ["1.2"])
        self.assertEqual(item(named, "1.2")["steps"][0], "build")

    def test_a_person_hold_is_a_hold_and_not_an_unblock(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][2]["status"] = "draft"
        status["tickets"][2]["blocked_at"] = "2026-10-16"
        status["tickets"][2]["blocked_reason"] = "waiting on Tim"
        plan = plan_scope.build_plan(status, ["1.2", "1.3"])
        held = item(plan, "1.3")
        self.assertEqual(held["steps"], ["hold"])
        self.assertEqual(held["hold_reason"], "waiting on Tim")

    def test_blocked_plan_checkpoint_still_waits_for_approval(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][2]["status"] = "blocked"
        status["tickets"][2]["state"] = "in-progress"
        plan = plan_scope.build_plan(status, ["1.2", "1.3"])
        self.assertEqual(
            item(plan, "1.3")["steps"],
            ["unblock", "plan", "approve", "build", "review", "close"],
        )

    def test_uppercase_entry_id_resolves(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"].append(row(A, 1, "6A", ref="1.6A", after=[4]))
        plan = plan_scope.build_plan(status, ["1.6A"])
        self.assertEqual(refs(plan), ["1.6A"])

    def test_backlog_prerequisite_by_raw_key_resolves(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["backlog"]["tickets"][1]["after"] = ["backlog/bug-crash.md"]
        status["backlog"]["tickets"][0]["refined"] = True
        plan = plan_scope.build_plan(status, ["bug-crash.md", "story-docs.md"])
        self.assertEqual(item(plan, "story-docs.md")["waits_on"], ["bug-crash.md"])

    def test_later_prerequisite_does_not_count_as_already_planned(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["tickets"][0]["status"] = ""
        status["tickets"][0]["state"] = "planned"
        status["tickets"][0]["after"] = [2]
        status["tickets"][1]["after"] = [4]
        plan = plan_scope.build_plan(status, ["1.2", "next:1"])
        self.assertEqual(refs(plan), ["1.2", "1.3"])

    def test_backlog_error_and_drift_surface_and_backlog_is_not_an_epic(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["backlog"] = {"folder": "backlog", "error": "unreadable"}
        status["tickets"][1]["drift"] = {"hitl": {"file": True, "entry": False}}
        plan = plan_scope.build_plan(status, ["1.2"])
        self.assertEqual(plan["tree_warnings"]["backlog_error"], "unreadable")
        self.assertEqual(plan["tree_warnings"]["drift"][0]["ref"], "1.2")
        self.assertEqual(plan["epics_touched"], [A])

    def test_backlog_tickets_resolve_by_file_name(self) -> None:
        plan = self.plan("story-docs.md", "bug-crash.md")
        self.assertEqual(refs(plan), ["story-docs.md"])
        self.assertTrue(reason(plan, "bug-crash.md").startswith("needs refining"))

    def test_unresolved_token_is_reported(self) -> None:
        plan = self.plan("9.9", "epic-9")
        self.assertEqual(plan["unresolved"], ["9.9", "epic-9"])
        self.assertEqual(plan["items"], [])

    def test_tree_warnings_pass_through(self) -> None:
        status = json.loads(json.dumps(STATUS))
        status["problems"] = ["bad plan"]
        plan = plan_scope.build_plan(status, ["1.2"])
        self.assertEqual(plan["tree_warnings"], {"problems": ["bad plan"]})

    def test_exit_codes(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            source = Path(tmp) / "status.json"
            source.write_text(json.dumps(STATUS), encoding="utf-8")
            out = str(Path(tmp) / "plan.json")
            self.assertEqual(plan_scope.main([str(source), "--scope", "epic-1", "-o", out]), 0)
            self.assertEqual(plan_scope.main([str(source), "--scope", "9.9", "-o", out]), 1)
            self.assertEqual(plan_scope.main([str(source), "--scope", "1.1", "-o", out]), 1)
            self.assertEqual(plan_scope.main([str(Path(tmp) / "nope.json"), "--scope", "epic-1"]), 2)

    def test_reads_status_from_stdin(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            out = Path(tmp) / "plan.json"
            with mock.patch.object(sys, "stdin", io.StringIO(json.dumps(STATUS))):
                self.assertEqual(plan_scope.main(["-", "--scope", "1.2", "-o", str(out)]), 0)
            self.assertEqual(refs(json.loads(out.read_text(encoding="utf-8"))), ["1.2"])


if __name__ == "__main__":
    unittest.main(verbosity=2)

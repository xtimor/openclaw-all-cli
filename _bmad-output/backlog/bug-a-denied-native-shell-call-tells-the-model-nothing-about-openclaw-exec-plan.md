---
title: 'A denied native shell call tells the model nothing about OpenClaw exec'
type: 'bugfix'
ticket: '23'
created: '2026-11-09'
status: 'in-progress'
baseline_revision: '12b384f30ee04b831ddef6c37f567446ee55d04a'
route: 'oneshot'
route_source: 'pinned'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** When a turn serves OpenClaw `exec`, Cursor's native shell is denied and the model gets only Cursor's generic refusal; the prompt never says where commands run. The manifest row P8, the parity matrix, and `docs/providers/cursor.md` claim the host answers "Use OpenClaw exec" to a denied native shell, and no code does that (issue #76).

**Approach:** The core adds one neutral sentence to the first prompt of a process opened for a host-shell turn: the native shell is disabled, run commands with OpenClaw `exec`, long ones in the background polled with `process`. No sentence without `exec` in the host's tool list. The three docs say the plugin tells the model in the prompt.

## Boundaries & Constraints

**Always:** Core names no CLI (AD-2). Text only where the host's tool list for the turn holds `exec`.

**Never:** Change permissions, the mode choice, the `exec` and `process` serving, or the continuity note. Touch `.github/`, `scripts/`, `_bmad/`, `.claude/`, `.agents/`, `docs/agents/`, `AGENTS.md`, `SECURITY.md`, protected `package.json` fields.

</intent-contract>

## Implementation Notes

Oneshot: one core sentence, one flag on the live entry, three doc rows.

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `npx vitest run test/shell-hint.test.ts` -- expected: fails first with `expected 'do it' to match /exec/`, then passes
- `npm run ci` -- expected: success

**Manual checks:**
- Live Cursor turn not run: no `cursor-agent` login on this host.

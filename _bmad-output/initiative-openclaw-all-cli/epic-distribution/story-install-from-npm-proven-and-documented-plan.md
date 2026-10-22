---
title: 'Install from npm proven and documented'
type: 'feature'
ticket: '5'
created: '2026-10-22'
status: 'in-review'
baseline_revision: '34b38f4c4a16892100acb9bab61376b94d0e1d44'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** `openclaw-all-cli@0.1.0` is on npm, but `docs/setup.md` still tells users to clone, build, and install a `.tgz`, and the npm install path and `plugins update` are unproven.

**Approach:** Prove in a clean isolated OpenClaw that `openclaw plugins install openclaw-all-cli` gives a working `cursor-cli` turn with an OpenClaw tool call, and that `openclaw plugins update openclaw-all-cli` moves to the next published version (needs a second release, which the owner approves). Rewrite `docs/setup.md`: status banner, step 2 is the one-line npm install plus update, build-from-source moves under Develop; README status; troubleshooting rows that pointed at the build. A fresh agent that reads only `docs/setup.md` installs from npm and gets a working turn.

</intent-contract>

## Implementation Notes

Oneshot: docs only, no code. Live (2026-10-22, OpenClaw 2026.10.3, cursor-agent 2026.10.19): fresh state `plugins install openclaw-all-cli --accept-capabilities --force` → `loaded` 0.1.0 `cursor-cli`; `agent --local --model cursor-cli/auto` turn called `mcp__openclaw__session_status` (toolSummary calls 1, failures 0) and replied. `plugins update openclaw-all-cli --dry-run` → "up to date (0.1.0)"; the install record follows the default selector (OpenClaw docs: third-party npm packages keep their selector), to be proven with 0.1.1.

Fresh-agent pass (sonnet, only `docs/setup.md`, clean state, 2026-10-22): reached a working turn (plugin `loaded` 0.1.0 from npm, about 48 Cursor models listed through a Gateway, reply, usage non-zero with the key, no leftovers after SIGTERM). Doc fixes from it: `--force` in the main install command (a non-TTY shell gets "Install cancelled"), the key config runs after step 2 in the same shell, the ready-line grep and start time, the first-run greeting, and the `provenance-invalid` row (it appears for the npm install too: OpenClaw's own trust check).

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- fresh-agent pass: an agent given only `docs/setup.md` and a clean state installs from npm and gets a turn
- after the next release: `openclaw plugins update openclaw-all-cli` in the same state → the new version, `loaded`

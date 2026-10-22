---
title: 'Install from npm proven and documented'
type: 'feature'
ticket: '5'
created: '2026-10-22'
status: done
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

### 2026-10-22 — Review pass
- verdicts: 10 findings — high 0, medium 4, low 5, false 0, maybe-false 1
- findings:
  - `[maybe-false]` `[defer]` `plugins update` is documented before it is proven — settled by the update check after the next release (0.1.1), before this ticket closes; the ticket stays open until then.
  - `[medium]` `[patch]` README install lacked `--force` and said OpenClaw asks — now `--force`, with the non-TTY note.
  - `[medium]` `[patch]` `docs/providers/cursor.md` still said "installed from source" — now "installed from npm".
  - `[low]` `[patch]` a pinned install never moves on `plugins update` — documented, with the command back to the latest.
  - `[medium]` `[patch]` install/update with a running Gateway apply through it (OpenClaw `install.md`, `uninstall-and-update.md`) — wording fixed.
  - `[low]` `[patch]` the ready grep needs `NO_COLOR=1`, which the commands lacked — added to both Gateway commands; the fallback note kept.
  - `[medium]` `[patch]` "provenance is checked by npm" was unsupported — replaced with `npm audit signatures` as the way to check.
  - `[low]` `[patch]` Build from source blamed the missing registry provenance — aligned with the Troubleshooting row.
  - `[low]` `[patch]` the Develop intro claimed `dev:env` sets up everything below — now says Build from source uses the global OpenClaw.
  - `[low]` `[patch]` live findings not in MEMORY.md — recorded.

## Auto Run Result

- Summary: `docs/setup.md` installs from npm in one line, updates with `plugins update`, and keeps build-from-source under Develop; README and the provider page say the same.
- Review: 9 patched, 1 deferred to the release check (now settled), 0 rejected.
- Verification: fresh state install from npm → `loaded` 0.1.0 and a live turn with `mcp__openclaw__session_status`; a fresh agent reading only `docs/setup.md` got a working turn; after the owner approved v0.1.1 (run via dispatch, trusted publishing), `openclaw plugins update openclaw-all-cli` printed `Updated openclaw-all-cli: 0.1.0 -> 0.1.1`, the plugin loaded 0.1.1, and a live turn replied `ok`; the v0.1.1 npm tarball equals the GitHub release asset (sha256 4cae4d97…).

## Verification

**Commands:**
- fresh-agent pass: an agent given only `docs/setup.md` and a clean state installs from npm and gets a turn
- after the next release: `openclaw plugins update openclaw-all-cli` in the same state → the new version, `loaded`

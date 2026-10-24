---
title: 'Explain a cursor-cli backend id clash with the older plugin'
type: 'bugfix'
ticket: 'bug-explain-a-cursor-cli-backend-id-clash-with-the-older-plugin'
created: '2026-10-24'
status: blocked
baseline_revision: '3e0f205ff4f466412af3738010ecbfa2fb2a9d23'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context: ['{project-root}/MEMORY.md']
warnings: []
deferred: []
blocked_at: "2026-10-24"
blocked_reason: "no subagents"
---

<intent-contract>

## Intent

**Problem:** With the older `cursor-cli` plugin (`@jeehou/openclaw-cursor-cli`) still loaded, the Gateway logs `cli backend already registered: cursor-cli (cursor-cli)` as an ERROR attributed to this plugin, and nothing tells the reader what it means or what to do.

**Approach:** Document the clash in `docs/setup.md` (remove the older plugin, quote the line and its meaning). Add no plugin-side warning: the config does not show reliably that the older plugin is loaded. Pin the existing registration (one `cursor-cli`, once) with a unit test.

## Boundaries & Constraints

**Always:** Keep backend id `cursor-cli` and the registration unchanged. Docs in English, short.

**Never:** Rename the id, register under a second id, or guess a warning from `plugins.entries`.

</intent-contract>

## Implementation Notes

Oneshot: a docs row plus one test. Findings (OpenClaw 2026.10.3 host source, `registry-*.mjs` `registerCliBackend`): the host reports `cli backend already registered: <id> (<pluginId>)` where `<pluginId>` is the FIRST owner of the id, so `(cursor-cli)` is the older plugin and this plugin (`openclaw-all-cli`) is the one refused. Only a duplicate id triggers it, and `registerAdapters` registers once per adapter (one adapter).

AC2 decision, no warning: a plugin-side check could only read `api.config`. `plugins.entries.cursor-cli` shows a config entry, not a loaded plugin: an installed plugin has no entry, a stale entry can outlive a removal, and a disabled entry does not clash. The plugin API exposes no list of loaded plugins or of registered backends at `register` time. A warning from config would be wrong in both directions, so none is added; the docs carry the fix.

## Tasks

- `docs/setup.md` -- add a Troubleshooting row for the log line (meaning, `openclaw plugins uninstall cursor-cli`, restart) and a note in step 2 to remove, not only disable, the older plugin.
- `test/backend.test.ts` -- test that `registerAdapters` registers `cursor-cli` exactly once.

## Verification

**Commands:**
- `npm run ci` -- expected: success

## Auto Run Result

Status: blocked. Blocking condition: `no subagents`. The review step (quick lens) needs a context-free reviewer subagent, and this worker session has no tool to launch one. The implementation is done and verified; no review ran, no findings were triaged.

- Summary: `docs/setup.md` now tells a reader coming from the older `cursor-cli` plugin to uninstall it (not only disable it), and a Troubleshooting row quotes `cli backend already registered: cursor-cli (cursor-cli)` with its meaning (the bracket names the first owner of the id, here the older plugin; this plugin is refused). No plugin-side warning (AC2 decision above). A unit test pins one `cursor-cli` registration and no warning even when the config has a `plugins.entries.cursor-cli` entry.
- Files changed: `docs/setup.md` (note before step 3, Troubleshooting row), `test/backend.test.ts` (one test), this plan.
- Review: not run. Deferred: none. Follow-up review recommended: false (nothing was patched); the quick review itself is still owed.
- Verification: `npm run ci` passed (42 test files passed, 1195 tests passed, install smoke `status=loaded cliBackendIds=["cursor-cli"]`). No live Cursor check (not needed).
- Residual risks: the clash with a disabled-but-installed older plugin is taken from the ticket and the host source (`registerCliBackend` reports the first owner); it was not reproduced (needs both plugins).

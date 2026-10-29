---
title: "The model setup page shows no plugin icon"
ticket: 18
type: bugfix
status: blocked
baseline_revision: 6756797b38256c05dbfe1e8d8c1e8ed4dbb4143d
route: oneshot
route_source: auto
risk: low
review: quick
review_source: pinned
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
warnings: []
deferred: []
blocked_at: "2026-10-29"
blocked_reason: "no subagents"
---

# The model setup page shows no plugin icon

## Implementation Notes

Oneshot (about 30 lines, 5 files, mechanical). Manifest: `icon` (raw GitHub URL of `assets/icon.png`) added to both `providerAuthChoices`. Test: `test/provider-auth.test.ts` checks each choice has an HTTPS `icon` whose path ends in `/assets/icon.png` (an unset icon resolves to `/undefined`, so it fails without the fix). Docs: `docs/providers/cursor.md` icon table now lists the setup page as showing it and links openclaw/openclaw#186945. `CHANGELOG.md` line for #45. `MEMORY.md` entry corrected.

## Review Triage Log

No review pass ran: this session has no tool to launch a subagent.

## Auto Run Result

- Status: blocked, `no subagents`. The change is implemented and verified; the quick review lens was not run.
- Files: `openclaw.plugin.json`, `test/provider-auth.test.ts`, `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md`.
- Verification: `npm test` passed (50 files, 1464 tests passed, 72 skipped). Live Gateway and browser check of the setup page: not run (no Gateway or cursor-agent login on this host).
- Residual risk: the host honoring the URL is read from the bundle only; the icon URL resolves only once `assets/icon.png` is on `main`.

---
title: "The model setup page shows no plugin icon"
ticket: 18
type: bugfix
status: done
baseline_revision: 6756797b38256c05dbfe1e8d8c1e8ed4dbb4143d
route: oneshot
route_source: auto
risk: low
review: quick
review_source: pinned
lenses_ran: [acceptance, correctness]
review_loop_iteration: 0
followup_review_recommended: false
warnings: []
deferred: []
---

# The model setup page shows no plugin icon

## Implementation Notes

Oneshot (about 30 lines, 5 files, mechanical). Manifest: `icon` (raw GitHub URL of `assets/icon.png`) added to both `providerAuthChoices`. Test: `test/provider-auth.test.ts` checks each choice has an HTTPS `icon` whose path ends in `/assets/icon.png` (an unset icon resolves to `/undefined`, so it fails without the fix). Docs: `docs/providers/cursor.md` icon table now lists the setup page as showing it and links openclaw/openclaw#186945. `CHANGELOG.md` line for #45. `MEMORY.md` entry corrected.

## Review Triage Log

Quick review by a separate reviewer agent (orchestrator session, after the build worker had no subagent tool). No blocking findings. Minor 1 (plan was blocked): fixed by this update. Minor 2 (user docs do not say the URL points at `main`): rejected; the docs already state the network need, and the icon resolves once this change is on `main`.

## Auto Run Result

- Status: built. The change is implemented and the quick review ran with no blocking findings.
- Files: `openclaw.plugin.json`, `test/provider-auth.test.ts`, `docs/providers/cursor.md`, `CHANGELOG.md`, `MEMORY.md`.
- Verification: `npm test` passed (50 files, 1464 tests passed, 72 skipped); `node scripts/changelog.mjs check` ok. Live Gateway and browser check of the setup page: not run (no Gateway or cursor-agent login on this host).
- Residual risk: the host honoring the URL is read from the bundle only; the icon URL resolves only once `assets/icon.png` is on `main`.

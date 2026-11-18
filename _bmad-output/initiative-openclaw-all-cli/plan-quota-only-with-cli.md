---
title: 'Show the Cursor quota only when cursor-agent is on the host'
type: 'bugfix'
ticket: ''
created: '2026-11-17'
status: 'built'
baseline_revision: '6bc64be37aa99b4d3b312533ecd935502c7c8638'
route: 'oneshot'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context: []
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** nick removed the plugin and `cursor-agent` from his server, then installed the plugin again. The `cursor-cli` provider card still shows the Cursor plan quota (Ultra, 52% left). It also says "Not configured". The quota appears because the usage hook finds a key somewhere (an OpenClaw auth profile, the plugin config, or the Gateway's environment), whether or not the CLI exists. nick (2026-11-17): "I don't care whether there is a key there or not; the remaining quota must not show if cursor-agent is not on the host."

**Approach:** The usage hook first checks that the backend's CLI is on the host, without running it. The command is the configured `cursor-cli.command`, else the adapter's default, found as a path or on `PATH`. When the CLI is not there, the hook answers `handled` with no token, so OpenClaw shows no quota row. Everything else stays as it is.

</frozen-after-approval>

## Implementation Notes

**Why oneshot:** one hook in `src/core/quota.ts` and a small lookup helper, plus tests, docs and a changelog line. About 60 lines in all.

**Decisions:**
- I look the CLI up on the filesystem (`cliOnHost`) and do not run `--version`. A run costs time inside OpenClaw's 5 s usage budget, and the turn path already does the version check.
- A path is resolved against the Gateway's working directory. A bare name is searched in the `PATH` the CLI runs with (the host env, then `cursor-cli.env`), and on Windows also with `PATHEXT`.
- The managed install sets an absolute `command`. If that folder is deleted, the lookup fails and the quota is hidden.

**Files changed:**
- `src/core/quota.ts`: new `cliOnHost`. `resolveUsageAuth` answers `handled` before it looks for any key when the CLI is missing. The `cliPresent` option lets tests inject the lookup.
- `test/quota.test.ts`: a missing CLI hides the quota, with OpenClaw never asked for a key. The configured command is the one looked up. `cliOnHost` checks a path, `PATH`, a missing file, a folder, a non-runnable file and an empty name.
- `test/profile-key.test.ts`: `cliPresent: () => true` for the existing hook tests.
- `docs/providers/cursor.md` (Plan quota limits), `CHANGELOG.md` (Fixed).

**Not run:** a live Gateway check. It would need a real Cursor key and quota, and the unit tests cover the decision.

## Verification

**Commands:**
- `npm run typecheck`. Expected: passes.
- `npm test`. Expected: passes, with new cases where a missing CLI gives no quota, and a CLI found by path or on `PATH` keeps the quota.

## Review Triage Log

Quick lens, pass 1. Afterwards typecheck, `npm test` (2017 passed, 70 skipped) and the build pass.

| Verdict | Route | Finding | Evidence and action |
| --- | --- | --- | --- |
| medium | patch | The lookup used `process.env.PATH`, not the CLI's env | Real. Turns and probes start the CLI with `{ ...context.env, ...settings.env }`. The hook now passes the same env to `cliOnHost`. |
| low | rejected | A relative `command` is resolved against the Gateway's cwd, not the turn's cwd | Real, but rare: a relative `command` hardly ever reaches a Gateway, and the managed install writes an absolute path. Matching the turn would need the cwd of each turn, which the hook does not have. The docs now say "relative to the Gateway's working directory". |
| low | patch | No hook-level test of the default lookup | Real. A new test runs the real `cliOnHost` through the hook with a temporary `PATH`, in three cases: on the host `PATH` (quota kept), missing (hidden), and via `cursor-cli.env.PATH` (kept). |
| false | rejected | An invalid backend config falls back to `adapter.command` | The reviewer found no defect: it matches `register.ts`, and symlinked launchers pass. |
| low | patch | The docs did not say which `PATH` is used | Fixed together with the first finding: the docs now name the CLI's `PATH` (the Gateway's, or `cursor-cli.env.PATH`). |

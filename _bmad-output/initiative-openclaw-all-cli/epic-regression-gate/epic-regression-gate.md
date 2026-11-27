---
type: epic
title: "Pre-release regression gate: every past bug re-run on a real OpenClaw before any release"
parent: initiative-openclaw-all-cli
covers: []
after: []
assignee: ""
risk: high
---

# Pre-release regression gate: every past bug re-run on a real OpenClaw before any release

## Description

Bugs came back after their fixes (five families among 20 closed bugs; #102 is the unfinished half of #76). Every release now installs the exact `.tgz` it will publish into real OpenClaw versions, re-runs a test for every past bug at the level where the bug showed (unit, a real Gateway with a scripted Cursor stand-in, the Control UI in a browser, a real Cursor model), and publishes nothing while one is red. A red regression becomes issues, the agent fixes them as one batch through the BMAD build, and the full regression runs again until it is green (change pre-release-regression-gate, user 2026-11-27).

## Outcome

The owner says "release", and what reaches npm and ClawHub has passed every ledger entry on OpenClaw min, extended-stable and latest, with a real Cursor turn for every model-behavior bug. A bug that once shipped cannot ship again unnoticed, because its test runs before every release.

## Done when

1. `test/regression/ledger.toml` lists every closed `type:bug` issue with its family, tier, and test, and `npm test` fails when a closed bug has no entry or an entry names a missing test.
2. A pull request runs the Gateway tier (packed `.tgz`, fresh OpenClaw, real Gateway, `fake-cursor-agent`) on OpenClaw min and latest and the Control UI tier on latest, without any secret; each past bug a fake Cursor can show has a scenario there.
3. A release run executes the Gateway and Control UI tiers on min, extended-stable and latest, and the live tier with the real `cursor-agent` and `CURSOR_API_KEY`, before any publish; any red publishes nothing; the job summary shows results, timings, and Cursor tokens spent.
4. On the owner's "release", red scenarios become `type:bug` issues, one BMAD batch fixes them with ledger entries, and the full regression runs again until green; after 3 red rounds the loop stops and reports to the owner.
5. A weekly run on OpenClaw `beta` opens an issue when it is red.

## Boundaries

`test/regression/`, `test/fixtures/`, `test/live/` (runner and new scenarios), `scripts/` (regression runner, release loop), `.github/workflows/` (`ci.yml`, `release.yml`, a weekly workflow), `docs/release.md`, `docs/agents/implement.md`, `_bmad/custom/` build overrides. No change under `src/` except a fix a red scenario demands, built as its own bug ticket. The fix for #102 is its own bug ticket in the issue flow.

## References

- change proposal — _bmad-output/initiative-openclaw-all-cli/change-pre-release-regression-gate/change-pre-release-regression-gate.md
- live harness — test/live/harness.ts (`startGateway`, `watchGatewayEvents`, `openclaw`)
- fake Cursor — test/fixtures/fake-cursor-agent.mjs
- CI and release — scripts/ci-check.sh, scripts/release.sh, .github/workflows/ci.yml, .github/workflows/release.yml, docs/release.md
- agent rules — docs/agents/implement.md ("Reproduction test", "Live checks never block")
- facts — MEMORY.md (live suite 3,196 s on 2026-10-21; webchat probe over `chat.send`; Control UI over CDP)

## Notes

- Decision: a full pre-release regression gates every release; a red regression is fixed as a batch and re-run until green (user, 2026-11-27).
- Decision: the live tier uses the owner's current Cursor key as `CURSOR_API_KEY` in a GitHub Actions environment `regression`, not a separate key (user, 2026-11-27).
- Decision (agent, recommended in the proposal, no objection from the owner): T1 to T3 red blocks with no override; a T4 scenario fails only when all 3 tries fail, and only the owner's explicit "release despite red" passes it, recorded in the release notes; the minimum OpenClaw stays 2026.10.3.
- Supersedes epic-distribution Done when 1 "the live suite stays out of CI": the live suite runs in the release (not on pull requests).
- Live runs only inside a release, not nightly, to spare the owner's Cursor usage.
- Estimates, not measurements: a full round about 1.5 hours and 2 to 5 million Cursor tokens; R5 measures both.
- Ids: entry N is R<N> of the proposal; 9 (split from R3) and 10 (refactor sweep) were added by the breakdown check.
- Tracer bullet: entry 2 (one plain turn through a real Gateway with the fake Cursor). Order reasons: 3 and 9 need the harness (2) and the ledger (1); 6 needs the reusable workflow from 4; 5 needs the ledger and `regression.yml` (4) and the owner's key; 7 wires every tier; 10 sweeps before 8 adds the loop on top.
- Decision (agent, 2026-11-27): no expected-red scenarios. The #102 scenario comes with the #102 fix (its own bug ticket); an open known bug therefore blocks the next release until fixed, as the owner asked ("no bugs in the release").
- Decision (agent, 2026-11-27): the ledger is a committed file; `npm test` checks it offline, and a CI step with `GITHUB_TOKEN` compares it with the closed `type:bug` issues.

---
type: change
title: "A pre-release regression gate: every past bug re-run on a real OpenClaw before any release"
parent: initiative-openclaw-all-cli
date: 2026-11-27
scope: moderate
status: proposed
---

# Change: a pre-release regression gate

## Issue summary

The owner sees bugs come back (user, 2026-11-27). The latest, [#102](https://github.com/xtimor/openclaw-all-cli/issues/102) (filed 2026-11-27): in Cursor's `ask` mode the model reads the missing native edit tool as a read-only session and refuses writes that the OpenClaw tools allow. The owner asks for a full regression before every release: install a real OpenClaw and the plugin, recreate the conditions under which past bugs reproduced, and release only when it is green.

The owner made the strategic call. Tactics below are the agent's (AGENTS.md); the three decisions at the end are the owner's.

## Evidence: is it a repeat?

**#102 is not the same bug as an earlier one, but it is the second half of #76.** #76 (2026-11-08): with native Shell denied, the model was told nothing about OpenClaw `exec`. The fix (`aa16d11`, `shellNote` in `src/core/turn-prompt.ts`) covered only turns where the host serves `exec` (Cursor `agent` mode). The `ask` mode turn kept getting no note at all. The adapter comment above `modeFor` already recorded the effect in a live probe ("in `ask` mode the model refuses any command that changes files ... live: 2 of 3 refused"), but no test pinned it, so it shipped.

The owner's sense of recurrence is right. Of 20 closed bugs (#11 to #99), five families came back:

| Family | First | Came back as | Why it came back |
| --- | --- | --- | --- |
| Model not told what is open when native tools are off | #76 (shell) | #102 (edits, ask mode) | fix covered one mode; the other was never run |
| Context usage tile | #40, fix #41 | #97 "incomplete fix in #41" | unit tests checked a summed value, not what the Control UI shows over turns |
| 15-20 s to the first reply | #11 | #38, #44 | measured once, not re-measured per release |
| Provider icon | #9 | #35, #45 | checked in the manifest, never in the Control UI |
| Auth status on the provider card | #39 (says not configured) | #98 (says authenticated with a bad key) | no test drives the card with good, bad, and missing keys |

Root causes, from the repository:

1. **The tests that use a real OpenClaw and a real Cursor never run on their own.** `test/live/` has about 90 tests in 17 files with a Gateway harness (`startGateway`), but `scripts/ci-check.sh` says "live tests are not part of it", and the release runs only `ci-check.sh`. They run when an agent remembers to run a focused file.
2. **CI and release test one old OpenClaw.** `OPENCLAW_VERSION: 2026.10.3` in `ci.yml` and `release.yml`. The owner runs 2026.11.2; npm `latest` is 2026.11.10 and `extended-stable` 2026.10.34 (read 2026-11-27). Several bugs depended on the OpenClaw version (#65, #80, Test connection on 2026.11.x).
3. **The offline end to end stops at "plugin loads".** The install smoke check in `ci-check.sh` installs the packed `.tgz` and checks `plugins inspect`. No offline test runs a chat turn through a real Gateway, although `test/fixtures/fake-cursor-agent.mjs` can stand in for Cursor.
4. **No bug-to-test ledger.** Since ticket 3.29 a triaged bug gets a reproduction test, but nothing lists which past bug is covered by which test, at which level (unit, Gateway, live, Control UI), so a fix verified only against the plugin's own model of the host counts the same as one verified on a real host.
5. **The Control UI is checked by hand.** Icon, provider card, Connect, Test connection, Remove key, quota and context tiles were checked over CDP by an agent, once per change, and never again.

## Impact analysis

- **Epics.** A new epic, `epic-regression-gate`. epic-distribution's release flow gains a gate (ticket R7 changes `release.yml` and `docs/release.md`). epic-cursor-cli and epic-antigravity-cli are unchanged; the Antigravity adapter later inherits the gate.
- **Spec and PRD.** No capability changes. CAP-11 (claude-cli parity, its live suite) gets an automatic runner; the spec text stays.
- **Architecture.** Consistency Conventions, row Tests: add the regression tiers and the ledger. Stack: the tested OpenClaw versions become a matrix. AD-4 stays: tests never call `cursor-agent -p`.
- **Agent flow.** `docs/agents/implement.md` and the BMAD build overrides: a bug fix is done only with a ledger entry and a test at the tier where the bug showed (Gateway or Control UI for a host-visible bug, live for model behavior).
- **Secrets and money.** The live tier needs a Cursor API key in GitHub Actions and spends Cursor usage on every release and nightly run (decision 1).
- **Release time.** A release run grows by an estimated 30 to 50 minutes (three OpenClaw versions, live turns). R5 measures it; the estimate is not a measurement yet.

## Recommended approach

Direct adjustment: one new epic of seven stories. The layers, cheapest first:

| Tier | What runs | Cursor | Secrets | When |
| --- | --- | --- | --- | --- |
| T1 unit | today's vitest suite | fake | none | every PR |
| T2 Gateway | packed `.tgz` installed into a fresh OpenClaw; a real Gateway; chat turns over its API; `fake-cursor-agent` scripted to recreate each bug's conditions (permission profile, `ask`/`agent` mode, empty native selection, throttle, bad key, usage numbers, reply text). Asserts what the plugin sends to the CLI (mode, permission file, prompt notes) and what the Gateway returns (one reply, usage, errors) | fake | none | every PR on min + latest OpenClaw; release on the full matrix |
| T3 Control UI | headless Chromium against that Gateway: provider card, icon, Connect with API key, Test connection, Remove key, quota and context tiles | fake | none | every PR on latest; release on the matrix |
| T4 live | the real `cursor-agent` and a real Cursor model in that Gateway: the existing `test/live/` suite plus one scenario per model-behavior bug (#102 write in ask mode, #76 exec, #75 GPT structured output, #11/#38/#44 first-reply time, Test connection, quota). A model can miss once: each scenario gets up to 3 tries and fails when all 3 fail; refusal-type bugs use the model from the report (`grok-4.7` for #102) | real | `CURSOR_API_KEY` | release and nightly |

The OpenClaw matrix: the minimum we declare (`2026.10.3`, from `package.json` `compat`), npm `extended-stable`, and npm `latest`, resolved at run time and printed in the summary. A weekly run on OpenClaw `beta` opens an issue when a new host breaks us before users see it.

| Ticket | What | Risk | Notes |
| --- | --- | --- | --- |
| R1 | Regression ledger: `test/regression/ledger.toml`, one entry per closed `type:bug` issue (number, family, tier, test file and name); a test fails when a closed bug has no entry or an entry names a missing test. The agent rules (`implement.md`, BMAD build overrides): a bug fix adds its entry and a test at the tier where it showed, proved red before the fix | low | backfills the 20 past bugs, marking honestly which are only unit-covered today |
| R2 | T2 harness: `scripts/regression.sh` installs the packed `.tgz` into a throwaway OpenClaw state per version, starts a Gateway, runs scenario files under `test/regression/gateway/`; `fake-cursor-agent` gains what scenarios need (log the prompt text and permission files it was started with, scripted refusals) | medium | no secret; runs in CI |
| R3 | T2 scenarios for every past bug a fake Cursor can recreate: #13, #14, #12/#46, #40/#97, #67, #74, #11/#38 (process count per turn), #76/#102 (the note reaches the CLI in both modes), #99, #98, #39, Test connection, managed install and Remove key (#92), #80 update docs | medium | the #102 fix itself is its own bug ticket in the issue flow; R3 only adds its Gateway scenario if that fix lands first |
| R4 | OpenClaw matrix in `ci.yml` and `release.yml`; the weekly `beta` run that opens an issue on red | low | |
| R5 | T4 in GitHub Actions: a `regression` environment holding `CURSOR_API_KEY`, the live suite plus the model-behavior scenarios with 3 tries, a per-run time and turn cap, results and timings in the job summary; nightly on `main` | high | hitl: the owner adds the key (decision 1). Measures the real time and Cursor usage of one full run |
| R6 | T3: Playwright with its Chromium, installed in the job, drives the Control UI of the T2 Gateway; screenshots on failure as a workflow artifact | medium | |
| R7 | The gate: `release.yml` runs T2+T3 on the matrix and T4 before `npm publish`; any red stops the release before anything is published; a dry run runs the same; `docs/release.md` says so | high | the override rule is decision 2 |

Order: R1, R2, R3, R4, R6, R5, R7. R1 to R4 need nothing from the owner and already catch the families above that a fake Cursor can show. Effort: about two to three days of agent work for R1 to R4 and R6; R5 and R7 about a day after the key is in place.

## What cannot be automated, or only partly

- **Model behavior is probabilistic.** #102-type refusals reproduce 2 of 3 times, not always. Three tries per scenario cut false alarms, but a live green is evidence, not proof. The prompt-level part (the right note reaches the CLI) is deterministic and sits in T2.
- **The owner's own setup.** Other plugins' tools (Workboard, wiki from #102), the owner's agents and long-lived state. T2/T4 use OpenClaw's built-in tools in their place.
- **Cursor account states.** A spent plan quota or a real throttle cannot be produced on demand; they stay fake-only (T2).
- **macOS.** All tiers run on Linux runners. A macOS job is possible later (GitHub macOS runners, about 10x the minutes); not in this change.
- **ClawHub review and npm/ClawHub themselves.** External; the release already waits for ClawHub's checks.

## Decisions for the owner

1. **A Cursor key in GitHub Actions.** The live tier needs `CURSOR_API_KEY` as an Actions secret (in a protected `regression` environment), and every release plus each nightly run spends Cursor usage on it. Recommended: a separate key, ideally a separate Cursor account, so the spend is visible and can be revoked alone. Without it, T1 to T3 still gate releases and T4 stays manual.
2. **How strict the gate is.** Recommended: any red in T1 to T3 blocks the release with no override; a T4 scenario that fails all 3 tries blocks it too, and the only way past is the owner's explicit "release despite red" in chat, recorded in the release notes.
3. **Which OpenClaw versions we promise.** Recommended: keep the minimum at 2026.10.3 and test min, extended-stable and latest. Raising the minimum would shorten the matrix but drop users on older hosts.

## Implementation handoff

- Scope: moderate (a new epic, no replan of existing epics).
- On approval: create `epic-regression-gate` and tickets R1 to R7 with `bmad-ticket`; record the decisions in the initiative Notes and `MEMORY.md`; update the architecture row Tests and the Stack line for the matrix; build in the order above with `bmad-build` (or `dev-orchestrator` for a batch).
- #102 is fixed separately through the issue flow and becomes the first bug filed under the new ledger rule.
- Success: a release run that installs the exact `.tgz` it will publish into OpenClaw min, extended-stable and latest, re-runs every ledger entry at its tier, and publishes nothing when one is red; and each of the five families above has a test at the tier where it was seen.

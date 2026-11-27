---
title: 'Gateway tier harness: packed plugin, fresh OpenClaw, real Gateway, scripted Cursor'
type: 'feature'
ticket: '2'
created: '2026-11-27'
status: 'in-progress'
baseline_revision: '131ad24b75301cfff044ea97acad1daa12c01241'
route: 'full'
route_source: 'auto'
risk: 'medium'
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

**Problem:** No offline test runs a chat turn through a real OpenClaw Gateway with the packed plugin; CI stops at "plugin loads" on one old OpenClaw (2026.10.3), so host-visible bugs ship. The regression epic needs a tier that installs the exact `.tgz` into a fresh OpenClaw of a chosen version, runs a Gateway, and drives turns against `fake-cursor-agent`.

**Approach:** A runner script `scripts/regression.sh gateway` prepares a per-version isolated OpenClaw under `.regression/`, packs and installs the plugin into a fresh state, and runs vitest files `test/regression/gateway/*.regression.test.ts` that are skipped unless `OPENCLAW_ALL_CLI_REGRESSION=1`. A small harness reuses `test/live/harness.ts`. One tracer scenario proves the chain over both `openclaw agent` (through the Gateway) and `chat.send`.

## Boundaries & Constraints

**Always:** no secret and no network beyond installing Node/OpenClaw from npm; the plugin under test is the packed `.tgz`, never the checkout; each run starts from an empty state dir and config; the Gateway and every fake CLI it started are stopped after the file (process group); `npm test` still passes offline with the new files skipped; English everywhere.

**Never:** touch `.spike/` state or `~/.openclaw`; change `src/`; call real `cursor-agent`; add CI jobs (ticket 4 does the matrix); add scenarios beyond the tracer (tickets 3 and 9).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Tracer via CLI | Gateway up, `cursor-cli.command` = fake shim, `openclaw agent --session-id <new> --message "say:<nonce>"` with `OPENCLAW_GATEWAY_PORT` | exit 0, reply lines equal `[<nonce>]` (exactly once), fake log shows one `session/prompt` whose text ends with the message | test fails with the CLI output |
| Tracer via chat.send | operator ws client sends `chat.send` `{sessionKey:"agent:main:explicit:<id>", message:"say:<nonce2>", idempotencyKey}` | exactly one `chat` frame with `state: "final"` for that run, its text contains `<nonce2>` once | fail with the frames seen |
| Version arg | `--openclaw latest` / `min` / `extended-stable` / `beta` / `X.Y.Z` | `min` = `package.json` `openclaw.compat.minGatewayVersion`; a tag resolves through `npm view openclaw dist-tags.<tag>`; the resolved version is printed | unknown tag: exit 2 with a message |
| Broken plugin | installed plugin registers no `cursor-cli` backend | tracer fails (red), runner exits non-zero | — |
| Not enabled | `npm test` without the env var | the regression files are reported skipped, no Gateway starts | — |

</intent-contract>

## Code Map

- `scripts/dev-openclaw.sh` -- reuse as is with `SPIKE_DIR` and `OPENCLAW_VERSION` (setup installs Node + OpenClaw; `run` execs `openclaw` with the isolated state/config). Do not change its defaults.
- `scripts/ci-check.sh` -- reference for pack + install into a throwaway state (`plugins install --force --accept-capabilities <tgz>`).
- `test/live/harness.ts` -- reuse `openclaw`, `openclawAsync`, `startGateway(port)` (spawns `dev-openclaw.sh run gateway run ... --auth none` in its own process group; inherits `SPIKE_DIR` from env), `watchGatewayEvents`, `replyLines`, `waitFor`, `LIVE_TIMEOUT_MS`. Do not change its behavior.
- `test/fixtures/fake-cursor-agent.mjs` -- already logs every request (with full prompt text in `session/prompt`) to `FAKE_CURSOR_LOG`, `say:<text>` replies `<text>`. No change needed for the tracer; later tickets add hooks.
- `test/fixtures/paths.ts` -- `FAKE_CURSOR_AGENT` path.
- `test/live/capability-check.live.test.ts` -- pattern for a shim script that exports `FAKE_CURSOR_*` and execs the fake.
- `vitest.config.ts` -- `fileParallelism` must also be off when `OPENCLAW_ALL_CLI_REGRESSION=1` (one shared state per run).
- `.gitignore` -- add `.regression/`.
- Probe facts (2026-11-27, OpenClaw 2026.10.3): with `plugins.entries.openclaw-all-cli.config.cursor-cli.command` = shim and `agents.defaults.model.primary` = `cursor-cli/auto`, a Gateway turn via `openclaw agent` returned the fake's reply in ~21 s (the plugin's usage reader waits up to 15 s when the fake has no ledger); the plugin's catalog loads ~12 s after the port opens, so wait for it before the first turn. Killing only the Gateway pid leaves the fake `acp` child alive: stop the process group.

## Tasks & Acceptance

**Execution:**
- [ ] `scripts/regression.sh` -- new: `regression.sh gateway [--openclaw <min|latest|extended-stable|beta|X.Y.Z>]` (default `min`); resolves the version, sets `SPIKE_DIR=$ROOT/.regression/openclaw-<version>`, runs `dev-openclaw.sh setup`, builds and packs once into `$ROOT/.regression/pack`, wipes `state/` and `openclaw.json`, re-runs `config set gateway.auth.mode none`, installs the `.tgz`, then `OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run test/regression/gateway`; prints the resolved version and the tgz sha256 -- one entry point for CI and release
- [ ] `test/regression/harness.ts` -- new: `REGRESSION` flag, `describeRegression` (skip unless set), `fakeCommand(root, name, env)` writing an executable shim with `FAKE_CURSOR_LOG`, `readFakeLog(file)` returning parsed lines, `configure(entries)` via `openclaw config set` (JSON values with `--strict-json`), `startRegressionGateway(port)` = `startGateway` plus a wait until `models list --json` (or equivalent) shows a `cursor-cli/` model, `gatewayAgentTurn(port, sessionId, message)`, `chatSend(port, sessionKey, message)` over an operator ws client returning the run's frames -- shared by every later scenario
- [ ] `test/regression/gateway/tracer.regression.test.ts` -- new: the two tracer rows of the matrix -- proves the chain
- [ ] `vitest.config.ts` -- `fileParallelism` false also when `OPENCLAW_ALL_CLI_REGRESSION=1`
- [ ] `package.json` -- script `test:regression` = `scripts/regression.sh gateway`
- [ ] `.gitignore` -- `.regression/`
- [ ] `MEMORY.md` -- one line under "Where things are": the Gateway regression tier and how to run it

**Acceptance Criteria:**
- Given a clean checkout with no `.regression/`, when `scripts/regression.sh gateway` runs, then it installs OpenClaw 2026.10.3, runs the tracer green, and exits 0.
- Given the same, when `scripts/regression.sh gateway --openclaw latest` runs, then it prints the resolved npm `latest` version and the tracer passes.
- Given the installed plugin's backend registration removed in the throwaway state, when the tracer runs, then it fails and the runner exits non-zero.
- Given `npm test`, when it runs, then the regression file is skipped and no Gateway process is started.
- Given a tracer run ends (pass or fail), when it is over, then no Gateway or fake-cursor-agent process from it is left running.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Verification

**Commands:**
- `scripts/regression.sh gateway` -- expected: tracer passes on 2026.10.3, exit 0
- `scripts/regression.sh gateway --openclaw latest` -- expected: tracer passes on npm latest
- `npm test` -- expected: green, regression file skipped
- `npm run typecheck` -- expected: clean
- `pgrep -fa fake-cursor-agent` after a run -- expected: nothing from the run

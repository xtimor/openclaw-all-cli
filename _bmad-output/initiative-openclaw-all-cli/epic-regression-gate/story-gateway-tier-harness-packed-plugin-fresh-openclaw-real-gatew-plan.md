---
title: 'Gateway tier harness: packed plugin, fresh OpenClaw, real Gateway, scripted Cursor'
type: 'feature'
ticket: '2'
created: '2026-11-27'
status: 'built'
baseline_revision: '131ad24b75301cfff044ea97acad1daa12c01241'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
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
- [x] `scripts/regression.sh` -- new: `regression.sh gateway [--openclaw <min|latest|extended-stable|beta|X.Y.Z>]` (default `min`); resolves the version, sets `SPIKE_DIR=$ROOT/.regression/openclaw-<version>`, runs `dev-openclaw.sh setup`, builds and packs once into `$ROOT/.regression/pack`, wipes `state/` and `openclaw.json`, re-runs `config set gateway.auth.mode none`, installs the `.tgz`, then `OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run test/regression/gateway`; prints the resolved version and the tgz sha256 -- one entry point for CI and release
- [x] `test/regression/harness.ts` -- new: `REGRESSION` flag, `describeRegression` (skip unless set), `fakeCommand(root, name, env)` writing an executable shim with `FAKE_CURSOR_LOG`, `readFakeLog(file)` returning parsed lines, `configure(entries)` via `openclaw config set` (JSON values with `--strict-json`), `startRegressionGateway(port)` = `startGateway` plus a wait until `models list --json` (or equivalent) shows a `cursor-cli/` model, `gatewayAgentTurn(port, sessionId, message)`, `chatSend(port, sessionKey, message)` over an operator ws client returning the run's frames -- shared by every later scenario
- [x] `test/regression/gateway/tracer.regression.test.ts` -- new: the two tracer rows of the matrix -- proves the chain
- [x] `vitest.config.ts` -- `fileParallelism` false also when `OPENCLAW_ALL_CLI_REGRESSION=1`
- [x] `package.json` -- script `test:regression` = `scripts/regression.sh gateway`
- [x] `.gitignore` -- `.regression/`
- [x] `MEMORY.md` -- one line under "Where things are": the Gateway regression tier and how to run it

**Acceptance Criteria:**
- Given a clean checkout with no `.regression/`, when `scripts/regression.sh gateway` runs, then it installs OpenClaw 2026.10.3, runs the tracer green, and exits 0.
- Given the same, when `scripts/regression.sh gateway --openclaw latest` runs, then it prints the resolved npm `latest` version and the tracer passes.
- Given the installed plugin's backend registration removed in the throwaway state, when the tracer runs, then it fails and the runner exits non-zero.
- Given `npm test`, when it runs, then the regression file is skipped and no Gateway process is started.
- Given a tracer run ends (pass or fail), when it is over, then no Gateway or fake-cursor-agent process from it is left running.

## Implementation Notes

- The runner unsets `CURSOR_API_KEY`/`CURSOR_AUTH_TOKEN` and `startRegressionGateway` omits them from the Gateway env (no secret; the host had a key set and the plugin ran a key check with it before this).
- `describeRegression` throws when enabled with a `SPIKE_DIR` outside `.regression/`, so a direct `OPENCLAW_ALL_CLI_REGRESSION=1 npx vitest run` cannot touch `.spike/`.
- Cleanup: OpenClaw 2026.11.10 starts its workers in process groups of their own, and the plugin starts each CLI in its own group, so killing the Gateway's group alone may not reach them. `stop()` notes the Gateway's whole process tree first, SIGTERMs the group (the Gateway then stops its workers and CLIs itself, observed on both versions), then SIGKILLs whatever of the tree is left. Every shim records its pid; `afterAll` waits for them to exit and SIGKILLs leftovers with a warning.
- Review fixes: the chat.send check requires `payload.message` and counts the nonce only in its text (the session key carries no nonce); pids are signalled only while their command line still matches (fake-cursor-agent for the shim's pids, the snapshot's command line for the Gateway tree and group; no group-wide kill); a failed or non-JSON `models.list` never counts as an empty catalog, and only failures end in a thrown error; the health and readiness waits take 90 s each, `config set` 30 s, and `onStarted` hands `afterAll` the stop function before the readiness wait; the tracer's temp dir is made in `beforeAll`.
- `chatSend` keeps listening 2 s after the run's first `final`/`error`/`aborted` frame, so a second final would be counted.
- The runner adds `--reporter=verbose` so a CI log names each scenario.
- `docs/setup.md` (development section) names `npm run test:regression` (AGENTS.md rule: docs change with setup).

## Plan Change Log

- Prompt check: OpenClaw wraps the user's message (a timestamp before it on the `openclaw agent` path, its messaging hints after it on both paths), so "text ends with the message" is never true. The tracer instead requires exactly one prompt line that ends with the message.
- Readiness wait: on OpenClaw 2026.11.10 (npm `latest` on 2026-11-27), offline, `models.list` is empty for every provider (`{}`, `view: all`, `provider: cursor-cli`, `refresh: true`; the log shows `remote model catalog refresh failed ... ENOTFOUND catalog.openclaw.ai`), so a cursor-cli row never shows up, while a turn works. The wait now ends with `catalog: "empty"` (and a warning) when no model at all is listed for 30 s; when other models are listed and cursor-cli never is, it still throws. On 2026.10.3 the cursor-cli rows show up as before.
- Build: `tsconfig.json` maps the SDK types to `.spike/openclaw`, which the tier must not read (and which a clean checkout lacks). The runner always builds with a generated `.regression/tsconfig.build.json` that points the same `paths` at `.regression/openclaw-<openclaw.build.openclawVersion>` (set up there when it is not the version under test), and it never puts `.spike/node` on PATH; without any Node on PATH it exits 2 asking for one to bootstrap.

## Plan Change Log

## Review Triage Log

### 2026-11-27 — Review pass
- verdicts: 8 findings — high 0, medium 4, low 3, false 0, maybe-false 0, rejected (plan edit) 1
- findings:
  - `[medium]` `[patch]` chat.send nonce counted in the whole payload while the session key held the nonce, so a final without text passed — fixed: `payload.message` required, nonce counted only in its text, session key uses its own id.
  - `[medium]` `[patch]` recorded pids and the Gateway tree snapshot were SIGKILLed (with process groups) without checking they were still ours — fixed: one `ps` snapshot, only pids whose command line still matches are signalled; group kills removed.
  - `[medium]` `[patch]` worst-case `beforeAll` exceeded the 300 s hook timeout and left a detached Gateway — fixed: inner waits 90 s, calls bounded, `onStarted(stop)` hands the stop to `afterAll` before readiness, self-stop on error.
  - `[low]` `[patch]` a failed `models.list` call counted as an empty catalog — fixed: `empty` only after a successful zero-row answer; no successful call throws.
  - `[medium]` `[patch]` the script read `.spike/` (PATH, SDK types) while header and docs said it never does, and built against an unpinned version — fixed: always builds against `openclaw.build.openclawVersion` under `.regression/`, `.spike/node` dropped.
  - `[low]` `[patch]` no Node on the host died with exit 127 — fixed: up-front check, exit 2 with a message.
  - `[low]` `[patch]` `mkdtempSync` in the describe factory left a temp dir on every `npm test` — fixed: created in `beforeAll`.
  - `[low]` `[reject]` duplicate `## Plan Change Log` heading in this plan — the fix edits this build's plan (rule: rejected).

## Auto Run Result

- **Summary:** Gateway regression tier: `scripts/regression.sh gateway [--openclaw <min|latest|extended-stable|beta|X.Y.Z>]` installs Node and the chosen OpenClaw under `.regression/`, packs the plugin once (built against the pinned SDK version), installs the `.tgz` into a fresh state, and runs `test/regression/gateway/` (skipped in `npm test`); harness `test/regression/harness.ts`; tracer over `openclaw agent` and `chat.send`.
- **Files:** `scripts/regression.sh` (runner), `test/regression/harness.ts` (shared helpers), `test/regression/gateway/tracer.regression.test.ts` (tracer), `vitest.config.ts` (no file parallelism in regression runs), `package.json` (`test:regression`), `.gitignore` (`.regression/`), `docs/setup.md` (how to run), `MEMORY.md` (where things are).
- **Review:** 7 patched (medium 4: chat.send nonce, pid reuse, hook timeout, `.spike` use; low 3: failed catalog call, no Node, temp dir), 0 deferred, 1 rejected (plan heading, plan-edit rule).
- **Follow-up review recommended:** false (no high patched; the four medium patches are narrow and re-verified).
- **Verification:** `npm run typecheck` clean; `npm test` 69 files passed, 19 skipped (2059 tests passed); `scripts/regression.sh gateway` (2026.10.3) 2/2 green, exit 0; `--openclaw latest` (2026.11.10) and `extended-stable` (2026.10.34) 2/2 green (implementer); broken `registerCliBackend` went red on 2026.10.3 and 2026.11.10 (before the review patches; not re-run after them); no Gateway or fake process left; no temp dir left.
- **Residual risks:** on OpenClaw 2026.11.10 offline `models.list` is empty, so readiness relies on the turns; 2026.11.10 logs `cli backend "cursor-cli" is missing modelProvider` (to watch in tickets 5 and 6); Node 24.22.0 is below 2026.11.10's recommended 24.22.1; no GitHub Actions run yet (ticket 4).

## Verification

Results (2026-11-27, sandbox, no Cursor login; `CURSOR_API_KEY` set in the host env and unset by the runner):
- `scripts/regression.sh gateway`: OpenClaw 2026.10.3, tracer 2/2 green, exit 0 (final code run twice; ~90 s each with Node/OpenClaw cached).
- `scripts/regression.sh gateway --openclaw latest`: resolved and printed 2026.11.10, tracer 2/2 green (readiness `empty`, see Plan Change Log), exit 0.
- Mutation (scratch copy of the checkout without `.spike/`, `api.registerCliBackend(...)` disabled in `src/core/register.ts`): both tracer tests red with `Unknown CLI backend: cursor-cli`, runner exit 1, on 2026.10.3 and on 2026.11.10. The same run proves the clean-checkout build fallback.
- `--openclaw nosuchtag` exit 2 ("Unknown OpenClaw dist-tag"); `--openclaw 'bad tag'` exit 2; an unknown flag or no tier prints usage, exit 2.
- `npm test`: green, `tracer.regression.test.ts` reported skipped, no Gateway started. `npm run typecheck`: clean.
- After every run: no `.regression` Gateway, worker, or fake-cursor-agent process left (`ps`).
- `scripts/regression.sh gateway --openclaw extended-stable`: resolved 2026.10.34, tracer 2/2 green (catalog listed cursor-cli), exit 0.
- Not run: `beta` end to end (2026.11.10 that day, same as `latest`); a run in GitHub Actions (ticket 4).

**Commands:**
- `scripts/regression.sh gateway` -- expected: tracer passes on 2026.10.3, exit 0
- `scripts/regression.sh gateway --openclaw latest` -- expected: tracer passes on npm latest
- `npm test` -- expected: green, regression file skipped
- `npm run typecheck` -- expected: clean
- `pgrep -fa fake-cursor-agent` after a run -- expected: nothing from the run

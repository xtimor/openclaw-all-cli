---
title: 'Live tests that do not test what they claim'
type: 'bugfix'
ticket: '41'
created: '2026-11-28'
status: 'in-review'
baseline_revision: '6d512552c94ca8563a02864d4af7ad043ed82d63'
route: 'oneshot'
route_source: 'auto'
risk: 'low'
review: 'quick'
review_source: 'auto'
lenses_ran: [quick]
review_loop_iteration: 1
followup_review_recommended: false
context: []
warnings: []
deferred: []
---

<intent-contract>

## Intent

**Problem:** Two live tests red in the live tier's first full run test a case that no longer exists: the permission-routing fallback test ran a stub turn in Cursor's `ask` mode, with no shell sentence, in a home where the native shell asks the host (no production home does), and history-continuity (c) "lost" a chat that its warm cursor-agent still held in memory.

**Approach:** Run each test's case as production has it: the fallback test in the production home with OpenClaw serving `exec`, the user asking only for the built-in shell; (c) loses the chat only after the Gateway and its cursor-agent are gone, and always gets a Gateway back.

## Boundaries & Constraints

**Always:** Assertions about the plugin stay or get stronger. If the model does not fall back in the production case, report it as a plugin finding (bug 23 territory) instead of scripting the fallback.

**Never:** Change plugin code. Touch history-continuity (a)-(d)'s 2026.11.11 log-line reads (another agent's).

</intent-contract>

## Implementation Notes

- Evidence, fallback test (OpenClaw 2026.10.3, cursor-agent 2026.11.11, stub host, `--retry 0`):
  - Old setup (no marker, asking home): `asked=[exec]`, decision `reject_once`, then no exec call; reply "The shell command was rejected ... I didn't retry it or try another tool, since the rejection looks like a decision to block it." The full run's `expected [] to include 'exec'` was the other branch: the model never asked.
  - With the marker and the old user text: the shell sentence sends the model straight to `mcp__openclaw__exec`, `asked=[]`.
- Decision (review finding 1): no production turn routes a native shell request to the host for a decision. Both static profiles (`CURSOR_PERMISSIONS`, `CURSOR_RESTRICTED_PERMISSIONS`) deny `Shell(*)`, and docs/providers/cursor.md ("Permissions and tool availability", "Shell commands") says Cursor blocks it without asking; host-routed requests exist only for what the file leaves open (web fetch and search, other MCP servers). So the test now uses the production home (`cursorAdapter.prepareHome`) with the marker, and the user asks only for the built-in shell ("Run the shell command `echo oac-fallback-7f3a` with your built-in shell tool and reply with its output only."), naming no fallback. It asserts: a host-shell turn; no permission request and no decision; Cursor's native `exec` call with the command before `mcp__openclaw__exec` with the same command; the stub `exec` reached through the proxy; `stub-exec-ran:` in the reply. The title says so: "falls back to OpenClaw exec when the native shell is denied, in the production home with OpenClaw serving exec". The model falls back ("The built-in shell was blocked, so I'll use the OpenClaw `exec` tool as the message describes"), so there is no plugin finding. The approval and abort tests keep the asking home (the P9 routing mechanism).
- Evidence, (c): the failing log shows turn 2 `reuse=reusable`, about 5 s, reply `FIG-…` (the fact), no `session/load`. The warm process came with bug 6 (2026-10-24), after (c) was written (2026-10-23).
- (c) now: reads the plugin's pid locks (`<home>/pids/*.json`) after turn 1 (and fails if there are none), stops the Gateway, waits up to 30 s until the Gateway's process group and every locked pid are gone (else it fails naming what is left), deletes the chat, and starts the Gateway on the same port. All of it is in a `try`/`finally`: if a step fails, the `finally` SIGKILLs what is left and starts the Gateway, so a retry and `afterAll` find one (review findings 3, 4).
- Found on the way: every OpenClaw 2026.10.x Gateway in one container logs to `$TMPDIR/openclaw/openclaw-<date>.log`; two at once mix their lines (seen: (c) try 1 read another Gateway's `cli exec` line). Recorded in MEMORY.md.
- Files: `test/live/permission-routing.live.test.ts`, `test/live/history-continuity.live.test.ts`, `MEMORY.md`.

## Plan Change Log

- 2026-11-28: the first fix of the fallback test (marker plus a home where the native shell asks the host, and user text "If that is refused, run it with whichever tool works") was rejected in review: it scripted the fallback and matched no production turn. Re-derived as above.

## Review Triage Log

### 2026-11-28 — Quick review (coordinator), patch round 1
- verdicts: 3 findings for this ticket — high 0, medium 3, low 0, false 0, maybe-false 0
- findings:
  - `[medium]` `[patch]` The fallback test's user text scripted the fallback, the order was not asserted, and agent mode plus an asking home matches no production turn — no production turn routes a native shell request to the host (both profiles deny `Shell(*)`); the test now uses the production home, the user names only the built-in shell, and the native call is asserted before the OpenClaw `exec` call (live 3 of 3 green, so no plugin finding).
  - `[medium]` `[patch]` (c): a failed assertion after the stop left the retries without a Gateway — stop, wait, delete and restart are in a `try`/`finally` that always starts the Gateway again.
  - `[medium]` `[patch]` (c): nothing checked that the Gateway and the warm cursor-agent had exited before the delete and the restart on the same port — it waits for the process group and every pid in the plugin's pid locks, and fails naming what is left.
- Also routed here from bug 40's review: the verification of both live-test fixes lives in this plan (finding 2).

## Verification

**Commands:**
- `OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/permission-routing.live.test.ts -t "falls back"` (stub host, real cursor-agent)
- `LIVE_TESTS=test/live/history-continuity.live.test.ts scripts/regression.sh live --openclaw 2026.10.3`

**Results (2026-11-28, this container, cursor-agent 2026.11.11-b912975):**
- Fallback test, final version, `--retry 0`: 3 runs, 3 green, 3 turns (each one turn: native `exec` blocked, `mcp__openclaw__exec` called).
- Fallback test, first version (rejected in review): green 2 of 2 (1 turn each); old version red as above (3 exploration turns).
- history-continuity, final version (finally and pid checks), OpenClaw 2026.10.3: 5 of 5 green, (c) on its first try (64 s), 5 turns for the file. Earlier version (stop, delete, start): 5 of 5 green, (c) on its first try, 5 turns; the run before that had (c) green on its second try, its first spoiled by a second 2026.10.3 Gateway of mine writing the same log file (6 turns).
- `npm run typecheck`, `npm test`: green (see bug 40's plan for the counts; one commit).
- Not run: OpenClaw 2026.11.x for (c) (its log-line reads belong to another agent; the catalog is unreachable here).

## Auto Run Result

Status: in-review

- Summary: the fallback test runs the production case (static `Shell(*)` deny, OpenClaw serving `exec`, no fallback named) and asserts the order; (c) loses its chat for real and always restarts the Gateway. Both green live on OpenClaw 2026.10.3.
- Review: quick (coordinator), 3 findings for this ticket, all patched.
- Residual risks: the fallback test relies on the model trying the built-in shell when asked to (3 of 3 here); parallel 2026.10.x Gateways in one container share a log file.

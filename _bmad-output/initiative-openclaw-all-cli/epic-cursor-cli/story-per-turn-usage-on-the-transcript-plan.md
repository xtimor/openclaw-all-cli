---
title: 'Per-turn usage on the transcript'
type: 'feature'
ticket: '10'
created: '2026-10-18'
status: 'in-progress'
baseline_revision: '92674710cc49a0d59530f0009aec6e814a8c294c'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'thorough'
review_source: 'pinned'
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md'
  - '{project-root}/MEMORY.md'
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/epic-cursor-cli/spike-where-cursor-usage-comes-from-on-acp.md'
warnings: [oversized]
deferred: []
---

<intent-contract>

## Intent

**Problem:** Cursor turns land on OpenClaw's transcript with usage `0/0/0/0` (seen in the isolated state: `transcript_events`, `provider: "cursor-cli"`). ACP reports no usage (spike 9); parity row P16 is `gap`.

**Approach:** After a turn's `result`, the core asks an optional adapter port `readUsage` for the turn's tokens and puts them on the result record it already builds. The Cursor adapter answers from Cursor's usage ledger (spike Addendum): exchange `CURSOR_API_KEY` for an access token, poll `GetFilteredUsageEvents`, match `conversationId` = ACP session id inside the turn's time window. Exact when it works; no usage, quietly, when it does not. No store.db fallback.

## Boundaries & Constraints

**Always:**
- AD-2: the core names no CLI. The port and a tiny core helper are generic; URLs, the key, the token, polling, and matching live in `src/adapters/cursor/`.
- `readUsage` runs only for a turn that ended with `result` and has no usage from the session (an ACP `usage` still wins), after the closing tool records and before the result record. It never fails the turn: a throw, a timeout, or an abort means no usage. Agent turns and side questions alike.
- The adapter owns every timer (AD-11: the core adds none; it only stops waiting on `ctx.abortSignal`).
- Secrets (spine Logging/Secrets rows): the API key and access token stay in memory, never in a log, warning, error message, or file. A warning names only the endpoint path and HTTP status (or "network error"), never a response body.
- Counts: `input` = `inputTokens` (excludes cache, as host and `-p` mean it), `output`, `cacheRead`, `cacheWrite`; a missing count is 0; `total` = the sum of the four. All four zero → no usage.

**Never:** read Cursor's stored login or `CURSOR_AUTH_TOKEN` (login-only accounts get no usage; open question below); a store.db reader or any estimate; the `-p` secondary transport; decoding the model stream or an endpoint forwarder (spike: rejected); a config knob for usage; `teamId` support without evidence; a new dependency (proxy agent included); touching `CONTINUITY_NOTE`/`freshChat` logic (ticket 1.11).

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Happy path | Key set; ledger lists one event for the session ~1 s after the turn | Result record carries the four counts and `total` | No error expected |
| Ledger lag | Event appears on the 3rd poll | Same usage; result ~3 s after the turn | No error expected |
| Never appears | 200s, no event for the session within 6 s of the turn end | Result without usage | Quiet; counts toward the miss streak |
| Two turns, one session | Turn 2 polls while turn 1's event is still in the list | Turn 2 gets only its own event (window and last-consumed mark) | No error expected |
| Several events, one turn | Two events for the session in the window | Summed | No error expected |
| Other conversations | Newer events of other sessions, the IDE, other agents | Ignored | No error expected |
| Event without `tokenUsage` / missing counts | e.g. no `cacheWriteTokens` | Missing count 0; all zero → no usage | No error expected |
| No API key (login only) | `CURSOR_API_KEY` empty | Result at once, no usage, no network call | Quiet (documented) |
| Key rejected | Exchange 401/403 | No usage; ledger skipped for this key for 10 min | One warning on entering the cooldown |
| RPC changed | RPC 400/404/415, or JSON without a `usageEventsDisplay` array | No usage; 10 min cooldown | One warning |
| Token expired | Cached token past JWT `exp` − 5 min, or RPC 401 | Exchange again once, retry the call once | Second 401 → key-rejected row |
| Transient | 5xx, 429, network error, request timeout (3 s each) | No usage this turn | Quiet; counts toward the miss streak |
| Miss streak | 3 turns in a row end without usage for any reason but no key | 10 min cooldown | One warning ("usage unavailable", path + last status) |
| No network | DNS fails | Transient row, then miss streak | As above |
| Team account | Ledger may list nothing without `teamId` (untested) | Never-appears row → miss streak → cooldown | One warning; documented |
| Abort | `ctx.abortSignal` aborts while waiting | Wait ends at once; the turn's abort path runs as today | No extra error |
| Base URL override | `OPENCLAW_ALL_CLI_CURSOR_USAGE_URL` in the env handed to `readUsage` | Ledger calls go there (tests). In `CURSOR_CLEAR_ENV`, so the host strips it from every OpenClaw turn: a Gateway env cannot redirect the key | No error expected |
| Concurrent turns, one key | Two turns end together, no cached token | One exchange shared | No error expected |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `NormalizedUsage` (11) is already the host's `CliBackendJsonlUsage`. Add `UsageQuery {sessionId, startedAt, endedAt (epoch ms), env, signal?}`, `UsageReport {usage?, warning?}`, and optional `CliAdapter.readUsage?(query): Promise<UsageReport>` with a doc comment (called once per `result` turn without usage, bounds its own time, never throws by contract).
- `src/core/usage.ts` (new) -- `readTurnUsage(adapter, query, warn)`: returns `undefined` when there is no port or the signal is already aborted; races the port with the abort; catches throws; passes `warning` to `warn`. Keeps `execute.ts` small.
- `src/core/execute.ts` -- turn body (~564-584): `const startedAt = Date.now()` just before `active.session.prompt(...)`; in the `result` branch, after `tools.closeOpen()`, `if (!summary.usage) summary.usage = await readTurnUsage(adapter, {sessionId: active.session.sessionId, startedAt, endedAt: Date.now(), env: {...ctx.env, ...home.env}, signal: ctx.abortSignal}, warn)`. About 6 lines. Ticket 1.11 (`in-progress`) edits the lines just above (`note`/`freshChat`): build after 1.11 lands and rebase; change nothing else here.
- `src/core/events.ts` -- `toRecord` already copies `summary.usage` onto the result record and `parseJsonlEvent` hands it to the host. No change.
- `src/transports/acp/session.ts` -- `mapUsage` (263) maps an ACP `usage` if Cursor ever sends one. No change.
- `src/adapters/cursor/usage.ts` (new) -- `createCursorUsageReader(options?)` → `{ read(query) }`. Options (tests shrink them): `firstPollMs` 1000, `pollIntervalMs` 1000, `deadlineMs` 6000 (from `endedAt`), `requestTimeoutMs` 3000, `cooldownMs` 600000, `missStreak` 3, `pageSize` 50, `skewMs` 5000. State per reader, keyed by `sha256(key)`: token `{value, expiresAt}` plus the in-flight exchange promise, `cooldownUntil`, miss count; per session id the last consumed event timestamp (bounded Map, oldest dropped past 1000). Pure `matchTurnEvents(events, {sessionId, notBefore, after})` for the window rule. Global `fetch` only.
- `src/adapters/cursor/index.ts` -- module singleton reader; `readUsage: reader.read` on `cursorAdapter`; add `OPENCLAW_ALL_CLI_CURSOR_USAGE_URL` to `CURSOR_CLEAR_ENV` (38) with a comment.
- `src/adapters/cursor/manifest.ts` -- P16 note.
- `scripts/dev-openclaw.sh` -- `use_isolated_env` (25): `export NODE_USE_ENV_PROXY="${NODE_USE_ENV_PROXY:-1}"`. `package.json` `test:live`: prefix `NODE_USE_ENV_PROXY=1`.
- Host facts (read-only): the transcript is SQLite `<state>/agents/<agent>/agent/openclaw-agent.sqlite`, table `transcript_events(session_id, seq, event_json, created_at, event_zstd, ...)`; an assistant entry is `event_json.message` with `provider`, `usage{input,output,cacheRead,cacheWrite,totalTokens}`. The per-agent home's `acp-sessions/<id>` names the turn's ACP session id. Fake agent: `test/fixtures/fake-cursor-agent.mjs` (random session ids). Execute tests use a scripted stub adapter (`execute.test.ts` ~90 already yields `usage`).
- Probed on this host (2026-10-18): exchange gives `{accessToken, refreshToken}`; the token is a JWT with `exp`, TTL 3600 s. Response `{totalUsageEventsCount, usageEventsDisplay[]}`; `timestamp` is a ms string; `tokenUsage` may omit `cacheWriteTokens`; a bad token gets 401 `unauthenticated`. Node 24.22 `fetch` ignores `HTTPS_PROXY` (ENOTFOUND here) unless the process starts with `NODE_USE_ENV_PROXY=1`.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/ports.ts`, `src/core/usage.ts` -- port types and the helper -- generic seam (AD-2, AD-3).
- [x] `src/core/execute.ts` -- `startedAt` and the call in the `result` branch -- the only hot-path change; rebase on 1.11.
- [x] `src/adapters/cursor/usage.ts` -- exchange, token cache, polling, matching, cooldown and miss streak, quiet degrade -- the ledger client.
- [x] `src/adapters/cursor/index.ts`, `manifest.ts` -- wire `readUsage`, clear-env entry, P16 note.
- [x] `src/core/usage.test.ts`, `src/core/execute.test.ts` -- stub adapter: usage on the result record; port skipped when the session gave usage, on `error`, without the port; throw and `warning` (→ `warn`) handled; abort ends the wait; query holds the session id, `startedAt <= endedAt`, and the home env.
- [x] `src/adapters/cursor/usage.test.ts` -- local `node:http` ledger stub on 127.0.0.1 via the URL override: every matrix row (no key makes zero requests; request headers and body; warnings and thrown messages never contain the key or token; one exchange for concurrent reads), plus `matchTurnEvents` cases.
- [x] `src/adapters/cursor/index.test.ts` -- real `cursorAdapter` + fake agent + stub through `createExecute`: the stub serves an event for the session id the `sessionId` record names; `parseJsonlEvent` of the result line gives those counts; without a key the result has no usage and the stub saw no request; `clearEnv` includes the override.
- [x] `test/live/usage.live.test.ts` (gated, P16) -- real Cursor, `openclaw agent --local --model cursor-cli/auto --json`: (a) one turn: the new `acp-sessions/<id>` gives the session id; the newest `cursor-cli` assistant entry in `transcript_events` (read with `node:sqlite`, read-only) equals the ledger's event(s) for that id, fetched by the test's own code, field by field, with input + cacheRead > 0 and output > 0; (b) a second turn in the same OpenClaw session: its entry equals its own event and differs from turn 1's.
- [x] `scripts/dev-openclaw.sh`, `package.json` -- env proxy switch for the Gateway and live runs.
- [x] Docs -- `docs/providers/cursor.md`: new "Usage" section (source, needs `CURSOR_API_KEY`, the key goes only to `api2.cursor.sh`, which `cursor-agent` already uses; the turn closes about 1-2 s later, up to 6 s; failure table; team accounts untested; proxy), P16 row, Known limits (login only: no usage); `docs/setup.md`: key also enables usage, `NODE_USE_ENV_PROXY=1` behind an HTTP proxy, troubleshooting "usage shows 0" with the warning texts; parity matrix P16; architecture spine CAP-3 row and the usage open-question row (answered: ledger); MEMORY: probed facts above, the live result, `NODE_USE_ENV_PROXY`.

**Acceptance Criteria:**
- Given `CURSOR_API_KEY` and a live Cursor turn through OpenClaw, when the turn ends, then its assistant transcript entry carries input, output, cacheRead, and cacheWrite equal to Cursor's ledger numbers for that ACP session.
- Given two turns in one OpenClaw session, when both end, then each transcript entry carries only its own turn's numbers.
- Given no API key, or a ledger that fails in any matrix way, when a turn runs, then the reply reaches OpenClaw as before, without usage, and no log line holds the key or token.
- Given `src/core/`, when the import-boundary test runs, then it still passes (no CLI named, adapters import only ports and transports).

## Implementation Notes

- Built on top of 1.11 (already committed; baseline `92674710`). `execute.ts` change is `startedAt` before `prompt` plus one block in the `result` branch.
- Cursor reader: `redirect: "error"` on every request so the key cannot follow a redirect; 403 on the exchange is a rejected key, 403 elsewhere is transient (matrix lists only 400/404/415 as "RPC changed"). A fresh token is used for at least 500 ms even if its `exp` margin has passed, so a short-lived token is not re-exchanged on every poll; `tokenMarginMs` is a test option beyond the plan's list.
- Transient failure ends the turn's polling at once (matrix: "no usage this turn"); only "no event yet" keeps polling until 6 s after `endedAt`.
- `P16` set to `approx` (not `match`: needs the key, adds up to 6 s, undocumented RPC). Manifest, docs, parity matrix, spine CAP-3 and open-question row updated.
- Test helper `test/fixtures/ledger-stub.ts` (local `node:http` ledger) serves both unit test files.
- Live: `test/live/usage.live.test.ts` passes (2 tests, ~72 s) with real Cursor: the transcript entry equals the ledger's event field by field; the second turn of the same chat gets only its own event. The test needs `NODE_USE_ENV_PROXY=1` on this host.
- Whole live suite (background, `NODE_USE_ENV_PROXY=1`): 10 files, 33 tests passed, 1477 s. Unit run: 22 files passed, 514 tests passed, 33 live skipped.
- Gateway log checked: no API key, no `exchange_user_api_key`/ledger body text.


## Plan Change Log

## Review Triage Log

## Design Notes

- **Port, not event.** The adapter could yield `usage` from `prompt` itself, but then the generic ACP transport would need a Cursor hook and the core could not bound the wait by the abort. An optional port keeps the transport untouched; a CLI without it pays nothing.
- **Why wait before the result.** The host reads usage only from the closing `result` (events.ts), and the ledger shows the event about 1 s after `session/prompt` returns. The text has already streamed; only the turn's close moves. Cooldown and miss streak cap the cost for accounts where the ledger never answers.
- **Window.** Match `conversationId === sessionId` and `ts >= startedAt − 5 s` (clock skew; the event is stamped ~0.5 s after the start) and `ts > lastConsumed[sessionId]`. Turns of one session never overlap (host lanes), so no upper bound. Residual: if turn N's read failed and turn N+1 starts within 5 s of turn N's event, N+1 also counts it (documented).
- **No store.db fallback.** It estimates input only (±2%), the host's usage has no "estimated" flag, so it would look exact, and it needs an undocumented protobuf reader. Login-only accounts get no usage instead.
- **Review depth thorough:** an undocumented external RPC on every turn, the API key leaving the process, and token caching.

## Verification

**Commands:**
- `npm run typecheck && npm run build && npx vitest run` -- expected: all pass, live tests skipped.
- `npm run test:live -- usage` -- expected: pass with real `cursor-agent` and `CURSOR_API_KEY` (set on this host); the proxy needs `NODE_USE_ENV_PROXY=1`, which the script sets.
- `grep -rn "accessToken\|CURSOR_API_KEY" src/core` -- expected: nothing.

**Manual checks (if no CLI):**
- After a live turn, the Gateway log (`/tmp/openclaw/openclaw-<date>.log`) holds no API key, access token, or ledger response body.

## Auto Run Result

- Status: ready-for-dev (halted after planning, as asked).
- Route full (auto, about 250 product lines plus tests and docs); risk medium (raised from the ticket's low: undocumented external RPC on every turn, the API key leaves the process, hot-path change); review thorough (pinned).
- Build after ticket 1.11 lands; rebase `src/core/execute.ts`.
- Version control: the tree held 1.11's uncommitted work at step 1 and was clean after its checkpoint commit (`74c58f088d67bba30c053f560d905d3fcad46e12`); planning proceeded because only this plan file is written.
- Open question for the user: login-only Cursor accounts get no usage. Reading Cursor's stored login token for the ledger (exact, untested) would close that; it touches the CLI login, which earlier tickets kept out.

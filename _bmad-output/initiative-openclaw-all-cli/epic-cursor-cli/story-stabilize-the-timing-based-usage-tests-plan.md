---
title: 'Stabilize the timing-based usage tests'
type: 'bugfix'
ticket: 22
created: '2026-10-21'
status: 'ready-for-dev'
baseline_revision: '98e0c2da617f83f01b23ae533992d4e8cebdbae6'
route: 'full'
route_source: 'auto'
risk: 'low'
review: ''
review_source: ''
lenses_ran: []
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/MEMORY.md'
  - '{project-root}/AGENTS.md'
warnings: ['oversized']
deferred: []
---

<intent-contract>

## Intent

**Problem:** The usage reader tests (`src/adapters/cursor/usage.test.ts`, 60 tests) race real time: real `setTimeout` sleeps, wall-clock bounds (`< 400`-`500` ms), and deadlines of 20-150 ms that must cover real HTTP round trips to the local ledger stub. Under load they fail: on this host, with vitest and 8 busy loops pinned to one CPU, 3 of 3 baseline runs failed (2-5 tests each, mostly "reads the turn's event", "keeps polling while the event lags": a real request outlived the 120 ms deadline). `src/core/usage.test.ts` schedules an abort with a real timer.

**Approach:** Give `createCursorUsageReader` two injected seams, a clock (`now`, `sleep`, `timeout`) and a `fetch`, with today's behavior as the defaults. The reader tests run on a virtual clock and an in-memory ledger (same steering API as the HTTP stub), so time moves only when the test's clock moves it and no real I/O races a deadline. Every test keeps its name and assertion intent; wall-clock bounds become the same bounds on virtual elapsed time. Each guard behind a converted test is mutation-checked.

## Boundaries & Constraints

**Always:** Production behavior unchanged: defaults are `Date.now()`, the existing `sleep`, `AbortSignal.timeout`, and the global `fetch` looked up at call time; same statement order, constants, messages, and request shape. Every test name in the two files survives (only additions); each converted test asserts what it asserted before. `startLedgerStub()` keeps its API and HTTP behavior (`src/adapters/cursor/index.test.ts` uses it). One shared answer function serves both the HTTP stub and the in-memory ledger, so their answers cannot drift. Mutation checks run in a scratch copy of the tree; the real tree is restored and diffed clean.

**Never:** Change `src/core/usage.ts`, `ports.ts`, `index.ts`, the live test, `src/adapters/cursor/index.test.ts`, or any other `*.test.ts` file (the two fixtures in `test/fixtures/` are in scope); change plugin config, user docs, or runtime behavior; use `vi.useFakeTimers` (it does not fake `AbortSignal.timeout`, and it cannot order real sockets); widen a bound instead of removing the real-time dependency; add dependencies; commit scratch scripts; edit `AGENTS.md`.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Virtual sleep | `clock.sleep(ms)` while `clock.run(p)` drives | Resolves when virtual time reaches `now + ms`; real time irrelevant | Already-aborted or aborting signal: resolves at once, timer removed |
| Same-time timers | Several timers due at one virtual time | Fired as one batch in registration order, then the loop idles again | none |
| Request timeout | `clock.timeout(ms)` passed into the in-memory fetch, ledger answer delayed longer | Signal aborts at virtual `now + ms` with a `TimeoutError` `DOMException`; fetch rejects with the reason | Reader classifies it as transient, as today |
| Stuck promise | `clock.run(p)` with `p` pending, loop idle, no timer left | Throws `virtual clock: ... no timer left` at once (a mutation fails fast, not at the 15 s test timeout) | Also throws past a virtual limit (default 1 h) |
| In-memory ledger | Same fields as the HTTP stub (`events`, `token`, `exchangeStatus`, `eventStatuses`, `delayMs`, `eventDelays`, `validTokens`, `redirectTo`, `requests`, `count`) plus `down` | Same answers and request records as the HTTP stub; waits use `clock.sleep` | `down`: fetch throws `TypeError("fetch failed")`; 3xx with `redirect: "error"`: throws `TypeError` |
| Production defaults | `createCursorUsageReader()` | Real clock and real `fetch`; `index.test.ts` usage wiring passes unchanged | none |

</intent-contract>

## Code Map

- `src/adapters/cursor/usage.ts` -- the reader. Real-time uses to route through the seams: `sleep` (l.129, stays as the default clock's sleep), `post` (`AbortSignal.timeout(Math.min(requestTimeoutMs, budgetMs))` l.184, `fetch(url + path, ...)` l.187), `accessToken` (`Date.now()` l.214, 219, 222 into `tokenExpiry`), `fetchPage` (l.243 budget), `readWithKey` (l.286 cooldown, l.297-299 `coolDown`, l.307-310 loop and `sleep`). Factory reads options at l.143-151: add `clock` and `fetch` there. File is 345 lines (sweep limit 450, functions 80).
- `src/adapters/cursor/usage.test.ts` -- 60 tests; timing parts: `FAST` options, `event()`/`query()` defaults from `Date.now()`, real waits at l.89 (30), 145 (600), 203 (80), aborts by `setTimeout` at l.438, 486, wall-clock bounds at l.276, 285, 293, 301, 360, 488, `stub.delayMs` l.280, 297, 412, `eventDelays` l.272, dead-port stubs l.264, 472, real redirect l.419-431.
- `src/core/usage.test.ts` -- 6 tests; only l.78 `setTimeout(() => controller.abort(), 10)` is real-time.
- `test/fixtures/ledger-stub.ts` -- HTTP stub; its request handler (record, `delayMs`, exchange/redirect/status, `validTokens` 401, `eventDelays`, `eventStatuses`, `events`) becomes the shared answer function with the wait injected. Default `token` uses `Date.now()`: the in-memory ledger uses `clock.now()`.
- `src/adapters/cursor/index.test.ts` l.693-761 -- real-HTTP, real-clock wiring of the default reader through the core. Read-only; it must keep passing.
- Baseline (Node 24 `.spike/node/bin`, HEAD 98e0c2d): `npx tsc --noEmit` clean; `npx vitest run` 31 files passed / 15 skipped, 899 tests passed / 64 skipped; the two usage files 66 tests. Host has `cursor-agent` and `CURSOR_API_KEY`.

## Tasks & Acceptance

**Execution:**
- [ ] `src/adapters/cursor/usage.ts` -- export `UsageClock` (`now(): number`, `sleep(ms, signal?): Promise<void>`, `timeout(ms): AbortSignal`), `systemClock` (`Date.now()`, the existing `sleep`, `AbortSignal.timeout`), `UsageFetch` (`(url: string, init: RequestInit) => Promise<Response>`); options `clock?`, `fetch?` (default `(url, init) => fetch(url, init)`); replace each real-time and `fetch` use listed in Code Map, nothing else -- the seam the ticket asks for.
- [ ] `test/fixtures/virtual-clock.ts` (new) -- `createVirtualClock(start = Date.UTC(2026, 0, 1))` returning a `UsageClock` plus `advance(ms)` (fires due timers in order, sync) and `run(promise, {maxMs?})` (loop: `idle()`; settled → return it; else fire the earliest due batch; errors per I/O Matrix); export `idle()` = three `setImmediate` turns -- deterministic driver.
- [ ] `test/fixtures/ledger-stub.ts` -- extract the handler into one answer function `(stub, {path, headers, body}, wait)`; `startLedgerStub()` wraps it in the HTTP server with `setTimeout` waits (unchanged); add `createLedgerFake(clock)`: same stub object plus `down`, `url` = `http://ledger.invalid`, and an in-memory `fetch` (an already-aborted signal rejects before anything is recorded, as real fetch sends nothing; an abort during a wait rejects with the signal's reason; returns a minimal `{status, body: {cancel}, json}` object built from the answer text, throws per I/O Matrix) -- no real I/O in reader tests.
- [ ] `src/adapters/cursor/usage.test.ts` -- per test: a fresh clock and fake in `beforeEach`; every `read` through `clock.run`; `Date.now()` → `clock.now()`; real waits → `clock.advance(n)` with the same `n`; timer aborts → `void clock.sleep(n).then(() => controller.abort())`; wall-clock bounds → the same bound on `clock.now() - started`; delays become virtual; dead ports → `down`. Keep "does not follow a redirect with the key, and answers without usage" on real HTTP (two `startLedgerStub()` of its own, inside the same `describe`, so its listed name is unchanged) with the default clock, `startedAt`/`endedAt` from `systemClock.now()` (a virtual stamp would put the deadline in the past), generous `deadlineMs`/`requestTimeoutMs`, ended by a `fetch` wrapper that aborts the query signal once the exchange settles, asserting the wrapper saw a rejection, `target.requests` empty, no key in the report, and no time bound. Add two `systemClock` tests (new `describe("systemClock")`): `sleep(60_000, signal)` settles after an abort (raced against `idle()`), and with an already-aborted signal -- determinism; keeps the default sleep's abort guard covered.
- [ ] `src/core/usage.test.ts` -- abort right after the call and race `pending` against `idle()` (expect settled) instead of the 10 ms timer -- same intent, fails fast on mutation.
- [ ] Scratch (not committed) -- mutation runner and the load loop in Verification; record each result in Implementation Notes.
- [ ] `MEMORY.md` -- one entry: reader seams `clock`/`fetch`, `virtual-clock.ts`, `createLedgerFake`, the single-CPU load recipe and baseline flake count. `docs/`: no change (no setup, config, or behavior change); say so in Implementation Notes.

**Acceptance Criteria:**
- Given vitest and 8 busy-loop processes pinned to CPU 0 (`taskset -c 0`), when `npx vitest run src/adapters/cursor/usage.test.ts src/core/usage.test.ts` runs 50 times in a row, then all 50 pass.
- Given each guard mutation in Design Notes applied alone in a scratch copy of the tree, when its named test runs, then it fails without hitting the vitest timeout, and the real tree's `git diff` is empty afterwards except the planned changes.
- Given `npx vitest list` of the two files at baseline and after, when compared, then every baseline test name is present and only the two `systemClock` tests are new.
- Given the two test files, when searched for `Date.now`, `setTimeout`, and `performance.now`, then none occurs, and no test asserts on real elapsed time.
- Given the change, when `npx tsc --noEmit --noUnusedLocals --noUnusedParameters` and `npx vitest run` run, then typecheck is clean and the suite reports 901 passed / 64 skipped (baseline plus 2), `index.test.ts` usage wiring included.
- Given a host with `CURSOR_API_KEY`, when `npm run build && npm run dev:install` then the live usage file (`test/live/usage.live.test.ts`, command in Verification) run, then the live usage file passes (one re-run only for a transient Cursor `RetriableError`); without a key it is recorded as not run.

## Implementation Notes

## Plan Change Log

## Review Triage Log

## Design Notes

**Why also `fetch`.** The baseline failures are deadline tests whose real HTTP round trip outlived a 120 ms real-time budget, not only the wall-clock bounds. A virtual clock alone cannot fix them: a timer must never fire while real I/O is in flight, and nothing can detect real-I/O idleness deterministically. With an in-memory `fetch` all work is microtasks, so `idle()` (setImmediate turns) is a true quiescence point. Real `fetch` stays covered by the redirect test (platform `redirect: "error"`), `index.test.ts` wiring, and the live test.

**Golden conversion** (shape only):

```ts
it("gives up a slow request after the request timeout and polls again", async () => {
  serve(event());
  stub.eventDelays = [600];                     // virtual ms
  const reader = createCursorUsageReader({ ...FAST, requestTimeoutMs: 50, deadlineMs: 3000, clock, fetch: stub.fetch });
  const started = clock.now();
  expect((await clock.run(reader.read(query()))).usage).toEqual(FULL);
  expect(clock.now() - started).toBeLessThan(450); // was wall clock
});
```

**Mutations** (remove or invert in `usage.ts` unless named; expected failing test):
1. Budget cap `Math.min(requestTimeoutMs, budgetMs)` → `requestTimeoutMs`: "never holds the read much past the deadline, however slow the ledger is", "... through a slow exchange either".
2. No request timeout (query signal only): "gives up a slow request after the request timeout and polls again".
3. `if (deadline - now < wait) break`: "does not sleep a whole poll interval past the deadline".
4. `if (state.exchange) return state.exchange`: "caches the token ... concurrent turns", "warns once when concurrent turns share a rejected exchange".
5. Token cache ignores `expiresAt`: "exchanges again when the cached token is about to expire".
6. Cooldown never ends (`cooldownUntil > 0`): "leaves the cooldown after its time and tracks keys separately".
7. `after` ignores the consumed stamp: "gives a second turn of one session only its own event" / "does not count the event an earlier turn consumed".
8. (none: the after-sleep `if (signal?.aborted) return {}` is masked by the catch-side abort check and by fetch never sending on an aborted signal; it was uncovered at baseline too. Its test, "ends the wait at once when the signal aborts", guards the sleep's abort handling, which is mutation 12.)
9. `coolDown` warns every time (no `first`): "warns once when concurrent turns share a rejected exchange".
10. Event without counts falls through as a miss: "marks an event without counts consumed and answers at once, without a miss".
11. `redirect: "error"` removed: "does not follow a redirect with the key, and answers without usage".
12. Default `sleep` without its abort listener: the new `systemClock` test.
13. `src/core/usage.ts` without the abort race: "stops waiting when the signal aborts".
The after-sleep `now >= deadline` check guards a late timer, which the virtual clock never produces; it stays uncovered as before (no test claimed it).

**Risk** stays low (ticket): the production edit only threads defaults through; a slip shows in `index.test.ts` wiring and the live usage test.

## Verification

**Commands:**
- `PATH=$PWD/.spike/node/bin:$PATH npx tsc --noEmit --noUnusedLocals --noUnusedParameters` -- expected: no output
- `npx vitest run` -- expected: 901 passed, 64 skipped
- Load loop: start 8 `taskset -c 0 node -e 'for(;;);'`, then 50× `taskset -c 0 npx vitest run src/adapters/cursor/usage.test.ts src/core/usage.test.ts`, stop the loops by pid (never `pkill -f`) -- expected: 50 of 50 pass
- `git diff 98e0c2da617f83f01b23ae533992d4e8cebdbae6 --stat` -- expected: only `usage.ts`, the two usage test files, the two fixtures, `MEMORY.md`, this plan
- `npm run build && npm run dev:install && NODE_USE_ENV_PROXY=1 OPENCLAW_ALL_CLI_LIVE=1 npx vitest run test/live/usage.live.test.ts` -- expected: live usage file passes

## Auto Run Result

Planning result: ready-for-dev, route full (auto), risk low (ticket's level kept), halted after planning as invoked. Baseline `98e0c2da617f83f01b23ae533992d4e8cebdbae6`: typecheck clean, 899 passed / 64 skipped. Flake reproduced at baseline: 3 of 3 runs of the two usage files failed under single-CPU load (8 parallel unloaded runs and 5 runs with unpinned busy loops all passed). No product code was written.

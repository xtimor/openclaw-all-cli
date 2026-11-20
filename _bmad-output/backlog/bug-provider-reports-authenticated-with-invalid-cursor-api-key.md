---
id: 29
type: bug
title: "Provider reports authenticated with an invalid CURSOR_API_KEY"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P1
---

# Provider reports authenticated with an invalid CURSOR_API_KEY

## Description

The Cursor provider's ongoing auth probe reports the provider as ready (`available`) whenever
`CURSOR_API_KEY` is merely non-empty, or whenever `cursor-agent status` exits 0 with a degraded line
that admits it could not confirm the login. Neither is proof of a working credential. A wrong,
expired, revoked, or rotated key keeps the provider advertising itself as authenticated while every
real run fails, so the provider is selected for runs and as a fallback and the failure surfaces far
from its real cause (a model/fallback error, not "no valid Cursor key").

## Reproduction

1. Set `CURSOR_API_KEY` to a value Cursor will refuse, with no stored `cursor-agent` login in the
   agent home.
2. Probe the provider's auth status.
3. Actual: `available`.
4. Separately, feed the probe the real degraded status line cursor-agent 2026.11.11 produces when it
   cannot confirm who is signed in: `Login successful!\nLogged in (unable to fetch user details)`
   (exit 0).
5. Actual: also `available`.
6. Expected in both cases: not `available` (for example `unreadable`), since the credential does not
   actually work.

## Cause Hypothesis

`probeAuth` (`src/adapters/cursor/index.ts`) returns `available` the instant `CURSOR_API_KEY` is
non-empty, without ever calling `checkKey` (the existing `cursor-agent about` validation helper),
which today is wired only into the interactive key-entry flow in `src/core/provider-auth.ts`.
Separately, `parseStatusOutput` matches `/\b(logged\s+in|authenticated|signed\s+in)\b/` anywhere in
the CLI's `status` output, so it also matches the degraded "Logged in (unable to fetch user details)"
wording as a healthy login.

## Acceptance Criteria

1. **A present but unvalidated env key does not probe as authenticated**
   **Given** `CURSOR_API_KEY` set to a value the CLI itself refuses
   **When** the auth probe runs
   **Then** it does not return `available`
2. **A degraded status line is not read as a working login**
   **Given** `cursor-agent status` output containing "Logged in (unable to fetch user details)" or
   comparable degraded wording
   **When** `parseStatusOutput` parses it
   **Then** it does not return `available`
3. **A genuinely working key still probes as authenticated**
   **Given** a `CURSOR_API_KEY` or stored login that `checkKey`/`status` confirms works
   **When** the auth probe runs
   **Then** it returns `available`, with no unnecessary added latency on the common case (cache the
   validation with a TTL rather than call it on every probe)
4. **A run rejected for credentials invalidates the cached probe**
   **Given** a run fails because the server rejects the credential
   **When** the next probe runs
   **Then** it re-validates instead of serving a stale `available` from cache
5. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers an invalid env key and the
   2026.11.11 degraded `status` wording, and the two existing tests in
   `src/adapters/cursor/index.test.ts` that currently pin the old behavior are updated to match the
   corrected behavior

## Boundaries

- Must not change: the interactive key-entry flow's own use of `checkKey` in
  `src/core/provider-auth.ts`, or the shape of `AuthStatus` beyond what the fix needs.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected
  `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/98
- related — https://github.com/xtimor/openclaw-all-cli/issues/39 (closed, ticket backlog 14; the
  inverse symptom, a working login shown as "Not configured")
- code — src/adapters/cursor/index.ts (`probeAuth`, `parseStatusOutput`, `checkKey`),
  src/core/provider-auth.ts

## Notes

- Issue: #98
- Triage reproduced it on `main` `6720296e2a5196d59c9ee6c120c2cf2feeb305cd`. The build must update the
  two existing tests in `src/adapters/cursor/index.test.ts` (around line 31 and lines 52-56) that
  currently assert `available` for the degraded status line and for a bare env key — they pin the old,
  incorrect behavior. Reproduction test, to be merged into `src/adapters/cursor/index.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { cursorAdapter, parseStatusOutput } from "../src/adapters/cursor/index.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

describe("issue #98: an unvalidated or degraded credential must not probe as authenticated", () => {
  it("does not report a non-empty CURSOR_API_KEY as available once the CLI itself refuses it", async () => {
    const env = fakeEnv({ CURSOR_API_KEY: "a-key-cursor-will-refuse", FAKE_CURSOR_ABOUT: "invalid" });
    const status = await cursorAdapter.probeAuth({ command: FAKE_CURSOR_AGENT, env });
    expect(status).not.toBe("available");
  });

  it("does not read the CLI's own degraded status line as a working login", () => {
    const status = parseStatusOutput("Login successful!\nLogged in (unable to fetch user details)");
    expect(status).not.toBe("available");
  });
});
```

  Failing output (`npx vitest run test/triage-scratch-98.test.ts`):
  ```
  ❯ issue #98 ... does not report a non-empty CURSOR_API_KEY as available once the CLI itself refuses it
  AssertionError: expected 'available' not to be 'available'
  ❯ issue #98 ... does not read the CLI's own degraded status line as a working login
  AssertionError: expected 'available' not to be 'available'
  ```
- Verify: `npx vitest run src/adapters/cursor/index.test.ts -t "does not report a non-empty CURSOR_API_KEY as available once the CLI itself refuses it"` and `-t "does not read the CLI's own degraded status line as a working login"` pass, then `npm test`.

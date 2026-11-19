---
id: 30
type: bug
title: "A transient Cursor throttle is reported as a spent plan quota"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P1
---

# A transient Cursor throttle is reported as a spent plan quota

## Description

Cursor sends the Connect code `resource_exhausted`, wrapped in a `RetriableError`, for short-lived
backend throttling that is unrelated to the account's subscription. The plugin labels it exactly like
a genuine exhausted-plan rejection ("rate limit reached (usage limit)"), so a transient throttle is
reported to the user as a spent subscription, even when the account's usage is nowhere near its
limit.

## Reproduction

1. Classify a Cursor reply error whose text is `RetriableError: [resource_exhausted] Error` (a
   transient backend throttle, as opposed to Cursor's `ActionRequiredError` + "upgrade your plan to
   continue" for a genuinely spent plan).
2. Actual: the classified failure's message reads "Cursor rate limit reached (usage limit): ...".
3. Expected: the message does not claim the account's usage limit is reached; it should read as a
   throttle/overload, not a spent plan.

## Cause Hypothesis

`src/adapters/cursor/errors.ts` maps both the Connect code `resource_exhausted` (`CONNECT_CODES`) and
the action phrase `"upgrade your plan to continue"` (`ACTION_PHRASES`) to the same `RATE_LIMIT`
constant, whose label is "rate limit reached (usage limit)". The two are different Cursor error
classes (`RetriableError` vs `ActionRequiredError`) and mean different things; only the second is a
genuine usage-limit condition.

## Acceptance Criteria

1. **A transient throttle is not reported as a spent usage limit**
   **Given** a classified Cursor reply error for the Connect code `resource_exhausted`
   **When** its message is read
   **Then** it does not claim the usage limit is reached, while still naming it a rate-limit condition
   (keeping the word "rate limit" the host's failover classification depends on) and still being
   retryable when no tool call has started in the turn (unchanged `tools.started` behavior, AD-11)
2. **A genuine plan exhaustion is unchanged**
   **Given** a classified Cursor reply error for the action phrase "upgrade your plan to continue"
   **When** its message is read
   **Then** it still reads as a usage limit, exactly as before this fix
3. **Host failover classification is unaffected**
   **Given** either classified error
   **When** the host reads its failure code
   **Then** `code` is still `rate_limit` for both, so the host's keyword-based failover path is
   unchanged
4. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers `resource_exhausted`, and a
   test confirms the "upgrade your plan to continue" case is unchanged

## Boundaries

- Must not change: `code: "rate_limit"` for either case, the host's text-based failover matching, or
  the `tools.started`-gated retry-clearing in `src/transports/acp/session.ts` (AD-11; explicitly out
  of scope per the owner-approved triage verdict — the report's claim that this is itself a defect was
  not accepted).
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected
  `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/99
- related — https://github.com/xtimor/openclaw-all-cli/issues/82 (closed, done; the unrelated plan-quota display feature)
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-11
- code — src/adapters/cursor/errors.ts, src/transports/acp/session.ts

## Notes

- Issue: #99
- Scoped narrower than the report by the owner-approved triage verdict: only the label/message split
  for `resource_exhausted` vs. the genuine plan-exhaustion action phrase. The report's second claim —
  that `retryable` is wrongly cleared once a tool call started — is not built: it is existing,
  intended AD-11 behavior, pinned by an existing test (`src/transports/acp/session.test.ts`, around
  line 984).
- Triage reproduced it on `main` `6720296e2a5196d59c9ee6c120c2cf2feeb305cd`. Reproduction test, to be
  merged into `src/adapters/cursor/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { classifyCursorReplyError } from "../src/adapters/cursor/errors.ts";

describe("triage scratch #99: resource_exhausted throttle vs. genuine plan exhaustion", () => {
  it("does not tell the caller a transient resource_exhausted throttle is a spent usage limit", () => {
    const throttle = classifyCursorReplyError(
      "\n\nError: RetriableError: [resource_exhausted] backend is busy, try again shortly",
    );
    expect(throttle?.code).toBe("rate_limit");
    expect(throttle?.message).not.toMatch(/usage limit/i);
  });

  it("still reports a genuine plan-exhaustion action phrase as a usage limit (unchanged)", () => {
    const planSpent = classifyCursorReplyError("Upgrade your plan to continue");
    expect(planSpent?.code).toBe("rate_limit");
    expect(planSpent?.message).toMatch(/usage limit/i);
  });

  it("marks the throttle as retryable before any tool call ran (this part is correct already)", () => {
    const throttle = classifyCursorReplyError(
      "\n\nError: RetriableError: [resource_exhausted] backend is busy, try again shortly",
    );
    expect(throttle?.retryable).toBe(true);
  });
});
```

  Failing output (`npx vitest run test/triage-scratch-99.test.ts`):
  ```
  ❯ does not tell the caller a transient resource_exhausted throttle is a spent usage limit
  AssertionError: expected 'Cursor rate limit reached (usage limi…' not to match /usage limit/i
  Received: "Cursor rate limit reached (usage limit): Error: RetriableError: [resource_exhausted] backend is busy, try again shortly"
  Tests  1 failed | 2 passed (3)
  ```
- Verify: `npx vitest run src/adapters/cursor/errors.test.ts -t "does not tell the caller a transient resource_exhausted throttle is a spent usage limit"` passes, then `npm test`.

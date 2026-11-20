---
id: 28
type: bug
title: "Context usage tile moves down between turns because a turn's summed usage is read as context size"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# Context usage tile moves down between turns because a turn's summed usage is read as context size

## Description

The host's context-usage tile is meant to track how much of the session's context window is used. It
moves down after a turn that made fewer model requests than the previous one, even though the
conversation only grew. This is a regression / incomplete fix of issue #40 (closed, ticket backlog
15, PR #41): that fix only guarded the case where the reported figure exceeds the session's context
ceiling; below the ceiling the same wrong number still reaches the tile.

## Reproduction

1. Start a `cursor-cli` session with a 256 000-token context ceiling.
2. Run a turn with several tool-call round trips. Each round trip resends the cached prompt, so the
   CLI's own `total` usage figure for that turn is a sum across its requests: `{ input: 2 000, output:
   1 500, cacheRead: 98 000, cacheWrite: 1 000, total: 101 000 }`.
3. Run a plain one-request follow-up turn. The conversation is now strictly larger (everything from
   step 2 is still in it, plus the reply), but the turn's own request count is 1, so its own `total` is
   smaller: `{ input: 2 200, output: 300, cacheRead: 71 000, cacheWrite: 500, total: 73 700 }`.
4. Actual: the context-usage figure derived from `total` falls from the first turn's 101 000 to the
   second turn's 73 700. Expected: it never falls while the conversation only grows (apart from
   compaction).

## Cause Hypothesis

`boundTurnUsage` (`src/core/usage.ts`) only intervenes when the reading exceeds the ceiling; below it,
`total` — a sum over every model request in the turn — passes straight through with nothing marking
it as a per-turn aggregate rather than a context size. `mapUsage` (`src/transports/acp/session.ts`)
relays `usage.totalTokens` verbatim once per turn, with no accumulation across turns. A consumer that
reads `total` as "context used so far" therefore tracks the last turn's request count, not the
context.

## Acceptance Criteria

1. **The reported context reading never falls while the conversation only grows**
   **Given** a session with a tool-heavy turn followed by a plain one-request turn, both below the
   context ceiling
   **When** `boundTurnUsage` processes each turn's usage
   **Then** the value a consumer reads as context size does not decrease between the two turns —
   either `total` is omitted for ACP turns, or it carries a flag (for example `contextUnknown`) that
   marks it as a per-turn aggregate rather than a context reading
2. **The existing above-ceiling guard is not weakened**
   **Given** a turn whose reading exceeds the session's context ceiling
   **When** `boundTurnUsage` processes it
   **Then** it still drops `total` and marks `contextUnknown`, exactly as before this fix
3. **Tests cover the condition found and fixed**
   **Given** the test suite
   **When** it runs
   **Then** a test that fails on the defect and passes on the fix covers a tool-heavy turn followed by
   a plain turn within the ceiling, and the existing above-ceiling tests still pass

## Boundaries

- Must not change: the above-ceiling behavior of `boundTurnUsage` (issue #40's fix), the `input`,
  `output`, `cacheRead`, and `cacheWrite` fields, or anything outside how `total`/context-unknown is
  reported.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected
  `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/97
- related — https://github.com/xtimor/openclaw-all-cli/issues/40 (closed, ticket backlog 15, PR #41)
- code — src/core/usage.ts (`boundTurnUsage`), src/transports/acp/session.ts (`mapUsage`)

## Notes

- Issue: #97
- Decision: the triage comment named `test/usage.test.ts` as the merge target, but the repository's
  actual unit test for `boundTurnUsage` is `src/core/usage.test.ts` (no `test/usage.test.ts` exists);
  the regression test below merges there instead.
- Triage reproduced it on `main` `6720296e2a5196d59c9ee6c120c2cf2feeb305cd`. Reproduction test, to be
  merged into `src/core/usage.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { boundTurnUsage } from "../src/core/usage.ts";

describe("triage #97: a turn's per-request usage sum is not a monotonic context reading", () => {
  const CEILING = 256_000;

  it("boundTurnUsage lets the reported total fall between turns within the ceiling, with nothing marking it as a per-turn sum", () => {
    const toolHeavyTurn = { input: 2_000, output: 1_500, cacheRead: 98_000, cacheWrite: 1_000, total: 101_000 };
    const plainFollowUpTurn = { input: 2_200, output: 300, cacheRead: 71_000, cacheWrite: 500, total: 73_700 };

    const boundedTurn1 = boundTurnUsage(toolHeavyTurn, CEILING);
    const boundedTurn2 = boundTurnUsage(plainFollowUpTurn, CEILING);

    expect(boundedTurn1.contextUnknown).toBeUndefined();
    expect(boundedTurn2.contextUnknown).toBeUndefined();
    expect(boundedTurn1.total).toBe(101_000);
    expect(boundedTurn2.total).toBe(73_700);

    expect(boundedTurn2.total).toBeGreaterThanOrEqual(boundedTurn1.total ?? 0);
  });
});
```

  Failing output (`npx vitest run test/triage-scratch-97.test.ts`):
  ```
  AssertionError: expected 73700 to be greater than or equal to 101000
  ```
- Verify: `npx vitest run src/core/usage.test.ts -t "boundTurnUsage lets the reported total fall between turns within the ceiling, with nothing marking it as a per-turn sum"` passes, then `npm test`.

---
id: 25
type: bug
title: "Update instructions say a running Gateway is refreshed by plugins update, which current OpenClaw refuses"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# Update instructions say a running Gateway is refreshed by plugins update, which current OpenClaw refuses

## Description

`README.md` (Update) and `docs/setup.md` (Install from npm) say a running local Gateway is refreshed by `openclaw plugins update`. Current OpenClaw refuses `plugins update` while the Gateway runs, so a user who follows the text fails. After the fix both docs give two paths: with the Gateway running, reinstall with `--force`; or stop the Gateway through its service owner, update, and start it again. They also say OpenClaw 2026.10.3 still accepts `plugins update` with the Gateway running.

## Reproduction

1. On `main`, read the Update section of `README.md` and the Install from npm section of `docs/setup.md`.
2. Actual: both say a running local Gateway is refreshed by the update.
3. Expected: both give the two paths above and no such claim.

The test in Notes fails on `main` for the three reasons above. OpenClaw 2026.11.2's own docs (`docs/cli/plugins.md`) say to stop the Gateway through its service owner before `plugins update`.

## Cause Hypothesis

The text was right for OpenClaw 2026.10.3, the version this repo pins, and was not revisited when OpenClaw changed the rule.

## Acceptance Criteria

1. **The Update docs match current OpenClaw**
   **Given** `README.md` (Update) and `docs/setup.md` (Install from npm)
   **When** they are read
   **Then** neither says a running Gateway is refreshed by `plugins update`; both give `openclaw plugins install openclaw-all-cli --accept-capabilities --force` for a running Gateway, and stop (`openclaw gateway stop`, or the Gateway container for Docker Compose), `openclaw plugins update openclaw-all-cli`, start again for the other path; both say 2026.10.3 still accepts `plugins update` with the Gateway running
2. **Changelog**
   **Given** `CHANGELOG.md`
   **When** it is read
   **Then** `## Unreleased` has one plain-words line for this fix with the issue link
3. **Tests**
   **Given** the test suite
   **When** `npm run ci` runs
   **Then** the reproduction test (committed in a docs test file named in Verify) passes

## Boundaries

- Must not change: install, update, or runtime behavior; only docs and the changelog.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/80
- doc — README.md, docs/setup.md

## Notes

- Issue: #80
- Verify: `npx vitest run test/docs-update-instructions.test.ts -t "Gateway"` passes, then `npm test`.
- Triage reproduced it on `main` `ca153573561b0c3b438a1a23f2949a8f5c0b6fe7`. Reproduction test, to be added first as `test/docs-update-instructions.test.ts` (merge into an existing docs test file when one fits):

```ts
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

for (const file of ["README.md", "docs/setup.md"]) {
  it(`${file} does not say a running Gateway is refreshed by plugins update`, () => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/running local Gateway is refreshed by the update/i);
  });
}

it("README Update section gives a path that works with the Gateway running or stopped", () => {
  const text = readFileSync("README.md", "utf8");
  const update = text.slice(text.indexOf("## Update"), text.indexOf("## Status"));
  expect(update).toMatch(/gateway stop|stop the gateway/i);
  expect(update).toMatch(/install openclaw-all-cli --accept-capabilities --force/);
});
```
- Assumption: priority p2 (the `--force` install is a workaround).

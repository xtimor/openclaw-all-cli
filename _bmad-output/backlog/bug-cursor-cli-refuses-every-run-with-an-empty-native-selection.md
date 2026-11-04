---
id: 20
type: bug
title: "cursor-cli refuses every run with an empty native selection although Cursor can close its native read, grep, and glob"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: medium
severity: P2
---

# cursor-cli refuses every run with an empty native selection although Cursor can close its native read, grep, and glob

## Description

A run whose native tool selection is empty (`tools.fs.workspaceOnly: true` produces it) is refused before any process starts. After this, the adapter has two static permission profiles, `default` (native `read`, `grep`, `glob` open) and `restricted` (all three closed by one `Read(*)` deny), the core picks the profile that matches the run's native selection, and such a run is served with OpenClaw's own file tools reachable through the MCP proxy.

## Reproduction

1. A `cursor-cli` agent whose run selects no native tools (`tools.fs.workspaceOnly: true`).
2. Start a turn.
3. Actual: the preflight throws `cursor-cli keeps native read, grep, glob on in every turn and cannot switch them off for this run. Select those native tools or run this turn on another model. OpenClaw did not start the run.` Expected: the turn is served.

Test, committed with the fix (file named in criterion 1); written by the triage agent on `main` 78b963d9b4b15b327b4bf381212ff6a5d0a760cf, fails there with the message above:

```ts
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";

describe("empty native selection", () => {
  it("serves a run whose native selection is empty instead of refusing it", async () => {
    const backend = buildCliBackend(cursorAdapter, { settings: {} });
    const agentDir = mkdtempSync(join(tmpdir(), "oac-"));
    const prepared = await backend.prepareExecution!({
      agentDir,
      toolAvailability: { native: [], openClaw: [] },
    } as never);
    expect(prepared).toBeTruthy();
  });
});
```

## Cause Hypothesis

AD-9 and `alwaysOnNativeTools` treat native `read`, `grep`, and `glob` as impossible to switch off, so any selection without them is refused. Live checks on `cursor-agent` 2026.10.22 show one `Read(*)` deny closes the three together.

## Acceptance Criteria

1. **The empty selection is served**
   **Given** a `cursor-cli` run whose native selection is empty
   **When** `prepareExecution` runs
   **Then** it resolves, the agent's `cli-config.json` for the run denies `Read(*)`, and the test above (in `test/backend.test.ts`, run with `npx vitest run test/backend.test.ts -t "serves a run whose native selection is empty instead of refusing it"`) passes
2. **The profile matches the selection**
   **Given** a run that selects all three native tools, and a run that selects none
   **When** each is prepared
   **Then** the first gets the `default` profile and the second the `restricted` one, and neither offers a native tool the host left out nor withholds one it selected
3. **A partial selection stays refused**
   **Given** a run that selects only part of the three
   **When** it is prepared
   **Then** it is refused with the existing message shape, naming the tools that stayed on
4. **A warm process never crosses profiles**
   **Given** a warm process of one profile
   **When** a turn of the other profile for the same agent starts
   **Then** a new process starts (the profile id is part of the reuse key), and a turn of the same profile reuses the warm one
5. **A chat resumes under either profile**
   **Given** a chat created under one profile
   **When** the next turn runs under the other
   **Then** the chat resumes, because a profile with its own config directory uses the default profile's chat store
6. **The permission files are valid and static**
   **Given** each profile
   **When** its `cli-config.json` is written
   **Then** it is complete (`{version, permissions}`), written atomically, and holds only static permissions, so parallel turns stay safe
7. **Docs and records match**
   **Given** the change
   **When** the docs and records are read
   **Then** AD-9 (already edited), parity rows P10 and P18, `docs/providers/cursor.md` (the workspace-only section, Known limits, Permissions and tool availability) and `docs/setup.md` describe the profiles, `CHANGELOG.md` has one line with the link to issue #67, and `npm run ci` passes
8. **Live check**
   **Given** a host with a Cursor login
   **When** a live turn with an empty native selection runs
   **Then** native `read`, `grep`, and `glob` are closed and an OpenClaw file tool works through the proxy; without a login this check is recorded as not run

## Boundaries

- Must not change: the `default` profile's behavior, the shell, write, edit, and delete denies, the MCP proxy path, session resume, and the refusal for a partial selection.
- No per-turn policy file; permissions stay static.

## References

- parent — none
- change — _bmad-output/initiative-openclaw-all-cli/change-permission-profiles-for-cursor-native-tools/change-permission-profiles-for-cursor-native-tools.md
- architecture — _bmad-output/initiative-openclaw-all-cli/architecture-openclaw-all-cli/architecture-openclaw-all-cli.md, AD-9
- docs — docs/providers/cursor.md

## Notes

- Issue: #67
- Decision: approved by the owner's approval of the issue; the batch pull request merges on green checks.
- Check outside the criteria: the live check of criterion 8 on a host with a Cursor login (the numbers in the issue come from `cursor-agent` 2026.10.22 and were not re-measured when this ticket was written).
- Decision: depends on the proposal merging first (AD-9 already edited).
- Decision: the owner's session comment of 2026-11-04 (13:58 UTC) on issue #67 asks for more live measurements (isolated config dir, host allow/deny control, `CURSOR_CONFIG_DIR` vs binary, `--force`, `--sandbox`, `--add-dir`, a cap for profile-keyed processes). It came after the approval and is not a click, so it is outside this approved scope; the build does not take it. It stays open for the owner to confirm, and the live check of criterion 8 stays not run without a Cursor login.

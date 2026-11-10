---
title: 'cursor-cli refuses every run with an empty native selection although Cursor can close its native read, grep, and glob'
type: 'bugfix'
ticket: 20
created: '2026-11-04'
status: done
baseline_revision: 'faf92b6f381e0f160d93384b769b593948a434fa'
route: 'full'
route_source: 'auto'
risk: 'medium'
review: 'quick'
review_source: 'pinned'
lenses_ran: [quick]
review_loop_iteration: 0
followup_review_recommended: false
context:
  - '{project-root}/AGENTS.md'
  - '{project-root}/_bmad-output/backlog/bug-cursor-cli-refuses-every-run-with-an-empty-native-selection.md'
  - '{project-root}/_bmad-output/initiative-openclaw-all-cli/change-permission-profiles-for-cursor-native-tools/change-permission-profiles-for-cursor-native-tools.md'
warnings: []
deferred:
  - summary: >-
      linkChatStore ignores EEXIST when acp-sessions in the restricted config dir is a real directory, so chats would not be shared.
    evidence: |-
      Nothing creates that directory today; Cursor writes sessions only where the link points. Needs a check that the entry is the expected symlink.
    location: >-
      src/adapters/cursor/index.ts linkChatStore
    severity: low
  - summary: >-
      symlink(..., "dir") may fail on Windows without privileges, failing empty-selection runs there.
    evidence: |-
      Windows is not a supported host of the plugin today (docs/setup.md); unverified.
    location: >-
      src/adapters/cursor/index.ts linkChatStore
    severity: low (unverified)
  - summary: >-
      An agent switching profiles may hold two live cursor-agent processes until idle reaping.
    evidence: |-
      By design (profile in reuse key, criterion 4); the owner's comment on #67 also asks for a cap rule. pool.ts not read. Needs an owner decision on a cap.
    location: >-
      src/core/execute.ts reuseKey
    severity: medium (unverified)
---

<intent-contract>

## Intent

**Problem:** A cursor-cli run whose native tool selection is empty (`tools.fs.workspaceOnly: true`) is refused in `prepareExecution`, because the adapter says native `read`, `grep`, `glob` cannot be switched off.

**Approach:** The adapter gets a second static permission profile, `restricted` (one `Read(*)` deny closes the three), next to `default`. The core picks the profile from the run's native selection, keeps the profile id in the process reuse key, and the restricted profile's own config dir shares the default profile's chat store.

## Boundaries & Constraints

**Always:** The `default` profile behaves exactly as today. Permissions stay static (no per-turn file); each `cli-config.json` is rewritten only when its permissions differ, atomically, keeping Cursor's other keys. A partial selection stays refused with the existing message shape naming the tools that stayed on. The shell, write, edit, delete denies, the MCP allow, the MCP proxy path, and session resume do not change. Adapters that declare no restricted profile still refuse an empty selection.

**Never:** No per-turn policy file. Do not write to a real `~/.cursor`. No change to files under `_bmad-output/` other than this plan and the parity matrix named below. No live Cursor run (no login on the host): criterion 8 is recorded as not run.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| Full selection | native has read, grep, glob | `default` profile, home env as today | none |
| Empty selection | native `[]` | `prepareExecution` resolves; `restricted` profile; its `cli-config.json` denies `Read(*)` | none |
| Partial selection | native `["read"]` | refused, message names `grep, glob` | `Error` before any process |
| No availability | `toolAvailability` absent | `default` | none |
| Adapter without restricted profile | native `[]` | refused as before | `Error` naming all always-on tools |
| Profile switch | warm process of `default`, next turn `restricted` (same agent) | a new process (profile in reuse key); same profile reuses | none |
| Chat across profiles | chat created under `default`, next turn `restricted` (and back) | resumes: restricted config dir's `acp-sessions` is the default's | none |

</intent-contract>

## Code Map

- `src/core/ports.ts` -- `CliAdapter.alwaysOnNativeTools` (keep); add optional `restrictedProfileId?: string`; `prepareHome(home, profile?)`.
- `src/core/permissions.ts` -- `unenforceableNativeTools`; add `selectNativeProfile(availability, alwaysOn, restrictedId?)` returning `{ profile?: string; blocked: string[] }`.
- `src/core/backend.ts` -- `resolveExecutionArgsFor` and `prepareExecutionFor` use the pick; the refusal message stays.
- `src/core/home.ts` -- `AgentHome` gains optional `profile`; `prepareAgentHome(..., profile?)` passes it to the adapter; `dir` stays the default home dir (chat registry, pid locks, delivered prompts).
- `src/core/execute.ts:89` -- `reuseKey` adds `home.profile ?? null`.
- `src/adapters/cursor/index.ts` -- `CURSOR_PERMISSIONS`, `prepareHome`, adapter object; add `CURSOR_RESTRICTED_PERMISSIONS`, restricted config dir `<home>/profiles/restricted`, symlink `acp-sessions` -> `<home>/acp-sessions`; `CURSOR_DATA_DIR` stays `<home>/data`. `discardSession` works through the link.
- `src/adapters/cursor/permissions.ts` -- comment on `CURSOR_ALWAYS_ON_NATIVE_TOOLS`.
- `src/adapters/cursor/manifest.ts`, `_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md` -- rows P10, P18 (and P8's "capped run is refused" gap) updated; keep both in step (AD-10).
- Tests: `test/backend.test.ts` (the reproduction test below; tests that assert the old empty-selection refusal change), `src/core/*.test.ts`, `src/adapters/cursor/index.test.ts`.
- Docs: `docs/providers/cursor.md` (workspace-only section, Known limits, Permissions and tool availability), `docs/setup.md`, `CHANGELOG.md` (one line under Unreleased with issue #67 link).

## Tasks & Acceptance

**Execution:**
- [ ] `src/core/ports.ts`, `src/core/permissions.ts`, `src/core/backend.ts`, `src/core/home.ts`, `src/core/execute.ts` -- profile pick, home profile, reuse key -- criteria 1-4
- [ ] `src/adapters/cursor/index.ts` (+ permissions.ts comment) -- restricted profile, own config dir, shared chat store, atomic static files -- criteria 5-6
- [ ] `test/backend.test.ts` -- add the test below under the name "serves a run whose native selection is empty instead of refusing it"; add tests for the matrix rows in core and adapter test files
- [ ] manifest, parity matrix, docs, CHANGELOG -- criterion 7

Reproduction test (goes into `test/backend.test.ts` as a `describe("empty native selection")` block, imports adjusted to the file):

```ts
it("serves a run whose native selection is empty instead of refusing it", async () => {
  const backend = buildCliBackend(cursorAdapter, { settings: {} });
  const agentDir = mkdtempSync(join(tmpdir(), "oac-"));
  const prepared = await backend.prepareExecution!({
    agentDir,
    toolAvailability: { native: [], openClaw: [] },
  } as never);
  expect(prepared).toBeTruthy();
});
```

**Acceptance Criteria:**
- Given an empty native selection, when `prepareExecution` runs, then it resolves, the run's `cli-config.json` denies `Read(*)`, and the test above passes.
- Given a full and an empty selection, then `default` and `restricted` are chosen; a partial selection is refused naming the tools that stayed on.
- Given a warm process of one profile, a turn of the other profile for the same agent starts a new process; same profile reuses.
- Given a chat under one profile, the next turn under the other resumes it.
- Given each profile, its `cli-config.json` is written atomically with only static permissions.
- `npm run ci` passes.

## Implementation Notes

## Plan Change Log

## Review Triage Log

### 2026-11-04 — Review pass
- verdicts: 9 findings — high 0, medium 2, low 3, false 2, maybe-false 2
- findings:
  - `[medium]` `[patch]` docs/providers/cursor.md Shell limits still says a capped run is refused — fixed: now says it starts in the restricted profile
  - `[medium]` `[patch]` docs/providers/cursor.md side-question paragraph stale about native readers — fixed
  - `[low]` `[defer]` linkChatStore leaves a real acp-sessions directory — see deferred
  - `[maybe-false]` `[defer]` Windows symlink — see deferred
  - `[maybe-false]` `[defer]` two live processes on profile switch — see deferred
  - `[low]` `[reject]` side question under restricted profile not tested through execute — discardSession is covered through the link; criterion 4/5 are met at reuse-key and link level; not worth a new harness
  - `[false]` `[reject]` test import order — style only, no rule
  - `[false]` `[reject]` plan checkboxes and bookkeeping untouched — the build sets them at finalize
  - `[low]` `[reject]` MEMORY.md not updated — recorded below in this run's notes instead; MEMORY entry added by the run

## Auto Run Result

Status: built
Summary: an empty native selection is served by the adapter's restricted permission profile (one `Read(*)` deny); the core picks the profile (`selectNativeProfile`), keeps it in the reuse key, and the restricted config dir links `acp-sessions` to the default one. Partial selections stay refused.
Files: src/core/{permissions,backend,home,execute,ports}.ts, src/adapters/cursor/{index,manifest,permissions}.ts, tests (backend, permissions, home, execute, cursor index), parity matrix, docs/providers/cursor.md, docs/setup.md, CHANGELOG.md.
Review: 2 patches (docs), 3 deferred, 4 rejected. followup_review_recommended false (no high patched, two medium were doc-only).
Verification: `npm run ci` passes; the reproduction test passes.
Residual risk: criterion 8 (live check with a Cursor login) NOT RUN: no login on this host; `Read(*)` closing native read/grep/glob rests on the issue's measurements.

## Design Notes

The restricted `allow` drops `Read(**)` (it is the open path) and keeps `Mcp(openclaw:*)`; its `deny` is `Read(*)` plus the default's three denies. Only `permissions` is managed; the version key is Cursor's and is kept if present (fresh files hold `{permissions}`, which Cursor accepts).

## Verification

**Commands:**
- `npx vitest run test/backend.test.ts -t "serves a run whose native selection is empty instead of refusing it"` -- expected: passes
- `npm run ci` -- expected: exit 0

---
title: 'Connecting cursor-cli installs cursor-agent when it is missing'
type: 'feature'
ticket: '27'
created: '2026-11-12'
status: 'built'
baseline_revision: '6b836905ede85d6d00c90a2070a817f9f77f86c5'
route: 'full'
route_source: 'auto'
risk: 'high'
review: 'quick'
review_source: 'pinned'
lenses_ran: ['quick']
review_loop_iteration: 0
context:
  - '{project-root}/_bmad-output/backlog/story-connecting-cursor-cli-installs-cursor-agent-when-it-is-missing.md'
  - '{project-root}/_bmad-output/backlog/story-connecting-cursor-cli-installs-cursor-agent-when-it-is-missing-research.md'
---

<frozen-after-approval reason="human-owned intent — do not modify unless human renegotiates">

## Intent

**Problem:** Connecting `cursor-cli` on a Gateway host without `cursor-agent` dead-ends: the user must install the CLI by hand, and a pasted API key is saved unchecked.

**Approach:** The Connect methods detect a missing or too old CLI and, after an explicit yes, install Cursor's pinned package (sha256-checked) into `<state dir>/tools/cursor-agent/<version>/` and point `cursor-cli.command` at it. The key method checks the key with `cursor-agent about` before saving. A third method, `remove`, offers to remove the saved key and the managed CLI. Story 27's acceptance criteria 1–11 are the contract.

## Boundaries & Constraints

**Always:** Install only from the adapter's pinned origin, version, and per-platform sha256; check the hash before unpacking; unpack with entry, size, and path limits into a temp folder, then one rename. Ask with `prompter.confirm` before any download; non-interactive or no `confirm` → no install. Core names no CLI (AD-2): the install spec is adapter data. Key never in a log, note, error, or argv. Remove only folders under the managed root. Linux glibc and macOS, x64/arm64 only.

**Never:** Run Cursor's install script or any shell; follow redirects off the pinned origin; touch `~/.local`, `PATH`, shell profiles, or a user-installed `cursor-agent`; install at Gateway start, in a turn, or in a probe; add npm dependencies; put a download-and-run command string in plugin source.

## I/O & Edge-Case Matrix

| Scenario | Input / State | Expected Output / Behavior | Error Handling |
|----------|--------------|---------------------------|----------------|
| CLI present | `command` runs a supported version | methods behave as today (key method adds the `about` check) | none |
| Install yes | no CLI, Linux glibc/macOS | download, hash ok, unpack, `--version` = pin, patch `command`, old managed versions removed | none |
| Install no / cancel / no confirm | no CLI | nothing written; link to manual docs; key saved unchecked with a note | none |
| Unsupported host | Windows, musl, other arch, `OPENCLAW_NIX_MODE=1` | no offer; reason + docs link; key saved unchecked | none |
| Bad download | hash mismatch, truncated, oversized, wrong origin, redirect, low disk, unpack limit, launcher fails | temp removed, config and earlier install untouched | error names the cause + docs link |
| Key check | `about` prints `User Email` / `invalid` / neither | save / refuse "invalid" / retry once then refuse "check could not run" | key never echoed |
| Remove | key and/or managed install | separate confirms; key → `env.CURSOR_API_KEY: undefined`; CLI → close idle pool processes, delete folder, unset `command` if it points there; refuse if a turn runs | nothing to remove → note |

</frozen-after-approval>

## Code Map

- `src/core/ports.ts` -- `CliAdapter`: add optional `managedInstall?: ManagedInstallSpec` (version, origin, per-platform `{url, sha256, bytes, unpackedBytes}`, `stripComponents`, `launcher`, `docsUrl`) and `checkKey?(params): Promise<"valid"|"invalid"|"unknown">`.
- `src/core/provider-auth.ts` -- `createAuthMethods`: add CLI detection (`adapter.checkVersion`), install offer, key check, and `REMOVE_METHOD_ID = "remove"`; reuse `settingsOf`, `checkKey` (rename the local one to `checkKeyText`), the configPatch builder. Takes new deps: `stateDir()`, `fetch`, `pools`.
- `src/core/managed-install.ts` (new) -- platform key (glibc via `process.report.getReport().header.glibcVersionRuntime`), managed root `<stateDir>/tools/<command>/`, find/remove installs, `installManaged()` (fetch with `redirect: "error"`, streaming sha256 + byte cap, `fs.statfs` free-space check, temp dir, unpack, verify launcher, rename, prune).
- `src/core/tar.ts` (new) -- bounded streaming tar.gz extractor (ustar prefix, GNU `L`, pax `path`; files and dirs only; rejects links, absolute, `..`; keeps exec bits).
- `src/core/register.ts` -- pass `stateDir` (`api.runtime.state.resolveStateDir`, fallback `OPENCLAW_STATE_DIR` / `OPENCLAW_HOME/.openclaw` / `~/.openclaw`) and the pool to `createAuthProvider`.
- `src/core/pool.ts` -- add `closeIdle(): number` (closes idle members, like `releaseConversation` without the key); `turns` already says whether a turn runs.
- `src/core/register.ts` also keeps a module-level map backendId → pool (`livePools`), which the remove method reads. Best effort: a setup-mode load of the plugin in another module instance sees an empty map; deleting files under a running binary is safe on Linux and macOS.
- `src/adapters/cursor/install.ts` (new) -- pinned spec data for 2026.11.11-b912975 (4 platforms, sha256 and sizes from Cursor's `.sha256` files and HEAD).
- `src/adapters/cursor/index.ts` -- wire `managedInstall`, `checkKey` (`about` with the key in env only; parse `User Email` / `provided API key is invalid`).
- `scripts/pin-cursor-agent.mjs` (new) -- reads version from `https://cursor.com/install`, fetches the 4 `.sha256` + HEAD sizes, rewrites `install.ts`; `--check` compares the pin with the `.sha256` files.
- `.github/workflows/cursor-pin.yml` (new) -- weekly schedule + dispatch running `--check`.
- `openclaw.plugin.json` -- third `providerAuthChoices` entry for `remove` (credentialOnly, `appGuidedSecret`).
- `test/fixtures/fake-cursor-agent.mjs` -- `about` subcommand steered by `FAKE_CURSOR_ABOUT` (`ok|invalid|unknown`).
- Tests: `test/provider-auth.test.ts` (existing tests must give `command: FAKE_CURSOR_AGENT`), new `test/managed-install.test.ts` (local HTTP stub, small tar.gz built in-test), `test/tar.test.ts`, host-contract check that `applyProviderAuthConfigPatch` deletes `undefined` keys (`test/fixtures/host-code.ts`).
- Docs: `docs/setup.md` (Install the requirements, Sign in from the Control UI or the CLI), `docs/providers/cursor.md` (Provider list and sign-in methods), `README.md` one line, spine AD-17, `CHANGELOG.md`, `MEMORY.md`.
- Do not change: turns, probes, usage reads, per-agent home, `login` method when the CLI is present.

## Tasks & Acceptance

**Execution:**
- [x] `src/core/tar.ts` + `test/tar.test.ts` -- bounded extractor -- no npm dep, safe paths.
- [x] `src/core/managed-install.ts` + `test/managed-install.test.ts` -- install/remove core -- AC 3, 4, 7 and the stub matrix.
- [x] `src/core/ports.ts`, `src/adapters/cursor/install.ts`, `src/adapters/cursor/index.ts`, fake agent -- adapter data and `checkKey` -- AD-2.
- [x] `src/core/provider-auth.ts`, `src/core/register.ts`, `src/core/pool.ts`, `openclaw.plugin.json`, `test/provider-auth.test.ts` -- methods -- AC 1, 2, 5, 6, 8.
- [x] `scripts/pin-cursor-agent.mjs`, `.github/workflows/cursor-pin.yml` -- AC 9.
- [x] Docs, spine AD-17, README, CHANGELOG, MEMORY -- AC 10.

**Acceptance Criteria:**
- Given story 27 criteria 1–11, when the branch is checked, then each holds as written there.

## Implementation Notes

- 2026-11-12: plan approved under the owner's go on story 27 (AGENTS.md: tactical decisions are the agent's). About 1900 tokens, above the 1600 guide; kept whole, as the story records (one PR, phased tasks).

- 2026-11-12 (build): implemented all six tasks. Tactical choices, within the plan:
  - The key check runs `cursor-agent about` in a throwaway HOME/XDG_CONFIG_HOME/CURSOR_CONFIG_DIR, twice per check, deleted afterwards. Live (2026.11.11): `about` answers from a login or key stored in `~/.config/cursor/auth.json` before the env key (a wrong key looked valid there), a fresh home answers `User Email  Not logged in` on its first run, and a wrong key prints that same line every time (no "provided API key is invalid"). So a wrong key ends as "could not be checked" (the AC 6 wording), not "invalid"; the old "invalid" text is still parsed. macOS Keychain is not isolated (not checked).
  - `CliAdapter.keyCopyPath` (optional) carries `~/.config/cursor/auth.json` for the remove note, since the core names no CLI.
  - The pin script measures `unpackedBytes` by streaming each package once through the plugin's own tar reader (and checks its sha256); `--check` downloads no package. Entry limit 20 000 is a core constant.
  - A failed install throws (no config change). After an install, a login that is missing or a key that is refused returns the `command` patch with a note instead of throwing, so the install is not orphaned.
  - The offer always names the terminal command (`openclaw models auth login --provider cursor-cli --method <id>`) for a Control UI step that times out.

## Plan Change Log

## Review Triage Log

### Pass 1 (quick lens), 2026-11-12: high 0, medium 3, low 4, false 0, maybe-false 0

| # | Finding | Verdict | Route | Evidence / action |
|---|---------|---------|-------|-------------------|
| 1 | Remove from a terminal cannot see Gateway turns; docs claim it refuses | medium | patch | `livePools` is module state; the CLI login runs in its own process. Keep the check, state the limit in the confirm message and both docs. Decision: deleting files under a running binary is safe on Linux/macOS; a cross-process check (pid locks) is not worth the complexity for a user-initiated removal. |
| 2 | Queued turns not counted by the refusal | low | patch | `ProcessPool.turns` is `running` only; add `queued`. |
| 3 | AC6 "invalid" never shown with the pinned CLI | low | rejected (code) | Cursor 2026.11.11 prints `Not logged in` for a wrong key (live check); the code cannot tell invalid from unreachable. Recorded as a Decision in story 27. |
| 4 | Unrunnable configured CLI makes the key refused, was saved before | medium | patch | `checkVersion` warns on EACCES/timeout, `detectCli` says present, `checkKey` answers unknown; skip the check on a warning and save unchecked with a note. |
| 5 | Pin script: HEAD without Content-Length fails | low | patch | `Number(null) === 0`; treat missing as unknown. |
| 6 | Cancel during install loses the "Could not install" message | low | rejected | A cancel rethrows the abort reason so the host ends the flow as cancelled; the user who cancelled needs no cause, and nothing was written. |
| 7 | Failed folder removal drops a confirmed key removal | medium | patch | `removeManaged` throws through; catch, note the cause, keep the key patch. |
| 8 | Size figures in docs are Linux x64 only | low | patch | macOS pins are larger; give the range. |

## Design Notes

- `configPatch` deletion: OpenClaw 2026.10.3 and 2026.11.3 `mergeConfigPatch` delete a key whose patch value is `undefined`; the Control UI path diffs base vs applied (`createProviderAuthConfigPatch`), so removal works on both.
- The Control UI 2026.11.3 wizard renders `confirm` and Gateway-run `progress`; 2026.10.3 `WizardPrompter` has both. Step timeout unknown: the progress keeps updating; a live Control UI run is recorded as not run if unavailable.

## Verification

**Commands:**
- `npx vitest run test/tar.test.ts test/managed-install.test.ts test/provider-auth.test.ts` -- expected: pass
- `npm run typecheck && npm test` -- expected: pass
- `node scripts/pin-cursor-agent.mjs --check` -- expected: pin matches Cursor's `.sha256` files

**Results (2026-11-12):** focused tests pass; `npm run typecheck` and `npm test` pass (63 files, 1926 tests, 69 skipped); `npm run build` and the package allowlist test pass; `node scripts/pin-cursor-agent.mjs --check` matches all four `.sha256` files. Live (this host, Linux x64 glibc, real `CURSOR_API_KEY`): the API key method installed 2026.11.11-b912975 into a temp state dir (~9 s) and confirmed the key; `checkKey` gave `valid` for the real key and `unknown` for a wrong one; through OpenClaw 2026.10.3 `models auth login --method login` installed into `<state dir>/tools/cursor-agent/` and patched `command`, `--method remove` deleted the folder, unset `command`, and removed the key; a `cursor-cli/auto` turn (`openclaw agent --local`) answered "ok" through the managed launcher with the key only in plugin config. Not run: a live Control UI install (step timeout), macOS.

**Manual checks (if no CLI):**
- Live: install the real package into a temp `OPENCLAW_STATE_DIR` through the method, then a `cursor-cli/auto` turn with the real key (needs `CURSOR_API_KEY`); otherwise recorded as not run.

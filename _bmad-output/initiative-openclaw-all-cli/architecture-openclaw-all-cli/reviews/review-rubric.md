# Rubric review — architecture spine `openclaw-all-cli`

- **Spine:** `../architecture-openclaw-all-cli.md` (draft, 2026-10-15)
- **Inputs:** `spec-cursor-cli-provider.md`, `claude-cli-parity.md`, `spike-cursor-transport.md` (and, for traceability, the research doc)
- **Method:** I read the spine against the good-spine checklist, and checked the OpenClaw API claims it rests on against the installed OpenClaw 2026.10.3 in `.spike/openclaw` (`dist/cli-backend.types-*.d.ts`, `execute.runtime-*.mjs`, `helpers-*.mjs`, `cli-live-session-registry-*.mjs`, `prompt-context-*.mjs`, `prepare.runtime-*.mjs`).
- **Verdict:** The shape is good. Hexagonal layering, one plugin with a backend per CLI, one event union, a capability manifest per adapter, and never writing into the user's workspace are the right divergence points, and the Rules are mostly crisp. But three of the core ADs (AD-5, AD-8, AD-11) are built on identity and lifecycle that OpenClaw's plugin seam doesn't expose, or already owns itself. The warm ACP session (AD-4) also conflicts with OpenClaw's per-turn MCP grant. And the spine has no Open Questions section, so several spec and spike items have quietly dropped out. **Not ready to build from until findings 1–4 are fixed.**

## Severity summary

| # | Severity | Finding |
| --- | --- | --- |
| 1 | critical | The session, lane, and home keys `(backendId, agentId, sessionKey)` aren't visible at the `execute` seam, and AD-5 duplicates OpenClaw's own CLI session binding |
| 2 | critical | A warm ACP session (AD-4) keeps turn 1's MCP grant, but OpenClaw issues a new grant and capture key per run, scoped to that run's sender and policy |
| 3 | high | Per-run tool policy and permissions are written into a per-agent home that concurrent sessions of the same agent share, and a warm process only reads them at start |
| 4 | high | No Open Questions section. CAP-7 web fetch and delete, spike S5 grep/glob leak, P11, P12, P15, P18, and spec Q3/Q4/Q6 landed nowhere |
| 5 | medium | Gaps in the operational envelope: version floors, CLI self-update, ACP version, Gateway restart, reaping idle processes, observability, distribution |
| 6 | medium | AD-2 contradicts the seed (`plugin.ts` imports the plugin SDK). AD-2 and AD-11 leave open who spawns the process that the ACP transport reads |
| 7 | medium | AD-9 doesn't name OpenClaw's tool-availability contract (`nativeToolMode`, `toolAvailabilityEnforcement`, `toolAvailabilityEnforced`, `hostOwnedTools`) |
| 8 | medium | AD-3 event union: MCP tool calls may be rendered twice, compaction lifecycle and `requestUserInput` are absent, and the mapping to OpenClaw's parsed-event union isn't fixed |
| 9 | low–medium | Deferred items that can still diverge: the `-p` usage option breaks AD-7, compaction touches the core, and distribution blocks CAP-10 |
| 10 | low | Constraints that didn't land: official surfaces only (no `agent.v1`), the gate for adding a second CLI, cursor-agent ≥ 2026.07.06, platforms other than macOS |

---

## 1. Session and lane identity isn't visible at the seam (critical)

**What the spine says.** AD-5: the core stores `(backendId, agentId, sessionKey) → nativeSessionId` in plugin state. AD-6 keys a live session on the same tuple. AD-8: `serialize: false`, and the core runs one turn at a time per `(backendId, agentId, sessionKey)`.

**What OpenClaw 2026.10.3 actually provides.**
- `CliBackendExecuteContext` carries `cwd`, `env`, `prompt`, `systemPrompt`, `modelId`, `sessionId`, `useResume`, `timeoutMs`, `abortSignal`, `toolAvailability`, an optional `liveSession`, `requestToolPermission`, and `requestUserInput`. **It has no `agentId` and no `sessionKey`.** `CliBackendPrepareExecutionContext` adds only `agentDir`, `workspaceDir`, and `authProfileId`.
- `sessionId` and `useResume` arrive already resolved, so **OpenClaw owns the CLI session binding**. It persists the native ID it reads from `sessionId` and `result.sessionId` records, and it handles `/new` and `/reset`, auth-epoch invalidation (`authEpochMode`), MCP resume hashes, and `freshSessionRecovery`.
- `resolveCliRunQueueKey`: with `serialize: false` and no `liveSession`, the key is `backendId:runId`, which gives no ordering. If `liveSession` is set, the key becomes `backendId:owner:<hash(agentAccountId, agentId, authProfileId, sessionId, sessionKey)>`. In that mode the host also passes `CliBackendLiveSessionCapability` (register, activate, restart, and close with reasons `idle | restart | abort | mcp-capture-rotation`). `acceptsCliLiveSession` requires `executionTarget.kind === "plugin"`, `liveSession !== undefined`, `output: "jsonl"`, and `input: "stdin"`.

**Why it matters.** The core can't compute the keys AD-5, AD-6, and AD-8 require. A second binding store would also drift from OpenClaw's. For example, after `/reset` OpenClaw clears its own binding, but the plugin's map would still resume the old Cursor chat. That is exactly the "two owners of the session-to-chat mapping" that AD-5 says it prevents. Separate stories (sessions, lanes, homes) would each invent their own way to recover `agentId`/`sessionKey`, for example by parsing `agentDir`, hashing `cwd`, or using `sessionId`.

**Fix.**
- Rewrite AD-5: "OpenClaw owns the binding. The adapter resumes from `ctx.sessionId` when `useResume` is set, and reports a new ID only through `sessionId`/`result.sessionId` records. The plugin persists no session map."
- Rewrite AD-8 and AD-11: "Backends set `liveSession` with `input: "stdin"` and `output: "jsonl"`, so OpenClaw serializes per owner and owns process admission. The core registers each ACP process as a `CliBackendLiveSessionHandle` and honors the host's close reasons." Keep a per-backend cap on concurrent processes as the only lane the plugin owns.
- AD-6: derive the per-agent home from `prepareExecution.agentDir`, not from an `agentId` the core never receives.
- Add an open question or spike: is `liveSession: "claude-stdio"` (a closed union) supported for a non-Claude plugin with a custom `execute`? If not, record the fallback key explicitly, for example `cwd + sessionId`, and accept that first turns aren't ordered.

## 2. A warm ACP session holds a stale MCP grant (critical)

**Evidence.** In `prepare.runtime`, each run mints `mcpClientGrant.token` into `OPENCLAW_MCP_TOKEN`. The grant is scoped to that run's sender, owner flag, sandbox tool policy, and runtime allowlist. `writeGeminiMcpCaptureSettings` writes "per-attempt Gemini settings with the active loopback capture token". For its own live session, the host closes the process with `mcp-capture-rotation`. Research also records #116235: a Gateway restart rotates the loopback port and token.

**Conflict.** AD-4 keeps one `cursor-agent acp` process per session. The sequence diagram passes `mcpSpec` only at `open` (`session/new`/`session/load`), and ACP fixes `mcpServers` when the session is created. So turn 2 would call OpenClaw tools with turn 1's token and capture key. That means the wrong sender policy in group chats, broken delivery and capture tracking, and expired tokens after a restart. AD-9's guarantee that "OpenClaw executes every call under its policy" (CAP-6) doesn't hold.

**Fix.** Add a Rule, in AD-9 or a new AD: "The MCP spec is per turn. Before each `prompt`, the core compares the grant fingerprint with the one the live session was opened with. If they differ, the adapter must reopen with `session/load` and the new `mcpServers` (same process if ACP allows it, otherwise restart the process). It never reuses a stale grant." Add a live test: two turns from different senders, where a tool is allowed for the first sender and denied for the second. Then re-measure P4 (warm turns), because a reload on every turn may erase the 2.4–2.6 s win. That outcome would change P4 from match to approx.

## 3. Per-run policy lives in a shared per-agent home (high)

AD-9 translates `tools.allow`/`deny` into "the CLI's per-tool rules". The spike says those rules belong in `CURSOR_CONFIG_DIR/cli-config.json`, which is per agent under AD-6. But:
- `toolAvailability` is **per run**, and AD-8 lets two sessions of the same agent run at once. Both would write one `cli-config.json`, which CAP-9 forbids ("never share … writes to per-agent Cursor state"). cursor-agent writes that file itself too; the corruption race was only fixed in 2026.07.06.
- A warm ACP process reads permissions when it starts, so a later turn with a different allow/deny set runs under the old rules.

**Fix.** Pick one of these and state it as a Rule:
- Static, policy-independent deny rules (Shell, Write, WebFetch, …) live in the per-agent home, written once under a lock. Per-run OpenClaw tool filtering happens only on the MCP side: OpenClaw's grant already filters tools (see `mcpToolsDeny` and `toolFilter` in the Gemini settings writer).
- Or config dirs are per session, not per agent.

Either way, add "a change in the effective permission set restarts or reloads the live session" (this fits with finding 2's fingerprint).

## 4. No Open Questions section; quiet items dropped (high)

The spine has **Deferred** but no **Open Questions**. Many items from the spec, the parity table, and the spike didn't land anywhere:

| Source item | Status in spine |
| --- | --- |
| CAP-7 lists **web fetch** and **delete** | AD-9 covers only shell and "native file tools". WebFetch has no rule, and Delete has no Cursor permission token (research [20]) |
| Spike S5: `deny: Read(**)` doesn't block `grep`/`glob` (content leaked); not tested on ACP. Spike "still open": grep/glob deny tokens | Missing. Read is neither allowed through approval nor denied |
| P11 skills (`--plugin-dir` or prompt catalog). CAP-6 says "skills" | Missing |
| P12 system prompt every turn. `execute` receives `systemPrompt` and `promptContext`, and ACP has no system-prompt field | Missing. Each adapter story would choose its own way to prefix it, and on a warm session it could be sent once or every turn |
| P15 reseed and fallback prelude. The spec constraint says a Cursor API key is needed only for reseed and the SDK | Missing. CAP-5 maps to "OpenClaw reseed" with no auth-profile decision (`defaultAuthProfileId`, `reseedFromRawTranscriptWhenUncompacted`) |
| P18 side questions (`--mode ask`, `executionMode: "side-question"`) | Only named as a manifest flag. Undecided whether side questions run in the warm session (mode switch) or a separate process |
| P17 `clearEnv` | AD-11 doesn't say which env is cleared before launching the CLI |
| Spec open question on CAP-5 reseed boundary; Q3 API-key billing; Q4 two processes on one chat and the shared helper; Q6 #148584 plugin skipped at startup | Missing |
| Spike "still open": driving it from a real OpenClaw plugin (Gemini loopback file, `requestToolPermission`) | Missing. AD-9's MCP bridge is still an untested inference, and the spine doesn't mark it as an assumption |
| Spec Assumption: admins can disable the headless CLI org-wide | Missing from the error mapping (AD-11 `CliError.code`) |

**Fix.** Add an `## Open Questions` section that lists each item above with the story it blocks. For WebFetch, Delete, and Read/grep/glob, add explicit AD-9 bullets ("denied in the per-agent permissions; a live test proves no content leaks").

## 5. Operational envelope incomplete (medium)

Decided: development and live-test environments, install by `openclaw plugins install`, in-process with the Gateway. Missing or unclear:
- **Version floors and checks.** The Stack lists the "tested" cursor-agent version but not the spec's floor (≥ 2026.07.06). The OpenClaw peer `2026.10.3` reads as an exact pin, while the spec says "2026.10.3 or later". There's no runtime check of the cursor-agent version or ACP `protocolVersion`, and no `CliError` code for an unsupported version. P19 (`runtimeArtifact`, binary detection) has no rule.
- **Upgrades.** cursor-agent updates itself (it has a versions dir under `~/.local/share/cursor-agent/versions/`), so a running warm process can outlive an update. Nothing says what happens to live sessions or whether resume across versions is supported. There's no policy for OpenClaw upgrades either, such as a re-check cadence for the closed unions and seam types the spine depends on. The research staleness map already flags these.
- **Gateway restart.** Orphaned `cursor-agent acp` children after a crash, and the #116235 token rotation, aren't covered.
- **Process budget.** AD-8 caps concurrent *turns*, not warm *processes*. Without an idle timeout and a cap on live processes, AD-8 doesn't actually prevent "unbounded CLI processes".
- **Observability.** Only a logging rule. Nothing on where CLI stderr goes, which per-turn diagnostics are logged (transport, the session reloads from finding 2, denials), or how a user diagnoses `missing-auth` or a backend that was skipped at startup (#148584).
- **Distribution** is deferred to "before first public release". CAP-10, though, needs `docs/setup.md` to name an install command (see finding 9).
- **Platforms.** Windows is out, but Linux isn't stated. The shared Keychain login is macOS-only, and the file credential store needs ≥ 2026.06.29.

**Fix.** Add an "Operations" block or AD with: version floors and a startup version check, an idle timeout and process cap, killing children on Gateway shutdown, a diagnostics log line per turn, the supported platform list, and an upgrade re-check cadence.

## 6. Dependency rule contradictions (medium)

- AD-2 says "Only `src/core/` imports `openclaw/plugin-sdk/*`", but the seed's `src/plugin.ts` calls `definePluginEntry`, which comes from the plugin SDK. Either allow the composition root to import it, or re-export `definePluginEntry` from core.
- "Adapters import only `src/core/ports.ts` and `src/transports/`" literally forbids `node:` built-ins, which an adapter writing permissions files needs. Allow `node:*`, and say whether `fs` is allowed in adapters at all, given that AD-6 says the core allocates homes.
- AD-11 has the core owning spawn and kill, while AD-4 puts the ACP client in `src/transports/acp/`. Nothing says who holds the child's stdio, so a transport could easily spawn its own process. Add a port, for example `ProcessHandle` or `spawn(cmd, args, env, cwd)`, that the core supplies to transports.
- Enforcement: name a mechanism, such as an import-boundary lint rule or a dependency-cruiser check in CI. Otherwise AD-2 is only a convention.

## 7. AD-9 doesn't name OpenClaw's tool contract (medium)

The Rule says "if the adapter can't translate them, the run is refused" but never names the OpenClaw mechanism. In 2026.10.3, restricted runs need `nativeToolMode: "selectable"` plus `toolAvailabilityEnforcement: "prepare-execution"` and `toolAvailabilityEnforced: true` returned from `prepareExecution`. `always-on` backends fail closed. `hostOwnedTools` applies only with bundled loopback MCP. The research recommended `always-on` until the deny spike passes. Without the exact values, the policy story and the manifest story (AD-10) can choose differently. **Fix:** state the values in AD-9 (or in the manifest row P10), and say which manifest status maps to `always-on` and which to `selectable`.

## 8. Event union details (medium)

- OpenClaw's `CliBackendParsedJsonlEvent` has no `usage` or `error` kinds: usage and `errorText` ride on `result`. AD-3 should say how `NormalizedEvent.usage` and `.error` fold into `result`.
- **Possible double rendering.** OpenClaw tool calls go through the loopback MCP, and OpenClaw tracks them on the host side. ACP also reports them as `tool_call` updates. The spine doesn't say whether adapters emit `toolStart`/`toolResult` for MCP calls or only for native ones. Fix: "Adapters emit tool events only for native tools; loopback MCP calls are suppressed", and verify that against how claude-cli renders them.
- Compaction start and end (`parseJsonlLifecycleEvent`) and `requestUserInput` (structured questions to the operator) are in the seam but not in the spine. Add them to the union, or explicitly exclude them.

## 9. Deferred items that can still diverge (low–medium)

- **Usage source.** One option, "the `-p` secondary transport (AD-4)", would need `.cursor/mcp.json` at the user's git root to reach tools, which AD-7 forbids. Running a second `-p` turn just to get usage would also double-bill. Restrict the options to ones that keep AD-7 and run nothing extra (ACP `_meta`, the Cursor transcript in the per-agent home), or record P16 as a gap.
- **Compaction (P14).** `ownsNativeCompaction`/`manualCompaction` touch the core (session binding, the live session, lifecycle events). Deferring it per manifest row is fine only if the AD-11 port already reserves a `compact` operation. Otherwise the compaction story will change the core, which breaks CAP-12's "no core edits".
- **Distribution.** The package name and install command show up in `docs/setup.md` (CAP-10) and in `openclaw.plugin.json`. Fix the package name `openclaw-all-cli` now, and defer only npm vs ClawHub publishing.
- **Model list (P1).** Not deferred, but not decided either. The list could come from `cursor-agent models` or from ACP `session/new`, be fetched at startup or per `/model`, and be cached or not. The CAP-1 story and the adapter story would choose differently. Decide it in AD-1 or AD-10.

## 10. Smaller constraint gaps (low)

- **Official surfaces only.** The ban on Cursor's private `agent.v1` isn't a Rule. Add it to AD-4.
- **Gate for adding a second CLI.** The spec says a new CLI provider comes only after Cursor passes every capability. The spine's "Antigravity adapter" deferral doesn't carry that gate.
- **Shared home writes.** AD-6 says "CLI login stays shared" but omits the other remaining shared writes (`prompt_history.json`, `CURSOR_WORKTREES_ROOT`, the helper process) that CAP-9 permits. List them so the isolation story's tests have a defined boundary.
- **Single Gateway per state dir.** "One Gateway process owns its state dir" (AD-8) is an assumption. Tag it as one, or detect a second Gateway with a lockfile.

## What's good (keep)

- The layer table and dependency diagram are clear. CAP-12's "no core edits" is directly supported by AD-1, AD-2, AD-4, and AD-10.
- AD-7 (never write into the workspace) is enforceable, testable, and well grounded in spike S1.
- AD-10 (a manifest keyed by P1–P19, updated in the same change as the matrix, docs, and live test) is a strong anti-drift mechanism.
- AD-9's split between native shell and native file tools mirrors claude-cli correctly, and the "edits don't ask" deferral is honest.
- The Capability → Architecture map covers all 12 CAPs. The Stack versions are concrete.

## Coverage reconcile

| Item | Landed | Note |
| --- | --- | --- |
| CAP-1 | AD-1, AD-10 | Model list source undecided (finding 9) |
| CAP-2 | AD-3, AD-4 | ok |
| CAP-3 | Deferred | Must be an Open Question; the `-p` option conflicts with AD-7 |
| CAP-4 | AD-5, AD-6 | Binding owner wrong (finding 1) |
| CAP-5 | Map only | P15 and reseed auth profile missing (finding 4) |
| CAP-6 | AD-9 | Per-turn MCP grant (finding 2); skills missing |
| CAP-7 | AD-9 | WebFetch, Delete, Read/grep/glob missing |
| CAP-8 | AD-6, AD-7 | ok, apart from deriving the home from `agentDir` |
| CAP-9 | AD-8 | Keys unobtainable; same-agent sessions share a home (findings 1 and 3) |
| CAP-10 | Conventions | Install command depends on deferred distribution |
| CAP-11 | AD-10 | ok |
| CAP-12 | AD-1, AD-2, AD-4, AD-10 | Compaction may force core edits |
| Constraints | Partly | Official-surfaces ban, cursor-agent floor, and second-CLI gate missing |
| Non-goals | Yes | Host-owned loop implicit; per-agent login and other CLIs covered |
| P1–P5, P7–P9 | Yes | |
| P6, P13, P14 | Deferred | |
| P10 | AD-9 | Contract values and location (findings 3 and 7) |
| P11, P12, P15, P18 | **No** | |
| P16 | Deferred | |
| P17 | AD-11 | `clearEnv` missing |
| P19 | Conventions (live tests) | Binary and version detection missing |
| Spike S5, open items | **No** | |
| Spec Q3, Q4, Q6, CAP-5 question | **No** | |

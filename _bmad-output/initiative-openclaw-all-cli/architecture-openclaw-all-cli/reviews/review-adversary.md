---
reviewer: adversary
target: ../architecture-openclaw-all-cli.md
date: 2026-10-15
lens: pairs of units that each obey every AD and still build incompatibly
---

# Adversarial review: architecture spine, openclaw-all-cli

## Verdict

**Not build-ready.** The paradigm and the dependency rules (AD-1, AD-2, AD-3) hold. But the spine never says which data lives for a **session** and which lives for a **turn**, and it never says where the key `(backendId, agentId, sessionKey)` comes from. Those two gaps let independently built stories collide on the warm ACP process. Three holes are critical: MCP grant lifetime, a second owner of the session binding, and an undefined key. Each can be closed with one added or tightened AD sentence. No paradigm change is needed.

Grounding used beyond the spine: research claims OC13 and OC25, and openclaw-side digest r2 claims 5, 7, 9, 17, 26 and r1 claims 28–30 (the per-run `OPENCLAW_MCP_TOKEN` grant; the `prepareExecution`/`execute` context fields; `serialize:false` queue keys; bug #116235). Spike S2, S4, and S7 were also used.

## How to read a hole

Each hole names two units, as they would come out of two separate stories. It names the ADs both units obey, explains how they still break, and proposes **one rule sentence** that closes the hole.

---

## Critical

### H1. Per-run MCP grant vs warm live session

- **Pair:** the MCP bridge (core, AD-9) and the ACP transport/live session (AD-4, AD-6 key).
- **Both obey:** AD-9 says the core reads the URL and Bearer header from the Gemini settings file and hands the adapter one `McpServerSpec`. AD-4 says one `cursor-agent acp` process per live session. In the sequence diagram, `open(..., mcpSpec, ...)` sends the spec once, in `session/new`.
- **Clash:** `OPENCLAW_MCP_TOKEN` is a **per-run** grant, bound to the Gateway-selected session, account, and channel (digest r2 claims 5 and 26). On turn 2 the warm process still holds turn 1's URL and token, which are now revoked or bound to the wrong channel. The model loses every OpenClaw tool, or calls them under turn 1's binding. An in-process Gateway restart also rotates the port and token (#116235), with the same result. The bridge author reads the spec per turn. The transport author injects it once per session. Both read the spine correctly.
- **Rule:** *The `McpServerSpec` is turn-scoped: the core passes it on every `prompt`. The live session reaches OpenClaw tools only through a core-owned, stable local MCP endpoint. That endpoint forwards to the current turn's loopback URL and grant, and it rejects calls made outside an active turn.* An acceptable alternative: re-issue ACP `session/load` with fresh `mcpServers` before each turn. In both cases, never reuse a session-time token.

### H2. Two owners of the session binding

- **Pair:** the session-binding store (core, AD-5) and OpenClaw's own CLI session binding, which reaches `execute` as `context.sessionId` and `useResume` (r2 claim 9).
- **Both obey:** AD-5 stores `(backendId, agentId, sessionKey) → nativeSessionId` in plugin state. The core emits a `sessionId` record (AD-3), and OpenClaw stores that record in its own binding. OpenClaw also clears its binding on `/reset`, on daily or idle reset, and when the auth identity changes (r1 claim 28).
- **Clash:** After `/reset`, OpenClaw sends `sessionId: undefined, useResume: false`. The plugin store still maps the same `sessionKey` to the old chat, and the live process is still warm. The plugin resumes a conversation the user just reset. The reverse also happens: when OpenClaw's fresh-session recovery picks a new ID, the plugin keeps the old one. AD-5 names this exact failure in its "Prevents" line and then builds it against the host.
- **Rule:** *OpenClaw's `context.sessionId`/`useResume` is authoritative for whether and what to resume. The plugin store may only add data keyed by that native ID (owner agent, live-process handle). Whenever OpenClaw asks for a fresh session or a different ID, the core closes any live process whose native ID differs.*

### H3. The session key cannot be derived from what OpenClaw provides

- **Pair:** lanes (AD-8), homes (AD-6), and binding (AD-5) all key on `agentId` and `sessionKey`. The backend builder sees only the `prepareExecution` and `execute` contexts.
- **Both obey:** All three ADs use `(backendId, agentId, sessionKey)`.
- **Clash:** Neither context carries `agentId` or `sessionKey`. `prepareExecution` has `workspaceDir` and `agentDir?`. `execute` has `cwd`, `sessionId?`, and `env` (r2 claims 7 and 9). Each story will derive its own key. The lanes story might hash `agentDir`. The homes story might use the workspace basename. The binding story might use OpenClaw's `sessionId`, which is absent on the first turn. The result is three different keys for one conversation. Two first turns of one new conversation then get different lane keys and run in parallel, which breaks CAP-9. Path safety is also undefined: `agentId` may contain `/` or `..`.
- **Rule:** *`ports.ts` defines one `SessionKey` type and the core function that derives it from the context fields named in that rule (for example, `agentId` from `agentDir`, conversation key from OpenClaw's session identifiers), with no fallback guessing. Home path segments are a fixed-length hash of that key, not raw IDs. If the key can't be derived, the turn fails with `CliError{code:"no-session-key"}`.* First story: verify which field identifies the conversation on turn 1.

---

## High

### H4. One per-agent home, many concurrent sessions, and per-turn policy

- **Pair:** homes (AD-6, keyed per agent) and lanes (AD-8, keyed per session). A second pair: the policy module (AD-9, restricted runs) and the warm process (AD-4).
- **Both obey:** AD-6 gives one home per `(backend, agent)`. AD-8 lets two sessions of the same agent run at once. AD-9 has the adapter write `tools.allow/deny` as CLI rules into that home (Cursor reads `cli-config.json`, per spike S2 and S4).
- **Clash:** Session A of agent X is a restricted run and writes a narrow `cli-config.json`. Session B of the same agent starts and rewrites it. Each process reads whatever was last written, at a time Cursor decides. Two `cursor-agent` processes also share one `CURSOR_DATA_DIR` chat store, which CAP-9 forbids ("never share … writes to per-agent Cursor state"). Separately, a warm process keeps the permissions it loaded at start, so a later turn with different `tools.allow` runs under the old policy.
- **Rules:**
  - *Files that depend on policy or the turn are written only into a per-session subdirectory of the agent home, or passed as session parameters. The agent-level home holds only state that every session of that agent can share.*
  - *A live process is reused only when its open-time fingerprint matches the turn: model, policy hash, cwd, home, auth epoch, and MCP endpoint (if not proxied per H1). Otherwise the core closes it and resumes into a new process.*

### H5. Nobody owns cancellation and timeouts while a permission request is pending

- **Pair:** lifecycle (core, AD-11: watchdog, timeouts, kill) and the permission flow (AD-9: a native request goes to `requestToolPermission`), with the ACP transport between them.
- **Both obey:** The watchdog kills when there is no output. The permission router awaits OpenClaw's approval. The transport waits for the router.
- **Clash:**
  - A human takes 3 minutes to approve. The no-output watchdog fires and kills the process mid-approval.
  - A pending `session/request_permission` must be answered with outcome `cancelled` when the turn is cancelled (ACP contract). The transport assumes the core answers. The core assumes `adapter.cancel` does it. The CLI hangs until the kill.
  - OpenClaw passes `timeoutMs`, `abortSignal`, and its own `reliability.watchdog`. The core adds its own timers. Two watchdogs act on one process, with different error shapes.
  - Nothing says whether a cancelled live session is reusable or must be killed.
- **Rule:** *The core is the only owner of timers. It uses OpenClaw's `timeoutMs`, `abortSignal`, and watchdog values, and pauses the no-output watchdog while a permission request is pending. On cancel it answers every pending permission request with `cancelled`, calls `adapter.cancel`, and kills after a fixed grace period. A session counts as reusable only if the transport reported a `cancelled` stop reason within that grace period.*

### H6. Gateway restart, orphan processes, and an unbounded process pool

- **Pair:** lifecycle (AD-11) and lanes (AD-8: "in-memory: one Gateway process owns its state dir"), with binding (AD-5, persisted).
- **Both obey:** Bindings survive a restart. Lanes and the live-process table don't.
- **Clash:**
  - When the Gateway dies, any `cursor-agent acp` children that are not reaped stay alive and hold the native chat. The new Gateway resumes the same chat in a second process. Whether two processes can share one chat is research question Q4, still open.
  - `openclaw agent --local`, or a second Gateway on the same state dir, breaks "one process owns the state dir", and nothing detects it.
  - AD-8 caps concurrent **turns**, not live **processes**. Idle warm processes grow without bound, and nothing defines eviction. Eviction can also race a turn that is queued on the same lane.
  - Plugin unload or reload (config apply) is not in the lifecycle.
- **Rule:** *The core owns a live-process pool with a max size and an idle TTL. Eviction acquires the session lane first. It holds an exclusive lock file per agent home (PID plus Gateway instance) and reaps or refuses stale owners on startup. It closes every live process on plugin unload and when the loopback grant changes.*

---

## Medium

### H7. Static manifest vs runtime capability

- **Pair:** manifest (AD-10, static, the only source of flags) and the ACP transport, which learns real capabilities at runtime (`initialize`: `loadSession`, MCP `http`, images, modes; spike S10).
- **Clash:**
  - The manifest says P4 and P5 `match`, but an older `cursor-agent` reports `loadSession: false` or no HTTP MCP. Flags are already registered, so the transport either degrades silently or fails with an ad-hoc error.
  - Row status (`match`/`approx`/`gap`) does not define flag values. The Cursor and Antigravity adapters can both mark P9 `approx` and need different `nativeToolMode` values, and the core can't derive them from status alone.
- **Rules:**
  - *Manifest rows carry typed backend-flag values plus the runtime capabilities each row requires. Status is documentation only.*
  - *At `open`, the core checks the transport's reported capabilities against the required capabilities of every `match`/`approx` row, and fails with `CliError{code:"capability-missing"}`. It never downgrades silently.*
  - *The manifest declares a minimum CLI version, which is checked at binary detection (P19).*

### H8. Event semantics are underdefined

- **Pair:** the Cursor adapter (ACP chunks are deltas) and a future Antigravity or `-p` adapter (stream-json may emit cumulative partials and a final `result`).
- **Clash:** AD-3 fixes the event names but not their meaning:
  - Is `text` a delta or a snapshot?
  - Does `result` carry the authoritative final text (CAP-2: "final text equals terminal result")?
  - Is missing usage an absent event or a zero `usage` (CAP-3 deferred)?
  - Does the native ID arrive through `open()`'s return value or a `sessionId` event? AD-5 says event. With ACP, `session/new` returns it synchronously.

  Two adapters following AD-3 can produce double text or empty finals.
- **Rule:** *`text`/`thinking` are append-only deltas. `result` carries the final text, which the core prefers over the accumulated deltas. Unknown usage means no `usage` event, never zeros. `open()` returns the native session ID, and the core persists it before the first `prompt`. The `sessionId` event is only for transports that learn the ID mid-turn.*

### H9. `CliError` has a shape but no vocabulary

- **Pair:** lifecycle (AD-11, `CliError{code, retryable, message}`) and each adapter that throws it.
- **Clash:** The `code` values are free strings. The core can't map them to OpenClaw outcomes: auth failure, rate limit, fresh-session recovery, or fallback model. If an error is `retryable: true` after a tool already ran, OpenClaw can replay the turn on a fallback model and run side effects twice. OpenClaw guards against this only for `claude-stream-json` (r1 claim 22).
- **Rule:** *`CliError.code` is a closed union in `ports.ts` (`auth`, `rate-limit`, `session-not-found`, `capability-missing`, `policy-refused`, `timeout`, `cancelled`, `cli-exit`, `protocol`, `no-session-key`). The core forces `retryable:false` once any `toolStart` was emitted in the turn. `session-not-found` makes the core drop the binding and retry fresh exactly once.*

### H10. The policy module vs the adapter: who decides, and in what shape

- **Pair:** the policy module (core, AD-9) and the adapter's permission mapping (AD-9 "translated by the adapter"; AD-2 "core never names a CLI").
- **Clash:**
  - The core can't write `cli-config.json` (it would name a CLI), so the adapter writes it. But AD-9 also forbids "adapters deciding policy themselves". With no shape for a policy decision, each adapter invents its own.
  - ACP permission requests for the OpenClaw MCP server arrive when no allow rule is set (spike S2). One author routes them to `requestToolPermission`, which double-approves a call the loopback already enforces. Another auto-allows every MCP server, including user MCP servers the CLI picked up.
  - Unknown permission kinds have no default.
- **Rule:** *The core emits a CLI-neutral `ToolPolicy` (allow/deny OpenClaw tool names; native categories `shell | read | write | fetch | other` → `deny | ask`), and the adapter only renders it. Every native permission request is mapped to a category, and unknown maps to `other` → deny. Requests for the core's own MCP endpoint are auto-allowed (OpenClaw enforces at the loopback), and requests for any other MCP server are denied.*

### H11. The secondary `-p` transport on a chat held by a live process

- **Pair:** AD-4 allows `-p` "as a usage source behind the same adapter". AD-8 lanes. AD-5 binding.
- **Clash:** Getting usage through `-p --resume <chatId>` is a second, billed turn that mutates the same chat a live ACP process holds (Q4 open). Each AD allows it, and nothing places it inside the lane slot.
- **Rule:** *A secondary transport runs only inside the owning turn's lane slot, never resumes a native chat that a live process holds, and never sends a prompt that adds to the conversation.*

### H12. Isolated working directory vs OpenClaw tools' workspace

- **Pair:** AD-6 ("an isolated working directory is opt-in per agent") and the MCP bridge (OpenClaw `exec`/`read` tools act in OpenClaw's workspace for the run).
- **Clash:** If the plugin creates the isolated directory itself, the model sees tree A through the CLI's cwd and acts on tree B through OpenClaw tools. AD-7 also leaves the location of that directory open.
- **Rule:** *The CLI's cwd is always `context.cwd`. "Isolated working directory" means OpenClaw's own per-agent workspace setting, never a directory the plugin creates.*

---

## Low

- **Two config sources.** The plugin config block (per-backend-ID convention) and OpenClaw's own `cliBackends` overrides (command, env, watchdog, timeouts) can both set the same knob. *Rule: plugin config holds only adapter-specific knobs. Anything OpenClaw already models is read from OpenClaw.*
- **Secrets in protocol frames.** A Bearer header sits inside `session/new` params, and the logging convention only bans info level. *Rule: transports redact `headers`, env, and `_meta` auth fields at every log level.*
- **The CLI's own writes in cwd.** AD-7 binds "the plugin". `cursor-agent` itself may create files (for example `.cursor/`). *Rule: a live test asserts the cwd tree is byte-identical after a turn. Any CLI-side write is recorded as a manifest gap.*
- **A CLI without a config-dir variable.** A future adapter may relocate state only through `HOME`, which breaks the shared login that AD-6 promises. *Rule: if an adapter can't relocate state without touching login, its manifest marks isolation (CAP-8) as `gap` and the core refuses isolated agents for that backend.*
- **Port shape.** The `open(home, cwd, mcpSpec, nativeSessionId?)` signature has no model, system prompt (P12), env, policy, `registerMessageInjection`, or `requestUserInput`. *Rule: `ports.ts` splits `OpenParams` (session-scoped) from `TurnParams` (turn-scoped). MCP spec, policy, system prompt, env, and abort signal are turn-scoped.*
- **Stateful work in `prepareExecution`.** With `serialize:false`, OpenClaw runs `prepareExecution` concurrently and outside any plugin lane (r2 claim 17). *Rule: `prepareExecution` is pure (it reads the Gemini settings file and returns `execute`). Binding lookup, home writes, and live-process lookup happen in `execute` after the lane is acquired.*
- **Home garbage collection.** Nothing removes the home of a deleted agent, or the per-session subdirectories from H4. *Rule: the core removes a session subdirectory when its binding is cleared, and an agent home when OpenClaw no longer lists the agent.*

---

## Proposed rule changes by AD

| AD | Change |
| --- | --- |
| AD-3 | Delta, final, and usage semantics; `open()` returns the native ID (H8) |
| AD-5 | OpenClaw's `sessionId`/`useResume` is authoritative; the plugin store is subordinate (H2) |
| AD-6 | `SessionKey` derivation and hashed paths (H3); per-session subdirectory for policy-dependent files (H4); cwd = `context.cwd` (H12) |
| AD-8 | Live-process pool cap and TTL; eviction under lane; lock file per home (H6); stateful work only inside the lane (Low) |
| AD-9 | Turn-scoped MCP through a stable core endpoint (H1); `ToolPolicy` shape, MCP auto-allow scope, unknown → deny (H10) |
| AD-10 | Typed flag values, required runtime capabilities, minimum CLI version (H7) |
| AD-11 | Sole timer owner; pause during permission; cancel protocol (H5); closed `CliError.code`; no retry after a tool ran (H9); close on unload or grant change (H6) |
| AD-4 | Secondary transport confined to the lane, with no conversation mutation (H11) |
| New AD-12 | Session-scoped vs turn-scoped data, and the reuse fingerprint for live processes (H1, H4) |

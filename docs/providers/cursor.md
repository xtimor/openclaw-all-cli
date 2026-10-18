# Cursor provider

What `cursor-cli/<model>` does in OpenClaw and how it compares with `claude-cli`. Setup is in [Setup](../setup.md).

> **Status:** walking skeleton. Rows marked *spike* or *planned* change as the plugin grows; each change to a row updates this page and that row's live test together.

## How it runs

OpenClaw selects the `cursor-cli` backend from the model ref `cursor-cli/<model>`. The plugin starts `cursor-agent acp` and talks to it over the Agent Client Protocol (ACP). One process serves one conversation. The plugin keeps it warm between turns (closed after 15 idle minutes) whenever OpenClaw allows reuse; see the P4 row. OpenClaw owns the session binding: it stores the Cursor session ID the plugin reports, and the next turn resumes it with ACP `session/load` when OpenClaw says to.

Each agent gets its own Cursor home, `<agentDir>/openclaw-all-cli/cursor-cli/` (`agentDir` is OpenClaw's per-agent directory). The plugin points `CURSOR_CONFIG_DIR` at it and `CURSOR_DATA_DIR` at its `data/` folder, so agents share no Cursor config or chat store. The Cursor login stays shared. The plugin writes nothing into the agent's working directory. If OpenClaw gives no agent directory, the turn fails with `OpenClaw gave no agent directory`; the plugin never falls back to a shared home.

The home holds one file the plugin writes, `cli-config.json`, with the same static permissions for every agent:

| Rule | Entries |
| --- | --- |
| Deny | `Shell(*)`, `Write(**)`, `WebFetch(*)` |
| Allow | `Read(**)`, `Mcp(openclaw:*)` |

The home directory is created with mode 0700 and the file with mode 0600 (an existing stricter file mode is kept). If `cli-config.json` exists but cannot be read, the turn fails and names the file instead of replacing it. The plugin writes the file once through an atomic rename and leaves it alone while it already holds these rules. Other keys Cursor stores there are kept, and edits to the `permissions` key are overwritten on the next turn. No per-turn policy goes into a file. Native read, grep, and glob stay available.

## Sessions, resume, and side questions

OpenClaw owns which Cursor chat belongs to which OpenClaw chat. The plugin keeps no session map: it only receives `sessionId` and `useResume` for a turn and reports the Cursor session ID it ends up with, on every turn.

| Situation | What happens |
| --- | --- |
| Follow-up turn, warm process | The same `cursor-agent acp` process answers; only the new prompt is sent |
| Follow-up after a Gateway restart (or any turn OpenClaw restarts the process for) | A new process loads the chat with ACP `session/load`; Cursor keeps the context, and only the new prompt is sent |
| `/reset` | OpenClaw passes no resume ID; the plugin starts a new Cursor session and reports its ID |
| Another agent's chat, or a chat deleted from the agent's home | `session/load` fails; the turn fails with `session_expired` and the text `CLI session not found: ...`. The plugin never starts a fresh chat behind it. The backend sets `freshSessionRecovery: "invalidated-only"`, so OpenClaw may retry once with a fresh Cursor chat and its own reseeded history, and only for an error like this one and only when it has history to reseed (needs a Cursor API-key profile, see P15). OpenClaw 2026.10.3 clears a failed chat binding only for `claude-cli`, so without that history every later turn fails the same way until you run `/reset` |
| Cursor answers `session/load` with another session ID | That ID is reported and used for the next turn |
| Cursor cannot load sessions at all | The turn fails with `capability_mismatch` |

A warm process serves the next turn only when model, mode, working directory, agent home, auth profile, and Cursor session ID all match the turn (AD-13); otherwise it is closed and a new one resumes the chat. At most one process holds a chat: if a second process is about to load a chat an idle one holds, the idle one is closed first, and if that one is in the middle of a turn the new turn fails with a retryable error. A live probe (2026-10-18, cursor-agent 2026.10.16) showed why: Cursor lets two processes load one chat without an error, but each keeps its own view, a turn in one is invisible to the other, and the stored chat ends up with only one process's turns.

A side question (OpenClaw's `/btw`, `executionMode: "side-question"`) opens a throwaway Cursor session in `ask` mode, with no MCP server (so no OpenClaw tools), no resume, and every permission request rejected without asking OpenClaw. It reports no session ID, so the chat's binding is untouched, and its process closes after the answer. The backend sets `sideQuestionToolMode: "disabled"`. Cursor cannot switch off its native `read`, `grep`, and `glob` per run (see Known limits), so a side question may still read files, but it cannot run a shell, write, or call an OpenClaw tool. Cursor keeps the throwaway session in the agent's `acp-sessions` folder.

## OpenClaw tools

OpenClaw's tools (`sessions_list`, `memory_search`, `web_fetch`, and the rest) reach Cursor as the MCP server `openclaw`. The backend sets `bundleMcp` with `bundleMcpMode: "gemini-system-settings"`, so for every turn OpenClaw writes a settings file with its own loopback URL, a fresh token, and a capture key, and names it in `GEMINI_CLI_SYSTEM_SETTINGS_PATH`. That URL and token change on every run, so the plugin never gives them to Cursor. Instead it runs one local HTTP proxy per live session, on `127.0.0.1` with a random port and its own random Bearer token, and hands Cursor only that proxy through ACP `mcpServers` (`session/new` and `session/load`). At the start of each turn the plugin reads `mcpServers.openclaw` (`url` or `httpUrl`, and `headers`) from the settings file and points the proxy at it; the proxy forwards method, path, body, and the response stream unchanged, with the turn's `Authorization` and `x-openclaw-cli-capture-key` headers. Between turns, after an abort, and after the proxy's session closes, the proxy rejects every call.

| Situation | What happens |
| --- | --- |
| Call outside a turn | HTTP 503 with a JSON-RPC error; nothing is forwarded |
| Missing or wrong client token | HTTP 401; nothing is forwarded. The token is checked before the path, so a wrong token gets 401 even for a path outside `/mcp` |
| Path outside `/mcp` | HTTP 404; nothing is forwarded |
| Proxy failure while handling a call | HTTP 500 with a JSON-RPC error |
| The proxy cannot start | The turn fails with a retryable error; Cursor is not started |
| The live session was closed while Cursor was starting | The new Cursor process is stopped and the turn fails with a retryable error (`The live session was closed while the CLI was starting`) |
| OpenClaw's endpoint unreachable | HTTP 502 to Cursor; the turn continues |
| No settings file, or no `mcpServers.openclaw` in it | The turn runs without OpenClaw tools and the plugin logs a warning; the chat does not fail. Cursor drops the `openclaw` server for the life of that process, so a process whose first turn had no settings is closed when that turn ends and the next turn starts a new one |
| Settings URL is not a loopback `http` URL | Treated as no settings, so the proxy never sends OpenClaw's token anywhere else |

Cursor connects to its MCP servers while it opens the session, before the first prompt, so the plugin registers the session with OpenClaw and points the proxy at the turn's endpoint before it starts `cursor-agent`. The plugin writes no MCP configuration into the workspace or any file you own.

## Streaming and tool progress

Cursor's replies reach OpenClaw while the turn runs, not when it ends: every `agent_message_chunk` becomes a text delta and every `agent_thought_chunk` a thinking delta, in order, and the closing record carries the full reply, which is exactly the concatenation of the text deltas. Nothing waits for the end of the turn. Live run (real `cursor-agent`, 2026.10.16): 159 text and 4 thinking deltas, the first one 9.6 s before the closing record.

Cursor's tool activity (`tool_call` and `tool_call_update`) shows as tool progress in OpenClaw. Rules:

- **Once per call.** However many updates Cursor sends for one call ID, OpenClaw gets one start and at most one result (at `completed` or `failed`; a failed call is marked as an error). An update for a call the plugin has not seen counts as its start.
- **Names.** Cursor announces a call with a generic title and, for search and MCP calls, no input; the next update, a few milliseconds later, has both. The plugin waits for that update, then shows the call under OpenClaw's tool names: `read`, `grep`, `glob`, `exec`, `edit`, `write`, `delete`, `web_fetch`, `web_search`, or `mcp__<server>__<tool>`. A call to OpenClaw's own tools through the MCP proxy shows as `mcp__openclaw__<tool>`, as in `claude-cli`; OpenClaw displays that without the prefix. The host adds no display of its own for a proxied call (checked live: its tool summary counts one entry), so the plugin does not hide it.
- **Nothing left pending.** A call still open when the turn ends, fails, or is cancelled gets a closing result marked as an aborted error.
- **Display only.** The events change no permission and no tool policy. Approvals still go through the permission requests described below.
- **Results are shortened.** A result longer than 8 000 characters is cut, because the events only feed the display.
- **Retries.** An error after any tool call started in the turn is not retryable, because the call may already have run. A process that dies before any tool call is retryable. OpenClaw's JSONL contract carries only the error text, so the host never sees this flag; it is in the plugin's own event for logs and tests.

## Permissions and tool availability

OpenClaw owns approval authority; the plugin only asks. The static `cli-config.json` is the first line of defence: it denies shell, writes, and web fetch, so Cursor does not ask about them. A permission request still arises for what the file leaves open (for example a web search or another MCP server). The plugin names the request in OpenClaw's terms (`exec`, `write`, `edit`, `delete`, `web_fetch`, `web_search`, `read`, `grep`, `glob`, or `mcp__<server>__<tool>`), asks the host (`requestToolPermission`), and answers Cursor from the result:

| Situation | Answer to Cursor |
| --- | --- |
| The host allows | `allow_once` |
| The host denies | reject. A denied shell request makes the model use another tool, such as OpenClaw `exec` when the run serves it |
| Asking the host fails, or the answer is malformed | reject (fail closed); the failure is logged and the turn continues |
| The host allows but changes the input | reject: Cursor can run only what the host saw |
| Cursor offers no option of the decided kind | `cancelled` |
| The turn is aborted while the host waits for a human | `cancelled` at once; the turn ends cleanly and the process closes as soon as the turn ends (the 5-second abort grace only bounds a CLI that ignores the cancel) |
| A request arrives after the turn ended, was aborted, or was superseded | `cancelled`; the host is never asked |
| A request the plugin cannot name (an unknown operation, a question prompt) during a turn | reject; the host is not asked (after the turn it is `cancelled`, like any late request) |
| The run's tool selection leaves the tool out | reject; the host is not asked |

The plugin starts no timer for approvals; OpenClaw's own timers apply. A run's tool selection (`toolAvailability`) comes from OpenClaw. The backend declares `nativeToolMode: "selectable"` with `prepare-execution` enforcement and confirms a selection only if it keeps native `read`, `grep`, and `glob` on, because Cursor cannot switch them off per turn and the plugin writes no per-turn policy file. OpenClaw 2026.10.3 asks for `native: []` for runs with a tool cap, tools disabled, or a system agent; such a run is refused before Cursor starts, with `cursor-cli keeps native read, grep, glob on in every turn...`. A run without a selection starts as usual. `tools.allow` and `tools.deny` filter the OpenClaw tool list on OpenClaw's side; the plugin translates nothing.

Native edits cannot ask in ACP: in agent mode Cursor applies them without a request whatever the permissions say, and its `ask` and `plan` modes have no edit tool. So edits stay denied by `Write(**)` in the static file, and every session also runs in Cursor's `ask` mode as a second lock. A side effect: in `ask` mode the model refuses commands that change files even when the host approves them. The plugin refuses to run when `cursor-agent` offers no `ask` mode.

## Models

`/model`, the model picker, and `openclaw models list --provider cursor-cli` show the models your Cursor account has, as `cursor-cli/<name>` with the readable name Cursor gives them:

```text
cursor-cli/auto
cursor-cli/composer-2.5
cursor-cli/grok-4.7
cursor-cli/claude-opus-5-5
```

The list comes from Cursor, never from the plugin. The plugin starts a short `cursor-agent acp` session in a temporary directory, reads the models Cursor reports in `session/new`, closes it, and removes that session's directory from Cursor's `acp-sessions` folder. No prompt is sent, so no model runs and no tokens are spent. The plugin reuses a listing for one minute (keyed on the command and the environment, so a changed `CURSOR_API_KEY` lists again at once; an account switch is noticed after the minute; from a logged-out state the next read lists at once, because nothing was cached) and lists again when OpenClaw next asks for its catalog (Gateway start, `openclaw models list --refresh`). A failed listing is remembered for 30 seconds, so a refresh within that time shows the failure again. A turn never waits for the list.

Cursor's own model IDs carry parameters, for example `grok-4.7[context=256k,reasoning_effort=high,fast=true]`. The name in the model ref is the base ID without the parameter list (`grok-4.7`), so it stays the same when Cursor changes a model's defaults. When several IDs share a base, the first one in Cursor's list keeps the bare name and the others get their parameter values as a suffix (`twin`, `twin-high`), then `key-value` pairs, then a number; `/model` labels each of them with its parameters. Names therefore follow Cursor's list order: a variant appended after the first changes nothing, but a variant added ahead of the first, a reorder, or the removal of the first moves the bare name (and the suffixed names after it) to another variant, and a configured `cursor-cli/twin` then runs that other variant. The plugin maps the name to Cursor's exact ID for you. You can also type the exact ID, in any case. `cursor-cli/default[]` and `cursor-cli/default` mean `cursor-cli/auto`.

| Situation | What happens |
| --- | --- |
| Logged in, or `CURSOR_API_KEY` set | The models are listed and available |
| Listing fails (`cursor-agent` missing, an error, no answer in 30 seconds) | Only `cursor-cli/auto` is listed and the failure is logged; no turn fails. The next listing attempt is at least 30 seconds later |
| Not logged in and no key | Only `cursor-cli/auto` is listed, as unavailable (`missing-auth` in the Gateway's model list, `Auth: no` in `openclaw models list`). A turn fails with the login error. `openclaw models status` still says `[indeterminate]`: that command reads no prepared auth |
| A model the account does not have | The turn fails with `Cursor has no model "<name>" for this account` (error code `model_not_found`) |
| A model the plan cannot use | Cursor answers with its own plan message, for example `Upgrade your plan to continue`; the plugin does not filter it out |

Cursor keeps the model you last used in the agent's own config (`<agentDir>/openclaw-all-cli/cursor-cli/cli-config.json`), so every turn checks the session's model against the model ref. A turn on `cursor-cli/auto` switches back to Auto when the session starts on another model, and sends nothing when it is already on Auto. The exact ID is checked against the session's own list when the session starts, so a stale list cannot pick a model the account lost.

OpenClaw loads the plugin before the first turn only when your config names a `cursor-cli/...` model, for example as the default model. Until then the Gateway's model list has no Cursor rows.

Every model is declared as text-only to OpenClaw, because images (P13) are still a `spike` row: image attachments are not routed to Cursor models until the adapter sends them.

## Parity with `claude-cli`

| # | Feature | Status | Notes |
| --- | --- | --- | --- |
| P1 | Provider in `/model`, model aliases | approx | The account's models are listed in `/model` and `openclaw models list` as `cursor-cli/<name>`, read from Cursor itself and cached; the name is mapped to Cursor's exact ID; aliases are Cursor's own spellings of Auto, not `claude-cli`'s short names. Live test: `test/live/model-catalog.live.test.ts` |
| P2 | Subscription login counts as auth | match | `cursor-agent status` (live: `Logged in as <email>`; the logged-out wording is unconfirmed) or `CURSOR_API_KEY`. The models are available with either, and unavailable without. Live test: `test/live/model-catalog.live.test.ts` |
| P3 | Streaming text, thinking, and tool progress | approx | Text and thinking deltas as they arrive; Cursor's native tool calls and OpenClaw tools called through the MCP proxy as display-only start and result events, one pair per call. The host does not treat them as tool execution, unlike `claude-cli`'s. Live test: `test/live/streaming.live.test.ts` |
| P4 | Warm process per conversation | approx | The plugin keeps one `cursor-agent acp` process per conversation, but OpenClaw 2026.10.3 puts the per-turn MCP settings path into its live-session fingerprint, so it restarts the process every turn and the next turn resumes with `session/load`. A process is reused only when model, mode, cwd, home, auth profile, and session ID all match, and one chat never has two processes. Live evidence: `test/live/session-resume.live.test.ts` (warm follow-up with only the new prompt, restart, one process per chat) and `test/live/mcp-proxy.live.test.ts` (warm session with a stand-in host) and the real-host run in the ticket notes |
| P5 | Resume a session | match | ACP `session/load` from the ID OpenClaw passes; the ID the CLI ends up with is reported every turn; a chat Cursor does not know fails as `session_expired` and OpenClaw decides about a fresh chat (`freshSessionRecovery: "invalidated-only"`). Live test: `test/live/session-resume.live.test.ts` |
| P6 | Fork, resume at a checkpoint | gap | `cursor-agent` has no fork or checkpoint flag |
| P7 | OpenClaw tools as MCP | match | The plugin hands Cursor one MCP proxy per live session, and nothing else, in ACP `mcpServers`. It forwards each call to the turn's OpenClaw endpoint and rejects calls between turns. Live test: `test/live/mcp-proxy.live.test.ts` |
| P8 | Native shell replaced by OpenClaw `exec` | approx | The per-agent `cli-config.json` denies `Shell(*)`, `Write(**)`, and `WebFetch(*)`, so the native shell does not run; a shell request that still arises goes to the host, and after a denial the model falls back to OpenClaw `exec` when the run serves it. OpenClaw 2026.10.3 serves no `exec` to a `prepare-execution` backend (`hostOwnedTools` has no effect), so a real run has no `exec` tool. Live tests: `test/live/per-agent-home.live.test.ts`, `test/live/permission-routing.live.test.ts` |
| P9 | Tool approvals through OpenClaw | approx | Permission requests go to the host and fail closed; abort answers them `cancelled`. Native edits cannot ask, so the static file and `ask` mode keep them denied. Live test: `test/live/permission-routing.live.test.ts` |
| P10 | `tools.allow` and `tools.deny` | approx | The host filters the OpenClaw tool list; the adapter translates nothing. A run's native tool selection is confirmed only if it keeps `read`, `grep`, and `glob`. Live test: `test/live/permission-routing.live.test.ts` (a `tools.deny` tool is absent from the model's list) |
| P11 | Skills as a native plugin | spike | |
| P12 | System prompt every turn | spike | The OpenClaw system prompt is not sent yet |
| P13 | Images | spike | |
| P14 | Native and manual compaction | spike | |
| P15 | History reseed | approx | Needs a Cursor API-key profile |
| P16 | Usage per turn | gap | ACP reports no usage; the input side can be estimated from Cursor's session store, output cannot |
| P17 | Clean env, watchdog, timeouts | match | OpenClaw's watchdog and timeouts apply |
| P18 | Side questions without tools | approx | A side question runs in `ask` mode with no MCP server, no resume, and every permission request rejected; no OpenClaw tool, shell, or write. Cursor cannot switch off native `read`, `grep`, and `glob` per run, so they stay reachable and the model may read files. Live test: `test/live/session-resume.live.test.ts` |
| P19 | Binary detection, live tests | approx | OpenClaw finds `cursor-agent` on `PATH`. The minimum version 2026.07.06 is recorded but not enforced yet |

## Known limits

- **No usage.** Cursor's ACP reports no token counts, so OpenClaw records none for a turn.
- **No OpenClaw system prompt or skills yet.** The model sees only the prompt text and OpenClaw's tools.
- **No warm process across turns with OpenClaw 2026.10.3.** Each turn restarts the process and resumes it with `session/load`, because OpenClaw's live-session check sees a different MCP settings path every turn.
- **Native read, grep, and glob stay reachable, also in a side question.** `Read(**)` is allowed, and Cursor's `grep` and `glob` are not blocked by a `Read` rule. So a run that selects no native tools is refused (see Permissions and tool availability). A second, static home that also denies `Grep(**)` and `Glob(**)` would lift this (checked: those rules make grep and glob return nothing); it is not built.
- **No OpenClaw `exec` in real runs yet.** OpenClaw 2026.10.3 serves `exec` only to backends that enforce tool availability through execution arguments, so the model has no shell at all: the native one is denied and OpenClaw's is not offered.
- **Native edits are never approved by the host.** Cursor cannot ask before editing.
- **Permissions are not configurable.** Every agent gets the same rules; changing them in `cli-config.json` has no lasting effect.

## Check it works

```sh
OPENCLAW_ALL_CLI_LIVE=1 npm run test:live
```

The live test needs a Cursor login and must run outside any sandbox that hides the login.

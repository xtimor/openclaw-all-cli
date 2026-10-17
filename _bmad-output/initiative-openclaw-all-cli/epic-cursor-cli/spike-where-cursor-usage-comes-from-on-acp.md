# Spike: where Cursor usage comes from on ACP (ticket 9)

Date: 2026-10-17. Host: `cursor-agent` 2026.10.16, API-key auth, `ask` mode, Linux. Parity row P16.

## Answer

**No exact usage source exists on ACP.** Cursor's ACP server never reports token counts, so none can match a `-p` run. A close **estimate of the input side** exists in the session store; output tokens cannot be recovered.

## What was checked

| Channel | Result |
| --- | --- |
| `session/prompt` result | `{ stopReason }` only. No `usage`, no `_meta`. |
| `session/update` notifications | `agent_message_chunk`, `agent_thought_chunk`, `available_commands_update`, `current_mode_update`, `session_info_update`. No `usage_update`. |
| Server code in the CLI bundle (`6136.index.js`) | `prompt` returns `{ stopReason }`; the string `usage_update` does not appear in the ACP server. The ACP SDK schema in `8096.index.js` allows `usage` and `usage_update`, Cursor does not send them. |
| Hooks (`afterAgentResponse`, `stop`) | The CLI source passes `input_tokens`, `output_tokens`, `cache_read_tokens`, `cache_write_tokens` to these hooks. With `hooks.json` in `~/.cursor`, in a project `.cursor/`, and in `CURSOR_CONFIG_DIR`, no hook fired in `-p` or ACP on this host. Not usable; may depend on account or workspace settings. |
| Session store `<CURSOR_CONFIG_DIR>/acp-sessions/<id>/store.db` | Holds a context-window breakdown: tokens used (for example 16 424) of the window (256 000), and per section (system prompt, tools, rules, skills, MCP, subagents, summarized conversation, conversation). Billing usage is absent. |
| Local endpoint override (`CURSOR_API_ENDPOINT`) | The CLI honors it (its first call, `GetMe`, reached a local listener). A forwarder could read usage from the model stream, but that means decoding an undocumented protobuf stream and tracking its hosts. Not recommended. |
| `-p --output-format json` / `stream-json` | `result.usage` with `inputTokens` (excluding cache), `outputTokens`, `cacheReadTokens`, `cacheWriteTokens`. Exact, but a different transport (AD-4 allows it only as a usage source and never against the live session's chat). |

## Measured sample (same prompts, fresh chats)

`-p` figure = `inputTokens + cacheReadTokens + cacheWriteTokens`. ACP figure = store `used` after the turn. The constant offset is about 1 990 tokens (ACP counts more).

| Case | `-p` in+cache | `-p` out | ACP `used` | ACP minus `-p` |
| --- | --- | --- | --- | --- |
| short prompt | 14 435 | 28 | 16 426 | 1 991 |
| 1 800-word prompt | 16 399 | 747 | 18 405 | 2 006 |
| 3 turns, turn 1 | 14 434 | 260 | 16 428 | 1 994 |
| 3 turns, turn 2 | 15 516 | 34 | 17 278 | 1 762 |
| 3 turns, turn 3 | 15 868 | 70 | 17 694 | 1 826 |

- The growth between two prompts agrees: 1 979 (ACP) against 1 964 (`-p`), under 1%.
- The absolute gap varies by about 230 tokens (about 1.5% of the input). Counts do **not** match exactly.
- Output tokens include hidden thinking: 260 output tokens for a 3-character reply. The store holds only the visible text, so output is not recoverable.

## Options for entry 10 (usage)

1. **Estimate from the store (recommended).** After each turn read the context total and report `input = total - calibrated offset` (about 1 990), with a visible-reply estimate for output, flagged as estimated. Within about 2% on input, output undercounts thinking. Needs a reader for an undocumented protobuf-in-sqlite format, so it must degrade to "no usage" on any parse failure and be covered by a live test.
2. **No usage.** Ship without usage (the user's stated last resort).
3. **Endpoint forwarder.** Exact, but decodes Cursor's private stream. Rejected for fragility.
4. **Re-check hooks** on a normal user machine (they may work outside this container) before choosing; if they work, they give exact counts per turn through a static `hooks.json` in the per-agent home.

## Decision for the user

Whether to ship an estimated usage (option 1, possibly upgraded by hooks later) or none. Parity row P16 stays `gap` with this reason until entry 10.

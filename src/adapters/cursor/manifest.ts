import { createManifest } from "../../core/ports.ts";

/** Lowest `cursor-agent` build the adapter supports (AD-14). */
export const CURSOR_MIN_VERSION = "2026.07.06";

/**
 * Cursor's row of `claude-cli-parity.md`. A change here updates the matrix,
 * `docs/providers/cursor.md`, and that row's live test in the same change.
 */
export const cursorManifest = createManifest(CURSOR_MIN_VERSION, {
  P1: { status: "match", note: "cursor-cli/<model>; model list from the ACP session" },
  P2: { status: "match", note: "synthetic auth from cursor-agent status or CURSOR_API_KEY" },
  P3: { status: "match", note: "ACP agent_message_chunk and agent_thought_chunk" },
  P4: { status: "match", note: "one cursor-agent acp process per conversation" },
  P5: { status: "match", note: "ACP session/load" },
  P6: { status: "gap", note: "cursor-agent has no fork or checkpoint flag" },
  P7: { status: "match", note: "ACP session/new mcpServers (HTTP with headers)" },
  P8: { status: "match", note: "shell arrives as a permission request and is rejected" },
  P9: { status: "approx", note: "shell and MCP ask; native edits do not ask" },
  P10: { status: "spike", note: "tools.allow and deny via per-agent cli-config.json" },
  P11: { status: "spike", note: "--plugin-dir or a prompt catalog" },
  P12: { status: "spike", note: "no system-prompt flag known" },
  P13: { status: "spike", note: "ACP advertises image prompts" },
  P14: { status: "spike", note: "not researched" },
  P15: { status: "approx", note: "reseed needs a Cursor API-key profile" },
  P16: { status: "gap", note: "ACP session/prompt reports no usage so far" },
  P17: { status: "match", note: "host watchdog and clean env" },
  P18: { status: "match", note: "ACP ask mode" },
  P19: { status: "match", note: "detect cursor-agent on PATH" },
});

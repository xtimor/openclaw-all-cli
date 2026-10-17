import { createManifest } from "../../core/ports.ts";

/** Lowest `cursor-agent` build the adapter supports (AD-14). */
export const CURSOR_MIN_VERSION = "2026.07.06";

/**
 * Cursor's row of `claude-cli-parity.md`. A change here updates the matrix,
 * `docs/providers/cursor.md`, and that row's live test in the same change.
 */
export const cursorManifest = createManifest(CURSOR_MIN_VERSION, {
  P1: { status: "spike", note: "cursor-cli/<model> runs; the model list in /model is not built" },
  P2: { status: "match", note: "synthetic auth from cursor-agent status or CURSOR_API_KEY; the real status wording is unconfirmed" },
  P3: { status: "approx", note: "text and thinking deltas; tool progress is not mapped yet" },
  P4: { status: "match", note: "one cursor-agent acp process per conversation" },
  P5: { status: "match", note: "ACP session/load" },
  P6: { status: "gap", note: "cursor-agent has no fork or checkpoint flag" },
  P7: { status: "spike", note: "ACP session/new mcpServers is spiked; the MCP proxy is not wired" },
  P8: { status: "approx", note: "per-agent cli-config.json denies Shell, Write, and WebFetch; OpenClaw exec is not offered yet" },
  P9: { status: "approx", note: "shell and MCP ask; native edits do not ask" },
  P10: { status: "spike", note: "tools.allow and deny via per-agent cli-config.json" },
  P11: { status: "spike", note: "--plugin-dir or a prompt catalog" },
  P12: { status: "spike", note: "no system-prompt flag known" },
  P13: { status: "spike", note: "ACP advertises image prompts" },
  P14: { status: "spike", note: "not researched" },
  P15: { status: "approx", note: "reseed needs a Cursor API-key profile" },
  P16: { status: "gap", note: "ACP session/prompt reports no usage so far" },
  P17: { status: "match", note: "host watchdog and clean env" },
  P18: { status: "spike", note: "every session runs in ask mode; side-question mode is not handled separately" },
  P19: { status: "approx", note: "OpenClaw finds cursor-agent on PATH; the minimum version is recorded, not enforced" },
});

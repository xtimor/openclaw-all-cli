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
  P4: { status: "approx", note: "the core keeps one cursor-agent acp process per conversation, but OpenClaw 2026.10.3 puts the per-turn MCP settings path into its live-session fingerprint, so it restarts the process every turn and the next turn resumes with session/load" },
  P5: { status: "match", note: "ACP session/load" },
  P6: { status: "gap", note: "cursor-agent has no fork or checkpoint flag" },
  P7: { status: "match", note: "the plugin hands Cursor one MCP proxy per live session, and nothing else, in ACP mcpServers; it forwards to each turn's loopback URL and headers from the host's settings file and rejects calls between turns" },
  P8: { status: "approx", note: "per-agent cli-config.json denies Shell, Write, and WebFetch, so Cursor's native shell does not run; a shell request that still arises goes to the host, and after a denial the model falls back to OpenClaw exec when the run serves it (stub-host live test). OpenClaw 2026.10.3 serves no exec to a prepare-execution backend, so hostOwnedTools has no effect and a real run has no exec tool" },
  P9: { status: "approx", note: "permission requests (shell, MCP, web fetch and search, reads) go to ctx.requestToolPermission and fail closed; native edits never ask (agent mode applies them, ask mode has no edit tool), so they stay denied by the static file and ask mode instead of being approved by the host" },
  P10: { status: "approx", note: "nativeToolMode selectable with prepare-execution; the host filters the OpenClaw tool list (live: tools.deny hides a tool from the model) and the adapter translates nothing (AD-9); a run's tool selection is confirmed only if it keeps native read, grep, and glob, which Cursor cannot switch off per turn, so a run that selects none is refused" },
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

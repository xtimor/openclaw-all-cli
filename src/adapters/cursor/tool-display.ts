import type { AcpToolCallView, AcpToolDisplay, DescribeToolCall } from "../../transports/acp/session.ts";

/**
 * Names Cursor's native tool calls for the host's tool display, in OpenClaw's canonical tool
 * names where one fits (`exec`, `read`, `grep`, `glob`, `edit`, `write`, `delete`, `web_fetch`,
 * `web_search`, `mcp__<server>__<tool>`). The events are display-only: nothing here touches
 * permission or tool policy (AD-3, AD-9).
 *
 * Shapes seen from `cursor-agent` 2026.10.16: a call is announced as `tool_call` with a generic
 * title and, for search and MCP calls, an empty `rawInput`; the next update carries the real
 * title and input. A search is titled `Find \`*.txt\`` (glob) or `grep "needle"`, a shell call
 * is `` `cmd` `` with `rawInput.command`, a read is `Read path`, and an MCP call is titled
 * `<server>: <tool>` with `rawInput: { providerIdentifier, toolName, args }`.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** The server and tool of an MCP call, from its input or from a `<server>: <tool>` title. */
function mcpCall(call: AcpToolCallView): { server: string; tool: string; args?: Record<string, unknown> } | undefined {
  const server = text(call.rawInput?.providerIdentifier);
  const tool = text(call.rawInput?.toolName);
  if (server && tool) {
    const args = call.rawInput?.args;
    return { server, tool, ...(isRecord(args) ? { args } : {}) };
  }
  const titled = /^([^:]+): (.+)$/s.exec(call.title);
  // Cursor's placeholder title before the call's details arrive is "MCP: tool".
  if (titled && call.title !== "MCP: tool") return { server: titled[1]!, tool: titled[2]! };
  return undefined;
}

function pathOf(call: AcpToolCallView): string | undefined {
  return text(call.rawInput?.path) ?? call.paths[0];
}

function withArgs(name: string, args: Record<string, unknown>): AcpToolDisplay {
  return { name, ...(Object.keys(args).length > 0 ? { args } : {}) };
}

/**
 * The naming hook for Cursor sessions. Calls to the plugin's own MCP proxy show as
 * `mcp__openclaw__<tool>`, like `claude-cli`'s: the host's loopback server emits no display
 * event of its own, so this is the only place such a call is shown (checked live, OpenClaw
 * 2026.10.3: the host's tool summary counted a proxied `session_status` call once).
 */
export const describeCursorToolCall: DescribeToolCall = (call, final) => {
  // The first announcement has no title or input worth showing; the next update does.
  if (!call.rawInput && !final) return undefined;

  if (call.toolCallId.startsWith("web_fetch_")) {
    return withArgs("web_fetch", call.rawInput ?? { url: call.title });
  }
  if (call.toolCallId.startsWith("web_search_")) {
    return withArgs("web_search", call.rawInput ?? { query: call.title });
  }

  switch (call.kind) {
    case "execute": {
      const command = text(call.rawInput?.command) ?? /^`(.*)`$/s.exec(call.title)?.[1];
      return withArgs("exec", command === undefined ? {} : { command });
    }
    case "read": {
      const path = pathOf(call) ?? /^Read (.+)$/s.exec(call.title)?.[1];
      return withArgs("read", path === undefined ? {} : { path });
    }
    case "search":
      return withArgs(call.title.startsWith("Find") ? "glob" : "grep", call.rawInput ?? {});
    case "delete": {
      const path = pathOf(call);
      return withArgs("delete", path === undefined ? {} : { path });
    }
    case "edit": {
      const path = pathOf(call);
      const name = call.title.startsWith("Delete") ? "delete" : /^Write (?!`)/.test(call.title) ? "write" : "edit";
      return withArgs(name, path === undefined ? {} : { path });
    }
    case "other": {
      const mcp = mcpCall(call);
      if (!mcp) return undefined;
      return withArgs(`mcp__${mcp.server}__${mcp.tool}`, mcp.args ?? {});
    }
    default:
      return undefined;
  }
};

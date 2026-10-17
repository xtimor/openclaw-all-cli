import type { PermissionRequest } from "../../core/ports.ts";
import type { AcpPermissionRequest } from "../../transports/acp/session.ts";

/**
 * Names a Cursor ACP permission request in OpenClaw's terms (AD-2), so the core can ask the host.
 * The shapes come from `cursor-agent` 2026.10.16: a shell request carries the command as its
 * title, an edit carries a diff, a read or delete carries the path in its title, an MCP request
 * is `<server>: <tool>` with JSON arguments, and a web request has a `web_fetch_`/`web_search_`
 * call ID. A request the mapping cannot name returns `undefined`; the caller rejects it.
 */

/** Native tools Cursor keeps open in every turn: the per-agent permissions allow `Read(**)`, and grep and glob are not blocked by it. */
export const CURSOR_ALWAYS_ON_NATIVE_TOOLS = ["read", "grep", "glob"] as const;

/** Cursor's question prompts reuse the permission request; their "allow" options are answers. */
const ASK_QUESTION_SKIP = "__ask_question_skip__";

function textOf(request: AcpPermissionRequest): string | undefined {
  for (const block of request.content) {
    if (block.type === "content" && block.content.type === "text") return block.content.text;
  }
  return undefined;
}

function diffOf(request: AcpPermissionRequest): { path: string; oldText?: string; newText: string } | undefined {
  for (const block of request.content) {
    if (block.type === "diff") {
      return {
        path: block.path,
        ...(typeof block.oldText === "string" ? { oldText: block.oldText } : {}),
        newText: block.newText,
      };
    }
  }
  return undefined;
}

/** The text inside the backticks of a title such as ``Edit `a/b.txt` ``. */
export function quoted(title: string, prefix: string): string | undefined {
  const match = new RegExp(`^${prefix} \`(.+)\`$`, "s").exec(title);
  return match?.[1]?.replaceAll("\\`", "`");
}

function pathOf(request: AcpPermissionRequest, fromTitle: string | undefined): string | undefined {
  const raw = request.rawInput?.path;
  return fromTitle ?? request.paths[0] ?? (typeof raw === "string" ? raw : undefined);
}

/** The command inside a shell call's title, which wraps it in backticks and escapes inner ones. */
export function commandFromTitle(title: string): string | undefined {
  const match = /^`(.*)`$/s.exec(title);
  return match?.[1]?.replaceAll("\\`", "`");
}

function shellCommand(request: AcpPermissionRequest): string | undefined {
  const raw = request.rawInput?.command;
  if (typeof raw === "string" && raw.length > 0) return raw;
  return commandFromTitle(request.title);
}

function mcpRequest(request: AcpPermissionRequest): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  const text = textOf(request);
  const fenced = text === undefined ? undefined : /^```json\n([\s\S]*)\n```$/.exec(text);
  const title = /^([^:]+): (.+)$/s.exec(request.title);
  if (!fenced || !title) return undefined;
  let args: unknown;
  try {
    args = JSON.parse(fenced[1]!);
  } catch {
    return undefined;
  }
  const toolInput = typeof args === "object" && args !== null && !Array.isArray(args) ? (args as Record<string, unknown>) : {};
  return { toolName: `mcp__${title[1]}__${title[2]}`, toolInput };
}

function canonical(request: AcpPermissionRequest): { toolName: string; toolInput: Record<string, unknown> } | undefined {
  if (request.optionIds.includes(ASK_QUESTION_SKIP)) return undefined;

  if (request.toolCallId.startsWith("web_fetch_")) return { toolName: "web_fetch", toolInput: { url: request.title } };
  if (request.toolCallId.startsWith("web_search_")) return { toolName: "web_search", toolInput: { query: request.title } };

  switch (request.kind) {
    case "execute": {
      const command = shellCommand(request);
      return command === undefined ? undefined : { toolName: "exec", toolInput: { command } };
    }
    case "edit": {
      const diff = diffOf(request);
      const deleted = quoted(request.title, "Delete");
      if (deleted !== undefined || request.title.startsWith("Delete ")) {
        const path = pathOf(request, deleted);
        return path === undefined ? undefined : { toolName: "delete", toolInput: { path } };
      }
      const created = /^Write (?!`)(.+)$/s.exec(request.title)?.[1];
      const path = diff?.path ?? pathOf(request, created ?? quoted(request.title, "Edit"));
      if (path === undefined) return undefined;
      if (created !== undefined) return { toolName: "write", toolInput: { path, content: diff?.newText ?? "" } };
      return {
        toolName: "edit",
        toolInput: { path, edits: [{ oldText: diff?.oldText ?? "", newText: diff?.newText ?? "" }] },
      };
    }
    case "read": {
      const path = pathOf(request, quoted(request.title, "Read"));
      return path === undefined ? undefined : { toolName: "read", toolInput: { path } };
    }
    case "search": {
      const pattern = request.rawInput?.pattern;
      const toolInput = typeof pattern === "string" ? { pattern } : {};
      return { toolName: request.title.startsWith("Find") ? "glob" : "grep", toolInput };
    }
    case "other":
      return mcpRequest(request);
    default:
      return undefined;
  }
}

export function toCanonicalRequest(request: AcpPermissionRequest): PermissionRequest | undefined {
  const named = canonical(request);
  if (!named) return undefined;
  return {
    title: request.title,
    ...(request.kind ? { kind: request.kind } : {}),
    toolCallId: request.toolCallId,
    ...named,
  };
}

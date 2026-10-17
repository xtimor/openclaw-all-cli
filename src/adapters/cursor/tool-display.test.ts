import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import type { CliSession, McpServerSpec, NormalizedEvent } from "../../core/ports.ts";
import { cursorAdapter } from "./index.ts";

const open: CliSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
});

const PROXY: McpServerSpec = { name: "openclaw", url: "http://127.0.0.1:1/mcp", headers: {} };

async function turn(items: unknown[]): Promise<NormalizedEvent[]> {
  const session = await cursorAdapter.open({
    command: FAKE_CURSOR_AGENT,
    args: cursorAdapter.launchArgs,
    cwd: process.cwd(),
    env: fakeEnv(),
    modelId: "auto",
    mcpServers: [PROXY],
    onPermissionRequest: async () => "reject_once",
  });
  open.push(session);
  const events: NormalizedEvent[] = [];
  for await (const event of session.prompt(`[[updates]]${JSON.stringify(items)}`)) events.push(event);
  return events.filter((event) => event.kind === "toolStart" || event.kind === "toolResult");
}

// The update sequences are what cursor-agent 2026.10.16 sent in a live probe.
const id = (n: number) => `call-uuid-${n}\nfc_${n}`;
const announce = (n: number, title: string, kind: string, rawInput: unknown) => ({
  sessionUpdate: "tool_call",
  toolCallId: id(n),
  title,
  kind,
  status: "pending",
  rawInput,
});
const update = (n: number, body: Record<string, unknown>) => ({
  sessionUpdate: "tool_call_update",
  toolCallId: id(n),
  ...body,
});

describe("cursor tool display", () => {
  it("names a glob once its pattern arrives, and renders it once", async () => {
    const events = await turn([
      announce(0, "Find", "search", {}),
      update(0, { title: "Find `*.txt`", rawInput: { pattern: "*.txt" } }),
      update(0, { status: "in_progress" }),
      update(0, { status: "completed", rawOutput: { totalFiles: 1, truncated: false } }),
    ]);
    expect(events).toEqual([
      { kind: "toolStart", toolCallId: id(0), name: "glob", args: { pattern: "*.txt" } },
      { kind: "toolResult", toolCallId: id(0), name: "glob", isError: false, result: { totalFiles: 1, truncated: false } },
    ]);
  });

  it("names grep, read, and shell calls with OpenClaw's tool names", async () => {
    const events = await turn([
      announce(1, "grep", "search", {}),
      update(1, { title: 'grep "needle"', rawInput: { pattern: "needle", path: "/w" } }),
      announce(2, "Read a.txt", "read", { path: "/w/a.txt" }),
      announce(3, "`echo hi`", "execute", { command: "echo hi" }),
      update(2, { status: "completed", rawOutput: { content: "hello\n" } }),
      update(1, { status: "completed", rawOutput: { totalMatches: 1 } }),
      update(3, { status: "completed" }),
    ]);
    const starts = events.filter((event) => event.kind === "toolStart");
    expect(starts).toEqual([
      { kind: "toolStart", toolCallId: id(1), name: "grep", args: { pattern: "needle", path: "/w" } },
      { kind: "toolStart", toolCallId: id(2), name: "read", args: { path: "/w/a.txt" } },
      { kind: "toolStart", toolCallId: id(3), name: "exec", args: { command: "echo hi" } },
    ]);
    expect(events.filter((event) => event.kind === "toolResult")).toHaveLength(3);
  });

  it("names edits, writes, deletes, and web calls", async () => {
    const events = await turn([
      announce(1, "Edit `/w/a.txt`", "edit", { path: "/w/a.txt" }),
      announce(2, "Write /w/b.txt", "edit", { path: "/w/b.txt" }),
      announce(3, "Delete `/w/c.txt`", "edit", { path: "/w/c.txt" }),
      { ...announce(4, "https://example.com", "fetch", {}), toolCallId: "web_fetch_1" },
      { ...announce(5, "cursor acp", "search", {}), toolCallId: "web_search_1" },
    ]);
    const starts = events.filter((event) => event.kind === "toolStart") as Array<{ name: string; args?: unknown }>;
    expect(starts.map((start) => start.name)).toEqual(["edit", "write", "delete", "web_fetch", "web_search"]);
    expect(starts[0]?.args).toEqual({ path: "/w/a.txt" });
    expect(starts[3]?.args).toEqual({ url: "https://example.com" });
    expect(starts[4]?.args).toEqual({ query: "cursor acp" });
  });

  it("shows a call to the MCP proxy as mcp__openclaw__<tool>, once", async () => {
    const events = await turn([
      announce(1, "MCP: tool", "other", {}),
      update(1, {
        title: "openclaw: sessions_list",
        rawInput: { providerIdentifier: "openclaw", toolName: "sessions_list", args: { limit: 3 } },
      }),
      update(1, { status: "in_progress" }),
      update(1, { status: "completed", rawOutput: { ok: true } }),
    ]);
    expect(events).toEqual([
      { kind: "toolStart", toolCallId: id(1), name: "mcp__openclaw__sessions_list", args: { limit: 3 } },
      { kind: "toolResult", toolCallId: id(1), name: "mcp__openclaw__sessions_list", isError: false, result: { ok: true } },
    ]);
  });

  it("names another MCP server's tool the same way", async () => {
    const events = await turn([
      announce(1, "MCP: tool", "other", {}),
      update(1, { title: "docs: search", rawInput: { providerIdentifier: "docs", toolName: "search", args: { q: "acp" } } }),
      update(1, { status: "completed" }),
    ]);
    expect(events[0]).toEqual({ kind: "toolStart", toolCallId: id(1), name: "mcp__docs__search", args: { q: "acp" } });
  });

  it("shows an MCP call whose details never arrived under Cursor's own title", async () => {
    const events = await turn([announce(1, "MCP: tool", "other", {}), update(1, { status: "completed" })]);
    expect(events.map((event) => event.kind)).toEqual(["toolStart", "toolResult"]);
    expect(events[0]).toMatchObject({ name: "MCP: tool" });
  });

  it("marks a failed call as an error", async () => {
    const events = await turn([announce(1, "`ls`", "execute", { command: "ls" }), update(1, { status: "failed" })]);
    expect(events.at(-1)).toMatchObject({ kind: "toolResult", name: "exec", isError: true });
  });
});

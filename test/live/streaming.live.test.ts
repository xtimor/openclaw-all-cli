import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import { createExecute } from "../../src/core/execute.ts";
import { SETTINGS_PATH_ENV } from "../../src/core/mcp-target.ts";
import type { NormalizedEvent } from "../../src/core/ports.ts";
import type { ExecuteContext } from "../../src/core/sdk-types.ts";
import { STUB_TOOL, startStubMcpHost } from "../fixtures/stub-mcp-host.ts";
import { LIVE_TIMEOUT_MS, describeLive, liveHostEnv, makeLiveSession, openclaw, writeSettingsFile } from "./harness.ts";

// Parity row P3 (streaming text, thinking, and tool progress). Real cursor-agent through the core's
// `createExecute`, with a stub host standing in for OpenClaw's MCP endpoint, and then through the
// real OpenClaw. Needs a Cursor login or CURSOR_API_KEY.
describeLive("text, thinking, and tool progress stream as deltas (P3)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-stream-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  it(
    "delivers deltas over time before the result, and shows each tool call once",
    async () => {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "notes.txt"), "The harbour opens at six.\n");
      const homeDir = homeDirFor(join(root, "agent"), "cursor-cli");
      const home = { dir: homeDir, env: await cursorAdapter.prepareHome(homeDir) };
      const execute = createExecute(cursorAdapter, { home, warn: (message) => console.warn(message) });
      const live = makeLiveSession();
      const host = await startStubMcpHost();
      const ctx: ExecuteContext = {
        command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
        args: cursorAdapter.launchArgs,
        cwd: workspace,
        env: {
          ...liveHostEnv(),
          [SETTINGS_PATH_ENV]: writeSettingsFile(root, "settings", host.url, "host-token", "capture"),
        },
        prompt:
          `First read notes.txt with your native read tool. Then call the MCP tool ${STUB_TOOL} (server "openclaw") ` +
          `once with text "ping". Then write ten numbered sentences about harbours, one per line, and nothing else.`,
        modelId: "auto",
        systemPrompt: "",
        useResume: false,
        timeoutMs: LIVE_TIMEOUT_MS,
        liveSession: live,
        requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
        requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      };

      const seen: { event: NormalizedEvent; at: number }[] = [];
      const startedAt = Date.now();
      try {
        for await (const record of execute(ctx)) {
          seen.push({ event: (record as unknown as { event: NormalizedEvent }).event, at: Date.now() });
        }
      } finally {
        live.current()?.close("abort");
        await host.close();
      }

      const events = seen.map((entry) => entry.event);
      const errors = events.filter((event) => event.kind === "error");
      expect(errors, JSON.stringify(errors)).toEqual([]);
      const result = seen.at(-1)!;
      expect(result.event.kind).toBe("result");

      // Deltas arrive over time, before the closing record.
      const texts = seen.filter((entry) => entry.event.kind === "text");
      const thoughts = seen.filter((entry) => entry.event.kind === "thinking");
      expect(texts.length).toBeGreaterThan(1);
      expect(thoughts.length).toBeGreaterThan(0);
      const firstDelta = Math.min(texts[0]!.at, thoughts[0]!.at);
      const gap = result.at - firstDelta;
      console.log(
        `P3 live: first delta ${firstDelta - startedAt} ms after the turn started, ${texts.length} text and ${thoughts.length} thinking deltas, result ${gap} ms after the first delta`,
      );
      expect(gap).toBeGreaterThan(500);
      expect(thoughts[0]!.at).toBeLessThan(result.at);

      // The final text is the concatenation of the deltas.
      const joined = texts.map((entry) => (entry.event as { text: string }).text).join("");
      expect((result.event as { text: string }).text).toBe(joined);
      expect(joined).toMatch(/1\./);

      // Each call shows once: one start and one result per ID, the start first.
      const starts = events.filter((event) => event.kind === "toolStart");
      const results = events.filter((event) => event.kind === "toolResult");
      const ids = starts.map((event) => event.toolCallId);
      expect(new Set(ids).size).toBe(ids.length);
      expect(results.map((event) => event.toolCallId).sort()).toEqual([...ids].sort());
      for (const id of ids) {
        const startIndex = events.findIndex((event) => event.kind === "toolStart" && event.toolCallId === id);
        const resultIndex = events.findIndex((event) => event.kind === "toolResult" && event.toolCallId === id);
        expect(startIndex).toBeLessThan(resultIndex);
      }
      const names = starts.map((event) => event.name);
      expect(names).toContain("read");
      expect(names).toContain(`mcp__openclaw__${STUB_TOOL}`);
      expect(names.filter((name) => name === `mcp__openclaw__${STUB_TOOL}`)).toHaveLength(1);
      expect(results.some((event) => event.isError)).toBe(false);
    },
    LIVE_TIMEOUT_MS,
  );
});

// Through the real OpenClaw: the host records every tool event it displays in the run's tool summary.
// A native call and an OpenClaw tool called through the MCP proxy are one entry each: the host's
// loopback server adds no display event of its own, so the plugin's start is the only one. Run
// `npm run dev:install` first.
describeLive("a real OpenClaw run shows each tool once (P3)", () => {
  it(
    "counts one read and one proxied OpenClaw tool call",
    () => {
      const run = openclaw(
        [
          "agent",
          "--local",
          "--json",
          "--model",
          "cursor-cli/auto",
          "--session-id",
          `stream-live-${Date.now()}`,
          "--message",
          "Use your native read tool to read AGENTS.md in the working directory exactly once, then call the OpenClaw MCP tool session_status exactly once, then reply with one short sentence.",
        ],
        { timeoutMs: 240_000 },
      );
      expect(run.status).toBe(0);
      const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
        meta: { toolSummary: { calls: number; tools: string[]; failures: number } };
      };
      const summary = json.meta.toolSummary;
      // `tools` is the set of names the host displayed; the model may call a tool more than once, so
      // only the names are checked: each expected one appears exactly once, and the proxied tool has
      // no second entry under another name (a host display next to the plugin's would show here).
      const count = (name: string) => summary.tools.filter((tool) => tool === name).length;
      expect(count("read")).toBe(1);
      expect(count("mcp__openclaw__session_status")).toBe(1);
      expect(summary.tools.filter((tool) => tool.endsWith("session_status"))).toEqual(["mcp__openclaw__session_status"]);
      expect(summary.failures).toBe(0);
    },
    LIVE_TIMEOUT_MS,
  );
});

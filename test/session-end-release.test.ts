import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { CliBackendPlugin, LiveSessionCapability, LiveSessionHandle } from "../src/core/sdk-types.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";
import { registerAdapters } from "../src/core/register.ts";
import { ADAPTERS } from "../src/registry.ts";

it("registers a session_end hook, so a finished conversation releases its process", () => {
  const hooks: string[] = [];
  registerAdapters(
    {
      pluginConfig: {},
      registerProvider: () => {},
      registerCliBackend: () => {},
      logger: { warn: () => {} },
      on: (name: string) => void hooks.push(name),
    } as never,
    ADAPTERS,
  );
  expect(hooks).toContain("session_end");
});

// Ticket 22 (issue #74): each criterion against the real adapter and the ACP stand-in, through the registered backend and hook.

const scratch = mkdtempSync(join(tmpdir(), "oac-session-end-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));
const mcpFile = join(scratch, "mcp.json");
writeFileSync(mcpFile, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));

type EndEvent = { sessionId: string; sessionKey?: string; reason?: string };
type Host = {
  backend: CliBackendPlugin;
  end: (event: EndEvent, ctxKey?: string) => void;
  stop: () => Promise<void>;
  /** Runs one turn of a conversation, with a live-session capability that keeps its process warm. */
  turn: (conversation: string, options?: { prompt?: string; agent?: string }) => Promise<void>;
  /** The pids of the `cursor-agent` stand-ins this host started, oldest first. */
  pids: () => number[];
};

function host(extraEnv: Record<string, string> = {}): Host {
  const log = join(scratch, `${randomUUID()}.jsonl`);
  let backend!: CliBackendPlugin;
  let hook!: (event: EndEvent, ctx: { sessionId: string; sessionKey?: string }) => void;
  let stop!: () => Promise<void>;
  registerAdapters(
    {
      pluginConfig: {},
      registerProvider: () => {},
      registerCliBackend: (b: CliBackendPlugin) => (backend = b),
      registerService: (service: { stop: () => Promise<void> }) => (stop = service.stop),
      logger: { warn: () => {} },
      on: (name: string, handler: typeof hook) => {
        if (name === "session_end") hook = handler;
      },
    } as never,
    ADAPTERS,
  );
  const lives = new Map<string, LiveSessionHandle | undefined>();
  const runtimeLine = (key: string) => `Runtime: agent=main | session=${key} | host=openclaw | os=Linux`;
  return {
    backend,
    end: (event, ctxKey?: string) =>
      hook(event, { sessionId: event.sessionId, ...(ctxKey ? { sessionKey: ctxKey } : event.sessionKey ? { sessionKey: event.sessionKey } : {}) }),
    stop: () => stop(),
    pids: () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; pid?: number })
            .filter((line) => line.method === "initialize" && line.pid)
            .map((line) => line.pid!)
        : [],
    turn: async (conversation, options = {}) => {
      const prepared = await backend.prepareExecution!({ agentDir: join(scratch, options.agent ?? "agent") } as never);
      const live: LiveSessionCapability = {
        fingerprint: `fp-${conversation}`,
        current: () => lives.get(conversation),
        restart: async () => {
          lives.get(conversation)?.close("restart");
          lives.delete(conversation);
        },
        register: (handle) => void lives.set(conversation, handle),
        activate: () => {},
        remove: (handle) => void (lives.get(conversation) === handle && lives.delete(conversation)),
      };
      const env = { ...fakeEnv({ FAKE_CURSOR_LOG: log, ...extraEnv }), [MCP_CONFIG_TEST_KEY]: mcpFile };
      for await (const _record of prepared!.execute!({
        command: FAKE_CURSOR_AGENT,
        ...withHostMcp(["acp"], env),
        cwd: process.cwd(),
        prompt: options.prompt ?? "say:pong",
        modelId: "auto",
        systemPrompt: runtimeLine(conversation),
        useResume: false,
        timeoutMs: 10_000,
        liveSession: live,
        requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
        requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      } as never)) {
        // Drain the turn.
      }
    },
  };
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const gone = async (pid: number, ms = 8_000) => {
  for (const deadline = Date.now() + ms; Date.now() < deadline; await new Promise((resolve) => setTimeout(resolve, 50))) {
    if (!alive(pid)) return true;
  }
  return false;
};

describe("a finished conversation releases its process (ticket 22)", () => {
  it.each(["new", "reset", "deleted", "idle", "daily"])("closes the idle process of the conversation on reason %s", async (reason) => {
    const h = host();
    try {
      await h.turn("agent:main:explicit:a");
      const [pid] = h.pids();
      expect(alive(pid!)).toBe(true);
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", reason });
      expect(await gone(pid!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("leaves the processes of other conversations alone", async () => {
    const h = host();
    try {
      await h.turn("agent:main:explicit:a");
      await h.turn("agent:main:explicit:b");
      const [a, b] = h.pids();
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", reason: "new" });
      expect(await gone(a!)).toBe(true);
      expect(alive(b!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("takes the key from the hook context when the event has none", async () => {
    const h = host();
    try {
      await h.turn("agent:main:explicit:a");
      const [pid] = h.pids();
      h.end({ sessionId: "s1", reason: "new" } as never, "agent:main:explicit:a");
      expect(await gone(pid!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("does not cut off a running turn, and a later release still closes the process", async () => {
    const h = host();
    try {
      const running = h.turn("agent:main:explicit:a", { prompt: "[[sleep:600]]say:slow" });
      while (h.pids().length === 0) await new Promise((resolve) => setTimeout(resolve, 20));
      const [pid] = h.pids();
      await new Promise((resolve) => setTimeout(resolve, 150));
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", reason: "new" });
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(alive(pid!)).toBe(true);
      await running;
      expect(alive(pid!)).toBe(true);
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", reason: "new" });
      expect(await gone(pid!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it.each(["shutdown", "restart", "compaction", "unknown", undefined])("closes nothing on reason %s; close-all stays the closer", async (reason) => {
    const h = host();
    try {
      await h.turn("agent:main:explicit:a");
      const [pid] = h.pids();
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", ...(reason ? { reason } : {}) });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(pid!)).toBe(true);
      await h.stop();
      expect(await gone(pid!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("closes nothing for an event without a key, or for a conversation the plugin never served", async () => {
    const h = host();
    try {
      await h.turn("agent:main:explicit:a");
      const [pid] = h.pids();
      h.end({ sessionId: "s1", reason: "new" });
      h.end({ sessionId: "s2", sessionKey: "agent:main:explicit:other", reason: "new" });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(alive(pid!)).toBe(true);
    } finally {
      await h.stop();
    }
  });

  it("returns at once for a process that ignores SIGTERM, and the transport's SIGKILL ends it within the abort grace", async () => {
    const h = host({ FAKE_CURSOR_IGNORE_TERM: "1", FAKE_CURSOR_IGNORE_STDIN_EOF: "1" });
    try {
      await h.turn("agent:main:explicit:a");
      const [pid] = h.pids();
      const started = Date.now();
      h.end({ sessionId: "s1", sessionKey: "agent:main:explicit:a", reason: "new" });
      expect(Date.now() - started).toBeLessThan(100);
      expect(await gone(pid!, 5_000)).toBe(true);
    } finally {
      await h.stop();
    }
  }, 20_000);

  it("registers on a host without hooks, and a plugin config does not need them", () => {
    expect(() =>
      registerAdapters(
        { pluginConfig: {}, registerProvider: () => {}, registerCliBackend: () => {}, logger: { warn: () => {} } } as never,
        ADAPTERS,
      ),
    ).not.toThrow();
  });
});

import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createExecute, HOST_SHELL_ARG } from "../src/core/execute.ts";
import { createManifest, type CliAdapter, type CliSession, type NormalizedEvent, type OpenParams } from "../src/core/ports.ts";
import type { LiveSessionCapability, LiveSessionHandle } from "../src/core/sdk-types.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const HOME = { dir: "/agent/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/agent/openclaw-all-cli/acme-cli" } };

function adapterRecording(prompts: string[], opens: OpenParams[]): CliAdapter {
  return {
    id: "acme", displayName: "Acme", command: "acme", launchArgs: ["serve"], defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}), alwaysOnNativeTools: ["read"], clearEnv: [],
    checkVersion: async () => "ok", probeAuth: async () => "available", listModels: async () => [],
    prepareHome: async (home) => ({ ACME_HOME: home }),
    open: async (params) => {
      opens.push(params);
      const session: CliSession = {
        sessionId: "native-1", alive: true,
        prompt: (text: string) => {
          prompts.push(text);
          return (async function* (): AsyncGenerator<NormalizedEvent> {
            yield { kind: "result", text: "ok", stopReason: "end_turn" };
          })();
        },
        cancel: async () => {}, close: async () => {}, waitForExit: () => new Promise<void>(() => {}),
      } as never;
      return session;
    },
  } as CliAdapter;
}

/** A host that lets the process live across turns: `current` holds the handle the core registered. */
function warmHost(): LiveSessionCapability {
  let current: LiveSessionHandle | undefined;
  return {
    fingerprint: "fp",
    current: () => current,
    restart: async () => {
      current?.close("restart");
      current = undefined;
    },
    register: (handle) => void (current = handle),
    activate: () => {},
    remove: (handle) => void (current === handle && (current = undefined)),
  } as LiveSessionCapability;
}

/** `names` null: the host's tool list cannot be read. `marker` false: the host did not flag a host shell. */
async function turnWithHostTools(names: string[] | null, { marker = true, turns = 1 } = {}) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      if (names === null) {
        res.writeHead(500);
        return void res.end();
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { tools: names.map((name) => ({ name })) } }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;
  const dir = mkdtempSync(join(tmpdir(), "oac-triage-"));
  const file = join(dir, "settings.json");
  writeFileSync(file, JSON.stringify({ mcpServers: { openclaw: { url, headers: {} } } }));
  const prompts: string[] = [];
  const opens: OpenParams[] = [];
  try {
    const host = withHostMcp(marker ? ["serve", HOST_SHELL_ARG] : ["serve"], { PATH: "/bin", [MCP_CONFIG_TEST_KEY]: file });
    const liveSession = warmHost();
    const execute = createExecute(adapterRecording(prompts, opens), { home: HOME });
    for (let turn = 0; turn < turns; turn += 1) {
      const ctx = {
        command: "acme", cwd: "/work", prompt: `do it ${turn}`, modelId: "auto", systemPrompt: "", timeoutMs: 60_000,
        useResume: turn > 0, ...(turn > 0 ? { sessionId: "native-1" } : {}), liveSession,
        requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
        requestUserInput: async () => ({ status: "cancelled", message: "no" }),
        ...host,
      } as never;
      for await (const r of execute(ctx)) void r;
    }
  } finally {
    server.close(); server.closeAllConnections();
  }
  return { prompts, opens };
}

// Issue #76 (ticket 23): the CLI's own shell is refused by its config, so only the prompt says where commands run.
describe("the native shell hint", () => {
  it("tells the model the native shell is off and OpenClaw exec is the way, when the host serves exec", async () => {
    const { prompts, opens } = await turnWithHostTools(["exec", "process"]);
    expect(opens[0]).toMatchObject({ hostShell: true });
    expect(prompts.join("\n")).toMatch(/exec/);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[0]).toMatch(/`exec`.*background.*`process`/s);
    expect(prompts[0]).toMatch(/do it 0$/);
  });

  it("says nothing about a shell without exec in the host's tool list", async () => {
    for (const names of [["process", "read"], [], null]) {
      const { prompts, opens } = await turnWithHostTools(names);
      expect(opens[0]).toMatchObject({ hostShell: false });
      expect(prompts).toEqual(["do it 0"]);
    }
    // The host did not flag a shell, although exec is listed.
    const unflagged = await turnWithHostTools(["exec", "process"], { marker: false });
    expect(unflagged.prompts).toEqual(["do it 0"]);
  });

  it("does not send the sentence to poll with process when process is not offered", async () => {
    const { prompts } = await turnWithHostTools(["exec"]);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[0]).not.toMatch(/process/);
  });

  it("sends the sentence once per process, not on every turn", async () => {
    const { prompts, opens } = await turnWithHostTools(["exec", "process"], { turns: 2 });
    expect(opens).toHaveLength(1);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[1]).toBe("do it 1");
  });
});

describe("the docs say what ships", () => {
  const files = [
    "src/adapters/cursor/manifest.ts",
    "_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md",
    "docs/providers/cursor.md",
  ];
  it.each(files)("%s does not claim the host answers a denied native shell call", (file) => {
    const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    expect(text).not.toMatch(/Use OpenClaw exec/i);
    expect(text).toMatch(/first prompt of the process/);
  });
});

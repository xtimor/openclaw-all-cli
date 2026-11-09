import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { createExecute, HOST_SHELL_ARG } from "../src/core/execute.ts";
import { createManifest, type CliAdapter, type CliSession, type NormalizedEvent, type OpenParams } from "../src/core/ports.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";
import { mkdtempSync, writeFileSync } from "node:fs";
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
        cancel: async () => {}, close: async () => {}, waitForExit: async () => {},
      } as never;
      return session;
    },
  } as CliAdapter;
}

async function turnWithHostTools(names: string[]) {
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
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
    const host = withHostMcp(["serve", HOST_SHELL_ARG], { PATH: "/bin", [MCP_CONFIG_TEST_KEY]: file });
    const ctx = {
      command: "acme", cwd: "/work", prompt: "do it", modelId: "auto", systemPrompt: "", useResume: false, timeoutMs: 60_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
      ...host,
    } as never;
    for await (const r of createExecute(adapterRecording(prompts, opens), { home: HOME })(ctx)) void r;
  } finally {
    server.close(); server.closeAllConnections();
  }
  return { prompts, opens };
}

it("tells the model the native shell is off and OpenClaw exec is the way, when the host serves exec", async () => {
  const { prompts, opens } = await turnWithHostTools(["exec", "process"]);
  expect(opens[0]).toMatchObject({ hostShell: true });
  expect(prompts.join("\n")).toMatch(/exec/);
});

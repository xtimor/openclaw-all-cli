---
id: 23
type: bug
title: "A denied native shell call tells the model nothing about OpenClaw exec"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# A denied native shell call tells the model nothing about OpenClaw exec

## Description

When a turn serves OpenClaw `exec`, the native shell of `cursor-agent` is denied by the agent's config, and the model gets only Cursor's generic refusal. The plugin tells the model nothing about the shell or about `exec`, so weaker models lose a turn. The manifest row P8, the provider doc, and the parity matrix say the host answers "Use OpenClaw exec"; no code does that. After the fix, the model is told once, in the turn's prompt, where to run commands, and the docs say what ships.

## Reproduction

1. Run a turn on a host whose tool list holds `exec` and `process`.
2. Actual: the prompt the CLI receives is the user's text and nothing else.
3. Expected: the prompt says the native shell is disabled and commands run through OpenClaw `exec` (long ones in the background, polled with `process`).

The test in Notes fails with `expected 'do it' to match /exec/`.

## Cause Hypothesis

The core reads `hostShell` from the host's tool list only to pick the session mode. No text about the shell reaches the system prompt or the turn prompt, and the native shell is refused locally by the static deny, so the host is never asked and never answers.

## Acceptance Criteria

1. **The model is told where to run commands**
   **Given** a turn whose host tool list has `exec`
   **When** the plugin sends the turn to the CLI
   **Then** the prompt holds one short sentence: the native shell is disabled, run commands with the OpenClaw `exec` tool, long ones in the background and polled with `process`
2. **No text without exec**
   **Given** a turn whose host tool list has no `exec`
   **When** the plugin sends the turn
   **Then** the prompt has no such sentence
3. **No CLI named in the core**
   **Given** the sentence is neutral core text or adapter text
   **When** the architecture and import tests run
   **Then** they pass (AD-2)
4. **The docs say what ships**
   **Given** the P8 row in the Cursor manifest, the parity matrix, and `docs/providers/cursor.md`
   **When** they are read
   **Then** none claims the host answers "Use OpenClaw exec" to a denied native shell; each says the plugin tells the model in the prompt
5. **Tests**
   **Given** the test suite
   **When** `npm run ci` runs
   **Then** the reproduction test (committed as `test/shell-hint.test.ts`, test name `tells the model the native shell is off`) and a test of criterion 2 pass

## Boundaries

- Must not change: permissions, the mode choice, the `exec` and `process` serving, and the continuity text of a resumed turn.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/76
- parity — _bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md, row P8
- doc — docs/providers/cursor.md, row P8 and "Shell commands"

## Notes

- Issue: #76
- Code to read: turn prompt composition and `execute` under `src/core/`, the Cursor manifest under `src/adapters/cursor/`.
- Triage reproduced it on `main` `082fee7d7ec0cfd833b2270d531262a14e7e102b`. Reproduction test, to be added first as `test/shell-hint.test.ts` (rename its test to `tells the model the native shell is off ...`):

```ts
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
```

  Failing output: `AssertionError: expected 'do it' to match /exec/`.
- Assumption: the sentence goes in the turn prompt (core, neutral text) so it works for any adapter; the build may place it in the system prompt if the delivery rules need that, and records a `Decision:`.

---
id: 24
type: bug
title: "GPT models under cursor-cli never call structured_output, so every run with an outputSchema fails"
parent: none
covers: []
after: []
assignee: ""
refined: true
hitl: false
risk: low
severity: P2
---

# GPT models under cursor-cli never call structured_output, so every run with an outputSchema fails

## Description

When a run has an `outputSchema`, OpenClaw serves a `structured_output` tool and the run only succeeds if the model calls it. A GPT model behind `cursor-cli` answers in prose and skips the tool, so the run ends `failed` with `structured_output was not called`; a Claude model on the same build calls it. The plugin tells the model nothing about the tool. After the fix, a turn whose host tool list holds `structured_output` carries one imperative sentence in its prompt: the final answer goes through that tool, prose alone fails the run. Turns without the tool get no sentence.

## Reproduction

1. Run a turn on a host whose tool list holds `structured_output`.
2. Actual: the prompt the CLI receives is the user's text and nothing else.
3. Expected: the prompt tells the model to give its final answer through `structured_output`.

The test in Notes fails with `expected 'do it' to contain 'structured_output'`. Live (owner, 2026-11-08, same build): `cursor-cli/gpt-5.5` ended `failed`, `cursor-cli/claude-opus-5-5` ended `done`.

## Cause Hypothesis

The core reads the host's tool list (`listToolNames` in `src/core/execute.ts`) only to pick the session mode and the shell sentence (ticket 23). No text about `structured_output` reaches the prompt, so a model that does not infer the need from the tool's description skips it.

## Acceptance Criteria

1. **The model is told to answer through the tool**
   **Given** a turn whose host tool list has `structured_output`
   **When** the plugin sends the turn to the CLI
   **Then** the prompt holds one short imperative sentence: the final answer must be given by calling the OpenClaw `structured_output` tool, an answer in prose alone fails the run
2. **No text without the tool**
   **Given** a turn whose host tool list has no `structured_output`
   **When** the plugin sends the turn
   **Then** the prompt has no such sentence
3. **Delivery follows the shell sentence**
   **Given** the sentence is part of the first prompt of a process, as the shell sentence of ticket 23 is
   **When** a later turn reuses the process
   **Then** the sentence is not repeated by accident of the reuse, and a later turn on a process whose first prompt lacked it (the tool was not listed then, but is now) still gets it once; the build records the delivery rule as a `Decision:`
4. **No CLI named in the core**
   **Given** the sentence is neutral core text
   **When** the architecture and import tests run
   **Then** they pass (AD-2)
5. **The docs say what ships**
   **Given** `docs/providers/cursor.md` and the parity matrix where they cover structured output or the turn prompt
   **When** they are read
   **Then** they say the plugin tells the model in the prompt to answer through `structured_output`, and that a model may still skip it (no re-prompt)
6. **Tests**
   **Given** the test suite
   **When** `npm run ci` runs
   **Then** the reproduction test (committed as `test/structured-output-hint.test.ts`, test name `tells the model to answer through structured_output when the host serves that tool`) and a test of criterion 2 pass

## Boundaries

- Must not change: permissions, the mode choice, the `exec` and `process` serving, the shell sentence, and the continuity text of a resumed turn.
- Out of scope: a one-shot re-prompt when the turn ends without the call.
- No change to `.github/`, `scripts/`, `_bmad/`, `.claude/`, `docs/agents/`, `AGENTS.md`, or protected `package.json` fields.

## References

- parent — none
- issue — https://github.com/xtimor/openclaw-all-cli/issues/75
- prior art — ticket 23 (`src/core/turn-prompt.ts` `shellNote`, `src/core/execute.ts`, `src/core/live-entry.ts`)
- doc — docs/providers/cursor.md

## Notes

- Issue: #75
- Verify: `npx vitest run test/structured-output-hint.test.ts -t "tells the model to answer through structured_output"` and `npm test`.
- Triage reproduced it on `main` `082fee7d7ec0cfd833b2270d531262a14e7e102b`. Reproduction test, to be added first as `test/structured-output-hint.test.ts` (rename its test to `tells the model to answer through structured_output when the host serves that tool`; merge helpers with `test/shell-hint.test.ts` if that file already holds the same ones):

```ts
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createExecute, HOST_SHELL_ARG } from "../src/core/execute.ts";
import { createManifest, type CliAdapter, type CliSession, type NormalizedEvent, type OpenParams } from "../src/core/ports.ts";
import { MCP_CONFIG_TEST_KEY, withHostMcp } from "./fixtures/host-mcp.ts";

const HOME = { dir: "/agent/openclaw-all-cli/acme-cli", env: { ACME_HOME: "/agent/openclaw-all-cli/acme-cli" } };

function adapterRecording(prompts: string[], opens: OpenParams[]): CliAdapter {
  return {
    id: "acme", displayName: "Acme", command: "acme", launchArgs: ["serve"], defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}), alwaysOnNativeTools: ["read"], clearEnv: [],
    checkVersion: async () => "ok", probeAuth: async () => "available", listModels: async () => [],
    prepareHome: async (home: string) => ({ ACME_HOME: home }),
    open: async (params: OpenParams) => {
      opens.push(params);
      const session = {
        sessionId: "native-1", alive: true,
        prompt: (text: string) => {
          prompts.push(text);
          return (async function* (): AsyncGenerator<NormalizedEvent> {
            yield { kind: "result", text: "ok", stopReason: "end_turn" };
          })();
        },
        cancel: async () => {}, close: async () => {}, waitForExit: async () => {},
      } as unknown as CliSession;
      return session;
    },
  } as unknown as CliAdapter;
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

describe("structured_output hint", () => {
  it("tells the model to answer through structured_output when the host serves that tool", async () => {
    const { prompts } = await turnWithHostTools(["read", "structured_output"]);
    expect(prompts.join("\n")).toContain("structured_output");
  });
});
```

  Failing output: `AssertionError: expected 'do it' to contain 'structured_output'`.
- Assumption: the sentence goes in the first prompt of the process like the shell sentence; the build may choose another delivery and records a `Decision:`.

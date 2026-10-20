import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, expect, it } from "vitest";
import { parseStatusOutput } from "../../src/adapters/cursor/index.ts";
import { LIVE, LIVE_TIMEOUT_MS, describeLive, openclawAsync, startToggleProxy, type ToggleProxy } from "./harness.ts";

// Errors (AD-11, ticket 20). A failed Cursor turn is one final reply chunk with `end_turn`
// (cursor-agent 2026.10.19); the plugin must turn it into an OpenClaw error turn. A CONNECT proxy
// that starts refusing the model-turn host after `session/new` forces the failure from outside.
// Run `npm run dev:install` first. Needs a Cursor login or CURSOR_API_KEY; without one the row is
// skipped (record it as not run).
const hasLogin =
  LIVE &&
  (Boolean(process.env.CURSOR_API_KEY?.trim()) ||
    parseStatusOutput(
      spawnSync(process.env.CURSOR_AGENT_BIN ?? "cursor-agent", ["status"], { encoding: "utf8", timeout: 15_000 }).stdout ?? "",
    ) === "available");

describeLive("Cursor errors are error turns, not reply text (AD-11)", () => {
  let proxy: ToggleProxy;

  // The OpenClaw run (and the cursor-agent it starts) reaches the network through the toggle proxy.
  // The host re-applies the process's own proxy variables over the plugin config `env`, so they go
  // in the run's environment. Async: the proxy runs in this process, and a blocking spawn would
  // stop it from answering.
  const ask = (message: string) =>
    openclawAsync(["agent", "--local", "--model", "cursor-cli/auto", "--session-id", `live-errors-${Date.now()}`, "--message", message, "--json"], {
      timeoutMs: 240_000,
      env: { HTTPS_PROXY: proxy.url, https_proxy: proxy.url, GLOBAL_AGENT_HTTPS_PROXY: proxy.url, NODE_USE_ENV_PROXY: "1" },
    });

  beforeAll(async () => {
    proxy = await startToggleProxy();
  });

  afterAll(async () => {
    await proxy?.close();
  });

  it.skipIf(!hasLogin)(
    "answers normally while the proxy lets Cursor through, and fails the turn once the model host is refused",
    async () => {
      proxy.allow();
      const control = await ask("Say hi");
      expect(control.status, control.stderr + control.stdout).toBe(0);

      proxy.block();
      const failed = await ask("Say hi again");
      const output = failed.stderr + failed.stdout;
      // The model host was reached for, and refused.
      expect(proxy.seen.some((entry) => entry.blocked), `no refused connection: ${JSON.stringify(proxy.seen)}`).toBe(true);
      // An error turn: a failed run, whose message is the plugin's (it names the failure in words
      // the host classifies), and no assistant reply holding Cursor's raw error text.
      expect(failed.status, output).not.toBe(0);
      expect(output).toMatch(/Cursor (internal server error|authentication failed|rate limit reached|is overloaded|timed out)/);
      const start = failed.stdout.indexOf("{");
      let json: { payloads?: Array<{ text?: string }>; result?: { payloads?: Array<{ text?: string }> } } | undefined;
      try {
        json = start >= 0 ? JSON.parse(failed.stdout.slice(start)) : undefined;
      } catch {
        json = undefined;
      }
      expect(json, `stdout is not JSON: ${failed.stdout}`).toBeDefined();
      const reply = [...(json!.payloads ?? []), ...(json!.result?.payloads ?? [])].map((payload) => payload.text ?? "").join("\n");
      expect(reply).not.toContain("Error:");
      expect(reply).not.toMatch(/Cursor (internal server error|authentication failed|rate limit reached|is overloaded|timed out)/);
    },
    LIVE_TIMEOUT_MS * 2,
  );
});

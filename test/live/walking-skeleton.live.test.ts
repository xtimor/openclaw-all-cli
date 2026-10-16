import { expect, it } from "vitest";
import { LIVE_TIMEOUT_MS, describeLive, openclaw, replyLines } from "./harness.ts";

// Parity rows P1 (provider and model ref), P2 (login counts as auth), P3 (reply text).
// Run `npm run dev:install` first so the isolated OpenClaw has the built plugin.
describeLive("walking skeleton: cursor-cli/auto answers a prompt (P1, P2, P3)", () => {
  it("loads the plugin and registers the cursor-cli backend", () => {
    const inspect = openclaw(["plugins", "inspect", "openclaw-all-cli", "--runtime", "--json"]);
    expect(inspect.status).toBe(0);
    const report = JSON.parse(inspect.stdout);
    expect(report.plugin.status).toBe("loaded");
    expect(report.plugin.cliBackendIds).toContain("cursor-cli");
  }, LIVE_TIMEOUT_MS);

  it("prints Cursor's reply to `openclaw agent --model cursor-cli/auto`", () => {
    const run = openclaw(["agent", "--local", "--model", "cursor-cli/auto", "--message", "Say hi"], {
      timeoutMs: 240_000,
    });
    expect(run.status).toBe(0);
    expect(replyLines(run.stdout).length).toBeGreaterThan(0);
    expect(run.stderr + run.stdout).not.toMatch(/cli terminal failure/);
  }, LIVE_TIMEOUT_MS);
});

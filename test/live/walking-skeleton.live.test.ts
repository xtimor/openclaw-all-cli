import { expect, it } from "vitest";
import { LIVE_TIMEOUT_MS, describeLive, openclaw, replyLines } from "./harness.ts";

// Parity rows P1 (provider and model ref), P2 (login counts as auth), P3 (reply text).
// Run `npm run dev:install` first so the isolated OpenClaw has the built plugin. The plugin-load
// check needs no login and lives in test/isolated-openclaw.test.ts.
describeLive("walking skeleton: cursor-cli/auto answers a prompt (P1, P2, P3)", () => {
  it("prints Cursor's reply to `openclaw agent --model cursor-cli/auto`", () => {
    // A fresh session id every run: a stored binding from an earlier run would make Cursor try
    // `session/load` on a session it never had.
    const sessionId = `live-${Date.now()}`;
    const run = openclaw(
      ["agent", "--local", "--model", "cursor-cli/auto", "--session-id", sessionId, "--message", "Say hi"],
      { timeoutMs: 240_000 },
    );
    expect(run.status).toBe(0);
    expect(replyLines(run.stdout).length).toBeGreaterThan(0);
    expect(run.stderr + run.stdout).not.toMatch(/cli terminal failure/);
  }, LIVE_TIMEOUT_MS);
});

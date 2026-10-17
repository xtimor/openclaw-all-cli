import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, liveHostEnv, openclaw, replyLines, startGateway, type TestGateway } from "./harness.ts";

type Row = { id: string; name: string; provider: string; available?: boolean; unavailableReason?: string };

const PORT = 18_912;

/** Cursor keeps the last model it ran in the per-agent config; this reads the base ID it recorded. */
function selectedModelId(): string | undefined {
  const home = homeDirFor(join(ISOLATED_STATE_DIR, "agents", "main", "agent"), "cursor-cli");
  const config = JSON.parse(readFileSync(join(home, "cli-config.json"), "utf8")) as { selectedModel?: { modelId?: string } };
  return config.selectedModel?.modelId;
}

// Parity rows P1 (the account's models in /model, selecting one runs on it) and P2 (the login or
// CURSOR_API_KEY makes them available). Run `npm run dev:install` first. Needs a Cursor login or
// CURSOR_API_KEY, and a host where `cursor-agent` can reach its servers.
describeLive("model catalog and model selection in the isolated OpenClaw (P1, P2)", () => {
  let gateway: TestGateway;
  let rows: Row[] = [];
  let exact = new Map<string, string>();

  beforeAll(async () => {
    // The plugin loads at Gateway startup only when the config names it (OpenClaw #148584).
    const set = openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]);
    expect(set.status).toBe(0);
    // Cursor's own listing, by exact ID.
    const listed = await cursorAdapter.listModels({
      command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
      args: cursorAdapter.launchArgs,
      env: liveHostEnv(),
    });
    exact = new Map(listed.map((model) => [model.name, model.id]));
    gateway = await startGateway(PORT);
    // The catalog is prepared in the background after startup; ask for it until it holds Cursor rows.
    for (let attempt = 0; attempt < 10 && rows.length === 0; attempt += 1) {
      const call = openclaw(["gateway", "call", "models.list", "--params", '{"refresh":true}', "--port", String(PORT), "--json", "--timeout", "60000"], {
        timeoutMs: 90_000,
      });
      if (call.status === 0) {
        rows = (JSON.parse(call.stdout) as { models: Row[] }).models.filter((model) => model.provider === "cursor-cli");
      }
    }
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    openclaw(["config", "unset", "agents.defaults.model.primary"]);
  });

  it("lists the account's Cursor models as cursor-cli/<name>, available", async () => {
    expect(rows.length).toBeGreaterThan(2);
    expect(rows.map((row) => row.id)).toContain("auto");
    for (const row of rows) {
      expect(row.id).toMatch(/^[a-z0-9._-]+$/);
      expect(row.available).toBe(true);
    }
    expect(new Set(rows.map((row) => row.id)).size).toBe(rows.length);

    // The same models Cursor's own session lists, with exact IDs that carry brackets.
    expect(rows.map((row) => row.id).sort()).toEqual([...exact.keys()].sort());
    expect([...exact.values()].some((id) => id.includes("["))).toBe(true);
  }, LIVE_TIMEOUT_MS);

  it("appears in `openclaw models list --provider cursor-cli`", () => {
    const list = openclaw(["models", "list", "--provider", "cursor-cli"], { env: gateway.env });
    expect(list.status).toBe(0);
    expect(list.stdout).toContain("cursor-cli/auto");
    expect(list.stdout.split("\n").filter((line) => line.startsWith("cursor-cli/")).length).toBe(rows.length);
  }, LIVE_TIMEOUT_MS);

  it("runs a turn on the selected non-auto model, and Auto again afterwards", () => {
    // A model the plan lets the account use is not known in advance: try the cheap ones first.
    const candidates = [...rows.map((row) => row.id).filter((id) => id !== "auto")].sort(
      (a, b) => Number(b.startsWith("composer")) - Number(a.startsWith("composer")),
    );
    let ran: string | undefined;
    for (const name of candidates.slice(0, 4)) {
      const run = openclaw(
        ["agent", "--model", `cursor-cli/${name}`, "--session-id", `live-model-${Date.now()}`, "--message", "Reply with the single word: ok"],
        { timeoutMs: 240_000, env: gateway.env },
      );
      if (run.status === 0 && replyLines(run.stdout).length > 0 && !/upgrade your plan/i.test(run.stdout + run.stderr)) {
        ran = name;
        break;
      }
    }
    expect(ran, "no non-auto model answered").toBeDefined();
    // Cursor records the model it ran in the per-agent config.
    expect(selectedModelId()).toBe(exact.get(ran!)!.split("[")[0]);
    expect(selectedModelId()).not.toBe("default");

    const auto = openclaw(
      ["agent", "--model", "cursor-cli/auto", "--session-id", `live-auto-${Date.now()}`, "--message", "Reply with the single word: ok"],
      { timeoutMs: 240_000, env: gateway.env },
    );
    expect(auto.status).toBe(0);
    expect(selectedModelId()).toBe("default");
  }, LIVE_TIMEOUT_MS * 2);

  it("fails an unknown model with model_not_found", () => {
    const run = openclaw(
      ["agent", "--model", "cursor-cli/no-such-model", "--session-id", `live-missing-${Date.now()}`, "--message", "hi"],
      { timeoutMs: 120_000, env: gateway.env },
    );
    expect(run.stdout + run.stderr).toMatch(/no model "no-such-model"/);
  }, LIVE_TIMEOUT_MS);
});

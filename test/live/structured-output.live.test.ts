import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterAll, beforeAll, expect, it } from "vitest";
import { cursorCatalog } from "../regression/harness.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw, openclawAsync, openclawVersion, startGateway, waitFor, type TestGateway } from "./harness.ts";

const PORT = 18_980;
/** The GPT model of issue #75 and of the owner's live check of it (2026-11-08: failed before the fix, Opus done). */
const GPT_MODEL = "cursor-cli/gpt-5.5";
const SCHEMA = { type: "object", properties: { reply: { type: "string" } }, required: ["reply"] };
const CONFIG_KEYS = ["agents.defaults.model.primary", "tools.swarm.enabled"] as const;

type SubagentRun = { model?: string; collectorCompletion?: { status?: string; structured?: { reply?: unknown }; schemaError?: string } };

/** The host's own record of the collector children a session spawned (`subagent_runs` in the state database). */
function childRuns(sessionId: string): SubagentRun[] {
  const db = new DatabaseSync(join(ISOLATED_STATE_DIR, "state", "openclaw.sqlite"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT payload_json FROM subagent_runs WHERE controller_session_key LIKE ? OR requester_session_key LIKE ? ORDER BY created_at")
      .all(`%${sessionId}`, `%${sessionId}`) as Array<{ payload_json: string }>;
    return rows.map((row) => JSON.parse(row.payload_json) as SubagentRun);
  } finally {
    db.close();
  }
}

// Issue #75 at the live tier, as the issue reproduced it: a collector child with an output schema (`sessions_spawn`
// with `collect: true`, `context: "isolated"`, the issue's schema and task) on a GPT model under cursor-cli. Before the
// fix the GPT child answered "ok" in prose, never called `structured_output`, and the run failed with "structured_output
// was not called". The parent turn (cursor-cli/auto) only starts the child and waits for it; the evidence is the host's
// own record of the child (model, status, structured result), not any model's words. The child's model has to be in the
// Gateway's model catalog: OpenClaw 2026.11 and later take theirs from catalog.openclaw.ai, so where that catalog lists
// no cursor-cli model (no network to it) the check skips with that reason; 2026.10.x lists the plugin's own rows and
// never skips.
describeLive("structured output of a GPT model (#75)", () => {
  let gateway: TestGateway | undefined;
  const prior = new Map<string, string | undefined>();
  let catalogSkip: string | undefined;

  const readConfig = (key: string) => {
    const result = openclaw(["config", "get", key, "--json"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  };

  beforeAll(async () => {
    for (const key of CONFIG_KEYS) prior.set(key, readConfig(key));
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    expect(openclaw(["config", "set", "tools.swarm.enabled", "true", "--strict-json"]).status).toBe(0);
    gateway = await startGateway(PORT);
    const [year, month] = openclawVersion();
    const listed = () => {
      const rows = cursorCatalog(PORT);
      return "error" in rows ? [] : rows.cursor;
    };
    const found = await waitFor(() => listed().includes(GPT_MODEL.slice("cursor-cli/".length)), 90_000, 3_000);
    if (!found) {
      const rows = listed();
      if ((year > 2026 || (year === 2026 && month >= 11)) && rows.length === 0) {
        catalogSkip = `OpenClaw ${year}.${month} lists no cursor-cli model here (its catalog comes from catalog.openclaw.ai), so no child can be spawned on ${GPT_MODEL}`;
      } else {
        expect.fail(`the Gateway's model catalog does not list ${GPT_MODEL}: ${rows.join(", ") || "no cursor-cli row"}`);
      }
    }
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    for (const key of CONFIG_KEYS) {
      const value = prior.get(key);
      if (value === undefined) openclaw(["config", "unset", key]);
      else openclaw(["config", "set", key, value, "--strict-json"]);
    }
  }, 120_000);

  it(
    "#75: a collector child with an outputSchema on cursor-cli/gpt-5.5 answers through structured_output and ends done",
    async (ctx) => {
      if (catalogSkip) ctx.skip(catalogSkip);
      const sessionId = `live-structured-${Date.now()}`;
      const spawn = { task: "Reply with exactly the word: ok", model: GPT_MODEL, collect: true, context: "isolated", outputSchema: SCHEMA };
      const message = [
        "Call the OpenClaw tool sessions_spawn exactly once with these arguments:",
        JSON.stringify(spawn),
        "Then call the OpenClaw tool agents_wait for that child and wait until it has finished.",
        "Then reply with the child's status and its structured result, copied from the tool result.",
      ].join("\n");
      const run = await openclawAsync(["agent", "--session-id", sessionId, "--message", message, "--json", "--timeout", "240"], { env: gateway!.env, timeoutMs: 280_000 });
      const raw = `${run.stdout}\n${run.stderr}`;
      expect(raw, "OpenClaw's budget compaction failed the parent turn (not #75)").not.toMatch(/transcript compaction failed/);
      expect(run.status, raw.slice(-2_000)).toBe(0);
      const children = childRuns(sessionId);
      expect(children.length, `the parent turn spawned no child: ${raw.slice(0, 1_500)}`).toBe(1);
      const child = children[0]!;
      const evidence = JSON.stringify({ model: child.model, collectorCompletion: child.collectorCompletion });
      expect(child.model, evidence).toBe(GPT_MODEL);
      expect(child.collectorCompletion?.schemaError, evidence).toBeUndefined();
      expect(child.collectorCompletion?.status, evidence).toBe("done");
      expect(String(child.collectorCompletion?.structured?.reply ?? "").trim(), evidence).toMatch(/^ok\.?$/i);
    },
    LIVE_TIMEOUT_MS,
  );
});

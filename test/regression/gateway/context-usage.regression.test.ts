import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { replyLines } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  chatPids,
  REGRESSION_TIMEOUT_MS,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  gatewayCall,
  linesOf,
  promptText,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

/**
 * A Cursor listing shaped like the one in bugs #12 and #46 (cursor-agent 2026.10.16 / 2026.10.22 `session/new`): rows
 * with their own `context=` value, a row whose family has a known window but no value, rows with no known window,
 * and Opus 5.5 as the 300k row ACP reports. Real Cursor lists no `context=1m` row over ACP and refuses every 1M ID it
 * did not list; the listing here also has one `context=1m` variant (the matrix row of ticket 4.3), listed after the
 * 300k row, so the scenario shows what #46 settled for a 1M row the ACP does list: its own model with its own
 * 1,000,000 window, the 300k row keeping its name and window, and no 1M row the listing did not have.
 */
const MODELS = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "grok-4.7[context=256k,reasoning_effort=high]", name: "Grok 4.7" },
  { modelId: "claude-opus-5-5[context=300k,effort=medium,fast=false]", name: "Opus 5.5" },
  { modelId: "claude-opus-5[effort=high]", name: "Opus 5" },
  { modelId: "fake-mini[context=200k]", name: "fake-mini" },
  { modelId: "composer-2.5[fast=true]", name: "Composer 2.5" },
  { modelId: "claude-opus-5-5[context=1m,effort=medium,fast=false]", name: "Opus 5.5" },
];
/** The listed 1M variant's name: the bare name stays with the first Opus 5.5 row, so this one takes its values. */
const LISTED_1M = "claude-opus-5-5-1m-medium-false";
/** The windows the plugin must publish for those rows (own value, else the family's); the rest have none. */
const WINDOWS: Record<string, number> = {
  "grok-4.7": 256_000,
  "claude-opus-5-5": 300_000,
  "claude-opus-5": 300_000,
  "fake-mini": 200_000,
  [LISTED_1M]: 1_000_000,
};
/** The model the usage turns run on, and its window. */
const USAGE_MODEL = "grok-4.7";
const USAGE_WINDOW = WINDOWS[USAGE_MODEL]!;

// Gateway scenarios for past context-window and context-usage bugs (epic-regression-gate ticket 3): the windows the
// Gateway's catalog publishes per cursor-cli model, and the context reading it keeps for a session over turns. One
// Gateway for the file, the packed plugin, fake-cursor-agent as the CLI with the listing above.
// Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: context windows and the context reading", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-context-"));
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store"), FAKE_CURSOR_MODELS: JSON.stringify(MODELS) });
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": `cursor-cli/${USAGE_MODEL}` });
    gateway = await startRegressionGateway(await freePort(), { onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(() => finishRegression({ stop: stopGateway, fakes: [fake], root }), 120_000);

  // #12: every cursor-cli row was published with no window, so OpenClaw showed and budgeted 128k for all of them.
  // #46: a 1M row the ACP did not list is one it refuses (`Invalid model value`), so the plugin builds none; a 1M
  // row the ACP lists is its own model with its own window.
  it(
    "#12/#46: the Gateway's catalog gives each cursor-cli row its own context window and offers no 1M row the ACP did not list",
    async (ctx) => {
      // OpenClaw 2026.11.10 offline lists no model at all (its catalog comes from catalog.openclaw.ai), so the
      // windows cannot be read through the Gateway there; startRegressionGateway reports that as `empty`.
      if (gateway!.catalog === "empty") ctx.skip(`OpenClaw ${process.env.OPENCLAW_VERSION} lists no model offline: models.list is empty for every provider`);
      const listed = gatewayCall(gateway!.port, "models.list", {});
      const rows = ((listed?.models ?? []) as Array<{ id?: string; provider?: string; contextWindow?: number }>).filter((row) => row.provider === "cursor-cli");
      const evidence = `cursor-cli rows:\n${rows.map((row) => `${row.id}: ${row.contextWindow}`).join("\n")}`;
      const windowOf = Object.fromEntries(rows.map((row) => [row.id, row.contextWindow]));
      expect(Object.keys(windowOf).sort(), evidence).toEqual(["auto", "claude-opus-5", "claude-opus-5-5", "composer-2.5", "fake-mini", "grok-4.7", LISTED_1M].sort());
      for (const [id, window] of Object.entries(WINDOWS)) expect(windowOf[id], `${id}\n${evidence}`).toBe(window);
      // The rows the Gateway returned, not the expectation above, carry more than one window.
      const published = new Set(rows.map((row) => row.contextWindow).filter((window) => typeof window === "number"));
      expect(published.size, evidence).toBeGreaterThan(1);
      // No row the ACP refuses: the only row with a 1M window or a 1M name is the one the listing had.
      const oneM = rows.filter((row) => (row.contextWindow ?? 0) >= 1_000_000 || /1m/i.test(row.id ?? "")).map((row) => row.id);
      expect(oneM, evidence).toEqual([LISTED_1M]);
    },
    REGRESSION_TIMEOUT_MS,
  );

  /** The session row's context reading as the Control UI tile reads it (`totalTokens`), with the row for evidence. */
  const contextReading = (key: string): { reading: number | undefined; row: unknown } => {
    const listed = gatewayCall(gateway!.port, "sessions.list", {});
    const row = ((listed?.sessions ?? []) as Array<{ key?: string; totalTokens?: number }>).find((session) => session.key === key);
    return { reading: typeof row?.totalTokens === "number" ? row.totalTokens : undefined, row };
  };

  /**
   * Runs the turns on one fresh session, each answering with its own ACP usage, and returns the session's context
   * reading after each turn (with the evidence: the usage sent, the row, the CLI output).
   */
  const runUsageTurns = async (name: string, usages: Array<Record<string, number>>) => {
    const tag = randomUUID().slice(0, 8);
    const sessionId = `regression-${name}-${tag}`;
    const key = `agent:main:explicit:${sessionId}`;
    const readings: Array<number | undefined> = [];
    const notes: string[] = [];
    const logFrom = readFakeLog(fake!.log).length;
    for (const [index, usage] of usages.entries()) {
      const reply = `${name}${tag}t${index}`;
      const run = await gatewayAgentTurn(gateway!.port, sessionId, `[[usage:${JSON.stringify(usage)}]] say:${reply}`);
      const output = `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(replyLines(run.stdout), output).toEqual([reply]);
      const { reading, row } = contextReading(key);
      readings.push(reading);
      const tokens = Object.fromEntries(Object.entries((row ?? {}) as Record<string, unknown>).filter(([field]) => /token|context/i.test(field)));
      notes.push(`turn ${index + 1}: usage ${JSON.stringify(usage)} -> session ${JSON.stringify(tokens)}`);
    }
    // The model each turn ran on: the last model switch the turn's Cursor chat got before its prompt.
    const lines = readFakeLog(fake!.log).slice(logFrom);
    const models = usages.map((_, index) => {
      const marker = `say:${name}${tag}t${index}`;
      const pids = chatPids(lines, marker);
      const own = pids.length === 1 ? linesOf(lines, pids[0]!) : [];
      const at = own.findIndex((line) => line.method === "session/prompt" && promptText(line).includes(marker));
      const chat = own[at]?.params?.sessionId;
      const switches = own
        .slice(0, Math.max(at, 0))
        .filter((line) => line.params?.sessionId === chat)
        .flatMap((line) =>
          line.method === "session/set_model" ? [line.params.modelId] : line.method === "session/set_config_option" && line.params.configId === "model" ? [line.params.value] : [],
        );
      return pids.length === 1 ? switches.at(-1) : `(${pids.length} processes got this prompt: ${pids.join(",")})`;
    });
    notes.push(`model of each turn's chat: ${JSON.stringify(models)}`);
    return { readings, models, evidence: notes.join("\n") };
  };

  /** Every turn ran on the model whose window the readings are held to. */
  const expectUsageModel = (models: unknown[], evidence: string) =>
    expect(models, `the turns ran on another model than ${MODELS[1]!.modelId}\n${evidence}`).toEqual(models.map(() => MODELS[1]!.modelId));

  /** Every reading is within the window, and no reading is below an earlier one. */
  const expectBoundedAndRising = (readings: Array<number | undefined>, evidence: string) => {
    expect(readings[0], `the first, plain turn gives a reading\n${evidence}`).toBeTypeOf("number");
    let high = 0;
    for (const [index, reading] of readings.entries()) {
      if (reading === undefined) continue;
      expect(reading, `turn ${index + 1} reads above the ${USAGE_WINDOW} window\n${evidence}`).toBeLessThanOrEqual(USAGE_WINDOW);
      expect(reading, `turn ${index + 1} reads lower than an earlier turn\n${evidence}`).toBeGreaterThanOrEqual(high);
      high = reading;
    }
  };

  // ACP usage of a plain turn: one model request, its prompt mostly cached.
  const plain = (input: number, cacheRead: number, output: number) => ({
    inputTokens: input,
    cachedReadTokens: cacheRead,
    outputTokens: output,
    totalTokens: input + cacheRead + output,
  });

  // #40: a tool-heavy Cursor turn reports usage summed over every model request (the cached prompt counted once per
  // request), and OpenClaw read that sum as the context size: the tile showed 5.6M of a 256k window.
  it(
    "#40: a tool-heavy turn's summed usage never reads as a context above the model's window",
    async () => {
      const { readings, models, evidence } = await runUsageTurns("summed", [
        plain(5_074, 10_240, 31),
        { inputTokens: 100_000, cachedReadTokens: 5_400_000, outputTokens: 86_800, totalTokens: 5_586_800 },
        plain(5_200, 10_400, 40),
      ]);
      expectUsageModel(models, evidence);
      expectBoundedAndRising(readings, evidence);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #97 (incomplete fix of #40): a turn with fewer requests than the one before reports a smaller sum, and the tile
  // went down although the conversation only grew.
  it(
    "#97: the context reading does not go down when a plain turn follows a tool-heavy one",
    async () => {
      const { readings, models, evidence } = await runUsageTurns("falling", [
        plain(5_074, 10_240, 31),
        { inputTokens: 10_000, cachedReadTokens: 90_000, outputTokens: 900, totalTokens: 100_900 },
        plain(5_300, 10_500, 50),
      ]);
      expectUsageModel(models, evidence);
      expectBoundedAndRising(readings, evidence);
    },
    REGRESSION_TIMEOUT_MS,
  );
});

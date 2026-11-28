import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayCall,
  runsOfflineCatalog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";
import { launchBrowser, pollUntil, withUiPage, type UiPage } from "./browser.ts";

/** A listing with the 256k model of the Gateway tier's context scenarios (and Auto). */
const MODELS = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "grok-4.7[context=256k,reasoning_effort=high]", name: "Grok 4.7" },
];
const USAGE_MODEL = "grok-4.7";
const USAGE_WINDOW = 256_000;

/** A number as the tile writes it ("15.3k", "256k", "5.6M", "812"). */
const tokens = (text: string) => Number(text.replace(/[kKmM]$/, "")) * (/[kK]$/.test(text) ? 1_000 : /[mM]$/.test(text) ? 1_000_000 : 1);
/** The tile's reading and window from its label ("Session context usage: 15.3k of 256k (6%)"), or undefined. */
const parseTile = (label: string | null) => {
  const match = label ? /([\d.]+[kKmM]?)\s+of\s+([\d.]+[kKmM]?)/.exec(label) : null;
  return match ? { used: tokens(match[1]!), limit: tokens(match[2]!) } : undefined;
};

// Control UI checks of the chat's context tile (epic-regression-gate ticket 4.6): what the owner sees above the composer
// after each turn. One Gateway for the file, fake-cursor-agent as the CLI with a 256k model as the default, turns typed
// into the chat composer in the browser; each turn answers with its own ACP usage (`[[usage:<json>]]`), the conditions of
// the Gateway tier's #40/#97 scenarios (context-usage.regression.test.ts). The browser reaches only the Gateway.
// OpenClaw 2026.11.x offline has no model catalog (catalog.openclaw.ai), so no session has a context window and the chat
// draws no tile: the file starts no Gateway there and skips its checks.
// Run with `scripts/regression.sh ui [--openclaw <version>]`.
describeRegression("Control UI: the chat's context tile", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;
  const catalogRuns = runsOfflineCatalog();
  const version = () => process.env.OPENCLAW_VERSION ?? "(unknown)";

  beforeAll(async () => {
    if (!catalogRuns) return;
    root = mkdtempSync(join(tmpdir(), "oac-regression-ui-tile-"));
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store"), FAKE_CURSOR_MODELS: JSON.stringify(MODELS) });
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": `cursor-cli/${USAGE_MODEL}` });
    gateway = await startRegressionGateway(await freePort(), { timeoutMs: 120_000, emptyMs: 120_000, logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
    if (gateway.catalog !== "cursor-cli") throw new Error(`OpenClaw ${version()} runs the catalog offline, but it never listed cursor-cli.`);
    browser = await launchBrowser();
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      await finishRegression({ stop: stopGateway, fakes: [fake], root });
    }
  }, 120_000);

  /** The session row's context reading (`totalTokens`), which the tile shows, with the row's token fields. */
  const sessionReading = (key: string) => {
    const listed = gatewayCall(gateway!.port, "sessions.list", {});
    const row = ((listed?.sessions ?? []) as Array<Record<string, unknown>>).find((session) => session.key === key);
    const fields = Object.fromEntries(Object.entries(row ?? {}).filter(([field]) => /token|context/i.test(field)));
    return { reading: typeof row?.totalTokens === "number" ? row.totalTokens : undefined, fields };
  };

  /**
   * Opens a fresh chat session in the browser and types each turn into the composer; after each reply, reads the
   * tile once it agrees with the session row (within its rounding) or after 30 s. Returns the readings (undefined: no
   * tile) and the evidence of every turn.
   */
  const runTurns = async (ui: UiPage, name: string, usages: Array<Record<string, number>>) => {
    const tag = randomUUID().slice(0, 8);
    const key = `agent:main:explicit:regression-ui-${name}-${tag}`;
    await ui.page.goto(ui.url(`/chat?session=${encodeURIComponent(key)}`), { waitUntil: "load" });
    const composer = ui.page.getByRole("textbox", { name: "Chat composer" });
    await composer.waitFor({ timeout: 30_000 });
    const tile = ui.page.locator('[aria-label^="Session context usage"]').first();
    const label = () => tile.getAttribute("aria-label", { timeout: 500 }).catch(() => null);
    const readings: Array<{ used: number; limit: number } | undefined> = [];
    const notes: string[] = [];
    for (const [index, usage] of usages.entries()) {
      const reply = `${name}${tag}t${index}`;
      await composer.fill(`[[usage:${JSON.stringify(usage)}]] say:${reply}`);
      await composer.press("Enter");
      const answered = await ui.page
        .getByText(reply, { exact: true })
        .last()
        .waitFor({ timeout: 120_000 })
        .then(() => true, () => false);
      expect(answered, `turn ${index + 1} got no reply ${reply}\n${await ui.evidence(undefined, notes.join("\n"))}`).toBe(true);
      // The tile is read only once the session row holds this turn's usage (its own input and output counts), so a
      // reading still left from the turn before cannot pass for this turn's.
      let row = await pollUntil(
        async () => sessionReading(key),
        (current) => current.fields.inputTokens === usage.inputTokens && current.fields.outputTokens === usage.outputTokens,
        30_000,
        500,
      );
      expect(
        [row.fields.inputTokens, row.fields.outputTokens],
        `turn ${index + 1}: the session row never took this turn's usage (row ${JSON.stringify(row.fields)})\n${await ui.evidence(undefined, notes.join("\n"))}`,
      ).toEqual([usage.inputTokens, usage.outputTokens]);
      const agrees = (text: string | null) => {
        row = sessionReading(key);
        const shown = parseTile(text);
        if (row.reading === undefined) return shown === undefined;
        return shown !== undefined && Math.abs(shown.used - row.reading) <= Math.max(51, row.reading * 0.01);
      };
      const shown = await pollUntil(label, agrees, 30_000, 1_000);
      readings.push(parseTile(shown));
      notes.push(`turn ${index + 1}: usage ${JSON.stringify(usage)} -> tile ${JSON.stringify(shown)}, session ${JSON.stringify(row.fields)}`);
    }
    // The tile after each turn, in the tier's log too (a green run shows what it read).
    console.info(`${name}:\n${notes.join("\n")}`);
    return { readings, evidence: notes.join("\n") };
  };

  /** The first reading is there with the model's window; no reading is above the window or below an earlier one. */
  const expectBoundedAndRising = async (ui: UiPage, readings: Array<{ used: number; limit: number } | undefined>, notes: string) => {
    const evidence = await ui.evidence(undefined, notes);
    expect(readings[0], `the tile shows no reading after the first, plain turn\n${evidence}`).toBeDefined();
    let high = 0;
    for (const [index, reading] of readings.entries()) {
      if (reading === undefined) continue;
      expect(reading.limit, `turn ${index + 1}: the tile's window is not the ${USAGE_MODEL} window\n${evidence}`).toBe(USAGE_WINDOW);
      expect(reading.used, `turn ${index + 1}: the tile reads above the ${USAGE_WINDOW} window\n${evidence}`).toBeLessThanOrEqual(USAGE_WINDOW);
      expect(reading.used, `turn ${index + 1}: the tile reads lower than after an earlier turn\n${evidence}`).toBeGreaterThanOrEqual(high);
      high = reading.used;
    }
  };

  const plain = (input: number, cacheRead: number, output: number) => ({
    inputTokens: input,
    cachedReadTokens: cacheRead,
    outputTokens: output,
    totalTokens: input + cacheRead + output,
  });

  // #40: a tool-heavy turn's usage, summed over its model requests, showed as the context: "5.6M of 256k".
  it(
    "#40: the context tile never shows more than the model's window after a tool-heavy turn",
    async (ctx) => {
      if (!catalogRuns) ctx.skip(`OpenClaw ${version()} has no model catalog offline, so no session has a context window and the chat draws no tile`);
      await withUiPage(browser!, gateway!.port, "40-context-tile", async (ui) => {
        const { readings, evidence } = await runTurns(ui, "summed", [
          plain(5_074, 10_240, 31),
          { inputTokens: 100_000, cachedReadTokens: 5_400_000, outputTokens: 86_800, totalTokens: 5_586_800 },
          plain(5_200, 10_400, 40),
        ]);
        await expectBoundedAndRising(ui, readings, evidence);
      });
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #97 (incomplete fix of #40): a plain turn after a tool-heavy one reported a smaller sum, and the tile went down.
  it(
    "#97: the context tile does not go down when a plain turn follows a tool-heavy one",
    async (ctx) => {
      if (!catalogRuns) ctx.skip(`OpenClaw ${version()} has no model catalog offline, so no session has a context window and the chat draws no tile`);
      await withUiPage(browser!, gateway!.port, "97-context-tile", async (ui) => {
        const { readings, evidence } = await runTurns(ui, "falling", [
          plain(5_074, 10_240, 31),
          { inputTokens: 10_000, cachedReadTokens: 90_000, outputTokens: 900, totalTokens: 100_900 },
          plain(5_300, 10_500, 50),
        ]);
        await expectBoundedAndRising(ui, readings, evidence);
      });
    },
    REGRESSION_TIMEOUT_MS,
  );
});

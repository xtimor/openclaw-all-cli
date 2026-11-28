import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openclaw } from "../../live/harness.ts";
import {
  REGRESSION_TIMEOUT_MS,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayCall,
  readFakeLog,
  runsOfflineCatalog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";
import { closeDialog, launchBrowser, openConnectDialog, pollUntil, readProviderCard, removeKeyButton, submitKey, withUiPage, type UiPage } from "./browser.ts";

/** The plugin's whole cursor-cli config entry. */
const CURSOR_CONFIG_KEY = "plugins.entries.openclaw-all-cli.config.cursor-cli";

// Control UI checks of a saved key's two buttons on the provider card (epic-regression-gate ticket 4.6): Test connection
// and Remove key. One Gateway for the file, fake-cursor-agent as the CLI, and no default model: so OpenClaw 2026.10.3 does
// not load the plugin at the Gateway start, and the card shows a key saved in the browser at once. (With cursor-cli as the
// model it does not, which is bug #106 and the #39 check in provider-card.regression.test.ts; these checks are about the
// buttons of a card that lists the key.) Every key is a dummy. The browser reaches only the Gateway.
// Run with `scripts/regression.sh ui [--openclaw <version>]`.
describeRegression("Control UI: Test connection and Remove key on the cursor-cli card", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;
  const version = () => process.env.OPENCLAW_VERSION ?? "(unknown)";
  /** No default model: OpenClaw 2026.10.3 then loads the plugin only once the config uses cursor-cli. */
  const unsetPrimary = () => {
    const unset = openclaw(["config", "unset", "agents.defaults.model.primary"], { timeoutMs: 30_000 });
    if (unset.status !== 0 && !/not found|no such|does not exist/i.test(`${unset.stdout}${unset.stderr}`)) {
      throw new Error(`openclaw config unset agents.defaults.model.primary failed:\n${unset.stdout}${unset.stderr}`);
    }
  };

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-ui-keys-"));
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store") });
    configure({ [CURSOR_CONFIG_KEY]: { command: fake.command } });
    unsetPrimary();
    // No default model, so no catalog of cursor-cli to wait for at the start.
    gateway = await startRegressionGateway(await freePort(), { waitForCatalog: false, logFile: join(root, "gateway.log"), onStarted: (stop) => (stopGateway = stop) });
    browser = await launchBrowser();
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        if (gateway) gatewayCall(gateway.port, "models.authLogout", { provider: "cursor-cli" });
      } finally {
        await finishRegression({ stop: stopGateway, fakes: [fake], root });
      }
    }
  }, 120_000);

  const ui = <T>(name: string, check: (ui: UiPage) => Promise<T>) => withUiPage(browser!, gateway!.port, name, check);
  /** The auth store's cursor-cli profiles, as `models.probe` (which probes auth-store profiles only) lists them. */
  const storedProfiles = () => {
    const probed = gatewayCall(gateway!.port, "models.probe", { provider: "cursor-cli", timeoutMs: 60_000 }, 90_000);
    expect(Array.isArray(probed?.results), `models.probe answered no results list: ${JSON.stringify(probed).slice(0, 1_500)}`).toBe(true);
    return { ids: (probed.results as Array<{ profileId?: string }>).map((result) => result.profileId), text: JSON.stringify(probed).slice(0, 1_500) };
  };

  /**
   * Saves a dummy key through Connect provider in the browser (unless the store has one) and returns the card once it
   * lists the key (its Remove key / Sign out button), or as it reads after 30 s.
   */
  const saveKeyAndReadCard = async (ui: UiPage) => {
    if (storedProfiles().ids.length === 0) {
      await openConnectDialog(ui);
      const outcome = await submitKey(ui, `regression-dummy-key-${randomUUID().slice(0, 8)}`);
      expect(outcome, `the key was not accepted\n${await ui.evidence(undefined, `dialog:\n${outcome}`)}`).toMatch(/accepted the key/);
      await closeDialog(ui);
    }
    let card = await readProviderCard(ui);
    const started = Date.now();
    while ((!card.present || (await removeKeyButton(card.card).count()) === 0) && Date.now() - started < 30_000) {
      await ui.page.waitForTimeout(3_000);
      card = await readProviderCard(ui);
    }
    const evidence = await ui.evidence(card.present ? card.card : undefined, `auth store (models.probe): ${storedProfiles().text}`);
    expect(card.present, `the Models page draws no cursor-cli card for the saved key\n${evidence}`).toBe(true);
    expect(await removeKeyButton(card.card).count(), `the card does not list the saved key\n${evidence}`).toBeGreaterThan(0);
    return card;
  };

  // Test connection probes the card's saved profiles with one real turn each (`models.probe`): the plugin's stream hook runs
  // a one-line prompt on the CLI. OpenClaw 2026.11.x offline answers the probe `format` without running the CLI (ticket
  // 4.9), and its card's "Test access" says "Invalid response" for every provider, so the check runs on 2026.10.x.
  it(
    "Test connection: a saved key's Test connection reports Connected, and the CLI ran the probe's one turn",
    async (ctx) => {
      if (!runsOfflineCatalog()) ctx.skip(`OpenClaw ${version()} answers models.probe "format" offline without running the CLI, so Test access cannot reach the plugin`);
      try {
        await ui("test-connection", async (ui) => {
          await saveKeyAndReadCard(ui);
          // The probe runs on the agent's model for the provider, else on a row of the prepared catalog, which has no
          // cursor-cli row while the plugin was not loaded at the Gateway start: make cursor-cli the model now (the
          // owner's setup), after the save, so the card keeps listing the key (#106 is about a plugin loaded at start).
          configure({ "agents.defaults.model.primary": "cursor-cli/auto" });
          const card = await saveKeyAndReadCard(ui);
          const button = card.card.getByRole("button", { name: /^Test (connection|access)/ }).first();
          const before = await ui.evidence(card.card);
          expect(await button.count(), `the card offers no Test connection\n${before}`).toBe(1);
          const logFrom = readFakeLog(fake!.log).length;
          await button.click();
          const status = card.card.getByRole("status");
          const text = await pollUntil(
            async () => (await status.allInnerTexts().catch(() => [] as string[])).join("\n"),
            (value) => /Connected|failed|error|invalid|timed? ?out|unavailable|no model/i.test(value),
            90_000,
            1_000,
          );
          const prompts = readFakeLog(fake!.log).slice(logFrom).filter((line) => line.method === "session/prompt");
          const evidence = await ui.evidence(card.card, `status after Test connection: ${JSON.stringify(text)}\nsession/prompt lines since the click: ${prompts.length}`);
          expect(text, `Test connection does not report Connected\n${evidence}`).toMatch(/\bConnected\b/);
          expect(text, `Test connection does not name the saved profile\n${evidence}`).toContain("cursor-cli:default");
          expect(prompts.length, `the probe did not run exactly one turn on the CLI\n${evidence}`).toBe(1);
          });
      } finally {
        unsetPrimary();
      }
    },
    REGRESSION_TIMEOUT_MS,
  );

  // Remove key (2026.11.x: the account's "Sign out of <account>?", confirmed with Sign out) removes the saved profile from
  // the auth store (`models.authLogout`, PR #92), and the card no longer lists a key.
  it(
    "Remove key: the card's Remove key empties its key line and the auth store",
    async () => {
      await ui("remove-key", async (ui) => {
        const card = await saveKeyAndReadCard(ui);
        const before = await ui.evidence(card.card);
        await removeKeyButton(card.card).first().click();
        // 2026.11.x asks first; 2026.10.x removes at once.
        const confirm = ui.page.getByRole("button", { name: "Sign out", exact: true });
        if (await confirm.waitFor({ timeout: 3_000 }).then(() => true, () => false)) await confirm.click();
        const stored = await pollUntil(async () => storedProfiles(), (value) => value.ids.length === 0, 30_000, 2_000);
        let current = await readProviderCard(ui);
        const started = Date.now();
        while (current.present && (await removeKeyButton(current.card).count()) > 0 && Date.now() - started < 30_000) {
          await ui.page.waitForTimeout(3_000);
          current = await readProviderCard(ui);
        }
        const evidence = await ui.evidence(current.present ? current.card : undefined, `card before Remove key:\n${before}\nauth store (models.probe): ${stored.text}`);
        expect(stored.ids, `the auth store keeps the removed key\n${evidence}`).toEqual([]);
        if (current.present) {
          expect(await removeKeyButton(current.card).count(), `the card still lists the removed key\n${evidence}`).toBe(0);
          expect(current.text, `the card still reads as signed in\n${evidence}`).not.toMatch(/Credentials configured|Provider profiles/);
        }
      });
    },
    REGRESSION_TIMEOUT_MS,
  );
});

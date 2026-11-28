import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Browser } from "playwright";
import { afterAll, beforeAll, expect, it } from "vitest";
import { waitFor } from "../../live/harness.ts";
import {
  REGRESSION_TIMEOUT_MS,
  configure,
  cursorCatalog,
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
import {
  GROUP_LABEL,
  METHOD_LABEL,
  closeDialog,
  launchBrowser,
  modalText,
  openConnectDialog,
  pollUntil,
  readProviderCard,
  removeKeyButton,
  samePixels,
  submitKey,
  withUiPage,
} from "./browser.ts";

/** The plugin's whole cursor-cli config entry: setting it replaces `command` and drops any `env` a case set. */
const CURSOR_CONFIG_KEY = "plugins.entries.openclaw-all-cli.config.cursor-cli";
const ROOT = join(import.meta.dirname, "..", "..", "..");
/** The packaged icon: what `/__openclaw__/plugin-icon/openclaw-all-cli` must serve (re-encoded by the host: same pixels). */
const ICON = readFileSync(join(ROOT, "assets", "icon.png"));
/**
 * The setup page's icon for the API key choice: the raw GitHub URL of the packaged icon on the default branch (#45), built
 * from package.json's repository, so a manifest that loses its `icon` cannot also change what is expected.
 */
const MANIFEST_ICON = (() => {
  const repository = (JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as { repository: { url: string } }).repository.url;
  const [, owner, repo] = /github\.com\/([^/]+)\/([^/.]+)/.exec(repository) ?? [];
  return `https://raw.githubusercontent.com/${owner}/${repo}/main/assets/icon.png`;
})();

// Control UI checks of the provider's icon, name, and card (epic-regression-gate ticket 4.6): what the owner sees in the
// browser. One Gateway for the file (the Gateway tier's harness: packed plugin, fresh state, `--auth none`),
// fake-cursor-agent as the CLI, logged in, cursor-cli as the model, so the plugin loads at the Gateway start (the owner's
// setup, and the condition of bug #106 on OpenClaw 2026.10.3). Every key is a dummy. The browser reaches only the Gateway.
// Run with `scripts/regression.sh ui [--openclaw <version>]`.
describeRegression("Control UI: the cursor-cli provider's icon, name, and card", () => {
  let root: string | undefined;
  let base: FakeCommand | undefined;
  const fakes: FakeCommand[] = [];
  let catalogRuns = false;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;

  const shim = (name: string, env: Record<string, string> = {}) => {
    const fake = fakeCommand(root!, name, { FAKE_CURSOR_STORE: join(root!, "store"), ...env });
    fakes.push(fake);
    return fake;
  };
  const nonce = () => randomUUID().slice(0, 8);
  const version = () => process.env.OPENCLAW_VERSION ?? "(unknown)";

  beforeAll(async () => {
    catalogRuns = runsOfflineCatalog();
    root = mkdtempSync(join(tmpdir(), "oac-regression-ui-card-"));
    mkdirSync(join(root, "store"));
    base = shim("cursor-agent");
    configure({ [CURSOR_CONFIG_KEY]: { command: base.command }, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), {
      logFile: join(root, "gateway.log"),
      ...(catalogRuns ? { timeoutMs: 120_000, emptyMs: 120_000 } : {}),
      onStarted: (stop) => (stopGateway = stop),
    });
    if (catalogRuns && gateway.catalog !== "cursor-cli") throw new Error(`OpenClaw ${version()} runs the catalog offline, but it never listed cursor-cli.`);
    browser = await launchBrowser();
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    try {
      await browser?.close();
    } finally {
      try {
        // The config and the auth store outlive this file: no key, profile, or shim of a case stays.
        if (gateway) {
          try {
            gatewayCall(gateway.port, "models.authLogout", { provider: "cursor-cli" });
          } finally {
            configure({ [CURSOR_CONFIG_KEY]: { command: base!.command } });
          }
        }
      } finally {
        await finishRegression({ stop: stopGateway, fakes, root });
      }
    }
  }, 120_000);

  const ui = <T>(name: string, check: Parameters<typeof withUiPage<T>>[3]) => withUiPage(browser!, gateway!.port, name, check);
  /** The auth store's cursor-cli profiles, as Test connection (`models.probe`) sees them: it probes auth-store profiles only. */
  const storedProfiles = () => {
    const probed = gatewayCall(gateway!.port, "models.probe", { provider: "cursor-cli", timeoutMs: 60_000 }, 90_000);
    return { ids: ((probed?.results ?? []) as Array<{ profileId?: string }>).map((result) => result.profileId), text: JSON.stringify(probed).slice(0, 1_500) };
  };
  const waitCatalog = async (holds: (ids: string[]) => boolean, timeoutMs = 60_000) => {
    const read = () => {
      const rows = cursorCatalog(gateway!.port);
      return "error" in rows ? { cursor: [] as string[], error: rows.error } : { cursor: rows.cursor, error: undefined };
    };
    let last = read();
    await waitFor(() => holds((last = read()).cursor) && last.error === undefined, timeoutMs, 2_000);
    return last;
  };
  /** Points cursor-cli at the file's logged-in shim again (no key) and, where the catalog runs, waits until it lists again. */
  const restoreBase = async () => {
    configure({ [CURSOR_CONFIG_KEY]: { command: base!.command } });
    if (catalogRuns) await waitCatalog((ids) => ids.length > 1);
  };

  // #35: OpenClaw drew no plugin icon (the package shipped none); #45: the model setup page showed none for the API key
  // choice. The package ships `assets/icon.png`, which the host serves at /__openclaw__/plugin-icon/<id> and the Plugins
  // page draws; the manifest gives the choice an `icon` URL the setup page asks for. The provider card, the chat's model
  // picker, and the Connect provider dialog draw a letter avatar for every provider without bundled brand art (upstream
  // openclaw/openclaw#186945), so they are not checked for it.
  it(
    "#35/#45: the Plugins page draws the packaged icon, and the model setup page asks for the manifest icon of the API key choice",
    async () => {
      await ui("35-45-icon", async (ui) => {
        await ui.page.goto(ui.url("/settings/plugins"), { waitUntil: "load" });
        const row = ui.page.locator("[data-plugin-id]").filter({ has: ui.page.getByText("OpenClaw All CLI", { exact: true }) }).first();
        await row.waitFor({ timeout: 30_000 }).catch(() => {});
        await row.scrollIntoViewIfNeeded().catch(() => {});
        const icon = row.locator("img").first();
        const width = await pollUntil(() => icon.evaluate((img) => (img as unknown as { naturalWidth: number }).naturalWidth).catch(() => 0), (value) => value > 0, 30_000);
        const served = ui.pluginIcons.filter((response) => response.url.endsWith("/__openclaw__/plugin-icon/openclaw-all-cli"));
        const evidence = await ui.evidence(
          row,
          `plugin icon responses for openclaw-all-cli: ${JSON.stringify(served.map(({ url, status, contentType, body }) => ({ url, status, contentType, bytes: body?.length })))}`,
        );
        expect(await row.count(), `the Plugins page lists no "OpenClaw All CLI" row\n${evidence}`).toBe(1);
        expect(width, `the "OpenClaw All CLI" row draws no icon image\n${evidence}`).toBeGreaterThan(0);
        expect(served.map((response) => [response.status, response.contentType]), evidence).toContainEqual([200, "image/png"]);
        const body = served.find((response) => response.status === 200)?.body;
        const pixels = body ? await samePixels(ui.context, body, ICON) : { same: false, sizes: [] };
        expect(pixels, `the served icon is not the packaged assets/icon.png (decoded sizes ${pixels.sizes.join(" vs ")})\n${evidence}`).toMatchObject({ same: true });

        // The model setup page (a first run's "Set up a model"): its provider picker asks the Gateway's catalog-icon proxy for
        // each choice's `icon`; the request is recorded and aborted, never loaded (it would reach raw.githubusercontent.com).
        await ui.page.goto(ui.url("/settings/model-setup?firstRun=1"), { waitUntil: "load" });
        const picker = ui.page.getByRole("button", { name: /^Provider and access method/ }).first();
        await picker.waitFor({ timeout: 30_000 });
        await picker.click();
        const choice = ui.page.getByRole("menuitemradio", { name: new RegExp(`^${GROUP_LABEL.replace(/[/]/g, "\\/")}, ${METHOD_LABEL.replace(/[()]/g, "\\$&")}`) }).first();
        await choice.waitFor({ timeout: 30_000 }).catch(() => {});
        await pollUntil(async () => ui.catalogIcons.includes(MANIFEST_ICON), Boolean, 15_000);
        const setupEvidence = await ui.evidence(choice, `catalog icons the setup page asked for: ${JSON.stringify(ui.catalogIcons)}`);
        expect(await choice.count(), `the setup page's provider picker has no ${GROUP_LABEL} API key choice\n${setupEvidence}`).toBe(1);
        expect(ui.catalogIcons, `the setup page never asked for the API key choice's manifest icon ${MANIFEST_ICON}\n${setupEvidence}`).toContain(MANIFEST_ICON);
      });
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #36: the provider read "Cursor-CLI", the name of another plugin; it reads "OAC / Cursor-CLI" (manifest `groupLabel`).
  // The provider card's own title is the host's rendering of the ID ("Cursor Cli"), not a label the plugin gives.
  it(
    "#36: the Connect provider dialog names the provider OAC / Cursor-CLI, never a bare Cursor CLI",
    async () => {
      await ui("36-name", async (ui) => {
        const listed = await openConnectDialog(ui);
        const evidence = await ui.evidence(undefined, `Connect provider dialog:\n${listed}`);
        const lines = listed.split("\n").map((line) => line.trim());
        expect(lines.filter((line) => /^cursor[ -]?cli$/i.test(line)), `the Connect provider dialog lists the provider under a bare name\n${evidence}`).toEqual([]);
        expect(lines, `the Connect provider dialog does not list ${GROUP_LABEL}\n${evidence}`).toContain(GROUP_LABEL);
        // Choosing it opens the plugin's own method.
        await ui.page.getByText(GROUP_LABEL, { exact: true }).first().click();
        const methods = await pollUntil(() => modalText(ui), (text) => text.includes(METHOD_LABEL), 30_000);
        expect(methods, await ui.evidence(undefined, `dialog after choosing ${GROUP_LABEL}:\n${methods}`)).toContain(METHOD_LABEL);
        await closeDialog(ui);
      });
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #39: the card read "Not configured" although the provider worked. A key saved with the API key method is an auth profile
  // the card lists, with Remove key. On OpenClaw 2026.10.3 this stays red until bug #106 is fixed: a Gateway that loaded the
  // plugin at start (cursor-cli as the model, the owner's setup) does not show the saved profile in `models.authStatus`.
  it(
    "#39: a key saved through Connect provider in the browser shows on the provider card with Remove key, not Not configured",
    async () => {
      try {
        await ui("39-card", async (ui) => {
          await openConnectDialog(ui);
          const outcome = await submitKey(ui, `regression-dummy-key-${nonce()}`);
          const dialogEvidence = await ui.evidence(undefined, `dialog:\n${outcome}`);
          expect(outcome, `the key was not accepted\n${dialogEvidence}`).toMatch(/accepted the key/);
          await closeDialog(ui);
          // The card reads the Gateway's auth status after the dialog: give its snapshot a moment (30 s) to catch up.
          let card = await readProviderCard(ui);
          const started = Date.now();
          while ((!card.present || (await removeKeyButton(card.card).count()) === 0) && Date.now() - started < 30_000) {
            await ui.page.waitForTimeout(3_000);
            card = await readProviderCard(ui);
          }
          const stored = storedProfiles();
          const evidence = await ui.evidence(
            card.present ? card.card : undefined,
            `auth store (models.probe): ${JSON.stringify(stored.ids)}` +
              (catalogRuns
                ? `\nOn OpenClaw ${version()} this is bug #106: a Gateway that loaded the plugin at start (cursor-cli is the model) does not show a profile saved later in models.authStatus, so the card keeps reading Not configured although the auth store has the profile.`
                : ""),
          );
          expect(stored.ids, `the saved key is not in the auth store\n${evidence}`).toEqual(["cursor-cli:default"]);
          expect(card.present, `the Models page draws no cursor-cli card 30 s after the save (#106 on 2026.10.3)\n${evidence}`).toBe(true);
          expect(card.text, `the card still reads Not configured 30 s after the save (#106 on 2026.10.3)\n${evidence}`).not.toContain("Not configured");
          expect(await removeKeyButton(card.card).count(), `the card offers no Remove key for the saved key (#106 on 2026.10.3)\n${evidence}`).toBeGreaterThan(0);
        });
      } finally {
        gatewayCall(gateway!.port, "models.authLogout", { provider: "cursor-cli" });
      }
    },
    REGRESSION_TIMEOUT_MS,
  );
  // #98: the provider reported authenticated with an invalid CURSOR_API_KEY. The key the owner types is checked with
  // `cursor-agent about` before it is saved; a key in the plugin config is checked by the login probe (2026.10.x catalog).
  it(
    "#98: a key cursor-agent refuses is reported invalid in Connect provider and not saved, and the card does not show the provider as signed in",
    async () => {
      const refused = shim("cursor-agent-refused", { FAKE_CURSOR_ABOUT: "invalid" });
      configure({ [CURSOR_CONFIG_KEY]: { command: refused.command } });
      try {
        if (catalogRuns) await waitCatalog((ids) => ids.length > 1);
        await ui("98-refused-key", async (ui) => {
          const before = await readProviderCard(ui);
          const logFrom = readFakeLog(refused.log).length;
          await openConnectDialog(ui);
          const outcome = await submitKey(ui, `regression-dummy-refused-${nonce()}`);
          const checked = readFakeLog(refused.log).slice(logFrom).filter((line) => line.method === "about" && line.keyed === true);
          const evidence = await ui.evidence(undefined, `dialog:\n${outcome}\nkeyed about runs: ${checked.length}`);
          expect(outcome, `the dialog does not say the refused key is invalid and unsaved\n${evidence}`).toMatch(/says the key is invalid\. It was not saved/);
          expect(outcome, evidence).not.toMatch(/accepted the key/);
          expect(checked.length, `the key was never checked with cursor-agent about\n${evidence}`).toBeGreaterThan(0);
          await closeDialog(ui);

          const after = await readProviderCard(ui);
          const cardEvidence = await ui.evidence(after.present ? after.card : undefined, `card before the dialog: ${JSON.stringify(before.text)}`);
          if (after.present) {
            expect(await removeKeyButton(after.card).count(), `the card offers to remove a key that was refused\n${cardEvidence}`).toBe(0);
          }
          if (catalogRuns) expect(after.text, `the card does not read Not configured\n${cardEvidence}`).toContain("Not configured");
          const stored = storedProfiles();
          expect(stored.ids, `the refused key is in the auth store (models.probe ${stored.text})\n${cardEvidence}`).toEqual([]);
        });

        // The same refused key in the plugin config: the login probe checks it with `about` and counts no login, so the card
        // lists no cursor-cli model (2026.10.x; 2026.11.x runs no provider catalog offline, so its card shows no models anyway).
        if (catalogRuns) {
          const probeFrom = readFakeLog(refused.log).length;
          configure({ [CURSOR_CONFIG_KEY]: { command: refused.command, env: { CURSOR_API_KEY: `regression-dummy-refused-${nonce()}` } } });
          // The catalog runs again for the changed config and probes the key with `about` first.
          await waitFor(() => readFakeLog(refused.log).slice(probeFrom).some((line) => line.method === "about" && line.keyed === true), 60_000, 500);
          const rows = await waitCatalog((ids) => ids.length === 0, 60_000);
          await ui("98-refused-config-key", async (ui) => {
            const card = await readProviderCard(ui);
            const evidence = await ui.evidence(card.present ? card.card : undefined, `models.list cursor-cli rows: ${JSON.stringify(rows)}`);
            expect(card.text, `the card lists cursor-cli models on a key cursor-agent refused\n${evidence}`).not.toMatch(/\b[1-9]\d* models?\b/);
          });
        }
      } finally {
        try {
          gatewayCall(gateway!.port, "models.authLogout", { provider: "cursor-cli" });
        } finally {
          await restoreBase();
        }
      }
    },
    REGRESSION_TIMEOUT_MS,
  );

});

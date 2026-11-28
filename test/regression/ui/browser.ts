import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Browser, BrowserContext, Locator, Page } from "playwright";

/**
 * Browser helpers for the Control UI regression tier (epic-regression-gate ticket 4.6): Playwright's Chromium against
 * the Control UI of a Gateway the gateway harness started (`startRegressionGateway`, `--auth none`). The page reaches
 * nothing but that Gateway: every other request and WebSocket is aborted and recorded, and so are the Gateway's own catalog-icon
 * proxy requests (`/__openclaw__/catalog-icon/<url>`, which would make the Gateway fetch the URL from the network), so
 * a check reads such an icon by the URL the page asked for, never by its pixels. A failing check leaves a screenshot
 * and the page's text in `uiArtifactDir()`, and every assertion message names that screenshot.
 *
 * Selectors are visible text and roles (and OpenClaw's `data-provider-id` to scope one provider's card); never the
 * hashed names in OpenClaw's bundle. Labels differ between OpenClaw versions (2026.10.x "Connect provider", "Test
 * connection", "Remove key"; 2026.11.x "Add account", "Test access", "Sign out of <account>?"): the helpers accept both.
 *
 * Playwright is imported only when a browser starts, so `npm test` (where the tier is skipped) never loads it.
 */

/** Where failure screenshots and page texts go: `OPENCLAW_ALL_CLI_UI_ARTIFACTS` (scripts/regression.sh sets it), else beside the tier state. */
export function uiArtifactDir(): string {
  return process.env.OPENCLAW_ALL_CLI_UI_ARTIFACTS || join(process.env.SPIKE_DIR ?? ".", "..", "ui-screenshots");
}

/**
 * Starts headless Chromium. `OPENCLAW_ALL_CLI_CHROMIUM` names a Chromium executable when Playwright's own download is
 * not where it looks (a local fallback only; CI installs the pinned Playwright's browser).
 */
export async function launchBrowser(): Promise<Browser> {
  const { chromium } = await import("playwright");
  const executablePath = process.env.OPENCLAW_ALL_CLI_CHROMIUM?.trim();
  return chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

export type UiPage = {
  page: Page;
  context: BrowserContext;
  /** Requests and WebSockets the page tried to open anywhere but the Gateway (aborted). */
  blocked: string[];
  /** The icon URLs the page asked the Gateway's catalog-icon proxy for, decoded (aborted: never loaded). */
  catalogIcons: string[];
  /** The screenshot a failure of this check leaves. */
  screenshot: string;
  /** `http://127.0.0.1:<port><path>`. */
  url(path: string): string;
  /**
   * Evidence for an assertion message: the page URL, the screenshot path, what was blocked, and the visible text of
   * `scope` (the element the check is about; default: the whole page), cut to a readable length.
   */
  evidence(scope?: Locator, note?: string): Promise<string>;
};

const slug = (name: string) => name.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "check";

/** The visible text of `locator` (its first match), or why there is none; never throws. */
export async function visibleText(locator: Locator, timeoutMs = 2_000): Promise<string> {
  try {
    return (await locator.first().innerText({ timeout: timeoutMs })).trim();
  } catch (error) {
    return `(no text: ${(error instanceof Error ? error.message : String(error)).split("\n")[0]})`;
  }
}

/**
 * Runs `check` on a fresh page (its own browser context) of the Gateway on `port`. When `check` throws, the page's
 * screenshot and text are saved under `uiArtifactDir()` (as `<name>.png` / `<name>.txt`) before the error goes on, so
 * the screenshot path that `evidence` put in the message exists. The context is closed either way.
 */
export async function withUiPage<T>(browser: Browser, port: number, name: string, check: (ui: UiPage) => Promise<T>): Promise<T> {
  const dir = uiArtifactDir();
  const base = join(dir, slug(name));
  const origin = `http://127.0.0.1:${port}`;
  const context = await browser.newContext({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1, serviceWorkers: "block" });
  const blocked: string[] = [];
  const catalogIcons: string[] = [];
  const own = (url: string) => url === origin || url.startsWith(`${origin}/`);
  // The Control UI's WebSocket goes to the Gateway (ws://127.0.0.1:<port>); any other is closed unopened.
  const wsOrigin = origin.replace(/^http/, "ws");
  await context.routeWebSocket(/.*/, (socket) => {
    const url = socket.url();
    if (url === wsOrigin || url.startsWith(`${wsOrigin}/`) || url.startsWith(`${wsOrigin}?`)) {
      socket.connectToServer();
      return;
    }
    blocked.push(url);
    void socket.close({ code: 1008, reason: "regression tier: not the Gateway" }).catch(() => {});
  });
  await context.route("**/*", async (route) => {
    const url = route.request().url();
    if (!own(url)) {
      blocked.push(url);
      return route.abort("blockedbyclient");
    }
    const catalog = /\/__openclaw__\/catalog-icon\/(.+)$/.exec(url);
    if (catalog) {
      catalogIcons.push(decodeURIComponent(catalog[1]!));
      return route.abort("blockedbyclient");
    }
    return route.continue();
  });
  const page = await context.newPage();
  const ui: UiPage = {
    page,
    context,
    blocked,
    catalogIcons,
    screenshot: `${base}.png`,
    url: (path) => `${origin}${path}`,
    evidence: async (scope, note) => {
      const text = await visibleText(scope ?? page.locator("body"));
      return [
        ...(note ? [note] : []),
        `URL: ${page.url()}`,
        `screenshot: ${base}.png (page text: ${base}.txt)`,
        ...(blocked.length > 0 ? [`blocked (not the Gateway): ${[...new Set(blocked)].slice(0, 10).join(", ")}`] : []),
        `--- ${scope ? "element" : "page"} text:`,
        text.length > 3_000 ? `${text.slice(0, 3_000)}\n...(cut)` : text,
      ].join("\n");
    },
  };
  try {
    return await check(ui);
  } catch (error) {
    mkdirSync(dir, { recursive: true });
    try {
      await page.screenshot({ path: `${base}.png`, fullPage: true, timeout: 15_000 });
    } catch (shot) {
      console.warn(`ui: no screenshot for ${name}: ${shot instanceof Error ? shot.message : String(shot)}`);
    }
    try {
      writeFileSync(`${base}.txt`, `URL: ${page.url()}\n\n${await visibleText(page.locator("body"), 5_000)}\n`);
    } catch {
      // The screenshot is the main evidence.
    }
    throw error;
  } finally {
    await context.close().catch(() => {});
  }
}

/** Polls `read` every `stepMs` until `done` holds for its value or `timeoutMs` passes; returns the last value read. */
export async function pollUntil<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs: number, stepMs = 500): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, stepMs));
    value = await read();
  }
  return value;
}

// --- The Control UI's Models page (/model-providers) ---------------------------------------------------------------

/** The plugin's provider group in Connect provider (manifest `providerAuthChoices[].groupLabel`). */
export const GROUP_LABEL = "OAC / Cursor-CLI";
/** The plugin's API key method in Connect provider (manifest `choiceLabel`), also the label of its key field. */
export const METHOD_LABEL = "Cursor CLI API key (CURSOR_API_KEY)";

/**
 * The text of every open dialog, joined. OpenClaw 2026.10.x draws its dialogs as a `<dialog role="dialog">` in a web
 * component's shadow root with the content slotted from outside (so the dialog element's own text is empty: the text of
 * what its slots show is read instead); 2026.11.x as a plain `role="dialog"` element.
 */
export async function modalText(ui: UiPage): Promise<string> {
  return ui.page.evaluate(() => {
    const out: string[] = [];
    const walk = (root: any) => {
      for (const element of root.querySelectorAll('[role="dialog"]')) {
        if (typeof element.checkVisibility === "function" && !element.checkVisibility()) continue;
        let text = String(element.innerText ?? "").trim();
        if (!text) {
          // Slotted content: the text of what each slot of the dialog shows.
          const parts: string[] = [];
          for (const slot of element.querySelectorAll("slot")) {
            for (const node of slot.assignedNodes({ flatten: true })) parts.push(String(node.innerText ?? node.textContent ?? "").trim());
          }
          text = parts.filter(Boolean).join("\n");
        }
        if (text) out.push(text);
      }
      for (const element of root.querySelectorAll("*")) if (element.shadowRoot) walk(element.shadowRoot);
    };
    walk((globalThis as any).document);
    return out.join("\n---\n");
  });
}

/**
 * Opens the Models page and its Connect provider dialog (2026.10.x: the page's "Connect provider"; 2026.11.x: "Add
 * account"), the page-level button, not a card's (which skips the provider list). Returns the dialog's text once it
 * lists providers (the plugin's group, or after 30 s whatever it shows). The dialog is modal, so the helpers below find
 * its controls by text on the page.
 */
export async function openConnectDialog(ui: UiPage): Promise<string> {
  await ui.page.goto(ui.url("/model-providers"), { waitUntil: "load" });
  const open = ui.page.getByRole("button", { name: /^(Connect provider|Add account)$/ }).first();
  await open.waitFor({ timeout: 30_000 });
  await open.click();
  return pollUntil(() => modalText(ui), (text) => text.includes(GROUP_LABEL), 30_000);
}

/** The dialog texts a key's save ends with: the method's note (accepted) or its refusal, or a host error. */
const SAVE_OUTCOME = /accepted the key|says the key is invalid|could not be checked|did not return a credential profile|could not finish|failed|error/i;

/**
 * In an open Connect provider dialog: picks the plugin's group and its API key method, enters `key`, submits, and
 * waits (up to 90 s) until the dialog shows how the save ended. Returns that dialog text (or what it showed last).
 */
export async function submitKey(ui: UiPage, key: string): Promise<string> {
  await ui.page.getByText(GROUP_LABEL, { exact: true }).first().click();
  await ui.page.getByText(METHOD_LABEL, { exact: true }).last().click();
  const field = ui.page.getByRole("textbox", { name: METHOD_LABEL });
  await field.waitFor({ timeout: 30_000 });
  await field.fill(key);
  await ui.page.getByRole("button", { name: "Submit", exact: true }).click();
  const outcome = await pollUntil(() => modalText(ui), (text) => SAVE_OUTCOME.test(text), 90_000, 1_000);
  // 2026.10.x shows a failed login as "Could not finish" and keeps the method's message in a folded "Details".
  const details = ui.page.getByText("Details", { exact: true }).last();
  if (/Could not finish/i.test(outcome) && (await details.isVisible().catch(() => false))) {
    await details.click();
    return pollUntil(() => modalText(ui), (text) => text !== outcome, 10_000);
  }
  return outcome;
}

/**
 * Ends the dialog after a save: "Continue" past the method's note (which finishes the login), then "Close"/"Cancel"
 * or Escape for whatever stays open. Returns the dialog text after "Continue" (empty when it closed at once).
 */
export async function closeDialog(ui: UiPage): Promise<string> {
  const proceed = ui.page.getByRole("button", { name: "Continue", exact: true });
  let after = "";
  if (await proceed.isVisible().catch(() => false)) {
    await proceed.click();
    after = await pollUntil(() => modalText(ui), (text) => !/accepted the key/.test(text), 30_000);
  }
  for (let round = 0; round < 4 && (await modalText(ui)) !== ""; round += 1) {
    const close = ui.page.getByRole("button", { name: /^(Close|Cancel|Done)$/ }).last();
    if (await close.isVisible().catch(() => false)) await close.click().catch(() => {});
    else await ui.page.keyboard.press("Escape");
    await ui.page.waitForTimeout(700);
  }
  return after;
}

export type ProviderCard = {
  /** Whether the Models page draws a cursor-cli card at all (2026.11.x draws none before a credential exists offline). */
  present: boolean;
  /** The card's visible text (expanded where the card folds its accounts away), or the provider list's text. */
  text: string;
  card: Locator;
};

/**
 * Opens (or reloads) the Models page and reads the cursor-cli card once the provider list has rendered (the card, or the
 * empty list's "No model providers configured"). A folded card (2026.11.x) is expanded first, so its accounts and
 * buttons are part of `text`. `rendered`, when given, is what the card's text must show before it is read.
 */
export async function readProviderCard(ui: UiPage, rendered?: (text: string) => boolean): Promise<ProviderCard> {
  await ui.page.goto(ui.url("/model-providers"), { waitUntil: "load" });
  const card = ui.page.locator('[data-provider-id="cursor-cli"]').first();
  const empty = ui.page.getByText("No model providers configured");
  await pollUntil(async () => (await card.count()) + (await empty.count()), (count) => count > 0, 30_000);
  // The list fills in as the Gateway's answers arrive: wait until the card shows what `rendered` asks for, or the list
  // shows no card (up to 30 s); without `rendered`, give the card's credentials a moment to settle.
  if (rendered) {
    await pollUntil(
      async () => ((await card.count()) > 0 ? rendered(await visibleText(card, 1_000)) : (await empty.count()) > 0),
      Boolean,
      30_000,
    );
  }
  else await ui.page.waitForTimeout(2_000);
  if ((await card.count()) === 0) {
    // No card: the page's provider section (from its "Provider access" heading on), as the evidence of what it drew.
    const body = await visibleText(ui.page.locator("body"), 5_000);
    const from = body.search(/PROVIDER ACCESS/i);
    return { present: false, text: from >= 0 ? body.slice(from) : body, card };
  }
  const fold = card.locator('button[aria-expanded="false"]').first();
  if ((await fold.count()) > 0) {
    await fold.click();
    await ui.page.waitForTimeout(500);
  }
  return { present: true, text: await visibleText(card), card };
}

/** The card's control that removes the saved key: 2026.10.x "Remove key", 2026.11.x the account's "Sign out of <account>?". */
export const removeKeyButton = (card: Locator): Locator => card.getByRole("button", { name: /^(Remove key|Sign out of .+)$/ });

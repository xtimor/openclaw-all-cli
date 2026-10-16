import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LIVE_TIMEOUT_MS, openclaw } from "./live/harness.ts";

/**
 * Needs no Cursor login: loads the built plugin in the isolated OpenClaw. It runs only when
 * `npm run dev:install` has put the toolchain and the plugin under .spike/.
 */
const spike = (path: string) => fileURLToPath(new URL(`../.spike/${path}`, import.meta.url));
const installed =
  existsSync(spike("openclaw/node_modules/.bin/openclaw")) &&
  existsSync(spike("node/bin/node")) &&
  existsSync(spike("state/extensions/openclaw-all-cli/openclaw.plugin.json"));

describe.skipIf(!installed)("plugin in the isolated OpenClaw", () => {
  it("loads and registers the cursor-cli backend", () => {
    const inspect = openclaw(["plugins", "inspect", "openclaw-all-cli", "--runtime", "--json"]);
    expect(inspect.status).toBe(0);
    const report = JSON.parse(inspect.stdout);
    expect(report.plugin.status).toBe("loaded");
    expect(report.plugin.cliBackendIds).toContain("cursor-cli");
  }, LIVE_TIMEOUT_MS);
});

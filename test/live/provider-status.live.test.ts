import { afterAll, beforeAll, expect, it } from "vitest";
import { authLogin, cursorCatalog, gatewayCall } from "../regression/harness.ts";
import { LIVE_TIMEOUT_MS, describeLive, openclaw, openclawVersion, startGateway, waitFor, type TestGateway } from "./harness.ts";

const PORT = 18_981;
const KEY = process.env.CURSOR_API_KEY?.trim() ?? "";
/** Failure messages carry Gateway answers; the key never appears in one. */
const scrub = (text: string) => (KEY ? text.split(KEY).join("<CURSOR_API_KEY>") : text);

// What the Control UI's provider card reads, with the real key against Cursor: the plan quota (OpenClaw's usage
// surfaces call the plugin's `resolveUsageAuth` and `fetchUsageSnapshot` hooks; `usage.status` is their Gateway
// method) and Test connection (`models.probe`, one CLI turn on the saved profile's key). The Gateway tier checks both
// with a fake cursor-agent and a dummy key; here Cursor itself answers. The key reaches the Gateway as CURSOR_API_KEY
// (a credential OpenClaw sees, so it asks for the quota) and, for Test connection, as an auth profile saved through
// the plugin's API key method (Connect provider), removed again at the end.
describeLive("provider status with the real key: plan quota and Test connection", () => {
  let gateway: TestGateway | undefined;
  let priorPrimary: string | undefined;

  beforeAll(async () => {
    expect(KEY, "CURSOR_API_KEY is needed").not.toBe("");
    const read = openclaw(["config", "get", "agents.defaults.model.primary", "--json"]);
    priorPrimary = read.status === 0 ? read.stdout.trim() : undefined;
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    gateway = await startGateway(PORT);
  }, LIVE_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    if (priorPrimary === undefined) openclaw(["config", "unset", "agents.defaults.model.primary"]);
    else openclaw(["config", "set", "agents.defaults.model.primary", priorPrimary, "--strict-json"]);
  }, 120_000);

  it(
    "quota: usage.status gives cursor-cli's Cursor plan quota, present and well formed",
    async () => {
      // The plugin reads the quota on demand; the first read after the Gateway start may still be loading the plugin.
      let answer: any;
      let entry: any;
      await waitFor(
        () => {
          try {
            answer = gatewayCall(PORT, "usage.status", {}, 60_000);
          } catch (error) {
            answer = { error: String(error) };
          }
          entry = (answer?.providers ?? []).find((provider: { provider?: string }) => provider.provider === "cursor-cli");
          return entry !== undefined && Array.isArray(entry.windows) && entry.windows.length > 0;
        },
        90_000,
        5_000,
      );
      const evidence = scrub(JSON.stringify(entry ?? answer)).slice(0, 2_000);
      expect(entry, `usage.status has no cursor-cli quota: ${evidence}`).toBeDefined();
      expect(entry.error, evidence).toBeUndefined();
      expect(entry.displayName, evidence).toBeTypeOf("string");
      expect(entry.windows.length, evidence).toBeGreaterThan(0);
      for (const window of entry.windows as Array<{ label?: unknown; usedPercent?: unknown; resetAt?: unknown }>) {
        expect(window.label, evidence).toBeTypeOf("string");
        // A fresh reading: a stale one says "(stale)" in every label (the quota API did not answer).
        expect(String(window.label), evidence).not.toMatch(/stale/i);
        expect(window.usedPercent, evidence).toBeTypeOf("number");
        expect(window.usedPercent as number, evidence).toBeGreaterThanOrEqual(0);
        expect(window.usedPercent as number, evidence).toBeLessThanOrEqual(100);
        if (window.resetAt !== undefined) expect(window.resetAt as number, evidence).toBeGreaterThan(Date.now() - 24 * 3600_000);
      }
      expect(String(entry.summary ?? ""), evidence).not.toMatch(/stale|unavailable/i);
    },
    LIVE_TIMEOUT_MS,
  );

  it(
    "Test connection: models.probe on cursor-cli is ok with the real key saved through Connect provider",
    async (ctx) => {
      // models.probe needs a model of the provider in the Gateway's catalog. OpenClaw 2026.11 and later take theirs from
      // catalog.openclaw.ai and answer "format" without a CLI turn where that catalog lists no cursor-cli model (no
      // network to it): the check then skips with that reason. 2026.10.x lists the plugin's own rows and never skips.
      const listed = () => {
        const rows = cursorCatalog(PORT);
        return "error" in rows ? [] : rows.cursor;
      };
      const loaded = await waitFor(() => listed().length > 0, 90_000, 3_000);
      const [year, month] = openclawVersion();
      if (!loaded && (year > 2026 || (year === 2026 && month >= 11))) {
        ctx.skip(`OpenClaw ${year}.${month} lists no cursor-cli model here (its catalog comes from catalog.openclaw.ai), so models.probe has nothing to probe`);
      }
      expect(loaded, "the Gateway's model catalog never listed a cursor-cli model").toBe(true);
      const status = gatewayCall(PORT, "models.authStatus", {});
      const capability = (status?.providerCapabilities ?? []).find((entry: { provider?: string }) => entry.provider === "cursor-cli");
      const choice = (capability?.loginOptions ?? []).find((entry: { id?: string }) => entry.id?.endsWith("/cursor-cli-api-key"))?.id as string | undefined;
      expect(choice, `Connect provider offers no cursor-cli API key option: ${scrub(JSON.stringify(capability)).slice(0, 1_500)}`).toBeTypeOf("string");
      const login = await authLogin(PORT, choice!, KEY);
      try {
        expect(login.final?.status, scrub(JSON.stringify(login)).slice(0, 2_000)).toBe("done");
        const probe = gatewayCall(PORT, "models.probe", { provider: "cursor-cli", timeoutMs: 60_000 }, 90_000);
        const evidence = scrub(JSON.stringify(probe)).slice(0, 2_000);
        expect(probe?.status, evidence).toBe("ok");
        expect(probe?.results?.[0]?.profileId, evidence).toBe("cursor-cli:default");
        expect(probe?.results?.[0]?.status, evidence).toBe("ok");
      } finally {
        gatewayCall(PORT, "models.authLogout", { provider: "cursor-cli" });
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

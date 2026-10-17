import { describe, expect, it, vi } from "vitest";
import { homeDirFor, prepareAgentHome } from "./home.ts";
import { CliError, createManifest, type CliAdapter } from "./ports.ts";

function adapterWith(prepareHome: CliAdapter["prepareHome"]): CliAdapter {
  return {
    id: "acme",
    displayName: "Acme",
    command: "acme",
    launchArgs: [],
    defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}),
    alwaysOnNativeTools: [],
    probeAuth: async () => "available",
    listModels: async () => [],
    prepareHome,
    open: async () => {
      throw new Error("not used");
    },
  };
}

describe("prepareAgentHome", () => {
  it("derives <agentDir>/openclaw-all-cli/<backendId> and hands it to the adapter", async () => {
    const prepareHome = vi.fn(async (home: string) => ({ ACME_HOME: home }));
    const home = await prepareAgentHome(adapterWith(prepareHome), "acme-cli", "/state/agents/main/agent");
    expect(home).toEqual({
      dir: "/state/agents/main/agent/openclaw-all-cli/acme-cli",
      env: { ACME_HOME: "/state/agents/main/agent/openclaw-all-cli/acme-cli" },
    });
    expect(prepareHome).toHaveBeenCalledWith(homeDirFor("/state/agents/main/agent", "acme-cli"));
  });

  it("gives two agents two homes", async () => {
    const adapter = adapterWith(async (home) => ({ ACME_HOME: home }));
    const a = await prepareAgentHome(adapter, "acme-cli", "/agents/a");
    const b = await prepareAgentHome(adapter, "acme-cli", "/agents/b");
    expect(a.dir).not.toBe(b.dir);
  });

  it.each([undefined, "", "   "])("fails without an agent directory (%j) and never calls the adapter", async (agentDir) => {
    const prepareHome = vi.fn(async () => ({}));
    const error = await prepareAgentHome(adapterWith(prepareHome), "acme-cli", agentDir).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toMatch(/OpenClaw gave no agent directory/);
    expect(prepareHome).not.toHaveBeenCalled();
  });

  it("wraps an adapter failure in a CliError that names the home", async () => {
    const adapter = adapterWith(async () => {
      throw new Error("EACCES");
    });
    const error = await prepareAgentHome(adapter, "acme-cli", "/agents/a").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect((error as CliError).message).toContain("/agents/a/openclaw-all-cli/acme-cli");
    expect((error as CliError).message).toContain("EACCES");
  });

  it("passes an adapter CliError through", async () => {
    const original = new CliError({ code: "format", message: "bad" });
    const adapter = adapterWith(async () => {
      throw original;
    });
    await expect(prepareAgentHome(adapter, "acme-cli", "/agents/a")).rejects.toBe(original);
  });
});

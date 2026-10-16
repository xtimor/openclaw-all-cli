import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ADAPTERS } from "../src/registry.ts";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { backendIdFor, buildCliBackend, nativeAuthMarkerFor } from "../src/core/backend.ts";
import { createConfigValidator, registerAdapters } from "../src/core/register.ts";
import provider from "../src/provider-discovery.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

describe("cursor-cli backend", () => {
  const backend = buildCliBackend(cursorAdapter, { settings: {} });

  it("registers as cursor-cli with the flags the manifest implies", () => {
    expect(backend.id).toBe("cursor-cli");
    expect(backend.config).toMatchObject({
      command: "cursor-agent",
      args: ["acp"],
      resumeArgs: ["acp"],
      output: "jsonl",
      input: "stdin",
      liveSession: "claude-stdio",
      sessionMode: "existing",
    });
    // Tools stay on until the per-agent permissions land.
    expect(backend.nativeToolMode).toBe("always-on");
    expect(backend.parseJsonlEvent).toBeTypeOf("function");
  });

  it("takes the binary from the plugin config", () => {
    const custom = buildCliBackend(cursorAdapter, { settings: { command: "/opt/cursor-agent" } });
    expect(custom.config.command).toBe("/opt/cursor-agent");
  });

  it("runs a prepared turn end to end against an ACP agent", async () => {
    const prepared = await backend.prepareExecution!({} as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd: process.cwd(),
      env: fakeEnv(),
      prompt: "say:pong",
      modelId: "auto",
      systemPrompt: "",
      useResume: false,
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      records.push(record);
    }
    const parse = backend.parseJsonlEvent!;
    const events = records.map((record) => parse(JSON.stringify(record), {} as never));
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "pong", sessionId: "fake-session-1" });
  });
});

describe("plugin registration", () => {
  it("registers one backend per adapter", () => {
    const registered: string[] = [];
    registerAdapters(
      {
        pluginConfig: { "cursor-cli": { command: "/x/cursor-agent" } },
        logger: { warn: () => {} },
        registerCliBackend: (b: { id: string; config: { command: string } }) => {
          registered.push(`${b.id}:${b.config.command}`);
        },
      } as never,
      ADAPTERS,
    );
    expect(registered).toEqual(["cursor-cli:/x/cursor-agent"]);
  });
});

describe("plugin config validator", () => {
  const validator = createConfigValidator(ADAPTERS);

  it("accepts no config and a valid one", () => {
    expect(validator.safeParse(undefined)).toEqual({ success: true, data: {} });
    expect(validator.safeParse({ "cursor-cli": { command: "/x/cursor-agent" } })).toEqual({
      success: true,
      data: { "cursor-cli": { command: "/x/cursor-agent" } },
    });
  });

  it("rejects an empty command with its path", () => {
    const result = validator.safeParse({ "cursor-cli": { command: "" } });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.path).toEqual(["cursor-cli", "command"]);
  });
});

describe("openclaw.plugin.json", () => {
  const ids = ADAPTERS.map(backendIdFor);

  it("declares every adapter's backend, provider, and synthetic auth", () => {
    expect(manifest.id).toBe("openclaw-all-cli");
    expect(manifest.cliBackends).toEqual(ids);
    expect(manifest.setup.cliBackends).toEqual(ids);
    // OpenClaw loads the provider-catalog entry only for a plugin that owns the provider ID.
    expect(manifest.providers).toEqual(ids);
    expect(manifest.syntheticAuthRefs).toEqual(ids);
    expect(manifest.nonSecretAuthMarkers).toEqual(ADAPTERS.map(nativeAuthMarkerFor));
  });

  it("points at the built entries that package.json ships", () => {
    expect(manifest.providerCatalogEntry).toBe("./dist/provider-discovery.js");
    expect(pkg.openclaw.extensions).toEqual(["./src/plugin.ts"]);
    expect(pkg.openclaw.runtimeExtensions).toEqual(["./dist/plugin.js"]);
  });
});

describe("synthetic auth provider entry", () => {
  const entry = (provider as unknown as { prepareSyntheticAuth: (c: unknown) => Promise<unknown>; id: string }[])[0]!;
  const config = (command: string) => ({ plugins: { entries: { "openclaw-all-cli": { config: { "cursor-cli": { command } } } } } });

  it("offers one entry per backend", () => {
    expect((provider as unknown as { id: string }[]).map((p) => p.id)).toEqual(ADAPTERS.map(backendIdFor));
  });

  it("returns the native-auth marker when the CLI login works", async () => {
    await expect(
      entry.prepareSyntheticAuth({ provider: "cursor-cli", config: config(FAKE_CURSOR_AGENT), env: fakeEnv() }),
    ).resolves.toEqual({ apiKey: "openclaw:cursor-cli-native-auth", source: "Cursor CLI native auth", mode: "oauth" });
  });

  it("returns nothing when the login is missing, the provider differs, or there is no config", async () => {
    await expect(
      entry.prepareSyntheticAuth({
        provider: "cursor-cli",
        config: config(FAKE_CURSOR_AGENT),
        env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0" }),
      }),
    ).resolves.toBeUndefined();
    await expect(
      entry.prepareSyntheticAuth({ provider: "other-cli", config: config(FAKE_CURSOR_AGENT), env: fakeEnv() }),
    ).resolves.toBeUndefined();
    await expect(entry.prepareSyntheticAuth({ provider: "cursor-cli", env: fakeEnv() })).resolves.toBeUndefined();
  });
});

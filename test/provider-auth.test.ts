import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { createCursorUsageReader, USAGE_URL_ENV } from "../src/adapters/cursor/usage.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { readBackendConfig } from "../src/core/config.ts";
import type { CliAdapter } from "../src/core/ports.ts";
import { API_KEY_METHOD_ID, createAuthMethods, createAuthProvider, LOGIN_METHOD_ID } from "../src/core/provider-auth.ts";
import { PLUGIN_ID } from "../src/core/synthetic-auth.ts";
import { ADAPTERS } from "../src/registry.ts";
import { createLedgerFake } from "./fixtures/ledger-stub.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";
import { createVirtualClock } from "./fixtures/virtual-clock.ts";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));

// A key that is easy to find in any output a test captures.
const KEY = "key_test_0123456789abcdef";

type Config = Parameters<ReturnType<typeof createAuthMethods>[0]["run"]>[0]["config"];
const configWith = (cursor: Record<string, unknown>, entry: Record<string, unknown> = {}): Config => ({
  plugins: { entries: { [PLUGIN_ID]: { ...entry, config: { "cursor-cli": cursor } } } },
});

/** A prompter that answers `text` with `answer` and records every message it is given. */
function prompter(answer = KEY) {
  const shown: string[] = [];
  const asked: Array<{ message: string; sensitive?: boolean; validate?: (value: string) => string | undefined }> = [];
  return {
    shown,
    asked,
    api: {
      text: async (params: (typeof asked)[number]) => (asked.push(params), shown.push(params.message), answer),
    },
  };
}

const methodOf = (adapter: CliAdapter, id: string) => createAuthMethods(adapter, PLUGIN_ID).find((method) => method.id === id)!;

describe("auth methods of the cursor-cli provider", () => {
  it("lists a login method with no fields and an API key method", () => {
    const methods = createAuthMethods(cursorAdapter, PLUGIN_ID);
    expect(methods.map((method) => method.id)).toEqual([LOGIN_METHOD_ID, API_KEY_METHOD_ID]);
    expect(methods[0]).toMatchObject({ label: "Use the cursor-agent login", kind: "custom" });
    expect(methods.every((method) => method.hint.length > 0)).toBe(true);
  });

  it("is the provider OpenClaw's login flows read: the backend ID, a label, and the methods", () => {
    const provider = createAuthProvider(cursorAdapter, PLUGIN_ID);
    expect(provider).toMatchObject({ id: "cursor-cli", label: "OAC / Cursor-CLI" });
    expect(provider.auth.map((method) => method.id)).toEqual([LOGIN_METHOD_ID, API_KEY_METHOD_ID]);
  });

  it("offers no API key method for a CLI without a key variable", () => {
    const { apiKeyEnvVar: _gone, ...without } = cursorAdapter;
    expect(createAuthMethods(without, PLUGIN_ID).map((method) => method.id)).toEqual([LOGIN_METHOD_ID]);
  });

  it("uses the adapter's own command line in the login label and hint", () => {
    const acme = { ...cursorAdapter, command: "acme-agent", displayName: "Acme CLI" };
    expect(methodOf(acme, LOGIN_METHOD_ID).label).toBe("Use the acme-agent login");
  });
});

describe("login method (criterion 1)", () => {
  const run = (env: Record<string, string>, command = FAKE_CURSOR_AGENT, adapter: CliAdapter = cursorAdapter) =>
    methodOf(adapter, LOGIN_METHOD_ID).run({ config: configWith({ command }), env, prompter: prompter().api });

  it("runs the login probe and reports logged in, asking for nothing and storing nothing", async () => {
    const asker = prompter();
    const result = await methodOf(cursorAdapter, LOGIN_METHOD_ID).run({
      config: configWith({ command: FAKE_CURSOR_AGENT }),
      env: fakeEnv(),
      prompter: asker.api,
    });
    expect(result.profiles).toEqual([]);
    expect(result).not.toHaveProperty("configPatch");
    expect(result.notes.join(" ")).toMatch(/logged in/i);
    expect(asker.asked).toEqual([]);
  });

  it("reports not logged in with the command that fixes it", async () => {
    await expect(run(fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0" }))).rejects.toThrow(/not logged in.*`cursor-agent login`/);
  });

  it("reports a CLI that cannot be run as not logged in", async () => {
    await expect(run(fakeEnv(), "/no/such/cursor-agent")).rejects.toThrow(/not logged in/);
  });

  it("says so when the probe cannot tell", async () => {
    const unsure: CliAdapter = { ...cursorAdapter, probeAuth: async () => "unreadable" };
    await expect(run(fakeEnv(), FAKE_CURSOR_AGENT, unsure)).rejects.toThrow(/could not tell whether cursor cli is logged in.*`cursor-agent login`/i);
    // The core names no subcommand of its own: the fix comes from the adapter.
    const acme: CliAdapter = { ...unsure, command: "acme-agent", displayName: "Acme CLI", loginCommand: "acme-agent auth" };
    await expect(run(fakeEnv(), FAKE_CURSOR_AGENT, acme)).rejects.toThrow(/`acme-agent auth`/);
    await expect(run(fakeEnv(), FAKE_CURSOR_AGENT, acme)).rejects.not.toThrow(/status/);
  });

  it("probes the CLI's own login: an API key in the env or the config does not count, and is named in a note", async () => {
    // A key makes the probe answer "available" at once; the login method must look past it.
    await expect(run(fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0", CURSOR_API_KEY: KEY }))).rejects.toThrow(/not logged in/);
    const keyedConfig = configWith({ command: FAKE_CURSOR_AGENT, env: { CURSOR_API_KEY: KEY } });
    await expect(
      methodOf(cursorAdapter, LOGIN_METHOD_ID).run({ config: keyedConfig, env: fakeEnv({ FAKE_CURSOR_LOGGED_IN: "0" }), prompter: prompter().api }),
    ).rejects.toThrow(/not logged in/);
    const result = await methodOf(cursorAdapter, LOGIN_METHOD_ID).run({
      config: keyedConfig,
      env: fakeEnv(),
      prompter: prompter().api,
    });
    expect(result.notes.join(" ")).toMatch(/CURSOR_API_KEY is set too/);
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  it("probes without the adapter's cleared env keys, like every other probe", async () => {
    const seen: Array<Record<string, string | undefined>> = [];
    const spy: CliAdapter = { ...cursorAdapter, probeAuth: async (params) => (seen.push(params.env), "available") };
    await methodOf(spy, LOGIN_METHOD_ID).run({
      config: configWith({ command: FAKE_CURSOR_AGENT, env: { EXTRA: "1" } }),
      env: { PATH: "/bin", CURSOR_API_BASE_URL: "http://elsewhere", CURSOR_API_KEY: KEY },
      prompter: prompter().api,
    });
    expect(seen).toEqual([{ PATH: "/bin", EXTRA: "1" }]);
  });

  it("stops when the flow is cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled"));
    await expect(
      methodOf(cursorAdapter, LOGIN_METHOD_ID).run({ config: configWith({}), env: fakeEnv(), signal: controller.signal, prompter: prompter().api }),
    ).rejects.toThrow("cancelled");
  });
});

describe("API key method (criterion 2)", () => {
  const run = (answer: string, config: Config = configWith({})) => {
    const asker = prompter(answer);
    return { asker, result: methodOf(cursorAdapter, API_KEY_METHOD_ID).run({ config, env: fakeEnv(), prompter: asker.api }) };
  };

  it("asks for the key as a secret and writes it to the plugin config env of cursor-cli, in OpenClaw's profile-less result", async () => {
    const { asker, result } = run(`  ${KEY}\n`);
    const done = await result;
    expect(asker.asked).toHaveLength(1);
    expect(asker.asked[0]).toMatchObject({ sensitive: true });
    expect(done.profiles).toEqual([]);
    expect(done.configPatch).toEqual({
      plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { env: { CURSOR_API_KEY: KEY } } } } } },
    });
  });

  it("keeps what the config already holds: the command, the caps, other env values, and the entry's other fields", async () => {
    const existing = { command: "/x/cursor-agent", maxConcurrentTurns: 2, env: { OTHER: "1", CURSOR_API_KEY: "old" } };
    const config = configWith(existing, { enabled: true });
    (config as any).plugins.entries[PLUGIN_ID].config.extra = "kept";
    const done = await run(KEY, config).result;
    expect(done.configPatch).toEqual({
      plugins: {
        entries: {
          [PLUGIN_ID]: {
            enabled: true,
            config: {
              extra: "kept",
              "cursor-cli": { command: "/x/cursor-agent", maxConcurrentTurns: 2, env: { OTHER: "1", CURSOR_API_KEY: KEY } },
            },
          },
        },
      },
    });
  });

  it("writes a config the plugin reads back: the settings, the backend's env, and the usage reader's query", async () => {
    const done = await run(KEY).result;
    const pluginConfig = (done.configPatch as any).plugins.entries[PLUGIN_ID].config;
    const settings = readBackendConfig(pluginConfig, "cursor-cli", (message) => {
      throw new Error(message);
    });
    expect(settings.env).toEqual({ CURSOR_API_KEY: KEY });
    // The host gives the backend's `config.env` to the CLI process, and the usage code reads it from the turn's env.
    const backend = buildCliBackend(cursorAdapter, { settings });
    expect(backend.config.env).toEqual({ CURSOR_API_KEY: KEY });
    const clock = createVirtualClock();
    const ledger = createLedgerFake(clock);
    const reader = createCursorUsageReader({ clock, fetch: ledger.fetch, firstPollMs: 5, pollIntervalMs: 10, deadlineMs: 50, requestTimeoutMs: 50 });
    await clock.run(
      reader.read({
        sessionId: "s",
        startedAt: clock.now(),
        endedAt: clock.now(),
        env: { ...backend.config.env, [USAGE_URL_ENV]: ledger.url },
      }),
    );
    expect(ledger.requests[0]).toMatchObject({ authorization: `Bearer ${KEY}` });
  });

  it("is never logged, noted, or echoed: not in the notes, a message, an error, or the console", async () => {
    const spies = (["log", "info", "warn", "error", "debug"] as const).map((name) => vi.spyOn(console, name).mockImplementation(() => {}));
    try {
      const done = await run(KEY).result;
      const visible = JSON.stringify({ notes: done.notes });
      expect(visible).not.toContain(KEY);
      expect(visible).toContain("CURSOR_API_KEY");
      // A refused key is not echoed either (the check sees spaces; the message must not repeat them).
      const bad = `${KEY} ${KEY}`;
      const refused = run(bad).result;
      await expect(refused).rejects.toThrow(/no spaces/);
      await refused.catch((error: Error) => expect(error.message).not.toContain(KEY));
      for (const spy of spies) expect(JSON.stringify(spy.mock.calls)).not.toContain(KEY);
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
  });

  it("refuses an empty key or one with a space, and its prompt validator says the same", async () => {
    await expect(run("   ").result).rejects.toThrow(/Enter the key/);
    await expect(run("a b").result).rejects.toThrow(/no spaces/);
    const { asker, result } = run(KEY);
    await result;
    const validate = asker.asked[0]!.validate!;
    expect(validate("")).toMatch(/Enter the key/);
    expect(validate("a\nb")).toMatch(/no spaces/);
    expect(validate(KEY)).toBeUndefined();
  });

  it("uses an ID other than api-key, which OpenClaw would store in its own auth store instead", () => {
    expect(API_KEY_METHOD_ID).not.toBe("api-key");
  });
});

describe("manifest providerAuthChoices", () => {
  const choices: Array<Record<string, unknown>> = manifest.providerAuthChoices;

  it("names one choice per auth method of every adapter, under the backend's provider", () => {
    for (const adapter of ADAPTERS) {
      const provider = createAuthProvider(adapter, PLUGIN_ID);
      const named = choices.filter((choice) => choice.provider === provider.id).map((choice) => choice.method);
      expect(named.toSorted()).toEqual(provider.auth.map((method) => method.id).toSorted());
    }
    expect(choices.every((choice) => manifest.providers.includes(choice.provider))).toBe(true);
  });

  it("lists in the Control UI's Connect dialog: credential-only with a guided kind, and unique choice IDs", () => {
    expect(new Set(choices.map((choice) => choice.choiceId)).size).toBe(choices.length);
    for (const choice of choices) {
      expect(choice.credentialOnly, String(choice.choiceId)).toBe(true);
      expect(choice.appGuidedAuth !== undefined || choice.appGuidedSecret === true, String(choice.choiceId)).toBe(true);
      expect(typeof choice.choiceLabel).toBe("string");
    }
  });

  it("shows the provider as OAC / Cursor-CLI in the group label and the settings hint, with the provider ID unchanged", () => {
    const label = createAuthProvider(cursorAdapter, PLUGIN_ID).label;
    expect(label).toBe("OAC / Cursor-CLI");
    expect(choices.map((choice) => choice.groupLabel)).toEqual([label, label]);
    expect(manifest.uiHints["cursor-cli"].label).toBe(label);
    expect(manifest.providers).toEqual(["cursor-cli"]);
    expect(choices.every((choice) => choice.provider === "cursor-cli" && choice.groupId === "cursor-cli")).toBe(true);
  });

  it("falls back to the display name when an adapter has no provider label", () => {
    const { providerLabel: _gone, ...without } = cursorAdapter;
    expect(createAuthProvider(without, PLUGIN_ID).label).toBe("Cursor CLI");
  });

  it("gives the login the adapter's label", () => {
    const login = choices.find((choice) => choice.method === LOGIN_METHOD_ID);
    expect(login?.choiceLabel).toBe(methodOf(cursorAdapter, LOGIN_METHOD_ID).label);
  });

  it("gives the API key choice the method's label", () => {
    const key = choices.find((choice) => choice.method === API_KEY_METHOD_ID);
    expect(key?.choiceLabel).toBe(methodOf(cursorAdapter, API_KEY_METHOD_ID).label);
  });

  it("keeps the API key choice off the id that OpenClaw gives a quick key entry", () => {
    expect(choices.some((choice) => choice.method === "api-key")).toBe(false);
  });
});

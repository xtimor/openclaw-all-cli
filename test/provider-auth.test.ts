import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { createCursorUsageReader, USAGE_URL_ENV } from "../src/adapters/cursor/usage.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { readBackendConfig } from "../src/core/config.ts";
import type { CliAdapter } from "../src/core/ports.ts";
import { API_KEY_METHOD_ID, createAuthMethods, createAuthProvider, LOGIN_METHOD_ID, REMOVE_METHOD_ID } from "../src/core/provider-auth.ts";
import { PLUGIN_ID } from "../src/core/synthetic-auth.ts";
import type { HostFacts } from "../src/core/managed-install.ts";
import type { AuthDeps } from "../src/core/provider-auth.ts";
import { resolvePluginStateDir } from "../src/core/register.ts";
import { startPackageStub, testPackage, testSpec, TEST_VERSION, unpackedSize, type PackageStub } from "./fixtures/package-stub.ts";
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
  it("lists a login method with no fields, an API key method, and a remove method", () => {
    const methods = createAuthMethods(cursorAdapter, PLUGIN_ID);
    expect(methods.map((method) => method.id)).toEqual([LOGIN_METHOD_ID, API_KEY_METHOD_ID, REMOVE_METHOD_ID]);
    expect(methods[0]).toMatchObject({ label: "Use the cursor-agent login", kind: "custom" });
    expect(methods.every((method) => method.hint.length > 0)).toBe(true);
  });

  it("is the provider OpenClaw's login flows read: the backend ID, a label, and the methods", () => {
    const provider = createAuthProvider(cursorAdapter, PLUGIN_ID);
    expect(provider).toMatchObject({ id: "cursor-cli", label: "OAC / Cursor-CLI" });
    expect(provider.auth.map((method) => method.id)).toEqual([LOGIN_METHOD_ID, API_KEY_METHOD_ID, REMOVE_METHOD_ID]);
  });

  it("offers no API key method for a CLI without a key variable, and no remove method without a key or a managed install", () => {
    const { apiKeyEnvVar: _gone, ...without } = cursorAdapter;
    expect(createAuthMethods(without, PLUGIN_ID).map((method) => method.id)).toEqual([LOGIN_METHOD_ID, REMOVE_METHOD_ID]);
    const { managedInstall: _none, ...bare } = without;
    expect(createAuthMethods(bare, PLUGIN_ID).map((method) => method.id)).toEqual([LOGIN_METHOD_ID]);
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

  it("reports a missing CLI it cannot install with the reason and the manual install link (no state dir, no confirm)", async () => {
    await expect(run(fakeEnv(), "/no/such/cursor-agent")).rejects.toThrow(
      /`\/no\/such\/cursor-agent` was not found\..*Install it by hand: https:\/\/github\.com\/.*docs\/setup\.md#install-the-requirements/,
    );
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
  const run = (answer: string, config: Config = configWith({ command: FAKE_CURSOR_AGENT })) => {
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
      plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { command: FAKE_CURSOR_AGENT, env: { CURSOR_API_KEY: KEY } } } } } },
    });
    expect(done.notes.join(" ")).toMatch(/Cursor CLI accepted the key/);
  });

  it("keeps what the config already holds: the command, the caps, other env values, and the entry's other fields", async () => {
    const existing = { command: FAKE_CURSOR_AGENT, maxConcurrentTurns: 2, env: { OTHER: "1", CURSOR_API_KEY: "old" } };
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
              "cursor-cli": { command: FAKE_CURSOR_AGENT, maxConcurrentTurns: 2, env: { OTHER: "1", CURSOR_API_KEY: KEY } },
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
    expect(settings).toEqual({ command: FAKE_CURSOR_AGENT, env: { CURSOR_API_KEY: KEY } });
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

  it("sets the setup page icon: an HTTPS URL that ends in the path of the packaged assets/icon.png", () => {
    expect(readFileSync(new URL("../assets/icon.png", import.meta.url)).length).toBeGreaterThan(0);
    for (const choice of choices) {
      const icon = new URL(String(choice.icon), "https://invalid.example");
      expect(icon.protocol, String(choice.choiceId)).toBe("https:");
      expect(icon.pathname.endsWith("/assets/icon.png"), String(choice.choiceId)).toBe(true);
    }
  });

  it("shows the provider as OAC / Cursor-CLI in the group label and the settings hint, with the provider ID unchanged", () => {
    const label = createAuthProvider(cursorAdapter, PLUGIN_ID).label;
    expect(label).toBe("OAC / Cursor-CLI");
    expect(choices.map((choice) => choice.groupLabel)).toEqual([label, label, label]);
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

// ---------------------------------------------------------------------------
// Managed install, key check, and remove (story 27)
// ---------------------------------------------------------------------------

const GLIBC_X64: HostFacts = { os: "linux", arch: "x64", glibc: "2.39", nixMode: false };
const PKG = testPackage();

let stub: PackageStub;
beforeAll(async () => {
  stub = await startPackageStub();
});
afterAll(async () => {
  await stub.close();
});
const scratch: string[] = [];
const newDir = (prefix: string) => {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  scratch.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
  stub.requests.length = 0;
});

/** A prompter with every step the wizard has; `confirm` answers in order and records what it asked. */
function wizard(options: { answer?: string; confirms?: Array<boolean | Error>; noConfirm?: boolean } = {}) {
  const asked: string[] = [];
  const confirmed: string[] = [];
  const progress: string[] = [];
  const answers = [...(options.confirms ?? [])];
  const api: Record<string, unknown> = {
    text: async (params: { message: string }) => (asked.push(params.message), options.answer ?? KEY),
    progress: (label: string) => (progress.push(label), { update: (message: string) => progress.push(message), stop: (message?: string) => progress.push(`stop:${message}`) }),
  };
  if (!options.noConfirm) {
    api.confirm = async (params: { message: string }) => {
      confirmed.push(params.message);
      const next = answers.shift() ?? false;
      if (next instanceof Error) throw next;
      return next;
    };
  }
  return { asked, confirmed, progress, api: api as any };
}

type Setup = { state: string; root: string; adapter: CliAdapter; deps: AuthDeps; closed: number[]; turns: { value: number }; queued: { value: number } };

function setup(options: { host?: HostFacts; spec?: ReturnType<typeof testSpec>; free?: number } = {}): Setup {
  const state = newDir("oac-state-");
  const adapter: CliAdapter = { ...cursorAdapter, managedInstall: options.spec ?? testSpec(PKG) };
  const closed: number[] = [];
  const turns = { value: 0 };
  const queued = { value: 0 };
  const deps: AuthDeps = {
    stateDir: () => state,
    fetch: stub.fetch,
    host: () => options.host ?? GLIBC_X64,
    freeBytes: async () => options.free ?? 1024 ** 4,
    pools: (id) =>
      id === "cursor-cli"
        ? {
            get turns() {
              return turns.value;
            },
            get queued() {
              return queued.value;
            },
            closeIdle: () => (closed.push(1), 1),
          }
        : undefined,
  };
  return { state, root: join(state, "tools", "cursor-agent"), adapter, deps, closed, turns, queued };
}

const runMethod = (s: Setup, id: string, prompter: ReturnType<typeof wizard>, cursor: Record<string, unknown>, env = fakeEnv()) =>
  createAuthMethods(s.adapter, PLUGIN_ID, s.deps)
    .find((method) => method.id === id)!
    .run({ config: configWith(cursor), env, prompter: prompter.api });

const patchedBackend = (result: { configPatch?: Record<string, unknown> }) => (result.configPatch as any)?.plugins.entries[PLUGIN_ID].config["cursor-cli"];

describe("install offer (criteria 1, 2, and 7)", () => {
  it("offers nothing when the configured CLI runs a supported version: the methods behave as before", async () => {
    const s = setup();
    const asker = wizard({ confirms: [true] });
    const done = await runMethod(s, API_KEY_METHOD_ID, asker, { command: FAKE_CURSOR_AGENT });
    expect(asker.confirmed).toEqual([]);
    expect(patchedBackend(done)).toEqual({ command: FAKE_CURSOR_AGENT, env: { CURSOR_API_KEY: KEY } });
    const login = await runMethod(s, LOGIN_METHOD_ID, asker, { command: FAKE_CURSOR_AGENT });
    expect(login).not.toHaveProperty("configPatch");
    expect(asker.confirmed).toEqual([]);
    expect(stub.requests).toEqual([]);
  });

  it("offers the install for a missing CLI, naming the version, the source host, the size, the disk space, the folder, and the CLI command", async () => {
    const s = setup();
    const asker = wizard({ confirms: [false] });
    await runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent" });
    expect(asker.confirmed).toHaveLength(1);
    const offer = asker.confirmed[0]!;
    expect(offer).toContain(TEST_VERSION);
    expect(offer).toContain("pkg.test");
    expect(offer).toMatch(/\d+ (B|KiB) download/);
    expect(offer).toMatch(/Disk space needed: \d+ MiB/);
    expect(offer).toContain(join(s.root, TEST_VERSION));
    expect(offer).toContain("openclaw models auth login --provider cursor-cli --method api-key-env");
  });

  it("offers it for a CLI older than the plugin's minimum", async () => {
    const s = setup();
    const asker = wizard({ confirms: [false] });
    await runMethod(s, API_KEY_METHOD_ID, asker, { command: FAKE_CURSOR_AGENT }, fakeEnv({ FAKE_CURSOR_VERSION: "2026.01.01-old" }));
    expect(asker.confirmed[0]).toMatch(/older than 2026\.07\.06/);
  });

  it.each([
    ["a no", { confirms: [false] }],
    ["a cancelled question", { confirms: [new Error("cancelled")] }],
    ["a run that cannot ask", { noConfirm: true }],
  ])("downloads and writes nothing after %s; the key is saved unchecked with a note and the manual link", async (_label, options) => {
    const s = setup();
    const asker = wizard(options);
    const done = await runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent" });
    expect(stub.requests).toEqual([]);
    expect(existsSync(s.root)).toBe(false);
    expect(patchedBackend(done)).toEqual({ command: "/no/such/cursor-agent", env: { CURSOR_API_KEY: KEY } });
    const notes = done.notes.join(" ");
    expect(notes).toMatch(/saved without a check/);
    expect(notes).toContain("https://docs.test/setup.md#install-the-requirements");
    expect(notes).not.toContain(KEY);
  });

  it("ends the login method with the manual link after a no", async () => {
    const s = setup();
    await expect(runMethod(s, LOGIN_METHOD_ID, wizard({ confirms: [false] }), { command: "/no/such/cursor-agent" })).rejects.toThrow(
      /Nothing was downloaded\. Install it by hand: https:\/\/docs\.test/,
    );
    expect(stub.requests).toEqual([]);
  });

  it.each([
    ["Windows", { ...GLIBC_X64, os: "win32" as NodeJS.Platform }, /Windows/],
    ["Linux musl", { ...GLIBC_X64, glibc: undefined }, /musl/],
    ["another architecture", { ...GLIBC_X64, arch: "ia32" }, /ia32/],
    ["Nix mode", { ...GLIBC_X64, nixMode: true }, /Nix mode/],
  ])("offers nothing on %s: says why, links the manual install, and saves the key unchecked", async (_label, host, why) => {
    const s = setup({ host });
    const asker = wizard({ confirms: [true] });
    const done = await runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent" });
    expect(asker.confirmed).toEqual([]);
    expect(done.notes.join(" ")).toMatch(why);
    expect(done.notes.join(" ")).toContain("https://docs.test/setup.md#install-the-requirements");
    expect(patchedBackend(done).env).toEqual({ CURSOR_API_KEY: KEY });
    await expect(runMethod(s, LOGIN_METHOD_ID, asker, { command: "/no/such/cursor-agent" })).rejects.toThrow(why);
    expect(stub.requests).toEqual([]);
  });

  it("reads Nix mode from the run's env with the real host facts", async () => {
    const s = setup();
    delete s.deps.host;
    const asker = wizard({ confirms: [true] });
    const done = await runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent" }, fakeEnv({ OPENCLAW_NIX_MODE: "1" }));
    expect(asker.confirmed).toEqual([]);
    expect(done.notes.join(" ")).toMatch(/Nix mode/);
  });
});

describe("install after a yes (criteria 3, 5, and 6)", () => {
  it("installs, checks the key with the installed CLI, and points the command at the absolute launcher, keeping the other settings", async () => {
    const s = setup();
    mkdirSync(join(s.root, "0.9.0"), { recursive: true });
    stub.answer({ kind: "body", body: PKG });
    const asker = wizard({ confirms: [true] });
    const done = await runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent", maxProcesses: 3, env: { OTHER: "1" } }, fakeEnv({ TEST_ABOUT: "ok" }));
    const launcher = join(s.root, TEST_VERSION, "tool");
    expect(patchedBackend(done)).toEqual({ command: launcher, maxProcesses: 3, env: { OTHER: "1", CURSOR_API_KEY: KEY } });
    expect(readdirSync(s.root)).toEqual([TEST_VERSION]);
    const notes = done.notes.join(" ");
    expect(notes).toContain(`now points at ${launcher}`);
    expect(notes).toMatch(/Removed the older installs of the plugin: 0\.9\.0/);
    expect(notes).toMatch(/accepted the key/);
    expect(notes).not.toContain(KEY);
    expect(asker.progress[0]).toBe(`Installing Cursor CLI ${TEST_VERSION}`);
    expect(asker.progress.some((line) => line.startsWith("Downloading"))).toBe(true);
    expect(asker.progress.at(-1)).toBe(`stop:Installed Cursor CLI ${TEST_VERSION}`);
    // The model list, probes, and turns read `command` from the same config (criterion 5).
    const settings = readBackendConfig({ "cursor-cli": patchedBackend(done) }, "cursor-cli", () => {});
    expect(buildCliBackend(cursorAdapter, { settings }).config.command).toBe(launcher);
  });

  it("keeps the install and the command when the installed CLI refuses the key, and saves no key", async () => {
    const s = setup();
    stub.answer({ kind: "body", body: PKG });
    const done = await runMethod(s, API_KEY_METHOD_ID, wizard({ confirms: [true] }), { command: "/no/such/cursor-agent" }, fakeEnv({ TEST_ABOUT: "invalid" }));
    expect(patchedBackend(done)).toEqual({ command: join(s.root, TEST_VERSION, "tool") });
    expect(done.notes.join(" ")).toMatch(/says the key is invalid\. It was not saved/);
  });

  it("names the absolute launcher in the login method's fix when the new CLI is not logged in, and keeps the command", async () => {
    const s = setup();
    stub.answer({ kind: "body", body: PKG });
    const done = await runMethod(s, LOGIN_METHOD_ID, wizard({ confirms: [true] }), { command: "/no/such/cursor-agent" });
    const launcher = join(s.root, TEST_VERSION, "tool");
    expect(patchedBackend(done)).toEqual({ command: launcher });
    expect(done.notes.join(" ")).toContain(`Run \`${launcher} login\``);
  });

  it("reports logged in through the new CLI when it is", async () => {
    const s = setup();
    stub.answer({ kind: "body", body: PKG });
    const done = await runMethod(s, LOGIN_METHOD_ID, wizard({ confirms: [true] }), {}, fakeEnv({ TEST_LOGGED_IN: "1", PATH: "/nonexistent" }));
    expect(done.notes.join(" ")).toMatch(/is logged in/);
    expect(patchedBackend(done).command).toBe(join(s.root, TEST_VERSION, "tool"));
  });

  it("names the absolute launcher in the fix when the command already points at the managed folder", async () => {
    const s = setup();
    stub.answer({ kind: "body", body: PKG });
    const installed = await runMethod(s, LOGIN_METHOD_ID, wizard({ confirms: [true] }), {}, fakeEnv({ PATH: "/nonexistent" }));
    const launcher = patchedBackend(installed).command;
    await expect(runMethod(s, LOGIN_METHOD_ID, wizard(), { command: launcher })).rejects.toThrow(`Run \`${launcher} login\``);
  });

  const failing = testPackage({ versionExit: 1 });
  it.each([
    ["a hash mismatch", PKG, testSpec(PKG, { sha: "1".repeat(64) }), {}, /sha256 does not match/],
    ["too little disk space", PKG, testSpec(PKG), { free: 1 }, /Not enough disk space/],
    ["a launcher that fails", failing, testSpec(failing, { unpackedBytes: unpackedSize({ versionExit: 1 }) }), {}, /launcher does not run/],
  ])("stops on %s without a config change, naming the cause and the manual path", async (_label, body, spec, extra, cause) => {
    const s = setup({ spec, ...extra });
    stub.answer({ kind: "body", body });
    const asker = wizard({ confirms: [true] });
    const failed = runMethod(s, API_KEY_METHOD_ID, asker, { command: "/no/such/cursor-agent" });
    await expect(failed).rejects.toThrow(cause);
    await expect(failed).rejects.toThrow(/Nothing was changed.*Install it by hand: https:\/\/docs\.test/);
    expect(asker.asked).toEqual([]);
    expect(existsSync(join(s.root, TEST_VERSION))).toBe(false);
  });
});

describe("key check (criterion 6)", () => {
  const log = () => join(newDir("oac-about-"), "log.jsonl");
  const aboutLines = (file: string) =>
    readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).filter((line) => line.method === "about");
  const runKey = (env: Record<string, string>, answer = KEY) => {
    const s = setup();
    return runMethod(s, API_KEY_METHOD_ID, wizard({ answer }), { command: FAKE_CURSOR_AGENT }, fakeEnv(env));
  };

  it("runs `about` with the key in the env only, never in an argument, in a throwaway home it removes", async () => {
    const file = log();
    await runKey({ FAKE_CURSOR_LOG: file, FAKE_CURSOR_ABOUT: "ok" });
    const lines = aboutLines(file);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ keyed: true });
    expect(JSON.stringify(lines)).not.toContain(KEY);
    const where = readFileSync(file, "utf8").trim().split("\n").map((line) => JSON.parse(line)).find((line) => line.method === "about/env");
    expect(where.home).toMatch(/oac-key-check-/);
    expect(where.home).not.toBe(process.env.HOME);
    expect(where.configDir.startsWith(where.home)).toBe(true);
    expect(existsSync(where.home)).toBe(false);
  });

  it("refuses a key the CLI calls invalid, without echoing it", async () => {
    const failed = runKey({ FAKE_CURSOR_ABOUT: "invalid" });
    await expect(failed).rejects.toThrow(/says the key is invalid\. It was not saved/);
    await failed.catch((error: Error) => expect(error.message).not.toContain(KEY));
  });

  it("tries once more on an unclear answer, then refuses with 'could not be checked'", async () => {
    const counter = join(newDir("oac-about-"), "count");
    const failed = runKey({ FAKE_CURSOR_ABOUT: "unknown", FAKE_CURSOR_ABOUT_COUNT: counter });
    await expect(failed).rejects.toThrow(/could not be checked.*It may be invalid.*It was not saved/);
    // Two checks, and each runs `about` twice in its throwaway home.
    expect(readFileSync(counter, "utf8")).toBe("4");
  });

  it("saves the key when the second try answers", async () => {
    const counter = join(newDir("oac-about-"), "count");
    const done = await runKey({ FAKE_CURSOR_ABOUT: "unknown", FAKE_CURSOR_ABOUT_THEN: "ok", FAKE_CURSOR_ABOUT_COUNT: counter });
    expect(patchedBackend(done).env).toEqual({ CURSOR_API_KEY: KEY });
    expect(readFileSync(counter, "utf8")).toBe("2");
  });

  it("treats a check that throws as unclear", async () => {
    const s = setup();
    let calls = 0;
    s.adapter = { ...s.adapter, checkKey: async () => (calls += 1, Promise.reject(new Error(`boom ${KEY}`))) };
    const failed = runMethod(s, API_KEY_METHOD_ID, wizard(), { command: FAKE_CURSOR_AGENT });
    await expect(failed).rejects.toThrow(/could not be checked/);
    await failed.catch((error: Error) => expect(error.message).not.toContain(KEY));
    expect(calls).toBe(2);
  });

  it("saves the key unchecked, with the warning, when the CLI's version check only warned", async () => {
    const file = log();
    const s = setup();
    const done = await runMethod(s, API_KEY_METHOD_ID, wizard(), { command: FAKE_CURSOR_AGENT }, fakeEnv({ FAKE_CURSOR_LOG: file, FAKE_CURSOR_VERSION: "garbled" }));
    expect(patchedBackend(done).env).toEqual({ CURSOR_API_KEY: KEY });
    expect(done.notes.join(" ")).toMatch(/Could not read the version.*The key was saved without a check/);
    expect(existsSync(file) ? aboutLines(file) : []).toEqual([]);
  });

  it("keeps the old path for an adapter without a key check", async () => {
    const s = setup();
    const { checkKey: _none, ...without } = s.adapter;
    s.adapter = without;
    const done = await runMethod(s, API_KEY_METHOD_ID, wizard(), { command: FAKE_CURSOR_AGENT });
    expect(patchedBackend(done).env).toEqual({ CURSOR_API_KEY: KEY });
  });
});

describe("remove method (criterion 8)", () => {
  const installFake = (s: Setup) => {
    mkdirSync(join(s.root, TEST_VERSION), { recursive: true });
    writeFileSync(join(s.root, TEST_VERSION, "tool"), "x".repeat(2048), { mode: 0o755 });
    return join(s.root, TEST_VERSION, "tool");
  };

  it("says there is nothing to remove when no key is saved and nothing is installed", async () => {
    const s = setup();
    const asker = wizard({ confirms: [true, true] });
    const done = await runMethod(s, REMOVE_METHOD_ID, asker, { command: FAKE_CURSOR_AGENT });
    expect(done.notes.join(" ")).toMatch(/Nothing to remove/);
    expect(done).not.toHaveProperty("configPatch");
    expect(asker.confirmed).toEqual([]);
  });

  it("removes the saved key on a yes, keeping the other settings, and names the copies that remain", async () => {
    const s = setup();
    const asker = wizard({ confirms: [true] });
    const done = await runMethod(s, REMOVE_METHOD_ID, asker, { command: FAKE_CURSOR_AGENT, maxProcesses: 2, env: { CURSOR_API_KEY: KEY, OTHER: "1" } });
    expect(asker.confirmed).toHaveLength(1);
    expect(asker.confirmed[0]).toMatch(/Remove the saved CURSOR_API_KEY/);
    const backend = patchedBackend(done);
    expect(backend.command).toBe(FAKE_CURSOR_AGENT);
    expect(backend.maxProcesses).toBe(2);
    expect(backend.env.OTHER).toBe("1");
    // `undefined` is how the patch deletes the key (OpenClaw's merge drops it; see the host contract test).
    expect(Object.hasOwn(backend.env, "CURSOR_API_KEY")).toBe(true);
    expect(backend.env.CURSOR_API_KEY).toBeUndefined();
    const notes = done.notes.join(" ");
    expect(notes).toContain("~/.config/cursor/auth.json");
    expect(notes).toMatch(/rotated config copies/);
    expect(notes).toContain("docs/setup.md#remove-the-key-and-the-managed-cli");
    expect(JSON.stringify(done)).not.toContain(KEY);
  });

  it("changes nothing on a no", async () => {
    const s = setup();
    const done = await runMethod(s, REMOVE_METHOD_ID, wizard({ confirms: [false] }), { env: { CURSOR_API_KEY: KEY } });
    expect(done).not.toHaveProperty("configPatch");
    expect(done.notes.join(" ")).toMatch(/stays/);
  });

  it("asks separately about the managed CLI, naming its folder and size, closes idle processes, removes it, and unsets a command that points there", async () => {
    const s = setup();
    const launcher = installFake(s);
    const asker = wizard({ confirms: [false, true] });
    const done = await runMethod(s, REMOVE_METHOD_ID, asker, { command: launcher, env: { CURSOR_API_KEY: KEY } });
    expect(asker.confirmed).toHaveLength(2);
    expect(asker.confirmed[1]).toContain(s.root);
    expect(asker.confirmed[1]).toMatch(/\(2 KiB\)/);
    expect(s.closed).toEqual([1]);
    expect(existsSync(s.root)).toBe(false);
    const backend = patchedBackend(done);
    expect(Object.hasOwn(backend, "command") && backend.command === undefined).toBe(true);
    expect(backend.env).toEqual({ CURSOR_API_KEY: KEY });
    expect(done.notes.join(" ")).toMatch(/command pointed there and is unset/);
  });

  it("keeps a command that points elsewhere, and never touches a CLI the plugin did not install", async () => {
    const s = setup();
    installFake(s);
    const own = join(newDir("oac-own-"), "cursor-agent");
    writeFileSync(own, "#!/bin/sh\n", { mode: 0o755 });
    const done = await runMethod(s, REMOVE_METHOD_ID, wizard({ confirms: [true] }), { command: own });
    expect(existsSync(s.root)).toBe(false);
    expect(existsSync(own)).toBe(true);
    expect(done).not.toHaveProperty("configPatch");
  });

  it("refuses to remove the CLI while a turn runs, and still removes the key on a yes", async () => {
    const s = setup();
    const launcher = installFake(s);
    s.turns.value = 1;
    const done = await runMethod(s, REMOVE_METHOD_ID, wizard({ confirms: [true, true] }), { command: launcher, env: { CURSOR_API_KEY: KEY } });
    expect(existsSync(launcher)).toBe(true);
    expect(s.closed).toEqual([]);
    const backend = patchedBackend(done);
    expect(backend.command).toBe(launcher);
    expect(Object.hasOwn(backend.env, "CURSOR_API_KEY")).toBe(true);
    expect(done.notes.join(" ")).toMatch(/turn is running/);
  });

  it("refuses to remove the CLI while a turn waits for a slot", async () => {
    const s = setup();
    const launcher = installFake(s);
    s.queued.value = 1;
    const done = await runMethod(s, REMOVE_METHOD_ID, wizard({ confirms: [true] }), { command: launcher });
    expect(existsSync(launcher)).toBe(true);
    expect(done).not.toHaveProperty("configPatch");
    expect(done.notes.join(" ")).toMatch(/running or waiting/);
  });

  it("says, run outside the Gateway, that it cannot see the Gateway's turns", async () => {
    const s = setup();
    installFake(s);
    delete s.deps.pools;
    const asker = wizard({ confirms: [true] });
    await runMethod(s, REMOVE_METHOD_ID, asker, {});
    expect(asker.confirmed[0]).toMatch(/cannot see turns running in the Gateway; a turn still using it may fail/);
    expect(existsSync(s.root)).toBe(false);
  });

  it("keeps the confirmed key removal and the command when the folder cannot be removed", async () => {
    const s = setup();
    const launcher = installFake(s);
    // The second lookup (the removal's) names another state dir, so the removal refuses the folder.
    let calls = 0;
    s.deps.stateDir = () => (calls++ === 0 ? s.state : newDir("oac-other-"));
    const done = await runMethod(s, REMOVE_METHOD_ID, wizard({ confirms: [true, true] }), { command: launcher, env: { CURSOR_API_KEY: KEY } });
    expect(existsSync(launcher)).toBe(true);
    const backend = patchedBackend(done);
    expect(backend.command).toBe(launcher);
    expect(Object.hasOwn(backend.env, "CURSOR_API_KEY") && backend.env.CURSOR_API_KEY === undefined).toBe(true);
    expect(done.notes.join(" ")).toMatch(/Could not remove .*command is unchanged.*#remove-the-key-and-the-managed-cli/);
  });

  it("removes nothing when the run cannot ask", async () => {
    const s = setup();
    installFake(s);
    await expect(runMethod(s, REMOVE_METHOD_ID, wizard({ noConfirm: true }), { env: { CURSOR_API_KEY: KEY } })).rejects.toThrow(
      /cannot ask for a yes.*--method remove/,
    );
    expect(existsSync(s.root)).toBe(true);
  });
});

describe("the state dir the methods install under", () => {
  it("is the host's answer, else OPENCLAW_STATE_DIR, else OPENCLAW_HOME/.openclaw, else ~/.openclaw", () => {
    const host = { runtime: { state: { resolveStateDir: () => "/host/state" } } } as any;
    expect(resolvePluginStateDir(host, {})).toBe("/host/state");
    const none = { runtime: { state: { resolveStateDir: () => { throw new Error("setup mode"); } } } } as any;
    expect(resolvePluginStateDir(none, { OPENCLAW_STATE_DIR: "/s" })).toBe("/s");
    expect(resolvePluginStateDir({ runtime: undefined } as any, { OPENCLAW_HOME: "/h" })).toBe("/h/.openclaw");
    expect(resolvePluginStateDir({ runtime: undefined } as any, {})).toMatch(/\.openclaw$/);
  });
});

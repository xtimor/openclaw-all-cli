import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { closeListings, createModelCatalog, defaultCatalogRow } from "./catalog.ts";
import { CliError, createManifest, type CliAdapter, type CliModel, type ListModelsParams } from "./ports.ts";

const MODELS: CliModel[] = [
  { name: "auto", label: "Auto", id: "default[]" },
  { name: "big", label: "Big", id: "big[x=1]" },
];

function makeAdapter(listModels: (params: ListModelsParams) => Promise<readonly CliModel[]>) {
  const adapter: CliAdapter = {
    id: "acme",
    displayName: "Acme",
    command: "acme",
    launchArgs: ["serve"],
    defaultModel: "acme-cli/auto",
    manifest: createManifest("1", {}),
    alwaysOnNativeTools: [],
    clearEnv: [],
    checkVersion: async () => "ok",
    probeAuth: async () => "available",
    prepareHome: async () => ({}),
    open: async () => {
      throw new Error("not used");
    },
    listModels,
  };
  return adapter;
}

// The fake adapters start no process, so this dir is never written; it only marks the listing as recorded.
const params = (env: Record<string, string | undefined> = { KEY: "a" }) => ({ command: "acme", env, lockDir: "/nonexistent/oac-home" });

describe("model catalog", () => {
  it("carries a model's context window into its row, and no window key when unknown", async () => {
    const catalog = createModelCatalog(
      makeAdapter(async () => [
        { name: "auto", label: "Auto", id: "default[]" },
        { name: "big", label: "Big", id: "big[context=1m]", contextWindow: 1_000_000 },
      ]),
    );
    const rows = await catalog.list(params());
    expect(rows).toEqual([
      { id: "auto", name: "OAC / Auto" },
      { id: "big", name: "OAC / Big", contextWindow: 1_000_000 },
    ]);
    expect("contextWindow" in rows[0]!).toBe(false);
  });

  it("maps the adapter's models onto rows named with the OAC prefix and the model name as id", async () => {
    const list = vi.fn(async () => MODELS);
    const catalog = createModelCatalog(makeAdapter(list));
    await expect(catalog.list(params())).resolves.toEqual([
      { id: "auto", name: "OAC / Auto" },
      { id: "big", name: "OAC / Big" },
    ]);
    const rows = await catalog.list(params({ KEY: "b" }));
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.name.startsWith("OAC / ")).toBe(true);
    expect(rows.map((row) => row.id)).toEqual(["auto", "big"]);
    expect(list).toHaveBeenCalledWith({
      command: "acme",
      args: ["serve"],
      env: { KEY: "a" },
      signal: expect.any(AbortSignal),
      onProcessStart: expect.any(Function),
    });
  });

  it("derives the default row from the adapter's default model", () => {
    expect(defaultCatalogRow(makeAdapter(async () => []))).toEqual({ id: "auto", name: "OAC / auto" });
  });

  it("caches a listing, and lists again after the TTL or when asked to refresh", async () => {
    const list = vi.fn(async () => MODELS);
    let now = 1_000;
    const catalog = createModelCatalog(makeAdapter(list), { ttlMs: 100, now: () => now });
    await catalog.list(params());
    await catalog.list(params());
    expect(list).toHaveBeenCalledTimes(1);
    await catalog.list(params(), { refresh: true });
    expect(list).toHaveBeenCalledTimes(2);
    now += 101;
    await catalog.list(params());
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("lists again when the environment changes, which covers a new login or API key", async () => {
    const list = vi.fn(async () => MODELS);
    const catalog = createModelCatalog(makeAdapter(list));
    await catalog.list(params({ KEY: "a" }));
    await catalog.list(params({ KEY: "b" }));
    await catalog.list({ ...params({ KEY: "b" }), command: "/other/acme" });
    expect(list).toHaveBeenCalledTimes(3);
    await catalog.list(params({ KEY: "b", UNSET: undefined }));
    expect(list).toHaveBeenCalledTimes(3);
  });

  it("shares one listing between concurrent callers", async () => {
    let release: (models: CliModel[]) => void = () => {};
    const list = vi.fn(() => new Promise<CliModel[]>((resolve) => (release = resolve)));
    const catalog = createModelCatalog(makeAdapter(list));
    const first = catalog.list(params());
    const second = catalog.list(params());
    release(MODELS);
    expect(await first).toEqual(await second);
    expect(list).toHaveBeenCalledTimes(1);
  });

  it("falls back to the default model alone and logs when the listing fails, without throwing", async () => {
    const warn = vi.fn();
    const list = vi.fn(async () => {
      throw new CliError({ code: "cli_not_found", message: "no acme" });
    });
    const catalog = createModelCatalog(makeAdapter(list), { warn });
    await expect(catalog.list(params())).resolves.toEqual([{ id: "auto", name: "OAC / auto" }]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("no acme");
    expect(warn.mock.calls[0]?.[0]).toContain("Acme");
  });

  it("does not retry a failed listing for every read, but does after the failure TTL", async () => {
    let now = 0;
    let fail = true;
    const list = vi.fn(async () => {
      if (fail) throw new Error("down");
      return MODELS;
    });
    const catalog = createModelCatalog(makeAdapter(list), { failureTtlMs: 50, now: () => now });
    await catalog.list(params());
    await catalog.list(params());
    expect(list).toHaveBeenCalledTimes(1);
    fail = false;
    now = 51;
    expect((await catalog.list(params())).map((row) => row.id)).toEqual(["auto", "big"]);
  });

  it("treats an empty listing as a failure", async () => {
    const warn = vi.fn();
    const catalog = createModelCatalog(makeAdapter(async () => []), { warn });
    await expect(catalog.list(params())).resolves.toEqual([{ id: "auto", name: "OAC / auto" }]);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("rejects only the caller whose signal aborts; other callers of the shared listing still get the rows", async () => {
    const warn = vi.fn();
    let release: (models: CliModel[]) => void = () => {};
    const list = vi.fn((_params: ListModelsParams) => new Promise<CliModel[]>((resolve) => (release = resolve)));
    const catalog = createModelCatalog(makeAdapter(list), { warn });
    const controller = new AbortController();
    const first = catalog.list({ ...params(), signal: controller.signal });
    const second = catalog.list(params());
    controller.abort();
    await expect(first).rejects.toThrow();
    release(MODELS);
    await expect(second).resolves.toEqual([
      { id: "auto", name: "OAC / Auto" },
      { id: "big", name: "OAC / Big" },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    // The listing's own signal (the unload's), never a caller's.
    expect(list.mock.calls[0]?.[0].signal).not.toBe(controller.signal);
    expect(list.mock.calls[0]?.[0].signal?.aborted).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects at once for a signal that is already aborted", async () => {
    const list = vi.fn(async () => MODELS);
    const catalog = createModelCatalog(makeAdapter(list));
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.list({ ...params(), signal: controller.signal })).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
  });
});

describe("listing process lock and unload (D22, AD-14)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-catalog-"));
  const children: ChildProcess[] = [];
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  afterEach(async () => {
    await closeListings(50);
    for (const child of children.splice(0)) child.kill("SIGKILL");
  });

  /** A real process, so the lock can read its start time. */
  async function liveProcess(): Promise<ChildProcess & { pid: number }> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"], { stdio: "ignore" }) as ChildProcess & { pid: number };
    children.push(child);
    await new Promise((resolve) => child.once("spawn", resolve));
    return child;
  }
  const lockFiles = (dir: string) => join(dir, "pids");

  it("locks the listing's process in the agent home from spawn to exit", async () => {
    const home = join(root, "locked");
    const child = await liveProcess();
    let during: { group?: boolean } | undefined;
    const list = vi.fn(async (listing: ListModelsParams) => {
      listing.onProcessStart?.(child.pid, { processGroup: true });
      const file = join(lockFiles(home), `${child.pid}.json`);
      for (let i = 0; i < 100 && !existsSync(file); i += 1) await new Promise((resolve) => setTimeout(resolve, 20));
      during = JSON.parse(readFileSync(file, "utf8"));
      return MODELS;
    });
    const warn = vi.fn();
    const catalog = createModelCatalog(makeAdapter(list), { warn });
    await catalog.list({ command: "acme", env: { KEY: "a" }, lockDir: home });
    expect(during).toMatchObject({ pid: child.pid, group: true });
    expect(existsSync(join(lockFiles(home), `${child.pid}.json`))).toBe(false);
    expect(warn).not.toHaveBeenCalled();
  });

  it("releases the lock when the listing fails", async () => {
    const home = join(root, "failed");
    const child = await liveProcess();
    const list = vi.fn(async (listing: ListModelsParams) => {
      listing.onProcessStart?.(child.pid, { processGroup: false });
      await new Promise((resolve) => setTimeout(resolve, 100));
      throw new CliError({ code: "server_error", message: "no session" });
    });
    const catalog = createModelCatalog(makeAdapter(list), { warn: () => {} });
    await catalog.list({ command: "acme", env: { KEY: "a" }, lockDir: home });
    expect(existsSync(join(lockFiles(home), `${child.pid}.json`))).toBe(false);
  });

  it("lists anyway, with a warning, when the lock cannot be written", async () => {
    const blocker = join(root, "not-a-dir");
    writeFileSync(blocker, "x");
    const child = await liveProcess();
    const warn = vi.fn();
    const list = vi.fn(async (listing: ListModelsParams) => {
      listing.onProcessStart?.(child.pid, { processGroup: true });
      return MODELS;
    });
    const catalog = createModelCatalog(makeAdapter(list), { warn });
    await expect(catalog.list({ command: "acme", env: { KEY: "a" }, lockDir: blocker })).resolves.toHaveLength(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("Could not record");
  });

  it("lists unlocked and warns once per catalog when it has no agent directory", async () => {
    const warn = vi.fn();
    const list = vi.fn(async (listing: ListModelsParams) => {
      expect(listing.onProcessStart).toBeUndefined();
      return MODELS;
    });
    const catalog = createModelCatalog(makeAdapter(list), { warn });
    await catalog.list({ command: "acme", env: { KEY: "a" } });
    await catalog.list({ command: "acme", env: { KEY: "b" } });
    expect(list).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("agent directory");
    // Another catalog warns on its own.
    const other = vi.fn();
    await createModelCatalog(makeAdapter(list), { warn: other }).list({ command: "acme", env: { KEY: "a" } });
    expect(other).toHaveBeenCalledTimes(1);
  });

  /** A listing that runs until its signal aborts, then needs a moment to "exit". */
  function hangingAdapter(exitMs = 30) {
    const state = { started: false, aborted: false, exited: false };
    const list = vi.fn(
      (listing: ListModelsParams) =>
        new Promise<CliModel[]>((_resolve, reject) => {
          state.started = true;
          listing.signal?.addEventListener(
            "abort",
            () => {
              state.aborted = true;
              setTimeout(() => {
                state.exited = true;
                reject(listing.signal!.reason);
              }, exitMs);
            },
            { once: true },
          );
        }),
    );
    return { adapter: makeAdapter(list), state };
  }

  it("aborts a listing in flight on unload and waits for its process to exit", async () => {
    const { adapter, state } = hangingAdapter();
    const warn = vi.fn();
    const listing = createModelCatalog(adapter, { warn }).list({ command: "acme", env: { KEY: "a" }, lockDir: join(root, "unload") });
    await vi.waitFor(() => expect(state.started).toBe(true));
    await closeListings();
    expect(state.aborted).toBe(true);
    expect(state.exited).toBe(true);
    // As a failed listing: the default row, and no failure to log (the unload stopped it).
    await expect(listing).resolves.toEqual([{ id: "auto", name: "OAC / auto" }]);
    expect(warn).not.toHaveBeenCalled();
  });

  it("does not remember an aborted listing: the next read lists again", async () => {
    const { adapter, state } = hangingAdapter();
    const catalog = createModelCatalog(adapter, { warn: () => {} });
    const request = { command: "acme", env: { KEY: "a" }, lockDir: join(root, "again") };
    const first = catalog.list(request);
    await vi.waitFor(() => expect(state.started).toBe(true));
    await closeListings();
    await first;
    const second = catalog.list(request);
    await vi.waitFor(() => expect(adapter.listModels).toHaveBeenCalledTimes(2));
    await closeListings();
    await second;
  });

  it("waits at most the given time for a listing that does not stop", async () => {
    let release: (models: CliModel[]) => void = () => {};
    const adapter = makeAdapter(() => new Promise<CliModel[]>((resolve) => (release = resolve)));
    const listing = createModelCatalog(adapter).list({ command: "acme", env: { KEY: "a" }, lockDir: join(root, "stuck") });
    await new Promise((resolve) => setTimeout(resolve, 20));
    const startedAt = Date.now();
    await closeListings(80);
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    release(MODELS);
    await listing;
  });

  it("returns at once when nothing is listing", async () => {
    await expect(closeListings()).resolves.toBeUndefined();
  });

  it("reaches a listing started by another module instance", async () => {
    vi.resetModules();
    const first = await import("./catalog.ts");
    vi.resetModules();
    const second = await import("./catalog.ts");
    expect(second.createModelCatalog).not.toBe(first.createModelCatalog);
    const { adapter, state } = hangingAdapter();
    const listing = first.createModelCatalog(adapter, { warn: () => {} }).list({ command: "acme", env: { KEY: "a" }, lockDir: join(root, "two") });
    await vi.waitFor(() => expect(state.started).toBe(true));
    await second.closeListings();
    expect(state.aborted).toBe(true);
    expect(state.exited).toBe(true);
    await listing;
  });
});

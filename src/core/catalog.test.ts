import { describe, expect, it, vi } from "vitest";
import { createModelCatalog, defaultCatalogRow } from "./catalog.ts";
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
    probeAuth: async () => "available",
    prepareHome: async () => ({}),
    open: async () => {
      throw new Error("not used");
    },
    listModels,
  };
  return adapter;
}

const params = (env: Record<string, string | undefined> = { KEY: "a" }) => ({ command: "acme", env });

describe("model catalog", () => {
  it("maps the adapter's models onto rows named by the model name", async () => {
    const list = vi.fn(async () => MODELS);
    const catalog = createModelCatalog(makeAdapter(list));
    await expect(catalog.list(params())).resolves.toEqual([
      { id: "auto", name: "Auto" },
      { id: "big", name: "Big" },
    ]);
    expect(list).toHaveBeenCalledWith({ command: "acme", args: ["serve"], env: { KEY: "a" } });
  });

  it("derives the default row from the adapter's default model", () => {
    expect(defaultCatalogRow(makeAdapter(async () => []))).toEqual({ id: "auto", name: "auto" });
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
    await catalog.list({ command: "/other/acme", env: { KEY: "b" } });
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
    await expect(catalog.list(params())).resolves.toEqual([{ id: "auto", name: "auto" }]);
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
    await expect(catalog.list(params())).resolves.toEqual([{ id: "auto", name: "auto" }]);
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
      { id: "auto", name: "Auto" },
      { id: "big", name: "Big" },
    ]);
    expect(list).toHaveBeenCalledTimes(1);
    expect(list.mock.calls[0]?.[0].signal).toBeUndefined();
    expect(warn).not.toHaveBeenCalled();
  });

  it("rejects at once for a signal that is already aborted", async () => {
    const list = vi.fn(async () => MODELS);
    const catalog = createModelCatalog(makeAdapter(list));
    const controller = new AbortController();
    controller.abort();
    await expect(catalog.list({ ...params(), signal: controller.signal })).rejects.toThrow();
  });
});

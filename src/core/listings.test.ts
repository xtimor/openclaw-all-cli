import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { closeListings } from "./catalog.ts";

const WORKER = fileURLToPath(new URL("../../test/fixtures/listing-worker.mjs", import.meta.url));

describe("listings in other threads (OpenClaw runs the provider catalog in a worker)", () => {
  const workers: Worker[] = [];
  const dirs: string[] = [];
  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function startWorker(exitMs: number) {
    const flags = new Int32Array(new SharedArrayBuffer(12));
    const lockDir = mkdtempSync(join(tmpdir(), "oac-listings-"));
    dirs.push(lockDir);
    const worker = new Worker(WORKER, {
      workerData: { flags: flags.buffer, exitMs, lockDir },
      execArgv: ["--experimental-transform-types"],
    });
    workers.push(worker);
    const result = new Promise<unknown>((resolve, reject) => {
      worker.once("message", resolve);
      worker.once("error", reject);
    });
    return { flags, result };
  }

  it("aborts a listing that runs in a worker thread, and waits until its process has exited", async () => {
    const { flags, result } = startWorker(400);
    await vi.waitFor(() => expect(Atomics.load(flags, 0)).toBe(1), { timeout: 15_000 });
    const startedAt = Date.now();
    await closeListings();
    // The abort reached the other thread, and the closer waited for the listing's "exit" there.
    expect(Atomics.load(flags, 1)).toBe(1);
    expect(Atomics.load(flags, 2)).toBe(1);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(350);
    // As a failed listing: the default row.
    expect(await result).toEqual({ rows: [{ id: "auto", name: "OAC / auto" }] });
  }, 30_000);

  it("gives up after the wait for a listing whose process does not exit", async () => {
    const { flags } = startWorker(60_000);
    await vi.waitFor(() => expect(Atomics.load(flags, 0)).toBe(1), { timeout: 15_000 });
    const startedAt = Date.now();
    await closeListings(500);
    expect(Atomics.load(flags, 1)).toBe(1);
    expect(Atomics.load(flags, 2)).toBe(0);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
  }, 30_000);

  it("returns quickly when no thread has a listing", async () => {
    const startedAt = Date.now();
    await closeListings();
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});

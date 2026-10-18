import { describe, expect, it, vi } from "vitest";
import { ProcessPool, type PoolMember } from "./pool.ts";
import { CliError } from "./ports.ts";

function member(options: { idle?: boolean; lastUsed?: number; exit?: Promise<void> } = {}) {
  const state = { idle: options.idle ?? true, closed: 0 };
  const m: PoolMember = {
    isIdle: () => state.idle,
    lastUsed: options.lastUsed ?? 0,
    close: vi.fn(() => {
      state.closed += 1;
    }),
    exited: () => options.exit ?? Promise.resolve(),
  };
  return { m, state };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("ProcessPool turns", () => {
  it("runs turns at once while under the cap", async () => {
    const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 4 });
    const a = await pool.acquireTurn();
    const b = await pool.acquireTurn();
    expect(pool.turns).toBe(2);
    a.release();
    b.release();
    expect(pool.turns).toBe(0);
  });

  it("queues the turn over the cap in FIFO order and hands it the freed slot", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
    const first = await pool.acquireTurn();
    const order: string[] = [];
    const second = pool.acquireTurn().then((slot) => (order.push("second"), slot));
    const third = pool.acquireTurn().then((slot) => (order.push("third"), slot));
    await flush();
    expect(order).toEqual([]);
    expect(pool.queued).toBe(2);
    first.release();
    const slot2 = await second;
    expect(order).toEqual(["second"]);
    expect(pool.turns).toBe(1);
    slot2.release();
    (await third).release();
    expect(order).toEqual(["second", "third"]);
    expect(pool.turns).toBe(0);
  });

  it("lets a waiting turn leave the queue on abort without holding a slot", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
    const first = await pool.acquireTurn();
    const controller = new AbortController();
    const waiting = pool.acquireTurn(controller.signal);
    const next = pool.acquireTurn();
    await flush();
    controller.abort(new Error("stop"));
    await expect(waiting).rejects.toThrow("stop");
    expect(pool.queued).toBe(1);
    first.release();
    (await next).release();
    expect(pool.turns).toBe(0);
  });

  it("throws at once for a signal that is already aborted", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
    const controller = new AbortController();
    controller.abort(new Error("gone"));
    await expect(pool.acquireTurn(controller.signal)).rejects.toThrow("gone");
    expect(pool.turns).toBe(0);
  });

  it("counts a double release once", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 4 });
    const slot = await pool.acquireTurn();
    slot.release();
    slot.release();
    expect(pool.turns).toBe(0);
    const again = await pool.acquireTurn();
    const waiting = pool.acquireTurn();
    slot.release();
    await flush();
    expect(pool.queued).toBe(1);
    again.release();
    (await waiting).release();
  });
});

describe("ProcessPool processes", () => {
  it("evicts the least recently used idle process at the cap", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 3 });
    const busy = member({ idle: false, lastUsed: 1 });
    const old = member({ lastUsed: 5 });
    const recent = member({ lastUsed: 9 });
    for (const x of [busy, old, recent]) await pool.add(x.m);
    const fresh = member();
    await pool.add(fresh.m);
    expect(old.state.closed).toBe(1);
    expect(recent.state.closed).toBe(0);
    expect(busy.state.closed).toBe(0);
    expect(pool.processes).toBe(3);
  });

  it("frees the slot when a process leaves", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    const a = member();
    await pool.add(a.m);
    pool.remove(a.m);
    const b = member();
    await pool.add(b.m);
    expect(a.state.closed).toBe(0);
  });

  it("fails retryably as overloaded when no process is idle", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    await pool.add(member({ idle: false }).m);
    const error = await pool.add(member().m).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CliError);
    expect(error).toMatchObject({ code: "overloaded", retryable: true });
    expect(pool.processes).toBe(1);
  });

  it("waits for the evicted process to exit before it counts the new one", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    let exit!: () => void;
    const old = member({ exit: new Promise<void>((resolve) => (exit = resolve)) });
    await pool.add(old.m);
    let admitted = false;
    const adding = pool.add(member().m).then(() => (admitted = true));
    await flush();
    expect(old.state.closed).toBe(1);
    expect(admitted).toBe(false);
    exit();
    await adding;
    expect(pool.processes).toBe(1);
  });

  it("stops waiting for an evicted process that does not exit", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1, closeWaitMs: 30 });
    await pool.add(member({ exit: new Promise<void>(() => {}) }).m);
    await pool.add(member().m);
    expect(pool.processes).toBe(1);
  });

  it("shares one version check between concurrent callers and remembers only a pass", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    let calls = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const run = async () => {
      calls += 1;
      await gate;
      return "ok" as const;
    };
    const all = [1, 2, 3, 4].map(() => pool.checkVersionOnce("acme", run));
    release();
    expect(await Promise.all(all)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(calls).toBe(1);
    await pool.checkVersionOnce("acme", run);
    expect(calls).toBe(1);
    await pool.checkVersionOnce("/other", async () => ({ warning: "w" }));
    let again = 0;
    await pool.checkVersionOnce("/other", async () => (again += 1, "ok" as const));
    expect(again).toBe(1);
    await expect(
      pool.checkVersionOnce("/bad", async () => {
        throw new Error("old");
      }),
    ).rejects.toThrow("old");
    await expect(pool.checkVersionOnce("/bad", async () => "ok" as const)).resolves.toBe("ok");
  });
});

describe("ProcessPool.closeAll", () => {
  it("closes every process, waits for the exits, then refuses new work", async () => {
    const pool = new ProcessPool({ maxTurns: 2, maxProcesses: 4 });
    let exit!: () => void;
    const slow = member({ idle: false, exit: new Promise<void>((resolve) => (exit = resolve)) });
    const idle = member();
    await pool.add(slow.m);
    await pool.add(idle.m);
    let done = false;
    const closing = pool.closeAll().then(() => (done = true));
    await flush();
    expect(slow.state.closed).toBe(1);
    expect(idle.state.closed).toBe(1);
    expect(done).toBe(false);
    exit();
    await closing;
    await expect(pool.acquireTurn()).rejects.toMatchObject({ code: "server_error", retryable: true });
    await expect(pool.add(member().m)).rejects.toThrow(/shutting down/);
  });

  it("stops waiting for a process that does not exit", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1, closeWaitMs: 30 });
    await pool.add(member({ exit: new Promise<void>(() => {}) }).m);
    const started = Date.now();
    await pool.closeAll();
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  it("rejects the queued turns", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 1 });
    await pool.acquireTurn();
    const waiting = pool.acquireTurn();
    const assertion = expect(waiting).rejects.toMatchObject({ code: "server_error" });
    await pool.closeAll();
    await assertion;
    expect(pool.queued).toBe(0);
  });

  it("shares one run between calls and survives a process that fails to close", async () => {
    const pool = new ProcessPool({ maxTurns: 1, maxProcesses: 2 });
    const bad = member();
    bad.m.close = () => {
      throw new Error("boom");
    };
    const good = member();
    await pool.add(bad.m);
    await pool.add(good.m);
    const [a, b] = [pool.closeAll(), pool.closeAll()];
    expect(a).toBe(b);
    await a;
    expect(good.state.closed).toBe(1);
  });
});

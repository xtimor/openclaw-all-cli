import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../test/fixtures/paths.ts";
import { inspectProcess, recordProcess, reapOnce, reapStale, type PidLockRecord } from "./pid-locks.ts";

const root = mkdtempSync(join(tmpdir(), "oac-pid-locks-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let counter = 0;
const newHome = () => {
  const dir = join(root, `home-${(counter += 1)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
};
const lockFile = (home: string, pid: number) => join(home, "pids", `${pid}.json`);

const children: ChildProcess[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
});

/** A fake agent that ignores stdin EOF (and SIGTERM when asked), like the real one ignores EOF. */
async function startAgent(extra: Record<string, string> = {}): Promise<ChildProcess & { pid: number }> {
  const child = spawn(process.execPath, [FAKE_CURSOR_AGENT, "acp"], {
    env: fakeEnv({ FAKE_CURSOR_IGNORE_STDIN_EOF: "1", ...extra }),
    stdio: ["pipe", "ignore", "ignore"],
  });
  children.push(child);
  await new Promise((resolve) => child.once("spawn", resolve));
  return child as ChildProcess & { pid: number };
}

/** A pid that is certainly dead: a child that has exited. */
async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  const pid = child.pid!;
  await new Promise((resolve) => child.once("exit", resolve));
  return pid;
}

async function lockFor(child: { pid: number }, owner: { pid: number; startTime: string }): Promise<PidLockRecord> {
  const state = await inspectProcess(child.pid);
  if (state.kind !== "alive") throw new Error("child not alive");
  return { pid: child.pid, startTime: state.startTime, ownerPid: owner.pid, ownerStartTime: owner.startTime };
}

function write(home: string, record: PidLockRecord, name = `${record.pid}.json`): string {
  mkdirSync(join(home, "pids"), { recursive: true });
  const file = join(home, "pids", name);
  writeFileSync(file, JSON.stringify(record));
  return file;
}

const isAlive = async (pid: number) => (await inspectProcess(pid)).kind === "alive";

async function deadOwner() {
  return { pid: await deadPid(), startTime: "Mon Jan  1 00:00:00 2001" };
}

describe("recordProcess", () => {
  it("writes <home>/pids/<pid>.json with both start times, private, and removes it on release", async () => {
    const home = newHome();
    const child = await startAgent();
    const warnings: string[] = [];
    const lock = await recordProcess(home, child.pid, (m) => warnings.push(m));
    expect(lock).toBeDefined();
    const file = lockFile(home, child.pid);
    const record = JSON.parse(readFileSync(file, "utf8")) as PidLockRecord;
    const own = await inspectProcess(process.pid);
    const theirs = await inspectProcess(child.pid);
    expect(record).toEqual({
      pid: child.pid,
      startTime: (theirs as { startTime: string }).startTime,
      ownerPid: process.pid,
      ownerStartTime: (own as { startTime: string }).startTime,
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, "pids")).mode & 0o777).toBe(0o700);
    await lock!.release();
    expect(existsSync(file)).toBe(false);
    await lock!.release();
    expect(warnings).toEqual([]);
  });

  it("records nothing for a process that is already gone", async () => {
    const home = newHome();
    expect(await recordProcess(home, await deadPid(), () => {})).toBeUndefined();
    expect(existsSync(join(home, "pids"))).toBe(false);
  });

  it("warns once and records nothing when ps is unavailable", async () => {
    const home = newHome();
    const child = await startAgent();
    const path = process.env.PATH;
    process.env.PATH = join(root, "no-binaries-here");
    const warnings: string[] = [];
    const warn = (m: string) => warnings.push(m);
    try {
      expect(await recordProcess(home, child.pid, warn)).toBeUndefined();
      expect(await recordProcess(home, child.pid, warn)).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/ps/);
    expect(existsSync(lockFile(home, child.pid))).toBe(false);
  });
});

describe("reapStale", () => {
  it("kills an orphan whose owner is gone, then deletes its lock", async () => {
    const home = newHome();
    const child = await startAgent();
    const file = write(home, await lockFor(child, await deadOwner()));
    const warnings: string[] = [];
    await reapStale(home, (m) => warnings.push(m));
    expect(await isAlive(child.pid)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(warnings.some((m) => m.includes(String(child.pid)))).toBe(true);
  });

  it("falls back to SIGKILL for an orphan that ignores SIGTERM", async () => {
    const home = newHome();
    const child = await startAgent({ FAKE_CURSOR_IGNORE_TERM: "1" });
    const file = write(home, await lockFor(child, await deadOwner()));
    await reapStale(home, () => {});
    expect(await isAlive(child.pid)).toBe(false);
    expect(existsSync(file)).toBe(false);
  }, 20_000);

  it("leaves the process and the lock alone while the owner is alive", async () => {
    const home = newHome();
    const child = await startAgent();
    const own = await inspectProcess(process.pid);
    const file = write(home, await lockFor(child, { pid: process.pid, startTime: (own as { startTime: string }).startTime }));
    await reapStale(home, () => {});
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it("does not kill a reused pid: the start time differs, so only the lock goes", async () => {
    const home = newHome();
    const child = await startAgent();
    const record = await lockFor(child, await deadOwner());
    const file = write(home, { ...record, startTime: "Mon Jan  1 00:00:00 2001" });
    await reapStale(home, () => {});
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it("reaps an orphan whose recorded owner pid now belongs to another process", async () => {
    const home = newHome();
    const child = await startAgent();
    // The owner pid is alive but is another process than the one that wrote the lock.
    const file = write(home, await lockFor(child, { pid: process.pid, startTime: "Mon Jan  1 00:00:00 2001" }));
    await reapStale(home, () => {});
    // The recorded owner (pid and start time) no longer exists, so the orphan is reaped.
    expect(await isAlive(child.pid)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("deletes the lock of a process that is already gone", async () => {
    const home = newHome();
    const pid = await deadPid();
    const file = write(home, { pid, startTime: "x", ownerPid: await deadPid(), ownerStartTime: "y" });
    await reapStale(home, () => {});
    expect(existsSync(file)).toBe(false);
  });

  it("deletes a corrupt <pid>.json, and ignores other file names", async () => {
    const home = newHome();
    mkdirSync(join(home, "pids"), { recursive: true });
    const corrupt = join(home, "pids", "4242.json");
    const mismatched = join(home, "pids", "4243.json");
    const foreign = join(home, "pids", "notes.txt");
    const foreignJson = join(home, "pids", "backup.json");
    writeFileSync(corrupt, "{not json");
    writeFileSync(mismatched, JSON.stringify({ pid: 1, startTime: "a", ownerPid: 2, ownerStartTime: "b" }));
    writeFileSync(foreign, "keep");
    writeFileSync(foreignJson, "{}");
    const warnings: string[] = [];
    await reapStale(home, (m) => warnings.push(m));
    expect(existsSync(corrupt)).toBe(false);
    expect(existsSync(mismatched)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(existsSync(foreignJson)).toBe(true);
    expect(warnings.filter((m) => /corrupt/.test(m))).toHaveLength(2);
  });

  it("does nothing for a home without pid locks", async () => {
    await expect(reapStale(join(root, "never-created"), () => {})).resolves.toBeUndefined();
  });

  it("kills nothing and keeps the lock when ps is unavailable", async () => {
    const home = newHome();
    const child = await startAgent();
    const file = write(home, await lockFor(child, await deadOwner()));
    const path = process.env.PATH;
    process.env.PATH = join(root, "no-binaries-here");
    const warnings: string[] = [];
    try {
      await reapStale(home, (m) => warnings.push(m));
    } finally {
      process.env.PATH = path;
    }
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(warnings).toHaveLength(1);
  });
});

describe("reapOnce", () => {
  it("reaps a home once per process, sharing the run", async () => {
    const home = newHome();
    const first = reapOnce(home, () => {});
    const second = reapOnce(home, () => {});
    expect(second).toBe(first);
    await first;
    // A lock written after the first reap is not touched by a later call.
    const child = await startAgent();
    const file = write(home, await lockFor(child, await deadOwner()));
    await reapOnce(home, () => {});
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });
});

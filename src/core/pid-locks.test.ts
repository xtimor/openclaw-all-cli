import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
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
    await expect(reapStale(join(root, "never-created"), () => {})).resolves.toBe(true);
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

describe("review hardening", () => {
  it("reads a process start time the same under any TZ", async () => {
    const child = await startAgent();
    const tz = process.env.TZ;
    try {
      process.env.TZ = "UTC";
      const utc = await inspectProcess(child.pid);
      process.env.TZ = "Pacific/Auckland";
      const auckland = await inspectProcess(child.pid);
      expect(auckland).toEqual(utc);
    } finally {
      if (tz === undefined) delete process.env.TZ;
      else process.env.TZ = tz;
    }
  });

  it("does not remember an unavailable owner read", async () => {
    vi.resetModules();
    const fresh = await import("./pid-locks.ts");
    const home = newHome();
    const child = await startAgent();
    const path = process.env.PATH;
    process.env.PATH = join(root, "no-binaries-here");
    try {
      expect(await fresh.recordProcess(home, child.pid, () => {})).toBeUndefined();
    } finally {
      process.env.PATH = path;
    }
    const lock = await fresh.recordProcess(home, child.pid, () => {});
    expect(lock).toBeDefined();
    await lock!.release();
  });

  it("does not remember a reap that ps made impossible", async () => {
    const home = newHome();
    const child = await startAgent();
    const file = write(home, await lockFor(child, await deadOwner()));
    const path = process.env.PATH;
    process.env.PATH = join(root, "no-binaries-here");
    try {
      await reapOnce(home, () => {});
    } finally {
      process.env.PATH = path;
    }
    expect(existsSync(file)).toBe(true);
    await reapOnce(home, () => {});
    expect(await isAlive(child.pid)).toBe(false);
    expect(existsSync(file)).toBe(false);
  });

  it("keeps the lock and does not claim success when the process cannot be stopped", async () => {
    const home = newHome();
    const child = await startAgent();
    const file = write(home, await lockFor(child, await deadOwner()));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    const warnings: string[] = [];
    try {
      await reapStale(home, (m) => warnings.push(m));
    } finally {
      kill.mockRestore();
    }
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(warnings.some((m) => m.startsWith("Could not stop"))).toBe(true);
    expect(warnings.some((m) => m.startsWith("Stopped"))).toBe(false);
  });

  it("removes its temporary file when the rename fails", async () => {
    const home = newHome();
    const child = await startAgent();
    // A directory in the lock's place makes the rename fail.
    mkdirSync(join(home, "pids", `${child.pid}.json`), { recursive: true });
    const warnings: string[] = [];
    expect(await recordProcess(home, child.pid, (m) => warnings.push(m))).toBeUndefined();
    expect(warnings).toHaveLength(1);
    expect(readdirSync(join(home, "pids")).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });
});

describe("process groups (D22)", () => {
  const posix = process.platform !== "win32";
  const spawned: number[] = [];
  afterEach(() => {
    for (const pid of spawned.splice(0)) {
      for (const target of [-pid, pid]) {
        try {
          process.kill(target, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  });

  /**
   * A leader of its own group that starts a worker in that group (like `cursor-agent` and its
   * `worker-server`). It prints the worker's pid. `leaderExits`: the leader is gone, the worker stays.
   */
  async function startGroup(
    options: { ignoreTerm?: boolean; workerIgnoreTerm?: boolean; leaderExits?: boolean; detached?: boolean } = {},
  ): Promise<{ leader: ChildProcess & { pid: number }; worker: number }> {
    const workerCode = `${options.workerIgnoreTerm ? 'process.on("SIGTERM", () => {});' : ""} setTimeout(() => {}, 60000);`;
    const script = `
      const { spawn } = require("node:child_process");
      ${options.ignoreTerm ? 'process.on("SIGTERM", () => {});' : ""}
      const worker = spawn(process.execPath, ["-e", ${JSON.stringify(workerCode)}], { stdio: "ignore" });
      worker.unref();
      process.stdout.write(worker.pid + "\\n", () => { ${options.leaderExits ? "process.exit(0);" : "setTimeout(() => {}, 60000);"} });
    `;
    const leader = spawn(process.execPath, ["-e", script], {
      detached: options.detached ?? true,
      stdio: ["ignore", "pipe", "ignore"],
    }) as ChildProcess & { pid: number };
    spawned.push(leader.pid);
    const worker = await new Promise<number>((resolve) => {
      let text = "";
      leader.stdout!.on("data", (chunk: Buffer) => {
        text += chunk.toString();
        if (text.includes("\n")) resolve(Number(text.trim()));
      });
    });
    spawned.push(worker);
    return { leader, worker };
  }

  /** A lock of a dead owner; `group` is written unless `"absent"` (an old lock). */
  const groupLock = async (child: { pid: number }, group: boolean | "absent" = true) => ({
    ...(await lockFor(child, await deadOwner())),
    ...(group === "absent" ? {} : { group }),
  });

  it("reads the process group of a process", async () => {
    const { leader, worker } = await startGroup();
    const own = await inspectProcess(leader.pid);
    const member = await inspectProcess(worker);
    expect(own).toMatchObject({ kind: "alive", pgid: leader.pid });
    expect(member).toMatchObject({ kind: "alive", pgid: leader.pid });
  });

  it("records `group: true` only for a group leader", async () => {
    const home = newHome();
    const child = await startAgent();
    const lock = await recordProcess(home, child.pid, () => {}, { group: true });
    expect((JSON.parse(readFileSync(lockFile(home, child.pid), "utf8")) as PidLockRecord).group).toBe(true);
    await lock?.release();
    await recordProcess(home, child.pid, () => {});
    expect(JSON.parse(readFileSync(lockFile(home, child.pid), "utf8"))).not.toHaveProperty("group");
  });

  it("treats a lock whose group field is not a boolean as corrupt", async () => {
    const home = newHome();
    const child = await startAgent();
    const file = write(home, { ...(await groupLock(child)), group: "yes" as unknown as boolean });
    await reapStale(home, () => {});
    expect(await isAlive(child.pid)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!posix)("stops a recorded leader's whole group: leader and worker, then the lock", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup();
    const file = write(home, await groupLock(leader));
    const warnings: string[] = [];
    await reapStale(home, (m) => warnings.push(m));
    expect(await isAlive(leader.pid)).toBe(false);
    expect(await isAlive(worker)).toBe(false);
    expect(existsSync(file)).toBe(false);
    expect(warnings.some((m) => m.startsWith("Stopped") && m.includes(String(leader.pid)))).toBe(true);
  });

  it.skipIf(!posix)("kills the group of a leader that ignores SIGTERM", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup({ ignoreTerm: true, workerIgnoreTerm: true });
    const file = write(home, await groupLock(leader));
    await reapStale(home, () => {});
    expect(await isAlive(leader.pid)).toBe(false);
    expect(await isAlive(worker)).toBe(false);
    expect(existsSync(file)).toBe(false);
  }, 20_000);

  it.skipIf(!posix)("sends no SIGKILL once the leader is gone: a member that ignores SIGTERM stays, and the lock is spent", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup({ workerIgnoreTerm: true });
    const file = write(home, await groupLock(leader));
    const warnings: string[] = [];
    await reapStale(home, (m) => warnings.push(m));
    // The leader died on SIGTERM. Nothing proves the rest of the group is ours any more.
    expect(await isAlive(leader.pid)).toBe(false);
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(false);
    expect(warnings.some((m) => m.includes("still running"))).toBe(true);
  }, 20_000);

  it.skipIf(!posix)("signals no group when the recorded leader is gone: the lock goes, the stray member stays", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup({ leaderExits: true });
    await new Promise((resolve) => leader.once("exit", resolve));
    // The leader's pid is dead and its group still has a member: no proof the member is ours.
    const file = write(home, {
      pid: leader.pid,
      startTime: "Mon Jan  1 00:00:00 2001",
      ownerPid: (await deadOwner()).pid,
      ownerStartTime: "y",
      group: true,
    });
    await reapStale(home, () => {});
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!posix)("signals no group when the pid was reused: the start time differs", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup();
    const record = await groupLock(leader);
    const file = write(home, { ...record, startTime: "Mon Jan  1 00:00:00 2001" });
    await reapStale(home, () => {});
    expect(await isAlive(leader.pid)).toBe(true);
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!posix)("stops only the process when it does not lead its group, though the lock says group", async () => {
    const home = newHome();
    // Not detached: the child is in the test's own group, so `pgid != pid`.
    const { leader, worker } = await startGroup({ detached: false });
    const file = write(home, await groupLock(leader));
    await reapStale(home, () => {});
    expect(await isAlive(leader.pid)).toBe(false);
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!posix)("stops only the process for an old lock without a group field", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup();
    const file = write(home, await groupLock(leader, "absent"));
    await reapStale(home, () => {});
    expect(await isAlive(leader.pid)).toBe(false);
    // As before the group handling: the worker is not part of the lock.
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(false);
  });

  it.skipIf(!posix)("leaves a group alone while its owner is alive", async () => {
    const home = newHome();
    const { leader, worker } = await startGroup();
    const own = await inspectProcess(process.pid);
    if (own.kind !== "alive") throw new Error("the test process is not alive");
    const file = write(home, { ...(await lockFor(leader, { pid: process.pid, startTime: own.startTime })), group: true });
    await reapStale(home, () => {});
    expect(await isAlive(leader.pid)).toBe(true);
    expect(await isAlive(worker)).toBe(true);
    expect(existsSync(file)).toBe(true);
  });

  it.skipIf(!posix)("keeps the lock when the group cannot be signalled", async () => {
    const home = newHome();
    const { leader } = await startGroup();
    const file = write(home, await groupLock(leader));
    const kill = vi.spyOn(process, "kill").mockImplementation(() => {
      throw Object.assign(new Error("not permitted"), { code: "EPERM" });
    });
    const warnings: string[] = [];
    try {
      await reapStale(home, (m) => warnings.push(m));
    } finally {
      kill.mockRestore();
    }
    expect(await isAlive(leader.pid)).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(warnings.some((m) => m.startsWith("Could not stop"))).toBe(true);
  });
});

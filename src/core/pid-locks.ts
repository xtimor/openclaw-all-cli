import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * Pid lock files (AD-14). A killed Gateway cannot close its CLI processes, and a CLI may ignore
 * the closed pipe and stay up, so every process the core starts is recorded in its agent home.
 * The next Gateway that uses the home kills what a dead owner left behind. A process is killed
 * only when its recorded pid and start time still match and its owner is gone.
 */

const PIDS_DIR = "pids";
const PS_TIMEOUT_MS = 5_000;
/** After SIGTERM an orphan gets this long to exit before SIGKILL. */
export const REAP_KILL_GRACE_MS = 2_000;
const POLL_MS = 100;

/** What `ps` says about a pid. A zombie counts as gone: it runs nothing and only awaits its parent. */
export type ProcessState = { kind: "alive"; startTime: string } | { kind: "gone" } | { kind: "unavailable" };

/** What a lock file holds. Start times are `ps -o lstart=` text, which is the same on macOS and Linux. */
export type PidLockRecord = { pid: number; startTime: string; ownerPid: number; ownerStartTime: string };

export function inspectProcess(pid: number): Promise<ProcessState> {
  return new Promise((resolve) => {
    execFile(
      "ps",
      ["-o", "stat=", "-o", "lstart=", "-p", String(pid)],
      // UTC and the C locale: the start time reads the same whatever zone or language the Gateway runs in.
      { timeout: PS_TIMEOUT_MS, env: { ...process.env, LC_ALL: "C", TZ: "UTC" } },
      (error, stdout) => {
        if (error) {
          // `ps -p` exits 1 when no such process exists; anything else means `ps` cannot answer.
          resolve((error as { code?: unknown }).code === 1 ? { kind: "gone" } : { kind: "unavailable" });
          return;
        }
        const match = /^\s*(\S+)\s+(.+?)\s*$/.exec(stdout.split("\n")[0] ?? "");
        if (!match || match[1]!.startsWith("Z")) resolve({ kind: "gone" });
        else resolve({ kind: "alive", startTime: match[2]! });
      },
    );
  });
}

let ownerState: ProcessState | undefined;
/** This process's own start time, read once. A failed read is not kept: the next call asks again. */
async function readOwner(): Promise<ProcessState> {
  if (ownerState) return ownerState;
  const state = await inspectProcess(process.pid);
  if (state.kind === "alive") ownerState = state;
  return state;
}

const warnedNoPs = new WeakSet<(message: string) => void>();
function warnNoPs(warn: (message: string) => void): void {
  if (warnedNoPs.has(warn)) return;
  warnedNoPs.add(warn);
  warn("`ps` is not available, so CLI processes are not recorded and leftovers of a killed Gateway are not reaped.");
}

export type ProcessLock = { release(): Promise<void> };

/**
 * Records `pid` in `<homeDir>/pids/<pid>.json` (dir 0700, file 0600, never the workspace).
 * Resolves undefined, and warns, when it cannot: a lock is a safety net, never a reason to fail a turn.
 */
export async function recordProcess(
  homeDir: string,
  pid: number,
  warn: (message: string) => void,
): Promise<ProcessLock | undefined> {
  try {
    const [process_, owner] = await Promise.all([inspectProcess(pid), readOwner()]);
    if (process_.kind === "unavailable" || owner.kind !== "alive") {
      warnNoPs(warn);
      return undefined;
    }
    // Already gone: nothing to guard.
    if (process_.kind !== "alive") return undefined;
    const dir = join(homeDir, PIDS_DIR);
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `${pid}.json`);
    const record: PidLockRecord = {
      pid,
      startTime: process_.startTime,
      ownerPid: process.pid,
      ownerStartTime: owner.startTime,
    };
    const temp = join(dir, `.${pid}.${randomUUID()}.tmp`);
    await writeFile(temp, JSON.stringify(record), { mode: 0o600 });
    try {
      await rename(temp, file);
    } catch (error) {
      await rm(temp, { force: true }).catch(() => {});
      throw error;
    }
    return { release: () => rm(file, { force: true }).catch(() => {}) };
  } catch (error) {
    warn(`Could not record CLI process ${pid}: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

function parseLock(text: string, pid: number): PidLockRecord | undefined {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof value !== "object" || value === null) return undefined;
  const record = value as Record<string, unknown>;
  const valid =
    record.pid === pid &&
    typeof record.startTime === "string" &&
    typeof record.ownerPid === "number" &&
    Number.isInteger(record.ownerPid) &&
    typeof record.ownerStartTime === "string";
  return valid ? (record as PidLockRecord) : undefined;
}

/** "denied" when the signal was refused (EPERM): the process is not ours to stop. A missing process counts as sent. */
function signal(pid: number, name: NodeJS.Signals): "sent" | "denied" {
  try {
    process.kill(pid, name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EPERM") return "denied";
  }
  return "sent";
}

/** Waits until the process is gone or `timeoutMs` passes. True when it is gone. */
async function waitGone(pid: number, startTime: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const state = await inspectProcess(pid);
    if (state.kind === "gone") return true;
    if (state.kind === "alive" && state.startTime !== startTime) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

/**
 * Kills the processes a dead owner left in `<homeDir>/pids/` and deletes their locks. A lock whose
 * owner is alive, or whose pid now belongs to another process, kills nothing. Never throws.
 * Resolves false when it could not finish because `ps` is unavailable, so the caller may try again.
 */
export async function reapStale(homeDir: string, warn: (message: string) => void): Promise<boolean> {
  const dir = join(homeDir, PIDS_DIR);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") warn(`Could not read "${dir}": ${String(error)}`);
    return true;
  }
  for (const name of names) {
    const match = /^(\d+)\.json$/.exec(name);
    if (!match) continue;
    const pid = Number(match[1]);
    const file = join(dir, name);
    try {
      const text = await readFile(file, "utf8").catch(() => undefined);
      if (text === undefined) continue;
      const lock = parseLock(text, pid);
      if (!lock) {
        warn(`Removed the corrupt CLI process lock "${name}".`);
        await rm(file, { force: true });
        continue;
      }
      const owner = await inspectProcess(lock.ownerPid);
      if (owner.kind === "unavailable") {
        warnNoPs(warn);
        return false;
      }
      // Its owner is a live Gateway (this one or another): the process is in use.
      if (owner.kind === "alive" && owner.startTime === lock.ownerStartTime) continue;
      const state = await inspectProcess(pid);
      if (state.kind === "unavailable") {
        warnNoPs(warn);
        return false;
      }
      if (state.kind === "alive" && state.startTime === lock.startTime) {
        let gone = false;
        if (signal(pid, "SIGTERM") === "sent") {
          gone = await waitGone(pid, lock.startTime, REAP_KILL_GRACE_MS);
          if (!gone) {
            // Checked again right before the kill: the pid must still be the recorded process.
            const again = await inspectProcess(pid);
            if (again.kind === "alive" && again.startTime === lock.startTime) {
              if (signal(pid, "SIGKILL") === "sent") gone = await waitGone(pid, lock.startTime, REAP_KILL_GRACE_MS);
            } else {
              gone = true;
            }
          }
        }
        if (!gone) {
          // Still running: the lock stays, so the next start tries again.
          warn(`Could not stop CLI process ${pid}, which a previous Gateway left running.`);
          continue;
        }
        warn(`Stopped CLI process ${pid}, which a previous Gateway left running.`);
      }
      // Gone, reused by another process, or just killed: the lock is spent.
      await rm(file, { force: true });
    } catch (error) {
      warn(`Could not reap the CLI process lock "${name}": ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return true;
}

const reaped = new Map<string, Promise<void>>();

/** Reaps a home once per process: register time and first use of a home share one run. */
export function reapOnce(homeDir: string, warn: (message: string) => void): Promise<void> {
  let run = reaped.get(homeDir);
  if (!run) {
    const started: Promise<void> = reapStale(homeDir, warn).then(
      (complete) => {
        // An unfinished reap (no `ps`) is not remembered: the next use of the home tries again.
        if (!complete && reaped.get(homeDir) === started) reaped.delete(homeDir);
      },
      () => {},
    );
    run = started;
    reaped.set(homeDir, run);
  }
  return run;
}

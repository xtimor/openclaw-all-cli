import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/batch-pending.sh (ticket 3.21 a): the marker a run sets once it claimed a batch and clears once the batch PR is
 * ready, and the stop hook that blocks the run's end while the marker stands.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "batch-pending.sh");

let dir = "";
let marker = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "batch-pending-"));
  marker = join(dir, "marker");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Out {
  code: number;
  stdout: string;
  stderr: string;
}

function run(args: string[], input = "{}"): Promise<Out> {
  return new Promise((done) => {
    const child = execFile("bash", [SCRIPT, ...args], { env: { ...process.env, OAC_BATCH_MARKER: marker }, timeout: 20_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
    child.stdin?.end(input);
  });
}

const decision = (out: Out) => (out.stdout.trim() === "" ? null : (JSON.parse(out.stdout) as { decision: string; reason: string }));

describe("batch-pending", () => {
  it("NO_MARKER: the stop hook says nothing and lets the session stop", async () => {
    expect(await run(["stop-hook"])).toEqual({ code: 0, stdout: "", stderr: "" });
  });

  it("CLAIMED: with the marker set, the hook blocks with a reason that names the branch and the steps", async () => {
    expect((await run(["set", "claude/ready-abc123"])).code).toBe(0);
    const out = await run(["stop-hook"]);
    expect(out.code).toBe(0);
    const parsed = decision(out);
    expect(parsed?.decision).toBe("block");
    expect(parsed?.reason).toContain("claude/ready-abc123");
    expect(parsed?.reason).toContain("Open the pull request");
    expect(parsed?.reason).toContain("scripts/batch-pending.sh clear");
  });

  it("CLEARED: after clear the hook lets the session stop; clear without a marker is fine", async () => {
    await run(["set", "claude/x"]);
    expect((await run(["clear"])).code).toBe(0);
    expect(existsSync(marker)).toBe(false);
    expect(await run(["stop-hook"])).toEqual({ code: 0, stdout: "", stderr: "" });
    expect((await run(["clear"])).code).toBe(0);
  });

  it("NOT_A_TRAP: the hook blocks three times, then lets go and removes the marker", async () => {
    await run(["set", "claude/x"]);
    for (let i = 0; i < 3; i++) expect(decision(await run(["stop-hook"]))?.decision, `block ${i + 1}`).toBe("block");
    expect(decision(await run(["stop-hook"]))).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("STALE: a marker older than 12 hours, or one with a damaged field, is ignored and removed", async () => {
    const old = Math.floor(Date.now() / 1000) - 13 * 3600;
    writeFileSync(marker, `branch=claude/x\nstarted=${old}\nblocks=0\n`);
    expect(decision(await run(["stop-hook"]))).toBeNull();
    expect(existsSync(marker)).toBe(false);
    writeFileSync(marker, "branch=claude/x\nstarted=soon\nblocks=0\n");
    expect(decision(await run(["stop-hook"]))).toBeNull();
    expect(existsSync(marker)).toBe(false);
    writeFileSync(marker, `branch=claude/x\nstarted=${Math.floor(Date.now() / 1000)}\nblocks=many\n`);
    expect(decision(await run(["stop-hook"]))).toBeNull();
  });

  it("USAGE: a bad branch name, a missing branch, extra arguments, and an unknown command exit 2 and write no marker", async () => {
    for (const args of [["set"], ["set", 'claude/"x'], ["set", "a b"], ["set", "claude/x", "extra"], ["clear", "now"], ["nope"], []]) {
      const out = await run(args);
      expect(out.code, args.join(" ")).toBe(2);
      expect(out.stderr).toContain("batch-pending:");
    }
    expect(existsSync(marker)).toBe(false);
  });

  it("MARKER_FILE: holds the branch, a start time, and a block count only; the script is executable", async () => {
    await run(["set", "claude/x"]);
    expect(readFileSync(marker, "utf8")).toMatch(/^branch=claude\/x\nstarted=\d+\nblocks=0\n$/);
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });
});

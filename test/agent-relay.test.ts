import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/agent-relay.sh against a stub `gh` (ticket 3.17). Every relay row of the matrix: success prints the run id, a failed
 * dispatch, no run URL, a failed run, and a missing or invalid ops file (exit 2 before any dispatch). Nothing here reaches GitHub.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "agent-relay.sh");
const RUN_URL = "https://github.com/xtimor/openclaw-all-cli/actions/runs/424242";
const SECRET = "ghs_SHOULD_NEVER_APPEAR_0123456789";

const STUB_GH = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$STUB_LOG"
case "$1 $2" in
  "workflow run")
    [ "\${STUB_DISPATCH_FAIL:-0}" = 1 ] && { echo "gh: HTTP 500" >&2; exit 1; }
    [ "\${STUB_NO_URL:-0}" = 1 ] && exit 0
    echo "\${STUB_URL:-${RUN_URL}}" ;;
  "run watch")
    echo "watching"
    [ "\${STUB_WATCH_FAIL:-0}" = 1 ] && exit 1
    exit 0 ;;
  "api repos/"*)
    echo "\${STUB_CONCLUSION-success}" ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`;

let work: string;
let stub: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "agent-relay-"));
  stub = join(work, "gh");
  writeFileSync(stub, STUB_GH);
  chmodSync(stub, 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function relay(ops: string | null, env: Record<string, string> = {}, args?: string[]) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(dir);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const file = join(dir, "ops.json");
  if (ops !== null) writeFileSync(file, ops);
  const result = spawnSync("bash", [SCRIPT, ...(args ?? [file])], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_RELAY_GH: stub, STUB_LOG: log, ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const OPS = '[{"op":"comment","issue":12,"body":"hi"}]';

describe("agent-relay.sh", () => {
  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("RELAY_OK: dispatches agent-write.yml on main with the file's text, watches, checks the run, and prints the run id", () => {
    const result = relay(OPS);
    expect(result).toMatchObject({ status: 0, stdout: "424242\n" });
    expect(result.calls).toEqual([`workflow run agent-write.yml --ref main -f ops=${OPS}`, "run watch 424242 --exit-status", "api repos/xtimor/openclaw-all-cli/actions/runs/424242 --jq .conclusion"]);
  });

  it("RELAY_OK: a failed watch does not matter when the run's conclusion is success; REPO moves the read", () => {
    const result = relay(OPS, { STUB_WATCH_FAIL: "1", REPO: "o/r" });
    expect(result).toMatchObject({ status: 0, stdout: "424242\n" });
    expect(result.calls[2]).toBe("api repos/o/r/actions/runs/424242 --jq .conclusion");
  });

  it("DISPATCH_FAILS: gh workflow run exits 1 -> exit 1, 'dispatch failed', nothing watched", () => {
    const result = relay(OPS, { STUB_DISPATCH_FAIL: "1" });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("dispatch failed");
    expect(result.calls).toHaveLength(1);
  });

  it("NO_URL: gh prints nothing, or a URL without a numeric id -> exit 1, 'no run id', nothing watched", () => {
    const cases: Array<Record<string, string>> = [{ STUB_NO_URL: "1" }, { STUB_URL: "https://github.com/xtimor/openclaw-all-cli/actions" }, { STUB_URL: `${RUN_URL}x` }];
    for (const env of cases) {
      const result = relay(OPS, env);
      expect(result.status, JSON.stringify(env)).toBe(1);
      expect(result.stderr).toContain("no run id");
      expect(result.stdout).toBe("");
      expect(result.calls).toHaveLength(1);
    }
  });

  it("RUN_FAILED: a conclusion other than success -> exit 1 with 'relay run <id>: <conclusion>'", () => {
    for (const conclusion of ["failure", "cancelled", "null", ""]) {
      const result = relay(OPS, { STUB_CONCLUSION: conclusion, STUB_WATCH_FAIL: "1" });
      expect(result.status, conclusion).toBe(1);
      expect(result.stderr).toContain(`relay run 424242: ${conclusion}`);
      expect(result.stdout).toBe("");
    }
  });

  it("MISSING_FILE: a missing path, invalid JSON, or wrong usage exits 2 before any dispatch", () => {
    const missing = relay(null);
    expect(missing.status).toBe(2);
    expect(missing.calls).toEqual([]);
    for (const text of ["not json", "", "[1,"]) {
      const bad = relay(text);
      expect(bad.status, JSON.stringify(text)).toBe(2);
      expect(bad.stderr).toContain("not valid JSON");
      expect(bad.calls).toEqual([]);
    }
    for (const args of [[], ["a", "b"]]) {
      const usage = relay(OPS, {}, args);
      expect(usage.status).toBe(2);
      expect(usage.calls).toEqual([]);
    }
  });

  it("prints no ops text on stdout or stderr, and touches no proxy variable", () => {
    const text = JSON.stringify([{ op: "comment", issue: 12, body: SECRET }]);
    const cases: Array<Record<string, string>> = [{}, { STUB_CONCLUSION: "failure" }, { STUB_DISPATCH_FAIL: "1" }];
    for (const env of cases) {
      const result = relay(text, env);
      expect(result.stdout + result.stderr).not.toContain(SECRET);
    }
    const source = readFileSync(SCRIPT, "utf8");
    expect(source).not.toMatch(/\bunset\b|noproxy|HTTPS?_PROXY|NO_PROXY|http_proxy/i);
  });
});

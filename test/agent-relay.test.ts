import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
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
    case "$*" in
      *.status*)
        n=$(cat "$STUB_LOG.polls" 2>/dev/null || echo 0); echo $((n + 1)) >"$STUB_LOG.polls"
        if [ "$n" -lt "\${STUB_RUNNING_POLLS:-0}" ]; then echo "\${STUB_RUNNING_STATUS:-in_progress}"; else echo completed; fi ;;
      *) echo "\${STUB_CONCLUSION-success}" ;;
    esac ;;
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
    env: { PATH: process.env.PATH ?? "", HOME: dir, AGENT_RELAY_GH: stub, STUB_LOG: log, AGENT_RELAY_POLL_SECONDS: "0", ...env },
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
    expect(result.calls).toEqual([`workflow run agent-write.yml --ref main -f ops=${OPS}`, "run watch 424242 --exit-status", "api repos/xtimor/openclaw-all-cli/actions/runs/424242 --jq .status", "api repos/xtimor/openclaw-all-cli/actions/runs/424242 --jq .conclusion"]);
  });

  it("RELAY_OK: a failed watch does not matter when the run's conclusion is success; REPO moves the read", () => {
    const result = relay(OPS, { STUB_WATCH_FAIL: "1", REPO: "o/r" });
    expect(result).toMatchObject({ status: 0, stdout: "424242\n" });
    expect(result.calls[2]).toBe("api repos/o/r/actions/runs/424242 --jq .status");
    expect(result.calls[3]).toBe("api repos/o/r/actions/runs/424242 --jq .conclusion");
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

  it("EARLY_WATCH: when watch returns while the run is still going, the script keeps polling the status and then reports the conclusion", () => {
    const result = relay(OPS, { STUB_WATCH_FAIL: "1", STUB_RUNNING_POLLS: "3" });
    expect(result).toMatchObject({ status: 0, stdout: "424242\n" });
    expect(result.calls.filter((call) => call.endsWith("--jq .status"))).toHaveLength(4);
    // A run that finishes failed is still reported as failed, after the wait.
    const failed = relay(OPS, { STUB_RUNNING_POLLS: "2", STUB_CONCLUSION: "failure" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("relay run 424242: failure");
  });

  it("STILL_RUNNING: a run not completed after the wait exits 1 with the status and a do-not-re-dispatch hint, never judging the conclusion", () => {
    for (const status of ["in_progress", "queued"]) {
      const result = relay(OPS, { STUB_WATCH_FAIL: "1", STUB_RUNNING_POLLS: "99", STUB_RUNNING_STATUS: status, AGENT_RELAY_MAX_POLLS: "3" });
      expect(result.status, status).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain(`relay run 424242 still ${status}; do not re-dispatch, read back first`);
      expect(result.calls.filter((call) => call.endsWith("--jq .status"))).toHaveLength(3);
      expect(result.calls.some((call) => call.endsWith("--jq .conclusion"))).toBe(false);
      expect(result.calls.filter((call) => call.startsWith("workflow run"))).toHaveLength(1);
    }
  });

  it("NOT_AN_ARRAY: JSON that is not a top-level array exits 2 before any dispatch (node and jq paths alike)", () => {
    const jqOnly = join(work, "jq-only-bin");
    mkdirSync(jqOnly, { recursive: true });
    for (const name of ["jq", "bash", "wc", "cat", "tail", "sleep", "dirname"]) {
      const found = spawnSync("bash", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
      if (found) symlinkSync(found, join(jqOnly, name));
    }
    for (const text of ["null", "false", "true", "0", '"x"', "{}", '{"op":"comment"}']) {
      const envs: Array<Record<string, string>> = [{}, { PATH: jqOnly }];
      for (const env of envs) {
        const result = relay(text, env);
        expect(result.status, `${text} ${JSON.stringify(env)}`).toBe(2);
        expect(result.stderr).toContain("not a JSON array");
        expect(result.calls).toEqual([]);
      }
    }
    const envs: Array<Record<string, string>> = [{}, { PATH: jqOnly }];
    for (const env of envs) expect(relay("[]", { STUB_NO_URL: "1", ...env }).status).toBe(1); // an array passes validation
  });

  it("TOO_LARGE: a file over 60000 bytes exits 2 'ops file too large; split the step' before any dispatch; exactly 60000 passes", () => {
    const over = relay(JSON.stringify(["x".repeat(59_997)]));
    expect(over.status).toBe(2);
    expect(over.stderr).toContain("ops file too large; split the step");
    expect(over.calls).toEqual([]);
    const exact = JSON.stringify(["x".repeat(59_996)]);
    expect(exact.length).toBe(60_000);
    expect(relay(exact).status).toBe(0);
  });

  it("MISSING_FILE: a missing path, invalid JSON, or wrong usage exits 2 before any dispatch", () => {
    const missing = relay(null);
    expect(missing.status).toBe(2);
    expect(missing.calls).toEqual([]);
    for (const text of ["not json", "", "[1,"]) {
      const bad = relay(text);
      expect(bad.status, JSON.stringify(text)).toBe(2);
      expect(bad.stderr).toContain("not a JSON array");
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

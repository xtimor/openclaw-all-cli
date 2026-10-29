import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/upstream-issue.sh against a stub `gh` (ticket 3.23): dispatch, wait, check the conclusion, read the workflow's result
 * annotation (the run log as a fallback), print the issue URL. Every failure path exits 1 or 2 with one line; nothing here reaches
 * GitHub.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "upstream-issue.sh");
const RUN_URL = "https://github.com/xtimor/openclaw-all-cli/actions/runs/515151";
const ISSUE = "https://github.com/openclaw/openclaw/issues/9001";

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
  "run view")
    [ "\${STUB_NO_LOG:-0}" = 1 ] && exit 1
    printf 'file\\tFile the issue\\t2026-10-28T10:00:00.0000000Z %s\\n' "\${STUB_LOG_LINE:-upstream-issue: created ${ISSUE}}"
    printf 'file\\tFile the issue\\t2026-10-28T10:00:01.0000000Z ##[group]other\\n' ;;
  "api repos/"*)
    case "$*" in
      *.status*)
        n=$(cat "$STUB_LOG.polls" 2>/dev/null || echo 0); echo $((n + 1)) >"$STUB_LOG.polls"
        if [ "$n" -lt "\${STUB_RUNNING_POLLS:-0}" ]; then echo in_progress; else echo completed; fi ;;
      *.conclusion*) echo "\${STUB_CONCLUSION-success}" ;;
      */jobs*) echo "\${STUB_JOB-77}" ;;
      */annotations*)
        [ "\${STUB_NO_ANNOTATION:-0}" = 1 ] && exit 0
        printf '%s\\n' "\${STUB_ANNOTATION:-upstream-issue: created ${ISSUE}}" ;;
      *) echo "unexpected api call: $*" >&2; exit 9 ;;
    esac ;;
  *) echo "unexpected gh call: $*" >&2; exit 9 ;;
esac
`;

let work: string;
let stub: string;
let counter = 0;

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "upstream-issue-sh-"));
  stub = join(work, "gh");
  writeFileSync(stub, STUB_GH);
  chmodSync(stub, 0o755);
});

afterAll(() => rmSync(work, { recursive: true, force: true }));

function helper(input: string | null, env: Record<string, string> = {}, args?: string[]) {
  const dir = join(work, `case-${counter++}`);
  mkdirSync(dir);
  const log = join(dir, "calls.log");
  writeFileSync(log, "");
  const file = join(dir, "issue.json");
  if (input !== null) writeFileSync(file, input);
  const result = spawnSync("bash", [SCRIPT, ...(args ?? [file])], {
    cwd: dir,
    encoding: "utf8",
    env: { PATH: process.env.PATH ?? "", HOME: dir, UPSTREAM_ISSUE_GH: stub, STUB_LOG: log, UPSTREAM_ISSUE_POLL_SECONDS: "0", ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, calls: readFileSync(log, "utf8").split("\n").filter(Boolean) };
}

const JSON_OBJECT = '{"title":"t","body":"b\\nFiled for xtimor/openclaw-all-cli#45"}';

describe("upstream-issue.sh", () => {
  it("is executable", () => {
    expect(statSync(SCRIPT).mode & 0o111).not.toBe(0);
  });

  it("OK: dispatches upstream-issue.yml on main with the file's text, watches, reads the annotation, prints only the URL", () => {
    const result = helper(JSON_OBJECT);
    expect(result).toMatchObject({ status: 0, stdout: `${ISSUE}\n` });
    expect(result.stderr).toContain("created");
    expect(result.calls).toEqual([
      `workflow run upstream-issue.yml --repo xtimor/openclaw-all-cli --ref main -f issue=${JSON_OBJECT}`,
      "run watch 515151 --repo xtimor/openclaw-all-cli --exit-status",
      "api repos/xtimor/openclaw-all-cli/actions/runs/515151 --jq .status",
      "api repos/xtimor/openclaw-all-cli/actions/runs/515151 --jq .conclusion",
      "api repos/xtimor/openclaw-all-cli/actions/runs/515151/jobs --jq .jobs[0].id",
      "api repos/xtimor/openclaw-all-cli/check-runs/77/annotations --jq .[].message",
    ]);
  });

  it("COMMENT: a comment file is dispatched as it is, and the comment's URL (with its fragment) is printed; `existing` works the same", () => {
    const comment = '{"op":"comment","issue":172969,"body":"b\\nFiled for xtimor/openclaw-all-cli#45"}';
    const url = "https://github.com/openclaw/openclaw/issues/172969#issuecomment-9001";
    const made = helper(comment, { STUB_ANNOTATION: `upstream-issue: commented ${url}` });
    expect(made).toMatchObject({ status: 0, stdout: `${url}\n` });
    expect(made.stderr).toContain("commented");
    expect(made.calls[0]).toBe(`workflow run upstream-issue.yml --repo xtimor/openclaw-all-cli --ref main -f issue=${comment}`);
    const again = helper(comment, { STUB_ANNOTATION: `upstream-issue: existing ${url}` });
    expect(again).toMatchObject({ status: 0, stdout: `${url}\n` });
    expect(again.stderr).toContain("existing");
    // Only this repository's issue URLs, with at most a comment fragment, are accepted.
    for (const line of [`commented ${url}x`, `commented ${url}#issuecomment-`, "commented https://github.com/evil/repo/issues/1#issuecomment-2", `commented ${url}#issuecomment-1#x`, `deleted ${url}`]) {
      const result = helper(comment, { STUB_ANNOTATION: `upstream-issue: ${line}`, STUB_NO_LOG: "1" });
      expect(result.status, line).toBe(1);
      expect(result.stdout).toBe("");
    }
  });

  it("EXISTING: an `existing` result prints the URL and says so on stderr; REPO moves the reads", () => {
    const result = helper(JSON_OBJECT, { STUB_ANNOTATION: `upstream-issue: existing ${ISSUE}`, UPSTREAM_ISSUE_REPO: "o/r" });
    expect(result).toMatchObject({ status: 0, stdout: `${ISSUE}\n` });
    expect(result.stderr).toContain("existing");
    // Dispatch, watch, and reads all name the same repository: never the current directory's.
    expect(result.calls[0]).toContain("--repo o/r ");
    expect(result.calls[1]).toBe("run watch 515151 --repo o/r --exit-status");
    expect(result.calls[2]).toBe("api repos/o/r/actions/runs/515151 --jq .status");
    // The old hook name no longer moves anything.
    expect(helper(JSON_OBJECT, { REPO: "o/r" }).calls[0]).toContain("--repo xtimor/openclaw-all-cli ");
  });

  it("LOG_FALLBACK: no annotation falls back to the run log, whose timestamps are stripped", () => {
    const result = helper(JSON_OBJECT, { STUB_NO_ANNOTATION: "1" });
    expect(result).toMatchObject({ status: 0, stdout: `${ISSUE}\n` });
    expect(result.calls.some((call) => call.startsWith("run view 515151"))).toBe(true);
  });

  it("NO_RESULT: a successful run whose result cannot be read, or reads as something else, exits 1 and prints no URL", () => {
    const cases: Array<Record<string, string>> = [{ STUB_NO_ANNOTATION: "1", STUB_NO_LOG: "1" }, { STUB_ANNOTATION: "upstream-issue: created https://github.com/evil/repo/issues/1", STUB_NO_LOG: "1" }, { STUB_ANNOTATION: "created " + ISSUE, STUB_NO_LOG: "1" }, { STUB_JOB: "x", STUB_NO_LOG: "1" }];
    for (const env of cases) {
      const result = helper(JSON_OBJECT, env);
      expect(result.status, JSON.stringify(env)).toBe(1);
      expect(result.stdout).toBe("");
      expect(result.stderr).toContain("could not be read");
    }
  });

  it("RUN_FAILED: a conclusion other than success exits 1 with 'run <id>: <conclusion>' and the script's reason when there is one", () => {
    const refused = helper(JSON_OBJECT, { STUB_CONCLUSION: "failure", STUB_ANNOTATION: "upstream-issue: Refused, nothing created: the body must hold exactly one line" });
    expect(refused.status).toBe(1);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("run 515151: failure (upstream-issue: Refused, nothing created: the body must hold exactly one line)");
    for (const conclusion of ["cancelled", "null", ""]) {
      const result = helper(JSON_OBJECT, { STUB_CONCLUSION: conclusion, STUB_NO_ANNOTATION: "1", STUB_NO_LOG: "1" });
      expect(result.status, conclusion).toBe(1);
      expect(result.stderr).toContain(`run 515151: ${conclusion}`);
      expect(result.stdout).toBe("");
    }
  });

  it("a success conclusion with a failure-looking line never prints a URL it did not match", () => {
    const result = helper(JSON_OBJECT, { STUB_ANNOTATION: `upstream-issue: Refused, nothing created: x ${ISSUE}` });
    expect(result.status).toBe(1);
    expect(result.stdout).toBe("");
  });

  it("DISPATCH_FAILS and NO_URL: exit 1, nothing watched", () => {
    const failed = helper(JSON_OBJECT, { STUB_DISPATCH_FAIL: "1" });
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain("dispatch failed");
    expect(failed.calls).toHaveLength(1);
    const urls: Array<Record<string, string>> = [{ STUB_NO_URL: "1" }, { STUB_URL: "https://github.com/xtimor/openclaw-all-cli/actions" }];
    for (const env of urls) {
      const result = helper(JSON_OBJECT, env);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain("no run id");
      expect(result.calls).toHaveLength(1);
    }
  });

  it("EARLY_WATCH: when watch returns while the run is still going, it keeps polling; a run still going after the wait exits 1", () => {
    const waited = helper(JSON_OBJECT, { STUB_WATCH_FAIL: "1", STUB_RUNNING_POLLS: "3" });
    expect(waited).toMatchObject({ status: 0, stdout: `${ISSUE}\n` });
    expect(waited.calls.filter((call) => call.endsWith("--jq .status"))).toHaveLength(4);
    const stuck = helper(JSON_OBJECT, { STUB_RUNNING_POLLS: "99", UPSTREAM_ISSUE_MAX_POLLS: "3" });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("still");
    expect(stuck.stdout).toBe("");
  });

  it("USAGE: a missing argument, a missing, oversize, non-object, or invalid file exits 2 before any dispatch", () => {
    const cases: Array<[string | null, string[] | undefined]> = [
      [null, []],
      [null, undefined],
      ["[1]", undefined],
      ["not json", undefined],
      ['"text"', undefined],
      ["null", undefined],
      [`{"title":"${"x".repeat(40_001)}"}`, undefined],
    ];
    for (const [input, args] of cases) {
      const result = helper(input, {}, args);
      expect(result.status, String(input).slice(0, 20)).toBe(2);
      expect(result.calls).toEqual([]);
    }
  });
});

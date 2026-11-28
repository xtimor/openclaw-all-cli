import { execFile } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/regression-beta-issue.mjs (epic-regression-gate ticket 4) against a local stub of the GitHub issues API: the
 * weekly beta run red with no open issue (one issue), red with one open (one comment, no issue), green (nothing), and a
 * re-run of the same run (nothing, also when the issue lost its label), and paging. Plus `scripts/regression.sh resolve`,
 * offline with a stub `npm` (the matrix the regression workflow builds), and the `--result` summary
 * (`scripts/regression-result.mjs`: passed, failed with the test names, error). Nothing reaches the real API or npm.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "regression-beta-issue.mjs");
const REGRESSION = join(ROOT, "scripts", "regression.sh");
const REPO = "owner/repo";
const TOKEN = "ghs_STUB_TOKEN_0123456789";
const LABEL = "regression:beta";
// A regression finding goes straight to work (ticket 11): the trusted origin label, the bug type, and the issue flow's open status.
const LABELS = [LABEL, "source:regression", "type:bug", "status:todo"];
const RUN_ID = "4242";
const RUN_URL = `https://github.com/${REPO}/actions/runs/${RUN_ID}`;

interface StubIssue {
  number: number;
  labels: string[];
  state: "open" | "closed";
  body: string;
  comments: string[];
  pull_request?: object;
}

let server: Server;
let base = "";
let issues: StubIssue[] = [];
let failStatus: number | undefined;
let dropLabels = false;
let failLabels = false;
let calls: { method: string; path: string; auth: string | undefined; body: any }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      const url = new URL(req.url ?? "/", "http://stub");
      const body = raw ? JSON.parse(raw) : undefined;
      calls.push({ method: req.method ?? "", path: url.pathname + url.search, auth: req.headers.authorization, body });
      const send = (status: number, payload: unknown) => {
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify(payload));
      };
      if (failStatus) return send(failStatus, { message: "stub failure" });
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const paged = <T>(rows: T[]) => rows.slice((page - 1) * perPage, page * perPage);
      const issueRow = (issue: StubIssue) => ({ number: issue.number, state: issue.state, body: issue.body, labels: issue.labels.map((name) => ({ name })), pull_request: issue.pull_request });
      if (req.method === "GET" && url.pathname === `/repos/${REPO}/issues`) {
        const label = url.searchParams.get("labels");
        const state = url.searchParams.get("state") ?? "open";
        const rows = issues.filter((issue) => (label === null || issue.labels.includes(label)) && (state === "all" || issue.state === state));
        if (url.searchParams.get("sort") === "created" && url.searchParams.get("direction") === "desc") rows.sort((a, b) => b.number - a.number);
        return send(200, paged(rows).map(issueRow));
      }
      if (req.method === "POST" && url.pathname === `/repos/${REPO}/issues`) {
        const issue: StubIssue = { number: 100 + issues.length, labels: dropLabels ? [] : body.labels, state: "open", body: body.body, comments: [] };
        issues.push(issue);
        return send(201, issueRow(issue));
      }
      const match = /^\/repos\/owner\/repo\/issues\/(\d+)\/(comments|labels)$/.exec(url.pathname);
      const issue = match ? issues.find((row) => row.number === Number(match[1])) : undefined;
      if (issue && match?.[2] === "comments" && req.method === "GET") return send(200, paged(issue.comments.map((text, id) => ({ id, body: text }))));
      if (issue && match?.[2] === "comments" && req.method === "POST") {
        issue.comments.push(body.body);
        return send(201, { id: issue.comments.length });
      }
      if (issue && match?.[2] === "labels" && req.method === "POST" && failLabels) return send(500, { message: "stub label failure" });
      if (issue && match?.[2] === "labels" && req.method === "POST") {
        issue.labels.push(...body.labels);
        return send(200, issue.labels.map((name) => ({ name })));
      }
      return send(404, { message: "Not Found" });
    });
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  issues = [];
  failStatus = undefined;
  dropLabels = false;
  failLabels = false;
  calls = [];
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "regression-beta-issue-"));
  dirs.push(dir);
  return dir;
}

const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_")));

/** Runs a command in a child process (never spawnSync while the stub serves in this process). */
function exec(file: string, args: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(file, args, { env, timeout: 20_000 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
}

const run = (args: string[], env: Record<string, string> = {}) =>
  exec(process.execPath, [SCRIPT, ...args], { ...cleanEnv(), GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: base, GITHUB_RUN_ID: RUN_ID, ...env });

function resultsFile(rows: unknown): string {
  const file = join(tempDir(), "results.json");
  writeFileSync(file, typeof rows === "string" ? rows : JSON.stringify(rows));
  return file;
}

const SHA = "a".repeat(64);
const red = [
  {
    version: "2026.12.1-beta.2",
    requests: ["beta"],
    requested: "2026.12.1-beta.2",
    result: "failed",
    seconds: 612,
    sha256: SHA,
    failed: ["auth-setup.regression.test.ts > Connect provider shows the saved key at once (#39)", "turn-process.regression.test.ts > one process per chat (#11)"],
  },
];
const report = (outcome: string, results: string, extra: string[] = []) => run(["report", "--outcome", outcome, "--results", results, "--run-url", RUN_URL, ...extra]);
const openIssue = (number: number, body = "earlier report"): StubIssue => ({ number, labels: [LABEL, "status:todo"], state: "open", body, comments: [] });
const writes = () => calls.filter((call) => call.method !== "GET");

describe("report", () => {
  it("uses labels that .github/labels.yml defines", () => {
    const file = readFileSync(join(ROOT, ".github", "labels.yml"), "utf8");
    for (const name of LABELS) expect(file).toContain(`- name: "${name}"`);
    expect(readFileSync(SCRIPT, "utf8")).toContain(`const LABEL = "${LABEL}";`);
  });

  it("red with no open issue: opens exactly one, with the beta version, the failing scenarios, the run link, and the marker label", async () => {
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("regression-beta-issue: opened #100");
    expect(writes()).toHaveLength(1);
    const post = writes()[0]!;
    expect(post).toMatchObject({ method: "POST", path: `/repos/${REPO}/issues`, auth: `Bearer ${TOKEN}` });
    expect(post.body.title).toBe("OpenClaw beta 2026.12.1-beta.2: the Gateway regression tier is red");
    // Straight to work: source:regression (triage skips it, the implementation run builds it with no approval) and type:bug.
    expect(post.body.labels).toEqual(LABELS);
    const body: string = post.body.body;
    expect(body.split("\n")[0]).toBe(`<!-- regression-beta run=${RUN_ID} -->`);
    expect(body).toContain(`| beta | 2026.12.1-beta.2 | failed | 10m 12s | \`${SHA}\` |`);
    expect(body).toContain("- `auth-setup.regression.test.ts > Connect provider shows the saved key at once (#39)`");
    expect(body).toContain("- `turn-process.regression.test.ts > one process per chat (#11)`");
    expect(body).toContain(`Run: ${RUN_URL}`);
    expect(body).toContain("A regression finding is fixed at once: `source:regression` skips triage and the owner's approval");
    expect(body).toContain("hands the issue to the owner (`status:blocked`)");
    expect(body).not.toContain("Triage decides");
    expect(calls[0]?.path).toBe(`/repos/${REPO}/issues?state=open&labels=regression%3Abeta&per_page=100&page=1`);
  });

  it("red with an open issue: comments on it with the new version and run link, and opens none", async () => {
    issues = [openIssue(7), { ...openIssue(3), state: "closed" }];
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("commented on the open issue #7");
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([`POST /repos/${REPO}/issues/7/comments`]);
    const comment: string = writes()[0]!.body.body;
    expect(comment).toContain(`<!-- regression-beta run=${RUN_ID} -->`);
    expect(comment).toContain("Red again on OpenClaw beta (2026.12.1-beta.2).");
    expect(comment).toContain("turn-process.regression.test.ts > one process per chat (#11)");
    expect(comment).toContain(`Run: ${RUN_URL}`);
    expect(issues.filter((issue) => issue.state === "open")).toHaveLength(1);
  });

  it("green (and any outcome but failure): no issue, no comment, no request at all, even without a token", async () => {
    issues = [openIssue(7)];
    for (const outcome of ["success", "cancelled", "skipped"]) {
      const result = await report(outcome, resultsFile(red), []);
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain(`result is ${outcome}: nothing to report`);
    }
    expect((await run(["report", "--outcome", "success"], { GITHUB_TOKEN: "" })).code).toBe(0);
    expect(calls).toEqual([]);
    expect(issues[0]?.state).toBe("open");
  });

  it("reports a run once: a re-run of the same run after it opened or commented changes nothing", async () => {
    expect((await report("failure", resultsFile(red))).code).toBe(0);
    const again = await report("failure", resultsFile(red));
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`run ${RUN_ID} is already reported on #100`);
    expect(issues).toHaveLength(1);
    expect(issues[0]?.comments).toEqual([]);

    // A later run comments once; its re-run finds the marker in the comments.
    expect((await report("failure", resultsFile(red), ["--run-id", "4243"])).code).toBe(0);
    expect((await report("failure", resultsFile(red), ["--run-id", "4243"])).stdout).toContain("run 4243 is already reported on #100");
    expect(issues).toHaveLength(1);
    expect(issues[0]?.comments).toHaveLength(1);
  });

  it("comments on the oldest open issue when several carry the label, and leaves out pull requests", async () => {
    issues = [{ ...openIssue(2), pull_request: { url: "x" } }, openIssue(9), openIssue(5)];
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(writes().map((call) => call.path)).toEqual([`/repos/${REPO}/issues/5/comments`]);
  });

  it("still opens the issue on a red run with no result (the run stopped before the tier), naming no version", async () => {
    for (const results of ["", "not json", "{}"]) {
      issues = [];
      calls = [];
      const result = await report("failure", resultsFile(results));
      expect(result.code, result.stderr).toBe(0);
      const post = writes()[0]!;
      expect(post.body.title).toBe("OpenClaw beta unknown version: the Gateway regression tier is red");
      expect(post.body.body).toContain("No tier result reached this job");
    }
    expect((await run(["report", "--outcome", "failure", "--run-url", RUN_URL])).code).toBe(0);
  });

  it("a forced red (the dispatch input) reports like a real one", async () => {
    const forced = [{ ...red[0], failed: ["force_red: failed on purpose (workflow_dispatch input)"] }];
    const result = await report("failure", resultsFile(forced));
    expect(result.code, result.stderr).toBe(0);
    expect(writes()[0]!.body.body).toContain("- `force_red: failed on purpose (workflow_dispatch input)`");
  });

  it("never opens a second issue for a run whose issue lost its label: a re-run finds the marker among the newest issues", async () => {
    dropLabels = true;
    failLabels = true;
    const first = await report("failure", resultsFile(red));
    expect(first.code).toBe(1);
    expect(first.stdout).toContain("regression-beta-issue: opened #100");
    expect(first.stderr).toContain(`POST /repos/${REPO}/issues/100/labels: GitHub answered 500`);
    expect(issues[0]?.labels).toEqual([]);

    failLabels = false;
    calls = [];
    const again = await report("failure", resultsFile(red));
    expect(again.code, again.stderr).toBe(0);
    expect(again.stdout).toContain(`run ${RUN_ID} is already reported on #100`);
    expect(calls.map((call) => `${call.method} ${call.path}`)).toEqual([
      `GET /repos/${REPO}/issues?state=open&labels=regression%3Abeta&per_page=100&page=1`,
      `GET /repos/${REPO}/issues?state=all&sort=created&direction=desc&per_page=100&page=1`,
      `POST /repos/${REPO}/issues/100/labels`,
    ]);
    // Only the marker label comes back: the status belongs to the issue flow by now, and source:regression is never added to an issue
    // found only by its marker (plain text anyone can write).
    expect(calls[2]?.body).toEqual({ labels: [LABEL] });
    expect(issues).toHaveLength(1);
    expect(issues[0]?.labels).toEqual([LABEL]);
  });

  it("pages through more than 100 comments to find the run's marker", async () => {
    const issue = openIssue(7);
    issue.comments = Array.from({ length: 150 }, (_, i) => (i === 139 ? `<!-- regression-beta run=${RUN_ID} -->\nRed again` : `comment ${i}`));
    issues = [issue];
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`run ${RUN_ID} is already reported on #7`);
    expect(calls.map((call) => call.path).filter((path) => path.includes("/comments"))).toEqual([
      `/repos/${REPO}/issues/7/comments?per_page=100&page=1`,
      `/repos/${REPO}/issues/7/comments?per_page=100&page=2`,
    ]);
    expect(writes()).toEqual([]);
  });

  it("pages through more than 100 open issues to the oldest, and stops at the page cap", async () => {
    issues = Array.from({ length: 150 }, (_, i) => openIssue(1000 - i));
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(writes().map((call) => call.path)).toEqual([`/repos/${REPO}/issues/851/comments`]);
    expect(calls.filter((call) => call.path.includes("labels=regression")).map((call) => new URL(call.path, base).searchParams.get("page"))).toEqual(["1", "2"]);

    issues = Array.from({ length: 2001 }, (_, i) => openIssue(i + 1));
    calls = [];
    const capped = await report("failure", resultsFile(red));
    expect(capped.code).toBe(1);
    expect(capped.stderr).toContain("more than 2000 rows");
    expect(calls).toHaveLength(20);
    expect(writes()).toEqual([]);
  });

  it("adds the labels again when GitHub dropped them on create", async () => {
    dropLabels = true;
    const result = await report("failure", resultsFile(red));
    expect(result.code, result.stderr).toBe(0);
    expect(writes().map((call) => `${call.method} ${call.path}`)).toEqual([`POST /repos/${REPO}/issues`, `POST /repos/${REPO}/issues/100/labels`]);
    expect(writes()[1]!.body).toEqual({ labels: LABELS });
  });

  it("caps the failing list and keeps each name on one line in backticks", async () => {
    const many = [{ ...red[0], failed: [...Array.from({ length: 33 }, (_, i) => `f.ts > case ${i}`), "x.ts > a `quoted`\nname <!-- regression-beta run=1 -->"] }];
    const result = await report("failure", resultsFile(many));
    expect(result.code, result.stderr).toBe(0);
    const body: string = writes()[0]!.body.body;
    expect(body).toContain("- `f.ts > case 29`");
    expect(body).not.toContain("case 30");
    expect(body).toContain("- and 4 more (see the run)");
    expect(body.match(/<!--/g)).toHaveLength(1);
  });

  it("fails on a red run without a token, when the API fails, or cannot be reached", async () => {
    const noToken = await run(["report", "--outcome", "failure", "--run-url", RUN_URL], { GITHUB_TOKEN: " " });
    expect(noToken.code).toBe(1);
    expect(noToken.stderr).toContain("regression-beta-issue: the run is red but GITHUB_TOKEN is not set");
    expect(calls).toEqual([]);
    failStatus = 500;
    const failing = await report("failure", resultsFile(red));
    expect(failing.code).toBe(1);
    expect(failing.stderr).toContain(`regression-beta-issue: GET /repos/${REPO}/issues?state=open&labels=regression%3Abeta&per_page=100&page=1: GitHub answered 500`);
    const unreachable = await run(["report", "--outcome", "failure", "--run-url", RUN_URL], { GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(unreachable.code).toBe(1);
    expect(unreachable.stderr).toMatch(/regression-beta-issue: GET \/repos\/owner\/repo\/issues.* failed: /);
  });

  it("refuses a bad command, argument, run id, or run URL with exit 2", async () => {
    expect((await run(["open"])).code).toBe(2);
    expect((await run(["report"])).code).toBe(2);
    expect((await run(["report", "--outcome", "failure", "--nope", "x"])).code).toBe(2);
    expect((await run(["report", "--outcome", "failure", "--run-url", RUN_URL], { GITHUB_RUN_ID: "" })).code).toBe(2);
    expect((await run(["report", "--outcome", "failure", "--run-url", "not a url"])).code).toBe(2);
    expect(writes()).toEqual([]);
  });
});

/** A stub `npm` first on PATH: `npm view openclaw dist-tags.<tag>` answers from the table, an unknown tag prints nothing. */
function stubNpm(tags: Record<string, string>): Record<string, string> {
  const bin = join(tempDir(), "bin");
  mkdirSync(bin);
  const cases = Object.entries(tags)
    .map(([tag, version]) => `  dist-tags.${tag}) echo ${version} ;;`)
    .join("\n");
  writeFileSync(join(bin, "npm"), `#!/bin/sh\ncase "$3" in\n${cases}\n  *) echo "" ;;\nesac\n`);
  chmodSync(join(bin, "npm"), 0o755);
  return { ...cleanEnv(), PATH: [bin, dirname(process.execPath), process.env.PATH ?? ""].join(delimiter) };
}

describe("scripts/regression.sh resolve (the workflow's matrix)", () => {
  const resolveRun = (args: string[], env: Record<string, string>) => exec(REGRESSION, ["resolve", ...args], env);

  it("resolves min from package.json and tags through npm, one entry per distinct version naming every request", async () => {
    const result = await resolveRun(["min", "latest", "beta", "2026.10.3", "latest"], stubNpm({ latest: "2026.11.10", beta: "2026.11.10" }));
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      { version: "2026.10.3", requests: ["min", "2026.10.3"] },
      { version: "2026.11.10", requests: ["latest", "beta"] },
    ]);
  });

  it("fails with the script's message on an unknown tag or a bad request, and on no request", async () => {
    const env = stubNpm({ latest: "2026.11.10" });
    const unknown = await resolveRun(["min", "nightly"], env);
    expect(unknown.code).toBe(2);
    expect(unknown.stdout).toBe("");
    expect(unknown.stderr).toContain("Unknown OpenClaw dist-tag 'nightly' (try min, latest, extended-stable, beta, or X.Y.Z).");
    const bad = await resolveRun(["Latest!"], env);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("Not an OpenClaw version or dist-tag: 'Latest!'.");
    expect((await resolveRun([], env)).code).toBe(2);
  });

  it("refuses a --tgz that is not a file before any setup", async () => {
    const result = await exec(REGRESSION, ["gateway", "--tgz", join(tempDir(), "missing.tgz")], stubNpm({}));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--tgz: no such file:");
  });
});

describe("scripts/regression-result.mjs (the summary regression.sh gateway --result writes)", () => {
  const RESULT = join(ROOT, "scripts", "regression-result.mjs");
  const write = async (args: string[]) => {
    const out = join(tempDir(), "logs", "result.json");
    const result = await exec(process.execPath, [RESULT, "--out", out, ...args], cleanEnv());
    return { ...result, out, json: () => JSON.parse(readFileSync(out, "utf8")) };
  };
  const vitestReport = (suites: unknown[]) => {
    const file = join(tempDir(), "result.vitest.json");
    writeFileSync(file, JSON.stringify({ numFailedTests: 0, testResults: suites }));
    return file;
  };
  const common = ["--requested", "min", "--version", "2026.10.3", "--sha256", SHA, "--exit-code"];

  it("passed: the tier ran and exited 0, nothing failed", async () => {
    const report = vitestReport([{ name: "/w/test/regression/gateway/tracer.regression.test.ts", status: "passed", message: "", assertionResults: [{ fullName: "a turn", status: "passed" }] }]);
    const result = await write([...common, "0", "--tier-status", "0", "--seconds", "612", "--report", report]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toEqual({ requested: "min", version: "2026.10.3", sha256: SHA, result: "passed", exitCode: 0, seconds: 612, failed: [] });
  });

  it("failed: lists each failing test by file and full name, and a file that failed outside its tests by its message", async () => {
    const report = vitestReport([
      {
        name: "/w/test/regression/gateway/auth-setup.regression.test.ts",
        status: "failed",
        message: "",
        assertionResults: [
          { fullName: "auth #39: a key saved shows at once", status: "failed" },
          { fullName: "auth PR #96", status: "passed" },
        ],
      },
      { name: "/w/test/regression/gateway/turn-process.regression.test.ts", status: "failed", message: "Hook timed out in 300000ms.\nmore", assertionResults: [{ fullName: "t", status: "skipped" }] },
      { name: "/w/test/regression/gateway/tracer.regression.test.ts", status: "passed", message: "", assertionResults: [] },
    ]);
    const result = await write([...common, "1", "--tier-status", "1", "--seconds", "559", "--report", report]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.json()).toMatchObject({ result: "failed", exitCode: 1, seconds: 559 });
    expect(result.json().failed).toEqual(["auth-setup.regression.test.ts > auth #39: a key saved shows at once", "turn-process.regression.test.ts: Hook timed out in 300000ms."]);
  });

  it("error: no tier status (the run stopped before the tier finished) and no or an unreadable report", async () => {
    for (const report of ["", join(tempDir(), "missing.json")]) {
      const result = await write(["--requested", "nightly", "--version", "", "--sha256", "", "--tier-status", "", "--exit-code", "2", "--seconds", "0", "--report", report]);
      expect(result.code, result.stderr).toBe(0);
      expect(result.json()).toEqual({ requested: "nightly", version: null, sha256: null, result: "error", exitCode: 2, seconds: 0, failed: [] });
    }
  });

  it("refuses a bad argument with exit 2", async () => {
    expect((await exec(process.execPath, [RESULT, "--requested", "min"], cleanEnv())).code).toBe(2);
    expect((await write(["--nope", "x"])).code).toBe(2);
  });

  it("regression.sh gateway --result writes one through its exit trap when the run stops early, with the script's exit code", async () => {
    const out = join(tempDir(), "result.json");
    const result = await exec(REGRESSION, ["gateway", "--openclaw", "nightly", "--result", out], stubNpm({ latest: "2026.11.10" }));
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("Unknown OpenClaw dist-tag 'nightly'");
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ requested: "nightly", version: null, result: "error", exitCode: 2, failed: [] });
  });
});

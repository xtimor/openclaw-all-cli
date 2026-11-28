import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { LEDGER_PATH, loadLedger } from "./regression/ledger.ts";

/**
 * scripts/regression-ledger.mjs check-issues (epic-regression-gate ticket 1) against a local stub of the GitHub
 * issues API: the Issue coverage OK, Issue missing, and No token / API error rows. Nothing reaches the real API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "regression-ledger.mjs");
const REPO = "owner/repo";
const TOKEN = "ghs_STUB_TOKEN_0123456789";

interface StubIssue {
  number: number;
  labels: string[];
  state: "open" | "closed";
  state_reason?: "completed" | "not_planned" | "duplicate";
  pull_request?: object;
}

let server: Server;
let base = "";
let issues: StubIssue[] = [];
let failStatus: number | undefined;
let calls: { path: string; auth: string | undefined }[] = [];

beforeAll(async () => {
  server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    calls.push({ path: url.pathname + url.search, auth: req.headers.authorization });
    const send = (status: number, payload: unknown) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };
    if (failStatus) return send(failStatus, { message: "stub failure" });
    if (req.method === "GET" && url.pathname === `/repos/${REPO}/issues`) {
      const label = url.searchParams.get("labels") ?? "";
      const state = url.searchParams.get("state") ?? "open";
      const perPage = Number(url.searchParams.get("per_page") ?? "30");
      const page = Number(url.searchParams.get("page") ?? "1");
      const rows = issues.filter((issue) => issue.labels.includes(label) && issue.state === state);
      return send(200, rows.slice((page - 1) * perPage, page * perPage).map(({ number, state_reason, pull_request }) => ({ number, state_reason: state_reason ?? null, pull_request })));
    }
    return send(404, { message: "Not Found" });
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
  calls = [];
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const stripGithub = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_")));

/** Runs the script in a child process (never spawnSync while the stub serves in this process). */
function run(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      process.execPath,
      [SCRIPT, ...args],
      { env: { ...stripGithub(), GITHUB_REPOSITORY: REPO, GITHUB_TOKEN: TOKEN, GITHUB_API_URL: base, ...env }, timeout: 20_000 },
      (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }),
    );
  });
}

function tempLedger(text: string): string {
  const dir = mkdtempSync(join(tmpdir(), "regression-ledger-script-"));
  dirs.push(dir);
  const file = join(dir, "ledger.toml");
  writeFileSync(file, text);
  return file;
}

const ledgerOf = (numbers: number[]) =>
  numbers.map((n) => `[[bug]]\nissue = ${n}\ntitle = "bug ${n}"\nfamily = "f"\ntier = "unit"\nfixed = true\ntests = []\nplanned = "4.3"\n`).join("\n");
const closedBug = (number: number): StubIssue => ({ number, labels: ["type:bug"], state: "closed", state_reason: "completed" });

describe("check-issues", () => {
  it("passes on the committed ledger when the closed bugs are the ones it lists, and prints the count", async () => {
    issues = loadLedger().map((bug) => closedBug(bug.issue));
    const result = await run(["check-issues"]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain(`regression-ledger: ${issues.length} type:bug issues of ${REPO} closed as completed, every one in the ledger`);
    expect(calls[0]).toEqual({ path: `/repos/${REPO}/issues?state=closed&labels=type%3Abug&per_page=100&page=1`, auth: `Bearer ${TOKEN}` });
  });

  it("fails when an entry of the committed ledger is removed (mutation in a scratch copy)", async () => {
    issues = loadLedger().map((bug) => closedBug(bug.issue));
    const text = readFileSync(LEDGER_PATH, "utf8");
    const start = text.indexOf("[[bug]]\nissue = 14\n");
    expect(start).toBeGreaterThan(0);
    const end = text.indexOf("[[bug]]", start + 1);
    const result = await run(["check-issues", "--ledger", tempLedger(text.slice(0, start) + text.slice(end))]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(`regression-ledger: 1 type:bug issue(s) of ${REPO} closed as completed have no entry in the ledger: #14`);
  });

  it("lists every closed bug with no entry, across pages, and leaves out pull requests, open issues, and other labels", async () => {
    const listed = Array.from({ length: 120 }, (_, i) => i + 1);
    issues = [
      ...listed.map(closedBug),
      closedBug(200),
      closedBug(150),
      { number: 300, labels: ["type:bug"], state: "closed", pull_request: { url: "x" } },
      { number: 301, labels: ["type:bug"], state: "open" },
      { number: 302, labels: ["type:idea"], state: "closed" },
    ];
    const result = await run(["check-issues", "--ledger", tempLedger(ledgerOf(listed))]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("have no entry in the ledger: #150, #200");
    expect(calls.map((call) => new URL(call.path, base).searchParams.get("page"))).toEqual(["1", "2"]);
  });

  it("passes across pages when every closed bug has an entry; entries for other issues are allowed", async () => {
    const listed = Array.from({ length: 100 }, (_, i) => i + 1);
    issues = listed.map(closedBug);
    const result = await run(["check-issues", "--ledger", tempLedger(ledgerOf([...listed, 102]))]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("100 type:bug issues of owner/repo closed as completed");
    expect(calls).toHaveLength(2);
  });

  it("needs no entry for a bug closed as not planned or as a duplicate", async () => {
    issues = [
      closedBug(1),
      { number: 2, labels: ["type:bug"], state: "closed", state_reason: "not_planned" },
      { number: 3, labels: ["type:bug"], state: "closed", state_reason: "duplicate" },
    ];
    const result = await run(["check-issues", "--ledger", tempLedger(ledgerOf([1]))]);
    expect(result.code, result.stderr).toBe(0);
    expect(result.stdout).toContain("1 type:bug issues of owner/repo closed as completed, every one in the ledger");
  });

  it("skips with exit 0 and no request when GITHUB_TOKEN is unset or blank", async () => {
    for (const token of ["", "  "]) {
      const result = await run(["check-issues"], { GITHUB_TOKEN: token });
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("regression-ledger: skipped: no GITHUB_TOKEN");
    }
    expect(calls).toEqual([]);
  });

  it("fails with the status when the API fails", async () => {
    failStatus = 500;
    const result = await run(["check-issues"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/regression-ledger: GET \/repos\/owner\/repo\/issues\?state=closed&labels=type%3Abug&per_page=100&page=1: GitHub answered 500/);
  });

  it("reads the repository from package.json when GITHUB_REPOSITORY is unset", async () => {
    const result = await run(["check-issues"], { GITHUB_REPOSITORY: "" });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("GET /repos/xtimor/openclaw-all-cli/issues?state=closed");
    expect(result.stderr).toContain("GitHub answered 404");
  });

  it("fails when the API cannot be reached", async () => {
    const result = await run(["check-issues"], { GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(result.code).toBe(1);
    expect(result.stderr).toMatch(/regression-ledger: GET \/repos\/owner\/repo\/issues.* failed: /);
  });

  it("fails naming the line when the ledger does not parse", async () => {
    issues = [closedBug(1)];
    const result = await run(["check-issues", "--ledger", tempLedger("[[bug]]\nissue = 1.5\n")]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('regression-ledger: ledger line 2: unsupported value "1.5"');
  });

  it("refuses an unknown command or argument with exit 2 or 1", async () => {
    expect((await run(["check"])).code).toBe(2);
    expect((await run(["check-issues", "--nope"])).code).toBe(1);
  });
});

import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/batch-merge.mjs against a local stub of the GitHub REST endpoints (ticket 3.20). Every row of the ticket's I/O
 * matrix: which pull requests are looked at, each guard (no merge call when it says no), the one merge call, and no token on
 * any stream or in the summary. The script runs in a child process, never spawnSync, since the stub serves from this process.
 * Nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "batch-merge.mjs");
const REPO = "xtimor/openclaw-all-cli";
const BOT = "oac-issue-agents[bot]";
const TOKEN = "ghs_STUB_INSTALLATION_TOKEN_0123456789";
const BASE_SHA = "b".repeat(40);
const TITLE_MARK = "TITLE_MARKER_must_not_be_echoed_5521";

interface Call {
  method: string;
  path: string;
  search: string;
  body: Record<string, unknown> | null;
  auth: string | undefined;
}

type Answer = [number, unknown];

let server: Server;
let base = "";
let calls: Call[] = [];
/** Per-test answers: `"METHOD path"` (decoded, no query) to `[status, payload]`. */
let answers = new Map<string, Answer>();
/** The open pull requests the stub knows (list and single read). */
let pulls: Record<string, unknown>[] = [];
/** Per-test answer sequences: `"METHOD path"` to a list of answers served in order (the last one repeats). */
let sequences = new Map<string, Answer[]>();

/** A distinct full sha per pull request number. */
const shaOf = (number: number) => `${number.toString(16).padStart(8, "0")}${"ab".repeat(16)}`;

const pull = (number: number, overrides: Record<string, unknown> = {}) => ({
  number,
  state: "open",
  draft: false,
  title: "Issue batch: #1, #2",
  user: { login: BOT },
  head: { ref: `claude/batch-${number}`, sha: shaOf(number), repo: { full_name: REPO } },
  base: { ref: "main", sha: BASE_SHA },
  mergeable_state: "clean",
  ...overrides,
});

const green = { total_count: 2, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }, { name: "label", status: "completed", conclusion: "skipped" }] };
const noStatuses = { state: "pending", total_count: 0, statuses: [] };

const stripped = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_") && !key.startsWith("AGENT_") && !key.startsWith("BATCH_") && !key.startsWith("ISSUE_FLOW") && !/proxy/i.test(key) && key !== "GH_TOKEN"));

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

/** The stub's default world: `pulls` are open; every head is green with no statuses; a merge succeeds. */
function defaults(method: string, path: string, search: URLSearchParams): Answer {
  const r = `/repos/${REPO}`;
  if (method === "GET" && path === `${r}/pulls`) {
    const page = Number(search.get("page") ?? "1");
    return [200, pulls.slice((page - 1) * 100, page * 100)];
  }
  if (method === "GET" && /\/pulls\/\d+\/files$/.test(path)) return [200, []];
  const one = /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/.exec(path);
  if (method === "GET" && one) {
    const found = pulls.find((entry) => entry.number === Number(one[1]));
    return found ? [200, found] : [404, { message: "Not Found" }];
  }
  if (method === "GET" && /\/commits\/[0-9a-f]{40}\/check-runs$/.test(path)) return [200, green];
  if (method === "GET" && /\/commits\/[0-9a-f]{40}\/status$/.test(path)) return [200, noStatuses];
  const merge = /\/pulls\/(\d+)\/merge$/.exec(path);
  if (method === "PUT" && merge) return [200, { merged: true, sha: "fedcba9876543210fedcba9876543210fedcba98" }];
  return [404, { message: "Not Found" }];
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = decodeURIComponent(url.pathname);
    const method = req.method ?? "GET";
    calls.push({ method, path, search: url.search, body: await readBody(req), auth: req.headers.authorization });
    const queued = sequences.get(`${method} ${path}`);
    const ref = url.searchParams.get("ref");
    const [status, payload] = (queued ? (queued.length > 1 ? queued.shift() : queued[0]) : undefined) ?? (ref ? answers.get(`${method} ${path}@${ref}`) : undefined) ?? answers.get(`${method} ${path}`) ?? defaults(method, path, url.searchParams);
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(payload));
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  await new Promise((done) => server.close(done));
});

beforeEach(() => {
  calls = [];
  answers = new Map();
  sequences = new Map();
  pulls = [];
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

interface Run {
  code: number;
  stdout: string;
  stderr: string;
  summary: string;
}

function run(env: Record<string, string | undefined> = {}): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "batch-merge-"));
  dirs.push(dir);
  const summaryFile = join(dir, "summary.md");
  const merged: Record<string, string | undefined> = {
    ...stripped(),
    GH_TOKEN: TOKEN,
    AGENT_LOGIN: BOT,
    GITHUB_REPOSITORY: REPO,
    GITHUB_API_URL: base,
    GITHUB_STEP_SUMMARY: summaryFile,
    BATCH_MERGE_WAIT_MS: "30",
    BATCH_MERGE_POLL_MS: "10",
    ...env,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT], { env: merged as NodeJS.ProcessEnv, timeout: 20_000 }, (error, stdout, stderr) => {
      let summary = "";
      try {
        summary = readFileSync(summaryFile, "utf8");
      } catch {
        // no summary written
      }
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, summary });
    });
  });
}

const seen = () => calls.map((call) => `${call.method} ${call.path.replace(`/repos/${REPO}`, "")}`);
const merges = () => calls.filter((call) => call.method === "PUT");
const writes = () => calls.filter((call) => call.method !== "GET");
const leaked = (result: Run, extra: string[] = []) => [TOKEN, TITLE_MARK, ...extra].filter((secret) => `${result.stdout}\n${result.stderr}\n${result.summary}`.includes(secret));
const checkPath = (number: number) => `GET /repos/${REPO}/commits/${shaOf(number)}/check-runs`;
const statusPath = (number: number) => `GET /repos/${REPO}/commits/${shaOf(number)}/status`;

describe("batch-merge", () => {
  it("QUALIFYING: reads the list, the pull request, the checks and the status, then merges with the head sha as the app", async () => {
    pulls = [pull(20, { title: `Issue batch: #1, #2 ${TITLE_MARK}` })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(seen()).toEqual(["GET /pulls", "GET /pulls/20", `GET /commits/${shaOf(20)}/check-runs`, `GET /commits/${shaOf(20)}/status`, "GET /pulls/20/files", "PUT /pulls/20/merge"]);
    expect(calls[0]?.search).toContain("state=open");
    expect(calls[0]?.search).toContain("per_page=100");
    expect(calls[0]?.search).toContain("page=1");
    expect(merges()).toHaveLength(1);
    expect(merges()[0]?.body).toEqual({ merge_method: "merge", sha: shaOf(20) });
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(writes()).toHaveLength(1); // it only merges: no comment, label, close, or edit
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(result.summary).toContain("| #20 | merged | at fedcba9 |");
    expect(leaked(result)).toEqual([]);
  });

  it("DRAFT: a draft is skipped and nothing is merged", async () => {
    pulls = [pull(20, { draft: true })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("batch-merge: #20 skipped: draft\n");
    expect(merges()).toEqual([]);
    expect(seen()).not.toContain(`GET /commits/${shaOf(20)}/check-runs`);
  });

  it("NOT_THE_APP: a batch by another author (here the owner) is never looked at", async () => {
    pulls = [pull(20, { user: { login: "xtimor" } })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(seen()).toEqual(["GET /pulls"]);
    expect(result.summary).toContain("No open agent batch pull request");
    // A hint that names it says why it is skipped.
    const hinted = await run({ BATCH_PR: "20" });
    expect(hinted.code).toBe(0);
    expect(hinted.stdout).toBe("batch-merge: #20 skipped: not an open agent batch pull request\n");
    expect(merges()).toEqual([]);
  });

  it("OTHER_TITLE: a pull request with another title is never looked at", async () => {
    pulls = [pull(20, { title: "Fix a thing" }), pull(21, { title: "issue batch: #1" })];
    const result = await run();
    expect(result.code).toBe(0);
    expect(seen()).toEqual(["GET /pulls"]);
    expect(merges()).toEqual([]);
  });

  it("OTHER_BRANCH_OR_FORK: a head that is not a claude/ branch, or not in this repository, or a base other than main, is skipped", async () => {
    pulls = [
      pull(20, { head: { ref: "feature/x", sha: shaOf(20), repo: { full_name: REPO } } }),
      pull(21, { head: { ref: "claude/x", sha: shaOf(21), repo: { full_name: "someone/openclaw-all-cli" } } }),
      pull(22, { head: { ref: "claude/x", sha: shaOf(22), repo: null } }),
      pull(23, { base: { ref: "release" } }),
    ];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    for (const number of [20, 21, 22, 23]) expect(result.stdout).toContain(`batch-merge: #${number} skipped: `);
    expect(merges()).toEqual([]);
    expect(seen().filter((entry) => entry.includes("check-runs"))).toEqual([]);
  });

  it.each([
    ["unknown", /mergeable state is "unknown"/],
    ["dirty", /mergeable state is "dirty"/],
    ["behind", /mergeable state is "behind"/],
  ])("NOT_CLEAN: mergeable state %s is skipped without a merge and without reading the checks", async (state, reason) => {
    pulls = [pull(20, { mergeable_state: state })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(reason);
    expect(result.stdout).toMatch(/^batch-merge: #20 skipped: /);
    expect(merges()).toEqual([]);
    expect(seen()).not.toContain(`GET /commits/${shaOf(20)}/check-runs`);
  });

  it.each([
    ["blocked", /mergeable state is "blocked"/],
    ["unstable", /mergeable state is "unstable"/],
  ])("NOT_CLEAN: mergeable state %s with green final checks is skipped at once (read once, no wait)", async (state, reason) => {
    pulls = [pull(20, { mergeable_state: state })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(reason);
    expect(result.stdout).not.toContain("not final");
    expect(merges()).toEqual([]);
    expect(seen().filter((entry) => entry === "GET /pulls/20")).toHaveLength(1);
  });

  it("UNKNOWN: a missing mergeable state counts as unknown", async () => {
    pulls = [pull(20, { mergeable_state: undefined })];
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('mergeable state is "unknown"');
    expect(merges()).toEqual([]);
  });

  it("UNKNOWN: an unknown state that turns clean on the next read is merged", async () => {
    pulls = [pull(20)];
    sequences.set(`GET /repos/${REPO}/pulls/20`, [[200, pull(20, { mergeable_state: "unknown" })], [200, pull(20)]]);
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(seen().filter((entry) => entry === "GET /pulls/20")).toHaveLength(2);
    expect(merges()).toHaveLength(1);
  });

  it("UNKNOWN: still unknown after three more reads is skipped (four reads in all), without checks or a merge", async () => {
    pulls = [pull(20, { mergeable_state: "unknown" })];
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(/^batch-merge: #20 skipped: .*"unknown"/);
    expect(seen().filter((entry) => entry === "GET /pulls/20")).toHaveLength(4);
    expect(seen()).not.toContain(`GET /commits/${shaOf(20)}/check-runs`);
    expect(merges()).toEqual([]);
  });

  it("UNKNOWN: a pull request that is not unknown is read once; a bad delay setting exits 2", async () => {
    pulls = [pull(20, { mergeable_state: "blocked" })];
    await run();
    expect(seen().filter((entry) => entry === "GET /pulls/20")).toHaveLength(1);
    calls = [];
    expect((await run({ BATCH_MERGE_POLL_MS: "soon" })).code).toBe(2);
    expect(calls).toEqual([]);
  });

  describe("FINAL STATE (ticket 3.21 d): a ready or CI trigger waits, within a bound, until the state and the checks are final", () => {
    const running = { total_count: 1, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "in_progress", conclusion: null }] };
    const reads = () => seen().filter((entry) => entry === "GET /pulls/20").length;

    it("READY_RACE: draft false but the state still says draft, then unknown, then clean with CI running, then green is merged in that one run", async () => {
      pulls = [pull(20)];
      sequences.set(`GET /repos/${REPO}/pulls/20`, [[200, pull(20, { mergeable_state: "draft" })], [200, pull(20, { mergeable_state: "unknown" })], [200, pull(20)]]);
      sequences.set(checkPath(20), [[200, running], [200, green]]);
      const result = await run({ BATCH_MERGE_WAIT_MS: "100" });
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toContain("batch-merge: #20 merged: at fedcba9");
      expect(merges()).toHaveLength(1);
      expect(reads()).toBeGreaterThanOrEqual(4);
    });

    it("STALE_DRAFT: draft false with the state draft that never settles is skipped after the bound, naming the re-reads", async () => {
      pulls = [pull(20, { mergeable_state: "draft" })];
      const result = await run();
      expect(result).toMatchObject({ code: 0, stderr: "" });
      expect(result.stdout).toMatch(/^batch-merge: #20 skipped: .*"draft".* \(not final after 3 re-reads\)/);
      expect(reads()).toBe(4);
      expect(merges()).toEqual([]);
    });

    it("A real draft (draft true) is skipped at once, not waited for", async () => {
      pulls = [pull(20, { draft: true, mergeable_state: "draft" })];
      const result = await run();
      expect(result.stdout).toMatch(/^batch-merge: #20 skipped: draft/);
      expect(reads()).toBe(1);
    });

    it("CHECK_NOT_STARTED: no check run yet, then the check running, then green, is merged", async () => {
      pulls = [pull(20)];
      sequences.set(checkPath(20), [[200, { total_count: 0, check_runs: [] }], [200, running], [200, green]]);
      const result = await run();
      expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    });

    it("STATUS_PENDING: a pending commit status that turns success is merged; one that stays pending is skipped after the bound", async () => {
      pulls = [pull(20)];
      const pending = { state: "pending", total_count: 1, statuses: [{ state: "pending" }] };
      const ok = { state: "success", total_count: 1, statuses: [{ state: "success" }] };
      sequences.set(statusPath(20), [[200, pending], [200, ok]]);
      expect((await run()).stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
      calls = [];
      sequences.set(statusPath(20), [[200, pending]]);
      const stuck = await run();
      expect(stuck.stdout).toMatch(/commit status is "pending".*not final after 3 re-reads/);
      expect(merges()).toEqual([]);
    });

    it("RED_AND_RUNNING: a run that already failed makes the answer final even while another run is still going: no wait", async () => {
      pulls = [pull(20)];
      answers.set(checkPath(20), [200, { total_count: 2, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }, { name: "lint", status: "in_progress", conclusion: null }] }]);
      const result = await run();
      expect(result.stdout).toMatch(/concluded "failure"/);
      expect(result.stdout).not.toContain("not final");
      expect(reads()).toBe(1);
    });

    it("BLOCKED_BY_PENDING: the state blocked while a check runs is waited for; clean and green then merges", async () => {
      pulls = [pull(20)];
      sequences.set(`GET /repos/${REPO}/pulls/20`, [[200, pull(20, { mergeable_state: "blocked" })], [200, pull(20)]]);
      sequences.set(checkPath(20), [[200, running], [200, green]]);
      expect((await run()).stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    });

    it("FINAL_RED: a failed check, a failed status, or another red run is skipped at once, with no re-read", async () => {
      pulls = [pull(20)];
      answers.set(checkPath(20), [200, { total_count: 1, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }] }]);
      const result = await run();
      expect(result.stdout).toMatch(/concluded "failure"/);
      expect(result.stdout).not.toContain("not final");
      expect(reads()).toBe(1);
    });

    it("BOUND: the wait is a budget of re-reads for the whole run, shared by every pull request; a bad setting exits 2 before any request", async () => {
      pulls = [pull(20, { mergeable_state: "unknown" }), pull(21, { mergeable_state: "unknown" })];
      const result = await run();
      expect(result.code).toBe(0);
      expect(reads()).toBe(4); // 1 read + 3 re-reads for #20
      expect(seen().filter((entry) => entry === "GET /pulls/21")).toHaveLength(1); // #21 gets the one read, the budget is spent
      expect(merges()).toEqual([]);
      calls = [];
      for (const env of [{ BATCH_MERGE_WAIT_MS: "soon" }, { BATCH_MERGE_POLL_MS: "-1" }]) expect((await run(env)).code).toBe(2);
      expect(calls).toEqual([]);
      calls = [];
      pulls = [pull(20, { mergeable_state: "unknown" })];
      await run({ BATCH_MERGE_WAIT_MS: "0", BATCH_MERGE_POLL_MS: "0" });
      expect(reads()).toBe(1);
    });

    it("GUARDS_FIRST: a pull request that fails a structural guard (here a fork head) makes no check calls even with a clean state", async () => {
      pulls = [pull(20, { head: { ref: "claude/x", sha: shaOf(20), repo: { full_name: "evil/openclaw-all-cli" } } })];
      await run({ BATCH_PR: "20" });
      expect(seen().filter((entry) => entry.includes("/commits/"))).toEqual([]);
    });
  });

  const checkCases: [string, unknown, unknown, RegExp][] = [
    ["the check run missing", { total_count: 1, check_runs: [{ name: "label", status: "completed", conclusion: "success" }] }, noStatuses, /"check" run is missing/],
    ["no check runs at all", { total_count: 0, check_runs: [] }, noStatuses, /"check" run is missing/],
    ["the check run pending", { total_count: 1, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "in_progress", conclusion: null }] }, noStatuses, /not completed/],
    ["the check run failed", { total_count: 1, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "failure" }] }, noStatuses, /concluded "failure"/],
    ["another run failed", { total_count: 2, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }, { name: "lint", status: "completed", conclusion: "cancelled" }] }, noStatuses, /"lint" concluded "cancelled"/],
    ["another run still running", { total_count: 2, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }, { name: "lint", status: "queued", conclusion: null }] }, noStatuses, /"lint" is not completed/],
    ["a pending commit status", green, { state: "pending", total_count: 1, statuses: [{ state: "pending" }] }, /commit status is "pending"/],
    ["a failed commit status", green, { state: "failure", total_count: 1, statuses: [{ state: "failure" }] }, /commit status is "failure"/],
    ["too many check runs for one page", { total_count: 150, check_runs: green.check_runs }, noStatuses, /too many check runs/],
  ];
  it.each(checkCases)("CHECKS: %s is skipped without a merge", async (_name, runs, status, reason) => {
    pulls = [pull(20)];
    answers.set(checkPath(20), [200, runs]);
    answers.set(statusPath(20), [200, status]);
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(reason);
    expect(result.stdout).toMatch(/^batch-merge: #20 skipped: /);
    expect(merges()).toEqual([]);
  });

  it("CHECKS: skipped and neutral runs next to a successful check are green; a statuses answer of success is green", async () => {
    pulls = [pull(20)];
    answers.set(checkPath(20), [200, { total_count: 3, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }, { name: "a", status: "completed", conclusion: "neutral" }, { name: "b", status: "completed", conclusion: "skipped" }] }]);
    answers.set(statusPath(20), [200, { state: "success", total_count: 1, statuses: [{ state: "success" }] }]);
    const result = await run();
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(merges()).toHaveLength(1);
  });

  it("HEAD: the merge, the checks and the guards use the head sha of the pull request as read, in lowercase", async () => {
    const upper = shaOf(20).toUpperCase();
    pulls = [pull(20, { head: { ref: "claude/batch-20", sha: upper, repo: { full_name: REPO } } })];
    const result = await run();
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(seen()).toContain(`GET /commits/${shaOf(20)}/check-runs`);
    expect(merges()[0]?.body).toEqual({ merge_method: "merge", sha: shaOf(20) });
  });

  it("HEAD: a pull request read without a usable head sha is skipped", async () => {
    pulls = [pull(20, { head: { ref: "claude/batch-20", sha: "short", repo: { full_name: REPO } } })];
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("batch-merge: #20 skipped: ");
    expect(merges()).toEqual([]);
  });

  it("FRESH: the guards run on the single read, not the list entry (the list says clean, the read says blocked)", async () => {
    pulls = [pull(20)];
    answers.set(`GET /repos/${REPO}/pulls/20`, [200, pull(20, { mergeable_state: "blocked" })]);
    const result = await run();
    expect(result.stdout).toContain('mergeable state is "blocked"');
    expect(merges()).toEqual([]);
  });

  it.each([405, 409])("REFUSED_BY_GITHUB: a merge answered %i is reported and exits 1", async (status) => {
    pulls = [pull(20)];
    answers.set(`PUT /repos/${REPO}/pulls/20/merge`, [status, { message: `Head branch was modified ${TOKEN}` }]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain(`batch-merge: #20 failed: PUT /pulls/20/merge: GitHub answered ${status}`);
    expect(result.summary).toContain("failed");
    expect(leaked(result)).toEqual([]);
  });

  it("REFUSED_BY_GITHUB: a 200 that did not merge is a failure too", async () => {
    pulls = [pull(20)];
    answers.set(`PUT /repos/${REPO}/pulls/20/merge`, [200, { merged: false, message: "no" }]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("batch-merge: #20 failed: ");
  });

  it("SEVERAL: merges only the qualifying pull request and reports each", async () => {
    pulls = [pull(20, { draft: true }), pull(21), pull(22, { user: { login: "xtimor" } }), pull(23, { mergeable_state: "dirty" })];
    const result = await run();
    expect(result.code).toBe(0);
    expect(merges().map((call) => call.path)).toEqual([`/repos/${REPO}/pulls/21/merge`]);
    expect(result.stdout.split("\n").filter(Boolean)).toEqual(["batch-merge: #20 skipped: draft", "batch-merge: #21 merged: at fedcba9", expect.stringMatching(/^batch-merge: #23 skipped: .*"dirty"/)]);
  });

  it("SEVERAL: a failed merge of one does not stop the next, and the run exits 1", async () => {
    pulls = [pull(20), pull(21)];
    answers.set(`PUT /repos/${REPO}/pulls/20/merge`, [405, { message: "Not allowed" }]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(result.stdout).toContain("#20 failed");
    expect(result.stdout).toContain("#21 merged");
    expect(merges()).toHaveLength(2);
  });

  it("SEVERAL: a read that fails skips that pull request (the next trigger retries) and goes on", async () => {
    pulls = [pull(20), pull(21)];
    answers.set(`GET /repos/${REPO}/pulls/20`, [500, { message: "boom" }]);
    const result = await run();
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("#20 skipped: GET /pulls/20: GitHub answered 500");
    expect(result.stdout).toContain("#21 merged");
    expect(merges().map((call) => call.path)).toEqual([`/repos/${REPO}/pulls/21/merge`]);
  });

  it("HINT: BATCH_PR from the event is checked first", async () => {
    pulls = [pull(20), pull(21)];
    const result = await run({ BATCH_PR: "21" });
    expect(result.code).toBe(0);
    expect(merges().map((call) => call.path)).toEqual([`/repos/${REPO}/pulls/21/merge`, `/repos/${REPO}/pulls/20/merge`]);
    expect(result.stdout.split("\n")[0]).toBe("batch-merge: #21 merged: at fedcba9");
  });

  it("HINT: an empty BATCH_PR (schedule, dispatch) is ignored; a hint that is not a number exits 2", async () => {
    pulls = [pull(20)];
    expect((await run({ BATCH_PR: "" })).stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    calls = [];
    const bad = await run({ BATCH_PR: "20; rm -rf /" });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("BATCH_PR");
    expect(calls).toEqual([]);
  });

  it("NOTHING_OPEN: no batch pull request is a plain exit 0", async () => {
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe("batch-merge: no open agent batch pull request\n");
    expect(seen()).toEqual(["GET /pulls"]);
  });

  it("LIST_FAILS: an unreadable list exits 1 and merges nothing", async () => {
    answers.set(`GET /repos/${REPO}/pulls`, [500, { message: "boom" }]);
    const down = await run();
    expect(down.code).toBe(1);
    expect(down.stderr).toContain("batch-merge: GET /pulls");
    expect(down.summary).toContain("Not run");
    answers.set(`GET /repos/${REPO}/pulls`, [200, { not: "a list" }]);
    const odd = await run();
    expect(odd.code).toBe(1);
    expect(merges()).toEqual([]);
  });

  it("MISSING_VARIABLES: no GH_TOKEN, AGENT_LOGIN, or repository exits 2 before any request", async () => {
    pulls = [pull(20)];
    for (const name of ["GH_TOKEN", "AGENT_LOGIN", "GITHUB_REPOSITORY"]) {
      const result = await run({ [name]: undefined });
      expect(result.code).toBe(2);
      expect(result.stderr).toContain(name);
      expect(result.summary).toContain("Not run");
    }
    const odd = await run({ AGENT_LOGIN: "xtimor" });
    expect(odd.code).toBe(2);
    expect(odd.stderr).toContain("AGENT_LOGIN");
    expect((await run({ GITHUB_REPOSITORY: "not a repo" })).code).toBe(2);
    expect(calls).toEqual([]);
  });

  it("REDIRECT: a redirect is never followed (the token goes nowhere else) and nothing is merged", async () => {
    answers.set(`GET /repos/${REPO}/pulls`, [302, {}]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(merges()).toEqual([]);
    expect(leaked(result)).toEqual([]);
  });

  it("LOG_LINES: text with newlines in a check run name cannot fake a log line or a workflow command", async () => {
    pulls = [pull(20)];
    answers.set(checkPath(20), [200, { total_count: 2, check_runs: [{ name: "check", app: { slug: "github-actions" }, status: "completed", conclusion: "success" }, { name: "x\n::add-mask::oops\nbatch-merge: #99 merged: fake", status: "completed", conclusion: "failure" }] }]);
    const result = await run();
    expect(result.code).toBe(0);
    for (const line of result.stdout.split("\n").filter(Boolean)) expect(line.startsWith("batch-merge: ")).toBe(true);
    expect(result.stdout.split("\n").filter(Boolean)).toHaveLength(1);
    expect(merges()).toEqual([]);
  });
});

describe("batch-merge guards beyond the relay's", () => {
  const file = (filename: string, extra: Record<string, unknown> = {}) => ({ filename, status: "modified", ...extra });
  const filesPath = `GET /repos/${REPO}/pulls/20/files`;
  const pkg = (fields: Record<string, unknown>) => [200, { content: Buffer.from(JSON.stringify({ name: "p", scripts: { build: "tsc" }, files: ["dist", "docs"], ...fields })).toString("base64"), encoding: "base64" }] as Answer;
  const pkgPath = `GET /repos/${REPO}/contents/package.json`;
  const setPackages = (before: Answer, after: Answer) => {
    answers.set(`${pkgPath}@${BASE_SHA}`, before);
    answers.set(`${pkgPath}@${shaOf(20)}`, after);
  };

  it.each([".github/workflows/ci.yml", "scripts/batch-merge.mjs", "_bmad/custom/x.toml", ".claude/settings.json", ".agents/skills/x.md", "docs/agents/implement.md", "AGENTS.md", "SECURITY.md", "Scripts/x.mjs"])("PROTECTED: a batch that changes %s is skipped and stays open", async (path) => {
    pulls = [pull(20)];
    answers.set(filesPath, [200, [file("src/a.ts"), file(path)]]);
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toBe(`batch-merge: #20 skipped: touches protected files: ${path}\n`);
    expect(merges()).toEqual([]);
  });

  it("PROTECTED: a file renamed or deleted out of a protected path counts; look-alike paths and the docs outside docs/agents do not", async () => {
    pulls = [pull(20)];
    answers.set(filesPath, [200, [file("src/new.mjs", { status: "renamed", previous_filename: "scripts/old.mjs" })]]);
    expect((await run()).stdout).toContain("touches protected files: scripts/old.mjs");
    expect(merges()).toEqual([]);
    answers.set(filesPath, [200, [file("docs/setup.md"), file("scriptsx/a.mjs"), file(".githubx/a"), file("src/scripts/a.ts"), file("test/agents.md"), file("docs/agents-notes.md"), file("package-lock.json")]]);
    const fine = await run();
    expect(fine.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(merges()).toHaveLength(1);
  });

  it("PROTECTED: the file list is paged; a protected file on page 2 is found, and an unreadable or endless list is skipped", async () => {
    pulls = [pull(20)];
    const hundred = Array.from({ length: 100 }, (_, i) => file(`src/f${i}.ts`));
    answers.set(filesPath, [200, hundred]);
    sequences.set(filesPath, [[200, hundred], [200, [file(".github/workflows/x.yml")]]]);
    const paged = await run();
    expect(paged.stdout).toContain("touches protected files: .github/workflows/x.yml");
    expect(calls.filter((call) => call.path.endsWith("/pulls/20/files")).map((call) => call.search)).toEqual(["?per_page=100&page=1", "?per_page=100&page=2"]);
    expect(merges()).toEqual([]);

    sequences.delete(filesPath);
    answers.set(filesPath, [200, { not: "a list" }]);
    expect((await run()).stdout).toContain("the changed files could not be read");
    answers.set(filesPath, [200, hundred]); // every page full: more than GitHub lists
    expect((await run()).stdout).toContain("too many changed files to verify");
    expect(merges()).toEqual([]);
  });

  it.each([
    ["scripts", { scripts: { build: "tsc", postinstall: "evil" } }],
    ["publishConfig", { publishConfig: { access: "public" } }],
    ["name", { name: "other" }],
    ["bin", { bin: { x: "scripts/x.mjs" } }],
    ["files (an entry lost)", { files: ["dist"] }],
    ["files (an entry changed)", { files: ["dist", "docs/", "other"].slice(0, 1).concat(["doc"]) }],
    ["files (removed)", { files: undefined }],
  ])("PACKAGE: a changed %s in package.json is skipped", async (_name, change) => {
    pulls = [pull(20)];
    answers.set(filesPath, [200, [file("package.json")]]);
    setPackages(pkg({}), pkg(change));
    const result = await run();
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(result.stdout).toMatch(/^batch-merge: #20 skipped: touches protected files: package\.json \(/);
    expect(merges()).toEqual([]);
    expect(calls.filter((call) => call.path.endsWith("/contents/package.json")).map((call) => call.search)).toEqual([`?ref=${BASE_SHA}`, `?ref=${shaOf(20)}`]);
  });

  it("PACKAGE: other fields, a reordered or longer files list, and a reordered scripts object are fine", async () => {
    pulls = [pull(20)];
    answers.set(filesPath, [200, [file("package.json")]]);
    setPackages(pkg({}), [200, { content: Buffer.from(JSON.stringify({ files: ["docs", "dist", "assets/icon.png"], version: "9.9.9", dependencies: { a: "1" }, scripts: { build: "tsc" }, name: "p" })).toString("base64") }]);
    const result = await run();
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(merges()).toHaveLength(1);
  });

  it("PACKAGE: package.json is read only when the batch changes it; an unreadable one or a missing base sha is skipped", async () => {
    pulls = [pull(20)];
    answers.set(filesPath, [200, [file("src/a.ts")]]);
    expect((await run()).stdout).toContain("merged");
    expect(calls.some((call) => call.path.endsWith("/contents/package.json"))).toBe(false);

    answers.set(filesPath, [200, [file("package.json")]]);
    setPackages(pkg({}), [200, { content: Buffer.from("{ not json").toString("base64") }]);
    expect((await run()).stdout).toMatch(/skipped: package\.json could not be read at /);
    setPackages(pkg({}), [404, { message: "Not Found" }]);
    expect((await run()).stdout).toMatch(/skipped: GET \/contents\/package\.json\?ref=\w+: GitHub answered 404/);
    pulls = [pull(20, { base: { ref: "main" } })];
    setPackages(pkg({}), pkg({}));
    expect((await run()).stdout).toContain("its base sha could not be read");
    expect(merges()).toHaveLength(1); // only the first run, which changed no package.json
  });

  it("CHECK_APP: a check run named check from another app (or with no app) does not count", async () => {
    pulls = [pull(20)];
    for (const app of [{ slug: "evil-app" }, undefined]) {
      answers.set(checkPath(20), [200, { total_count: 1, check_runs: [{ name: "check", app, status: "completed", conclusion: "success" }] }]);
      const result = await run();
      expect(result.stdout).toContain("the \"check\" run is missing or not from GitHub Actions");
    }
    expect(merges()).toEqual([]);
  });

  it("LIST: every page of open pull requests is read, so a batch after 100 others is merged", async () => {
    pulls = [...Array.from({ length: 100 }, (_, i) => pull(1000 + i, { title: "Fix a thing", user: { login: "xtimor" } })), pull(20)];
    const result = await run();
    expect(result.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(calls.filter((call) => call.path === `/repos/${REPO}/pulls`).map((call) => call.search)).toEqual(["?state=open&per_page=100&page=1", "?state=open&per_page=100&page=2"]);
  });

  it("HINT: the pull request of the event is read directly, also when the list does not hold it, and filtered the same way", async () => {
    pulls = [pull(20)];
    answers.set(`GET /repos/${REPO}/pulls`, [200, []]);
    const outside = await run({ BATCH_PR: "20" });
    expect(outside.stdout).toBe("batch-merge: #20 merged: at fedcba9\n");
    expect(seen().slice(0, 2)).toEqual(["GET /pulls", "GET /pulls/20"]);

    pulls = [pull(21, { state: "closed" }), pull(22, { title: "Other" }), pull(23, { user: { login: "xtimor" } })];
    for (const number of [21, 22, 23]) {
      calls = [];
      const result = await run({ BATCH_PR: String(number) });
      expect(result.stdout).toBe(`batch-merge: #${number} skipped: not an open agent batch pull request\n`);
    }
    calls = [];
    const missing = await run({ BATCH_PR: "99" });
    expect(missing).toMatchObject({ code: 0 });
    expect(missing.stdout).toContain("#99 skipped: GET /pulls/99: GitHub answered 404");
    expect(merges()).toEqual([]);
  });

  it("MERGE_OUTCOME_UNKNOWN: an error that is not ours at the merge call is reported as failed, exit 1", async () => {
    pulls = [pull(20)];
    const { run: runIn } = (await import(pathToFileURL(SCRIPT).href)) as { run: (env: Record<string, string>, log: (line: string) => void) => Promise<{ code: number; rows: { pr: number; result: string; reason: string }[] }> };
    const real = globalThis.fetch;
    // A response whose status cannot be read: thrown inside the client, outside its own error handling.
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (init?.method === "PUT") return { get status(): number { throw new TypeError("boom"); } } as unknown as Response;
      return real(url, init);
    }) as typeof fetch;
    try {
      const lines: string[] = [];
      const result = await runIn({ GH_TOKEN: TOKEN, AGENT_LOGIN: BOT, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: base }, (line) => lines.push(line));
      expect(result.code).toBe(1);
      expect(result.rows).toEqual([{ pr: 20, result: "failed", reason: "merge outcome unknown" }]);
      expect(lines).toEqual(["#20 failed: merge outcome unknown"]);
    } finally {
      globalThis.fetch = real;
    }
  });

  it("READ_ERRORS: an error that is not ours while reading is skipped with exit 0, not called a failed merge", async () => {
    pulls = [pull(20)];
    const { run: runIn } = (await import(pathToFileURL(SCRIPT).href)) as { run: (env: Record<string, string>, log: (line: string) => void) => Promise<{ code: number; rows: { result: string }[] }> };
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/status")) return { get status(): number { throw new TypeError("boom"); } } as unknown as Response;
      return real(url, init);
    }) as typeof fetch;
    try {
      const result = await runIn({ GH_TOKEN: TOKEN, AGENT_LOGIN: BOT, GITHUB_REPOSITORY: REPO, GITHUB_API_URL: base }, () => {});
      expect(result.code).toBe(0);
      expect(result.rows[0]?.result).toBe("skipped");
    } finally {
      globalThis.fetch = real;
    }
    expect(merges()).toEqual([]);
  });
});

describe("batch-merge workflow file", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "batch-merge.yml"), "utf8");

  it("pins every action by SHA like agent-write.yml and asks for nothing beyond contents: read", () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.map((m) => m[1])).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"]);
    for (const [, , rest] of uses) expect(rest).toMatch(/# v\d/);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text.match(/^\s+permissions:\n\s+contents: read$/gm)).toHaveLength(1);
    expect(text).not.toMatch(/: (write|admin)\b/);
    expect(text).toMatch(/NODE_VERSION: 24\.22\.0/);
  });

  it("has the four triggers: CI completed, a pull request ready for review, dispatch, and an hourly schedule", () => {
    const on = text.match(/^on:\n((?: {2}.*\n|\n)+)/m)?.[1] ?? "";
    expect(on).toMatch(/^ {2}workflow_run:\n {4}workflows: \[CI\]\n {4}types: \[completed\]$/m);
    expect(on).toMatch(/^ {2}pull_request_target:\n {4}types: \[ready_for_review\]$/m);
    expect(on).toMatch(/^ {2}workflow_dispatch:$/m);
    expect(on).toMatch(/^ {2}schedule:\n {4}- cron: '\d+ \* \* \* \*'$/m);
    expect(on.match(/^ {2}\w+:/gm)).toHaveLength(4);
    // The merge waits on the workflow the CI file defines.
    expect(readFileSync(join(ROOT, ".github", "workflows", "ci.yml"), "utf8")).toMatch(/^name: CI$/m);
  });

  it("runs only on main, in the agent environment, one run at a time without cancelling", () => {
    expect(text).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main' && \(github\.event_name != 'pull_request_target' \|\| github\.event\.pull_request\.head\.repo\.full_name == github\.repository\)$/m);
    expect(text).toMatch(/^ {4}environment: agent$/m);
    expect(text).toMatch(/^concurrency:\n {2}group: batch-merge\n {2}cancel-in-progress: false$/m);
  });

  it("checks out main only, without credentials, and never the pull request", () => {
    const checkout = text.match(/uses: actions\/checkout@.*\n {8}with:\n((?: {10}.*\n)+)/)?.[1] ?? "";
    expect(checkout).toMatch(/^ {10}ref: refs\/heads\/main$/m);
    expect(checkout).toMatch(/^ {10}persist-credentials: false$/m);
    // The head is read only in the job's `if` (to refuse a fork), never in a step.
    const steps = text.slice(text.indexOf("    steps:"));
    expect(steps).not.toMatch(/github\.event\.pull_request\.head/);
    expect(text).not.toMatch(/github\.head_ref|github\.event\.workflow_run\.head|refs\/pull|pull_request\.merge_commit/);
    expect(text).not.toMatch(/\b(npm|npx|pnpm|yarn)\b\s+(ci|install|run|test|i)\b/);
  });

  it("passes event data and secrets through env only, masks the token, and mints and merges in one step", () => {
    const runBlocks = [...text.matchAll(/ {8}run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1] ?? "");
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) expect(block).not.toContain("${{");
    const step = runBlocks.find((block) => block.includes("batch-merge.mjs")) ?? "";
    expect(step).toContain("scripts/agent-token.mjs");
    expect(step).toContain("scripts/agent-token.mjs --login");
    expect(step).toContain('echo "::add-mask::$TOKEN"');
    expect(step.indexOf("::add-mask::")).toBeLessThan(step.indexOf("batch-merge.mjs"));
    expect(step).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|set -x|echo "\$TOKEN"/);
    expect(text).toContain("AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}");
    expect(text).toContain("AGENT_APP_ID: ${{ vars.AGENT_APP_ID }}");
    expect(text).toContain("BATCH_PR: ${{ github.event.pull_request.number || github.event.workflow_run.pull_requests[0].number }}");
    // Every other `${{ }}` outside env/with is a plain expression of the repository or the job.
    const outside = text.split("\n").filter((line) => line.includes("${{") && !/^ {10}\w[\w_]*: \$\{\{/.test(line) && !/^ {2,}\w[\w-]*: \$\{\{/.test(line));
    expect(outside).toEqual([]);
  });

  it("runs the merge script without the private key and revokes the token when the step ends", () => {
    expect(text).toMatch(/env -u AGENT_APP_PRIVATE_KEY -u AGENT_APP_PRIVATE_KEY_B64 GH_TOKEN="\$TOKEN" .*node scripts\/batch-merge\.mjs$/m);
    const trap = text.match(/^\s+trap '(.*)' EXIT$/m)?.[1] ?? "";
    expect(trap).toContain("-X DELETE");
    expect(trap).toContain("/installation/token");
    expect(text.indexOf("trap '")).toBeGreaterThan(text.indexOf("::add-mask::"));
    expect(text.indexOf("trap '")).toBeLessThan(text.indexOf("env -u"));
  });

  it("the script it runs only merges: no other write call exists in it", () => {
    const script = readFileSync(SCRIPT, "utf8");
    const methods = [...script.matchAll(/client\.rest\("(\w+)"/g)].map((m) => m[1]);
    expect(methods.filter((method) => method !== "GET")).toEqual(["PUT"]);
    expect(script).not.toMatch(/graphql\(|\/comments|\/labels/);
  });
});

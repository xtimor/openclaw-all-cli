import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/agent-write.mjs against a local stub of the GitHub REST and GraphQL endpoints (ticket 3.15). Every row of the
 * ticket's I/O matrix: the order of the calls, each guard (nothing sent when it says no), and no token or body on any
 * stream or in the summary. The script runs in a child process, never spawnSync, since the stub serves from this process.
 * Nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "agent-write.mjs");
const REPO = "xtimor/openclaw-all-cli";
const BOT = "oac-issue-agents[bot]";
const TOKEN = "ghs_STUB_INSTALLATION_TOKEN_0123456789";
const SHA = "0123456789abcdef0123456789abcdef01234567";
const BODY_MARK = "BODY_MARKER_must_not_be_echoed_7731";

interface Call {
  method: string;
  path: string;
  body: Record<string, unknown> | null;
  auth: string | undefined;
}

type Answer = [number, unknown];

let server: Server;
let base = "";
let calls: Call[] = [];
/** Per-test answers: `"METHOD path"` (decoded) to `[status, payload]`. */
let answers = new Map<string, Answer>();

const pull = (overrides: Record<string, unknown> = {}) => ({
  number: 20,
  node_id: "PR_node_20",
  state: "open",
  draft: false,
  title: "Issue batch: #1, #2",
  user: { login: BOT },
  head: { ref: "claude/batch-1", sha: SHA, repo: { full_name: REPO } },
  base: { ref: "main" },
  mergeable_state: "clean",
  ...overrides,
});

const stripped = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_") && !key.startsWith("AGENT_") && !key.startsWith("ISSUE_FLOW") && !/proxy/i.test(key) && key !== "GH_TOKEN"));

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

/** The stub's default world: the app owns comment 55 and pull requests 20 (open, ready) and 21 (draft). */
function defaults(method: string, path: string): Answer {
  const key = `${method} ${path}`;
  const r = `/repos/${REPO}`;
  if (key === `POST ${r}/issues/12/comments`) return [201, { id: 9001 }];
  if (key === `POST ${r}/issues/12/labels`) return [200, []];
  if (method === "DELETE" && path.startsWith(`${r}/issues/12/labels/`)) return [200, []];
  if (key === `GET ${r}/issues/comments/55`) return [200, { id: 55, user: { login: BOT } }];
  if (key === `PATCH ${r}/issues/comments/55`) return [200, { id: 55 }];
  if (key === `GET ${r}/issues/12`) return [200, { number: 12 }];
  if (key === `GET ${r}/issues/20`) return [200, { number: 20, pull_request: { url: "x" } }];
  if (key === `PATCH ${r}/issues/12`) return [200, { number: 12 }];
  if (key === `POST ${r}/pulls`) return [201, { number: 31 }];
  if (key === `GET ${r}/pulls/20`) return [200, pull()];
  if (key === `GET ${r}/pulls/21`) return [200, pull({ number: 21, node_id: "PR_node_21", draft: true })];
  if (key === `PATCH ${r}/pulls/20` || key === `PATCH ${r}/pulls/21`) return [200, {}];
  if (key === `GET ${r}/commits/${SHA}/check-runs`) return [200, { total_count: 2, check_runs: [{ name: "check", status: "completed", conclusion: "success" }, { name: "label", status: "completed", conclusion: "skipped" }] }];
  if (key === `GET ${r}/commits/${SHA}/status`) return [200, { state: "pending", total_count: 0, statuses: [] }]; // no statuses at all
  if (key === `PUT ${r}/pulls/20/merge`) return [200, { merged: true, sha: "fedcba9876543210fedcba9876543210fedcba98" }];
  if (key === "POST /graphql") return [200, { data: { markPullRequestReadyForReview: { pullRequest: { number: 21, isDraft: false } } } }];
  return [404, { message: "Not Found" }];
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = decodeURIComponent(url.pathname);
    const method = req.method ?? "GET";
    calls.push({ method, path, body: await readBody(req), auth: req.headers.authorization });
    const [status, payload] = answers.get(`${method} ${path}`) ?? defaults(method, path);
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

function run(ops: unknown, env: Record<string, string | undefined> = {}, raw?: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "agent-write-"));
  dirs.push(dir);
  const summaryFile = join(dir, "summary.md");
  const merged: Record<string, string | undefined> = {
    ...stripped(),
    AGENT_WRITE_OPS: raw ?? JSON.stringify(ops),
    GH_TOKEN: TOKEN,
    AGENT_LOGIN: BOT,
    GITHUB_REPOSITORY: REPO,
    GITHUB_ACTOR: "xtimor",
    GITHUB_TRIGGERING_ACTOR: "xtimor",
    GITHUB_RUN_ATTEMPT: "1",
    ISSUE_FLOW_OWNERS: "xtimor",
    GITHUB_API_URL: base,
    GITHUB_STEP_SUMMARY: summaryFile,
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
const leaked = (result: Run, extra: string[] = []) => [TOKEN, BODY_MARK, ...extra].filter((secret) => `${result.stdout}\n${result.stderr}\n${result.summary}`.includes(secret));

describe("agent-write", () => {
  it("COMMENT_THEN_LABEL: posts the comment, then the labels, then deletes the removed one, in that order, as the app", async () => {
    const result = await run([
      { op: "comment", issue: 12, body: `hello ${BODY_MARK}` },
      { op: "labels", issue: 12, add: ["status:triaged", "priority:p2"], remove: ["status:new"] },
    ]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(seen()).toEqual(["POST /issues/12/comments", "POST /issues/12/labels", "DELETE /issues/12/labels/status:new"]);
    expect(calls[0]?.body).toEqual({ body: `hello ${BODY_MARK}` });
    expect(calls[1]?.body).toEqual({ labels: ["status:triaged", "priority:p2"] });
    expect(calls.every((call) => call.auth === `Bearer ${TOKEN}`)).toBe(true);
    expect(result.summary).toContain(BOT);
    expect(result.stdout).toContain(`agent-write: acting as ${BOT}\n`);
    expect(result.summary).toContain("Applied 2 operation(s)");
    expect(result.summary).toContain("comment 9001 created");
    expect(result.summary).toContain("added status:triaged, priority:p2; removed status:new");
    expect(leaked(result)).toEqual([]);
  });

  it("LABELS: removing a label the issue lacks is fine; any other 404 stops the run", async () => {
    answers.set(`DELETE /repos/${REPO}/issues/12/labels/status:new`, [404, { message: "Label does not exist" }]);
    const fine = await run([{ op: "labels", issue: 12, remove: ["status:new"] }]);
    expect(fine.code).toBe(0);
    expect(fine.summary).toContain("status:new (was not set)");
    answers.set(`DELETE /repos/${REPO}/issues/12/labels/status:new`, [404, { message: "Not Found" }]);
    const bad = await run([{ op: "labels", issue: 12, remove: ["status:new"] }]);
    expect(bad).toMatchObject({ code: 1 });
    expect(bad.summary).toContain("failed");
  });

  it("EDIT_COMMENT: edits a comment of the app; refuses another author's comment", async () => {
    const own = await run([{ op: "edit_comment", comment_id: 55, body: `new ${BODY_MARK}` }]);
    expect(own.code).toBe(0);
    expect(seen()).toEqual(["GET /issues/comments/55", "PATCH /issues/comments/55"]);
    expect(calls[1]?.body).toEqual({ body: `new ${BODY_MARK}` });
    expect(leaked(own)).toEqual([]);

    calls = [];
    answers.set(`GET /repos/${REPO}/issues/comments/55`, [200, { id: 55, user: { login: "xtimor" } }]);
    const foreign = await run([{ op: "edit_comment", comment_id: 55, body: "x" }]);
    expect(foreign.code).toBe(1);
    expect(seen()).toEqual(["GET /issues/comments/55"]);
    expect(foreign.summary).toContain("refused");
  });

  it("CLOSE: patches state closed with the reason; a bad reason or a pull request is refused", async () => {
    const closed = await run([{ op: "close", issue: 12, reason: "not_planned" }]);
    expect(closed.code).toBe(0);
    expect(seen()).toEqual(["GET /issues/12", "PATCH /issues/12"]);
    expect(calls[1]?.body).toEqual({ state: "closed", state_reason: "not_planned" });

    calls = [];
    for (const reason of ["wontfix", "", undefined, "Completed"]) {
      const bad = await run([{ op: "close", issue: 12, reason }]);
      expect(bad.code).toBe(1);
    }
    expect(calls).toEqual([]);

    const pr = await run([{ op: "close", issue: 20, reason: "completed" }]);
    expect(pr.code).toBe(1);
    expect(seen()).toEqual(["GET /issues/20"]);
    expect(pr.summary).toContain("pull request");
  });

  it("PR_CREATE: posts a draft against main and shows the number; a head outside claude/ is refused", async () => {
    const result = await run([{ op: "pr_create", head: "claude/x", title: "Issue batch (in progress)", body: `b ${BODY_MARK}`, draft: true }]);
    expect(result.code).toBe(0);
    expect(seen()).toEqual(["POST /pulls"]);
    expect(calls[0]?.body).toEqual({ title: "Issue batch (in progress)", head: "claude/x", base: "main", body: `b ${BODY_MARK}`, draft: true });
    expect(result.summary).toContain("PR #31 created (draft)");
    expect(leaked(result)).toEqual([]);

    calls = [];
    for (const head of ["feature/x", "xtimor:claude/x", "claude/../main", "main", "", "claude/a b", 5]) {
      expect((await run([{ op: "pr_create", head, title: "t" }])).code).toBe(1);
    }
    expect(calls).toEqual([]);
  });

  it("PR_READY: marks a draft of the app ready through GraphQL; refuses another author; does nothing when already ready", async () => {
    const ready = await run([{ op: "pr_ready", pr: 21 }]);
    expect(ready.code).toBe(0);
    expect(seen()).toEqual(["GET /pulls/21", "POST /graphql"]);
    expect(calls[1]?.body?.variables).toEqual({ id: "PR_node_21" });
    expect(String(calls[1]?.body?.query)).toContain("markPullRequestReadyForReview");
    expect(ready.summary).toContain("marked ready for review");

    calls = [];
    const already = await run([{ op: "pr_ready", pr: 20 }]);
    expect(already.code).toBe(0);
    expect(seen()).toEqual(["GET /pulls/20"]);

    calls = [];
    answers.set(`GET /repos/${REPO}/pulls/21`, [200, pull({ number: 21, draft: true, user: { login: "xtimor" } })]);
    const foreign = await run([{ op: "pr_ready", pr: 21 }]);
    expect(foreign.code).toBe(1);
    expect(seen()).toEqual(["GET /pulls/21"]);

    calls = [];
    answers.delete(`GET /repos/${REPO}/pulls/21`);
    answers.set("POST /graphql", [200, { errors: [{ message: `denied ${TOKEN}` }] }]);
    const failed = await run([{ op: "pr_ready", pr: 21 }]);
    expect(failed.code).toBe(1);
    expect(leaked(failed)).toEqual([]);
  });

  it("PR_EDIT: patches title and body of the app's pull request; refuses another author; needs a title or a body", async () => {
    const edited = await run([{ op: "pr_edit", pr: 20, title: "Issue batch: #3", body: `b ${BODY_MARK}` }]);
    expect(edited.code).toBe(0);
    expect(seen()).toEqual(["GET /pulls/20", "PATCH /pulls/20"]);
    expect(calls[1]?.body).toEqual({ title: "Issue batch: #3", body: `b ${BODY_MARK}` });
    expect(leaked(edited)).toEqual([]);

    calls = [];
    answers.set(`GET /repos/${REPO}/pulls/20`, [200, pull({ user: { login: "someone" } })]);
    expect((await run([{ op: "pr_edit", pr: 20, title: "x" }])).code).toBe(1);
    expect(seen()).toEqual(["GET /pulls/20"]);

    calls = [];
    expect((await run([{ op: "pr_edit", pr: 20 }])).code).toBe(1);
    expect(calls).toEqual([]);
  });

  const hoursAgo = (hours: number) => new Date(Date.now() - hours * 3_600_000).toISOString();

  it("PR_CLOSE: closes the app's own open draft batch PR with state closed", async () => {
    answers.set(`GET /repos/${REPO}/pulls/21`, [200, pull({ number: 21, draft: true, title: "Issue batch (in progress)", updated_at: hoursAgo(5) })]);
    const result = await run([{ op: "pr_close", pr: 21 }]);
    expect(result).toMatchObject({ code: 0, stderr: "" });
    expect(seen()).toEqual(["GET /pulls/21", "PATCH /pulls/21"]);
    expect(calls[1]?.body).toEqual({ state: "closed" });
    expect(calls[1]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(result.summary).toContain("PR #21");
    expect(result.summary).toContain("closed");
    expect(leaked(result)).toEqual([]);
  });

  it("PR_CLOSE: not a draft, closed, another author, another title, a head outside claude/, a fork, or a deleted fork is refused, nothing patched", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["ready", { draft: false }],
      ["closed", { state: "closed" }],
      ["merged", { state: "closed", merged: true }],
      ["author", { user: { login: "xtimor" } }],
      ["no author", { user: null }],
      ["title", { title: "Fix everything" }],
      ["title case", { title: "issue batch: #1" }],
      ["no title", { title: undefined }],
      ["head ref", { head: { ref: "feature/x", sha: SHA, repo: { full_name: REPO } } }],
      ["no head", { head: undefined }],
      ["fork", { head: { ref: "claude/x", sha: SHA, repo: { full_name: "evil/openclaw-all-cli" } } }],
      ["deleted fork", { head: { ref: "claude/x", sha: SHA, repo: null } }],
    ];
    for (const [name, override] of cases) {
      calls = [];
      answers.set(`GET /repos/${REPO}/pulls/21`, [200, pull({ number: 21, draft: true, updated_at: hoursAgo(5), ...override })]);
      const result = await run([{ op: "pr_close", pr: 21 }]);
      expect(result.code, name).toBe(1);
      expect(seen(), name).toEqual(["GET /pulls/21"]);
      expect(result.summary, name).toContain("refused");
    }
    // An unreadable pull request is refused too.
    calls = [];
    answers.set(`GET /repos/${REPO}/pulls/21`, [200, null]);
    expect((await run([{ op: "pr_close", pr: 21 }])).code).toBe(1);
    expect(seen()).toEqual(["GET /pulls/21"]);
  });

  it("PR_CLOSE: a draft updated less than 4 hours ago, or with no readable update time, is refused; one idle longer is closed", async () => {
    const cases: Array<[string, unknown, number]> = [
      ["just now", hoursAgo(0), 1],
      ["3 hours", hoursAgo(3), 1],
      ["3h59", hoursAgo(3.98), 1],
      ["future", hoursAgo(-1), 1],
      ["missing", undefined, 1],
      ["unreadable", "yesterday", 1],
      ["number", 5, 1],
      ["4h01", hoursAgo(4.02), 0],
      ["a day", hoursAgo(24), 0],
    ];
    for (const [name, updated_at, code] of cases) {
      calls = [];
      answers.set(`GET /repos/${REPO}/pulls/21`, [200, pull({ number: 21, draft: true, title: "Issue batch (in progress)", updated_at })]);
      const result = await run([{ op: "pr_close", pr: 21 }]);
      expect(result.code, name).toBe(code);
      expect(seen(), name).toEqual(code === 1 ? ["GET /pulls/21"] : ["GET /pulls/21", "PATCH /pulls/21"]);
      if (code === 1) expect(result.summary, name).toContain("refused");
    }
  });

  it("PR_CLOSE: a bad shape is refused before any call; a failed PATCH stops the list", async () => {
    for (const entry of [{ op: "pr_close" }, { op: "pr_close", pr: "21" }, { op: "pr_close", pr: 0 }, { op: "pr_close", pr: 21, state: "open" }, { op: "pr_close", pr: 21, sha: SHA }]) {
      expect((await run([entry])).code, JSON.stringify(entry)).toBe(1);
    }
    expect(calls).toEqual([]);
    answers.set(`GET /repos/${REPO}/pulls/21`, [200, pull({ number: 21, draft: true, updated_at: hoursAgo(5) })]);
    answers.set(`PATCH /repos/${REPO}/pulls/21`, [403, { message: "Resource not accessible" }]);
    const result = await run([{ op: "pr_close", pr: 21 }, { op: "comment", issue: 12, body: "later" }]);
    expect(result.code).toBe(1);
    expect(seen()).toEqual(["GET /pulls/21", "PATCH /pulls/21"]);
    expect(result.summary).toContain("Stopped at operation 1 of 2");
  });

  it("MERGE: merges the agent's own ready batch PR with method merge and the sha", async () => {
    const result = await run([{ op: "merge", pr: 20, sha: SHA.toUpperCase() }]);
    expect(result.code).toBe(0);
    expect(seen()).toEqual(["GET /pulls/20", `GET /commits/${SHA}/check-runs`, `GET /commits/${SHA}/status`, "PUT /pulls/20/merge"]);
    expect(calls[3]?.body).toEqual({ merge_method: "merge", sha: SHA });
    expect(result.summary).toContain("merged at fedcba9");
  });

  it("MERGE: draft, closed, another author, head outside claude/, a fork, base not main, title not Issue batch, or a sha mismatch is refused before the call", async () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["draft", { draft: true }],
      ["closed", { state: "closed" }],
      ["author", { user: { login: "xtimor" } }],
      ["head ref", { head: { ref: "feature/x", sha: SHA, repo: { full_name: REPO } } }],
      ["fork", { head: { ref: "claude/x", sha: SHA, repo: { full_name: "evil/openclaw-all-cli" } } }],
      ["deleted fork", { head: { ref: "claude/x", sha: SHA, repo: null } }],
      ["base", { base: { ref: "release" } }],
      ["title", { title: "Fix everything" }],
      ["sha", { head: { ref: "claude/x", sha: "f".repeat(40), repo: { full_name: REPO } } }],
      ["blocked", { mergeable_state: "blocked" }],
      ["unknown", { mergeable_state: "unknown" }],
      ["dirty", { mergeable_state: "dirty" }],
      ["no state", { mergeable_state: undefined }],
    ];
    for (const [name, override] of cases) {
      calls = [];
      answers.set(`GET /repos/${REPO}/pulls/20`, [200, pull(override)]);
      const result = await run([{ op: "merge", pr: 20, sha: SHA }]);
      expect(result.code, name).toBe(1);
      expect(seen(), name).toEqual(["GET /pulls/20"]);
      expect(result.summary, name).toContain("refused");
    }
    calls = [];
    answers.delete(`GET /repos/${REPO}/pulls/20`);
    for (const sha of ["abc", "g".repeat(40), 5, undefined]) expect((await run([{ op: "merge", pr: 20, sha }])).code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("MERGE: a pull request that is not green is refused before the merge call", async () => {
    const runs = (check_runs: unknown[], total_count = check_runs.length): Answer => [200, { total_count, check_runs }];
    const ok = { name: "check", status: "completed", conclusion: "success" };
    const cases: Array<[string, Answer, Answer?]> = [
      ["no check runs", runs([])],
      ["no check run named check", runs([{ name: "other", status: "completed", conclusion: "success" }])],
      ["check failed", runs([{ ...ok, conclusion: "failure" }])],
      ["check skipped", runs([{ ...ok, conclusion: "skipped" }])],
      ["check running", runs([{ name: "check", status: "in_progress", conclusion: null }])],
      ["other run failed", runs([ok, { name: "x", status: "completed", conclusion: "failure" }])],
      ["other run cancelled", runs([ok, { name: "x", status: "completed", conclusion: "cancelled" }])],
      ["other run timed out", runs([ok, { name: "x", status: "completed", conclusion: "timed_out" }])],
      ["other run needs action", runs([ok, { name: "x", status: "completed", conclusion: "action_required" }])],
      ["other run queued", runs([ok, { name: "x", status: "queued", conclusion: null }])],
      ["more runs than listed", runs([ok], 150)],
      ["runs unreadable", [200, { nope: true }]],
      ["status failure", runs([ok]), [200, { state: "failure", total_count: 1, statuses: [] }]],
      ["status pending", runs([ok]), [200, { state: "pending", total_count: 2, statuses: [] }]],
      ["status error", runs([ok]), [200, { state: "error", total_count: 1, statuses: [] }]],
      ["status unreadable", runs([ok]), [200, null]],
    ];
    for (const [name, checks, status] of cases) {
      calls = [];
      answers.set(`GET /repos/${REPO}/commits/${SHA}/check-runs`, checks);
      if (status) answers.set(`GET /repos/${REPO}/commits/${SHA}/status`, status);
      else answers.delete(`GET /repos/${REPO}/commits/${SHA}/status`);
      const result = await run([{ op: "merge", pr: 20, sha: SHA }]);
      expect(result.code, name).toBe(1);
      expect(seen().includes("PUT /pulls/20/merge"), name).toBe(false);
      expect(result.summary, name).toContain("refused");
      answers.delete(`GET /repos/${REPO}/commits/${SHA}/status`);
    }
    // Neutral, skipped, and a green status are fine.
    calls = [];
    answers.set(`GET /repos/${REPO}/commits/${SHA}/check-runs`, runs([ok, { name: "a", status: "completed", conclusion: "neutral" }, { name: "b", status: "completed", conclusion: "skipped" }]));
    answers.set(`GET /repos/${REPO}/commits/${SHA}/status`, [200, { state: "success", total_count: 1, statuses: [] }]);
    expect((await run([{ op: "merge", pr: 20, sha: SHA }])).code).toBe(0);
  });

  it("POST_CALL: a 200 that did not do the thing is a failure (ready with isDraft true or no pull request; merge with merged false)", async () => {
    for (const payload of [{ data: { markPullRequestReadyForReview: { pullRequest: { number: 21, isDraft: true } } } }, { data: { markPullRequestReadyForReview: { pullRequest: null } } }, { data: null }, {}]) {
      answers.set("POST /graphql", [200, payload]);
      const result = await run([{ op: "pr_ready", pr: 21 }]);
      expect(result.code, JSON.stringify(payload)).toBe(1);
      expect(result.summary).toContain("did not mark it ready for review");
    }
    answers.set(`PUT /repos/${REPO}/pulls/20/merge`, [200, { merged: false, message: "nope" }]);
    const merge = await run([{ op: "merge", pr: 20, sha: SHA }]);
    expect(merge.code).toBe(1);
    expect(merge.summary).toContain("did not merge it");
    answers.set(`PUT /repos/${REPO}/pulls/20/merge`, [200, {}]);
    expect((await run([{ op: "merge", pr: 20, sha: SHA }])).code).toBe(1);
    answers.set(`POST /repos/${REPO}/pulls`, [201, {}]);
    const created = await run([{ op: "pr_create", head: "claude/x", title: "t" }]);
    expect(created.code).toBe(1);
    expect(created.summary).toContain("no pull request number");
  });

  it("CLOSE_REOPEN: an unreadable issue answer skips nothing: it is refused; reopen patches state open and also refuses a pull request", async () => {
    for (const payload of ["text", null, [], 5]) {
      calls = [];
      answers.set(`GET /repos/${REPO}/issues/12`, [200, payload]);
      for (const op of [{ op: "close", issue: 12, reason: "completed" }, { op: "reopen", issue: 12 }]) {
        const result = await run([op]);
        expect(result.code, JSON.stringify(payload)).toBe(1);
        expect(result.summary).toContain("could not be read");
      }
      expect(seen().filter((call) => call.startsWith("PATCH"))).toEqual([]);
    }
    answers.delete(`GET /repos/${REPO}/issues/12`);
    calls = [];
    const reopened = await run([{ op: "reopen", issue: 12 }]);
    expect(reopened.code).toBe(0);
    expect(seen()).toEqual(["GET /issues/12", "PATCH /issues/12"]);
    expect(calls[1]?.body).toEqual({ state: "open", state_reason: "reopened" });
    expect(reopened.summary).toContain("reopened");
    calls = [];
    const pr = await run([{ op: "reopen", issue: 20 }]);
    expect(pr.code).toBe(1);
    expect(seen()).toEqual(["GET /issues/20"]);
    expect((await run([{ op: "reopen", issue: 12, reason: "completed" }])).code).toBe(1);
    expect((await run([{ op: "reopen" }])).code).toBe(1);
  });

  it("LOG_LINES: API text with newlines cannot fake a log line or a workflow command; every line starts with agent-write:", async () => {
    answers.set(`POST /repos/${REPO}/issues/12/comments`, [422, { message: "bad\r\n::add-mask::x\nagent-write: Applied 9 operation(s)\u2028::error::boom" }]);
    const result = await run([{ op: "comment", issue: 12, body: "hi" }]);
    expect(result.code).toBe(1);
    for (const line of `${result.stdout}${result.stderr}`.split("\n").filter((l) => l !== "")) expect(line.startsWith("agent-write: "), line).toBe(true);
    expect(result.stdout + result.stderr).not.toMatch(/^::/m);
    expect(result.stderr + result.stdout).toContain("bad ::add-mask::x agent-write: Applied 9 operation(s) ::error::boom");
    expect(result.summary).not.toMatch(/^::/m);
  });

  it("PROGRESS: each finished operation is on stdout before the next starts, and a failed run still shows what was applied", async () => {
    answers.set(`POST /repos/${REPO}/issues/12/labels`, [403, { message: "no" }]);
    const result = await run([{ op: "comment", issue: 12, body: "hi" }, { op: "labels", issue: 12, add: ["status:triaged"] }, { op: "close", issue: 12, reason: "completed" }]);
    const lines = result.stdout.split("\n").filter((l) => l !== "");
    expect(lines.slice(0, 2)).toEqual([`agent-write: acting as ${BOT}`, "agent-write: comment #12: comment 9001 created"]);
    expect(lines.slice(2)).toEqual(expect.arrayContaining([expect.stringContaining("labels : failed"), "agent-write: close : not applied"]));
  });

  it("APPROVAL: status:approved in any spelling refuses the whole input, nothing applied", async () => {
    for (const label of ["status:approved", " Status:Approved ", "STATUS:APPROVED"]) {
      const result = await run([{ op: "comment", issue: 12, body: "hi" }, { op: "labels", issue: 12, add: ["status:triaged", label] }]);
      expect(result.code).toBe(1);
      expect(result.summary).toContain("Refused, nothing applied");
    }
    expect(calls).toEqual([]);
    // Removing it is not adding it.
    expect((await run([{ op: "labels", issue: 12, remove: ["status:approved"] }])).code).toBe(0);
  });

  it("LABEL_NAMES: only status:, type:, priority:, and source: names; dot names, lookalikes, typos, and a name in both lists are refused", async () => {
    const bad = [".", "..", "", "bug", "status:", "status: triaged", "Status:triaged", "status:Triaged", "stat\u0435s:triaged", "status:a/b", "status:../x", "wontfix", "status:x\nstatus:y", "label:x", "status:" + "a".repeat(41)];
    for (const name of bad) {
      for (const key of ["add", "remove"]) {
        const result = await run([{ op: "labels", issue: 12, [key]: [name] }]);
        expect(result.code, `${key} ${JSON.stringify(name)}`).toBe(1);
        expect(result.summary).toContain("Refused, nothing applied");
      }
    }
    const both = await run([{ op: "labels", issue: 12, add: ["status:triaged"], remove: ["status:triaged"] }]);
    expect(both).toMatchObject({ code: 1 });
    expect(both.summary).toContain("both added and removed");
    expect(calls).toEqual([]);
    for (const name of ["status:in-progress", "type:bug", "priority:p0", "source:agent", "status:needs-info"]) {
      expect((await run([{ op: "labels", issue: 12, add: [name] }])).code, name).toBe(0);
    }
  });

  it("DISPATCHER: an actor or triggering actor outside ISSUE_FLOW_OWNERS (or none) is refused, nothing applied; the comparison ignores case", async () => {
    const ops = [{ op: "comment", issue: 12, body: "hi" }];
    const cases = [
      { GITHUB_ACTOR: "mallory" },
      { GITHUB_ACTOR: undefined },
      { GITHUB_ACTOR: " " },
      { GITHUB_TRIGGERING_ACTOR: "mallory" }, // a non-owner re-ran an owner's run
      { GITHUB_TRIGGERING_ACTOR: undefined },
      { GITHUB_TRIGGERING_ACTOR: " " },
      { ISSUE_FLOW_OWNERS: "" },
      { ISSUE_FLOW_OWNERS: undefined },
    ];
    for (const env of cases) {
      const result = await run(ops, env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.summary).toContain("is not an owner");
    }
    expect(calls).toEqual([]);
    expect((await run(ops, { GITHUB_ACTOR: "XTimor", GITHUB_TRIGGERING_ACTOR: "xTIMOR", ISSUE_FLOW_OWNERS: "someone, xtimor" })).code).toBe(0);
  });

  it("NO_REPLAY: a re-run (attempt not 1, or unknown) is refused, nothing applied", async () => {
    const ops = [{ op: "comment", issue: 12, body: "hi" }];
    for (const GITHUB_RUN_ATTEMPT of ["2", "10", "0", "", undefined, "1.0"]) {
      const result = await run(ops, { GITHUB_RUN_ATTEMPT });
      expect(result.code, String(GITHUB_RUN_ATTEMPT)).toBe(1);
      expect(result.summary).toContain("re-run");
    }
    expect(calls).toEqual([]);
  });

  it("SIZE: more than 50 operations or more than 60 000 characters is refused; 50 pass", async () => {
    const one = { op: "comment", issue: 12, body: "hi" };
    const tooMany = await run(Array.from({ length: 51 }, () => one));
    expect(tooMany.code).toBe(1);
    expect(tooMany.summary).toContain("51 operations");
    const huge = await run([{ op: "comment", issue: 12, body: "x".repeat(60_001) }]);
    expect(huge.code).toBe(1);
    expect(huge.summary).toContain("characters");
    expect(calls).toEqual([]);
    const fifty = await run(Array.from({ length: 50 }, () => one));
    expect(fifty.code).toBe(0);
    expect(calls).toHaveLength(50);
    calls = [];
    expect((await run([{ op: "comment", issue: 12, body: "x".repeat(50_000) }])).code).toBe(0);
  });

  it("UNKNOWN_OP: an unknown op, field, or shape refuses everything before any call", async () => {
    const good = { op: "comment", issue: 12, body: "hi" };
    const bad: unknown[] = [
      { op: "delete", issue: 12 },
      { op: "comment", issue: 12, body: "hi", extra: 1 },
      { op: "comment", issue: "12", body: "hi" },
      { op: "comment", issue: 0, body: "hi" },
      { op: "comment", issue: 1.5, body: "hi" },
      { op: "comment", issue: 12, body: "  " },
      { op: "comment", issue: 12 },
      { op: "labels", issue: 12 },
      { op: "labels", issue: 12, add: "status:triaged" },
      { op: "labels", issue: 12, add: [""] },
      { op: "labels", issue: 12, add: ["x".repeat(51)] },
      { op: "edit_comment", comment_id: "5", body: "x" },
      { op: "toString" },
      { op: 5 },
      "comment",
      null,
    ];
    for (const entry of bad) {
      const result = await run([good, entry]);
      expect(result.code, JSON.stringify(entry)).toBe(1);
      expect(result.summary).toContain("Refused, nothing applied");
    }
    for (const raw of ["not json", "{}", "[]", "null", '"x"']) expect((await run(null, {}, raw)).code, raw).toBe(1);
    expect(calls).toEqual([]);
  });

  it("STOP_AT_FIRST_FAILURE: later operations are not applied and the summary says which failed", async () => {
    answers.set(`POST /repos/${REPO}/issues/12/labels`, [403, { message: "Resource not accessible" }]);
    const result = await run([
      { op: "comment", issue: 12, body: "first" },
      { op: "labels", issue: 12, add: ["status:triaged"] },
      { op: "comment", issue: 12, body: "third" },
    ]);
    expect(result.code).toBe(1);
    expect(seen()).toEqual(["POST /issues/12/comments", "POST /issues/12/labels"]);
    expect(result.summary).toContain("Stopped at operation 2 of 3");
    expect(result.summary).toContain("failed: POST /issues/12/labels: GitHub answered 403 (Resource not accessible)");
    expect(result.summary).toContain("| 3 | comment |  | not applied |");
    expect(result.summary).toContain("comment 9001 created");
    expect(result.stderr).toContain("Stopped at operation 2 of 3");
  });

  it("NO_TOKEN_LEAK: an API message that echoes the token is redacted everywhere; a refused connection leaks nothing", async () => {
    answers.set(`POST /repos/${REPO}/issues/12/comments`, [401, { message: `Bad credentials ${TOKEN}` }]);
    const echoed = await run([{ op: "comment", issue: 12, body: `b ${BODY_MARK}` }]);
    expect(echoed.code).toBe(1);
    expect(echoed.summary).toContain("[redacted]");
    expect(leaked(echoed)).toEqual([]);
    const down = await run([{ op: "comment", issue: 12, body: `b ${BODY_MARK}` }], { GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(down.code).toBe(1);
    expect(leaked(down)).toEqual([]);
  });

  it("a redirect is not followed (the token stays with the API host)", async () => {
    const moved = createServer((req, res) => {
      calls.push({ method: req.method ?? "GET", path: req.url ?? "", body: null, auth: req.headers.authorization });
      res.writeHead(302, { location: req.url ?? "/" });
      res.end();
    });
    await new Promise<void>((done) => moved.listen(0, "127.0.0.1", done));
    try {
      const result = await run([{ op: "comment", issue: 12, body: "x" }], { GITHUB_API_URL: `http://127.0.0.1:${(moved.address() as AddressInfo).port}` });
      expect(result.code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(leaked(result)).toEqual([]);
    } finally {
      await new Promise((done) => moved.close(done));
    }
  });

  it("MISSING_VARS: a missing or malformed variable exits 2 with no request", async () => {
    const ops = [{ op: "comment", issue: 12, body: "hi" }];
    for (const name of ["GH_TOKEN", "GITHUB_REPOSITORY", "AGENT_LOGIN"]) {
      const result = await run(ops, { [name]: undefined });
      expect(result.code, name).toBe(2);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(TOKEN);
    }
    expect((await run(ops, { AGENT_LOGIN: "xtimor" })).code).toBe(2);
    expect((await run(ops, { GITHUB_REPOSITORY: "nope" })).code).toBe(2);
    expect((await run(null, { AGENT_WRITE_OPS: undefined }, "")).code).toBe(2);
    expect(calls).toEqual([]);
    // The step summary still says why nothing ran.
    const noToken = await run(ops, { GH_TOKEN: undefined });
    expect(noToken.summary).toContain("Not run");
    expect(noToken.summary).toContain("GH_TOKEN");
  });
});

describe("agent-write workflow file", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "agent-write.yml"), "utf8");
  const flow = readFileSync(join(ROOT, ".github", "workflows", "issue-flow.yml"), "utf8");

  it("pins every action by SHA like the other workflows and asks for nothing beyond contents: read", () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses.map((m) => m[1])).toEqual(["actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1", "actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1"]);
    for (const [, , rest] of uses) expect(rest).toMatch(/# v\d/);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text.match(/^\s+permissions:\n\s+contents: read$/gm)).toHaveLength(1);
    expect(text).not.toMatch(/: (write|admin)\b/);
    expect(text).toMatch(/NODE_VERSION: 24\.22\.0/);
  });

  it("runs only on main, dispatch only, in the agent environment, with no concurrency group", () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}ops:\n(?: {8}.*\n)*? {8}required: true\n(?: {8}.*\n)*? {8}type: string\n/m);
    expect(text).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(text).toMatch(/^ {4}environment: agent$/m);
    expect(text).not.toMatch(/^\s*concurrency:/m);
  });

  it("passes inputs and secrets through env only, masks the token, and mints and writes in one step", () => {
    const runBlocks = [...text.matchAll(/ {8}run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1] ?? "");
    expect(runBlocks.length).toBeGreaterThan(0);
    for (const block of runBlocks) expect(block).not.toContain("${{");
    const step = runBlocks.find((block) => block.includes("agent-write.mjs")) ?? "";
    expect(step).toContain("scripts/agent-token.mjs");
    expect(step).toContain('echo "::add-mask::$TOKEN"');
    expect(step.indexOf("::add-mask::")).toBeLessThan(step.indexOf("agent-write.mjs"));
    expect(step).not.toMatch(/GITHUB_ENV|GITHUB_OUTPUT|set -x|echo "\$TOKEN"/);
    expect(text).toContain("AGENT_APP_PRIVATE_KEY: ${{ secrets.AGENT_APP_PRIVATE_KEY }}");
    expect(text).toContain("AGENT_APP_ID: ${{ vars.AGENT_APP_ID }}");
    expect(text).toContain("AGENT_WRITE_OPS: ${{ inputs.ops }}");
    expect(text).toContain("GITHUB_TRIGGERING_ACTOR: ${{ github.triggering_actor }}");
  });

  it("runs the writer without the private key and revokes the token when the step ends", () => {
    expect(text).toMatch(/env -u AGENT_APP_PRIVATE_KEY -u AGENT_APP_PRIVATE_KEY_B64 GH_TOKEN="\$TOKEN" .*node scripts\/agent-write\.mjs$/m);
    const trap = text.match(/^\s+trap '(.*)' EXIT$/m)?.[1] ?? "";
    expect(trap).toContain("-X DELETE");
    expect(trap).toContain("/installation/token");
    expect(text.indexOf("trap '")).toBeGreaterThan(text.indexOf("::add-mask::"));
    expect(text.indexOf("trap '")).toBeLessThan(text.indexOf("env -u"));
  });

  it("keeps the same owner list as issue-flow.yml", () => {
    const owners = (source: string) => source.match(/^ {2}ISSUE_FLOW_OWNERS: (.+)$/m)?.[1];
    expect(owners(text)).toBeDefined();
    expect(owners(text)).toBe(owners(flow));
    expect(text).toContain("issue-flow.yml");
    expect(flow).toContain("agent-write.yml");
  });
});

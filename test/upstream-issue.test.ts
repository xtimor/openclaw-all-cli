import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/upstream-issue.mjs against a local stub of the GitHub REST API (ticket 3.23). Every row of the plan's I/O matrix: what is
 * created, what is refused with no request, the idempotent answer, and no token, title, or body on any stream, in the summary, or in
 * the output file. The script runs in a child process, never spawnSync, since the stub serves from this process. Nothing here
 * reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "upstream-issue.mjs");
const OURS = "xtimor/openclaw-all-cli";
const TARGET = "openclaw/openclaw";
const TOKEN = "ghp_STUB_PERSONAL_TOKEN_0123456789";
const TITLE_MARK = "TITLE_MARKER_must_not_be_echoed_5521";
const BODY_MARK = "BODY_MARKER_must_not_be_echoed_7731";
const MARKER = `Filed for ${OURS}#45`;

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
let answers = new Map<string, Answer>();

async function readBody(req: IncomingMessage): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : null;
}

const issue = (overrides: Record<string, unknown> = {}) => ({ title: `Plugin icon is not read ${TITLE_MARK}`, body: `### Summary\n\n${BODY_MARK}\n\n${MARKER}\n`, ...overrides });

function defaults(method: string, path: string): Answer {
  if (method === "GET" && path === "/user") return [200, { login: "xtimor" }];
  if (method === "GET" && path === `/repos/${TARGET}/issues`) return [200, []];
  if (method === "POST" && path === `/repos/${TARGET}/issues`) return [201, { number: 777, labels: [] }];
  return [404, { message: "Not Found" }];
}

beforeAll(async () => {
  server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://stub");
    const path = decodeURIComponent(url.pathname);
    const method = req.method ?? "GET";
    calls.push({ method, path, search: url.search, body: await readBody(req), auth: req.headers.authorization });
    const [status, payload] = answers.get(`${method} ${path}${method === "GET" && url.searchParams.has("page") ? `?page=${url.searchParams.get("page")}` : ""}`) ?? answers.get(`${method} ${path}`) ?? defaults(method, path);
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
  output: string;
}

const stripped = () =>
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_") && !key.startsWith("UPSTREAM_") && !key.startsWith("ISSUE_FLOW") && !/proxy/i.test(key) && key !== "GH_PUBLIC_TOKEN"));

function run(input: unknown, env: Record<string, string | undefined> = {}, raw?: string): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "upstream-issue-"));
  dirs.push(dir);
  const summaryFile = join(dir, "summary.md");
  const outputFile = join(dir, "output.txt");
  const merged: Record<string, string | undefined> = {
    ...stripped(),
    UPSTREAM_ISSUE: raw ?? JSON.stringify(input),
    GH_PUBLIC_TOKEN: TOKEN,
    GITHUB_REPOSITORY: OURS,
    GITHUB_ACTOR: "xtimor",
    GITHUB_TRIGGERING_ACTOR: "xtimor",
    GITHUB_RUN_ATTEMPT: "1",
    ISSUE_FLOW_OWNERS: "xtimor",
    GITHUB_API_URL: base,
    GITHUB_STEP_SUMMARY: summaryFile,
    GITHUB_OUTPUT: outputFile,
    ...env,
  };
  for (const key of Object.keys(merged)) if (merged[key] === undefined) delete merged[key];
  const read = (file: string) => {
    try {
      return readFileSync(file, "utf8");
    } catch {
      return "";
    }
  };
  return new Promise((done) => {
    execFile(process.execPath, [SCRIPT], { env: merged as NodeJS.ProcessEnv, timeout: 20_000 }, (error, stdout, stderr) => {
      done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr, summary: read(summaryFile), output: read(outputFile) });
    });
  });
}

const seen = () => calls.map((call) => `${call.method} ${call.path}`);
const writes = () => calls.filter((call) => call.method !== "GET");
const everything = (result: Run) => `${result.stdout}\n${result.stderr}\n${result.summary}\n${result.output}`;
const leaked = (result: Run, extra: string[] = []) => [TOKEN, TITLE_MARK, BODY_MARK, ...extra].filter((secret) => everything(result).includes(secret));
const URL_777 = `https://github.com/${TARGET}/issues/777`;

describe("upstream-issue", () => {
  it("CREATE: reads the token's owner, finds nothing, posts the issue to the allowed repository with the token, prints the URL", async () => {
    const result = await run(issue());
    expect(result.code, result.stderr).toBe(0);
    expect(seen()).toEqual(["GET /user", `GET /repos/${TARGET}/issues`, `POST /repos/${TARGET}/issues`]);
    expect(calls[1]?.search).toContain("creator=xtimor");
    expect(calls[1]?.search).toContain("state=all");
    expect(calls[2]?.body).toEqual({ title: `Plugin icon is not read ${TITLE_MARK}`, body: `### Summary\n\n${BODY_MARK}\n\n${MARKER}\n` });
    for (const call of calls) expect(call.auth).toBe(`Bearer ${TOKEN}`);
    expect(result.stdout).toContain(`upstream-issue: created ${URL_777}`);
    expect(result.output).toBe(`result=upstream-issue: created ${URL_777}\n`);
    expect(result.summary).toContain("Upstream issue");
    expect(leaked(result)).toEqual([]);
    // Every line is one line with the prefix: nothing to fake a workflow command with.
    for (const line of result.stdout.split("\n").filter(Boolean)) expect(line.startsWith("upstream-issue: ")).toBe(true);
  });

  it("CREATE: an explicit allowed repo in any case, and labels, are sent; the log says which labels the target applied", async () => {
    answers.set(`POST /repos/${TARGET}/issues`, [201, { number: 777, labels: [{ name: "bug" }] }]);
    const result = await run(issue({ repo: "OpenClaw/OpenClaw", labels: ["bug", " bug ", "enhancement"] }));
    expect(result.code, result.stderr).toBe(0);
    expect(writes()[0]?.body?.labels).toEqual(["bug", "enhancement"]);
    expect(result.stdout).toContain("labels applied: bug; not applied by the target: enhancement");
    expect(leaked(result)).toEqual([]);
  });

  it("EXISTING: the same marker line among the owner's issues is returned, nothing is created (the title may differ; pull requests and other markers do not count)", async () => {
    answers.set(`GET /repos/${TARGET}/issues`, [
      200,
      [
        { number: 10, title: "other", body: `x\nFiled for ${OURS}#450\n` },
        { number: 11, title: "a pull request", body: MARKER, pull_request: { url: "x" } },
        { number: 12, title: "closed one", body: `text\n${MARKER}\r\nmore`, state: "closed" },
      ],
    ]);
    const result = await run(issue({ title: "A different title" }));
    expect(result.code, result.stderr).toBe(0);
    expect(writes()).toEqual([]);
    expect(result.stdout).toContain(`upstream-issue: existing https://github.com/${TARGET}/issues/12`);
    expect(result.output).toBe(`result=upstream-issue: existing https://github.com/${TARGET}/issues/12\n`);
    expect(leaked(result)).toEqual([]);
  });

  it("EXISTING: the same title (any case, any state) is returned too; a null body is fine", async () => {
    answers.set(`GET /repos/${TARGET}/issues`, [200, [{ number: 5, title: `  PLUGIN ICON IS NOT READ ${TITLE_MARK.toUpperCase()} `, body: null }]]);
    const result = await run(issue({ title: `plugin icon is not read ${TITLE_MARK.toUpperCase()}` }));
    expect(result.code, result.stderr).toBe(0);
    expect(writes()).toEqual([]);
    expect(result.stdout).toContain(`issues/5`);
  });

  it("EXISTING: pages through the owner's issues; the match on page 2 is found; a full last page of 10 refuses instead of guessing", async () => {
    const filler = (from: number) => Array.from({ length: 100 }, (_, i) => ({ number: from + i, title: `t${from + i}`, body: "" }));
    answers.set(`GET /repos/${TARGET}/issues?page=1`, [200, filler(100)]);
    answers.set(`GET /repos/${TARGET}/issues?page=2`, [200, [{ number: 9, title: "x", body: MARKER }]]);
    const found = await run(issue());
    expect(found.code, found.stderr).toBe(0);
    expect(found.stdout).toContain("issues/9");
    expect(writes()).toEqual([]);

    calls = [];
    answers = new Map();
    for (let page = 1; page <= 10; page++) answers.set(`GET /repos/${TARGET}/issues?page=${page}`, [200, filler(page * 1000)]);
    const many = await run(issue());
    expect(many.code).toBe(1);
    expect(many.stderr).toContain("cannot rule out a duplicate");
    expect(writes()).toEqual([]);
  });

  it("REFUSED_INPUT: another repo, an extra key, bad types, a bad label list: refused, no request of any kind", async () => {
    const bad: unknown[] = [
      issue({ repo: "xtimor/openclaw-all-cli" }),
      issue({ repo: "openclaw/openclaw-evil" }),
      issue({ repo: 5 }),
      issue({ comment: "x" }),
      issue({ title: 5 }),
      issue({ title: "   " }),
      issue({ body: 5 }),
      issue({ labels: "bug" }),
      issue({ labels: ["a", "b", "c", "d", "e", "f"] }),
      issue({ labels: [5] }),
      issue({ labels: ["a,b"] }),
      issue({ labels: ["x".repeat(51)] }),
      [issue()],
      "text",
      null,
    ];
    for (const input of bad) {
      const result = await run(input);
      expect(result.code, JSON.stringify(input)?.slice(0, 80)).toBe(1);
      expect(result.stderr).toContain("Refused, nothing created");
      expect(leaked(result)).toEqual([]);
    }
    expect((await run(null, {}, "{not json")).code).toBe(1);
    expect(calls).toEqual([]);
  });

  it("MARKER: no marker, two markers, a marker for another repository, or one that is not on its own line is refused, no request", async () => {
    const bodies = [
      "### Summary\n\nno marker here",
      `${MARKER}\nand again\n${MARKER}`,
      `${MARKER}\nFiled for ${OURS}#46`,
      "Filed for openclaw/openclaw#45",
      `see ${MARKER} for details`,
      `${MARKER} extra words`,
      `Filed for ${OURS}#0`,
    ];
    for (const body of bodies) {
      const result = await run(issue({ body }));
      expect(result.code, body).toBe(1);
      expect(result.stderr).toContain("Refused, nothing created");
    }
    expect(calls).toEqual([]);
    // Windows line ends and a trailing blank are still one marker line.
    expect((await run(issue({ body: `a\r\n${MARKER}  \r\n` }))).code).toBe(0);
  });

  it("SIZE: an oversize title, body, or input, a multi-line title, and control characters are refused, no request; the limits themselves pass", async () => {
    const refusals = [
      issue({ title: "t".repeat(257) }),
      issue({ title: "two\nlines" }),
      issue({ title: "bell\u0007" }),
      issue({ body: `${MARKER}\n${"b".repeat(30_000)}` }),
      issue({ body: `${MARKER}\u0000` }),
    ];
    for (const input of refusals) expect((await run(input)).code, JSON.stringify(input).slice(0, 60)).toBe(1);
    const huge = await run(null, {}, JSON.stringify({ title: "t", body: `${MARKER}\n`, labels: [], pad: "x".repeat(40_001) }));
    expect(huge.code).toBe(1);
    expect(huge.stderr).toContain("the limit is 40000");
    expect(calls).toEqual([]);
    const body = `${MARKER}\n${"b".repeat(30_000 - MARKER.length - 1)}`;
    expect((await run(issue({ title: "t".repeat(256), body }))).code).toBe(0);
  });

  it("ACTORS: a dispatcher or triggering actor outside ISSUE_FLOW_OWNERS (or none) is refused; the comparison ignores case; a re-run is refused; no request", async () => {
    for (const env of [{ GITHUB_ACTOR: "mallory" }, { GITHUB_TRIGGERING_ACTOR: "mallory" }, { GITHUB_ACTOR: undefined }, { GITHUB_TRIGGERING_ACTOR: "" }, { GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ATTEMPT: undefined }]) {
      const result = await run(issue(), env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(result.stderr).toContain("Refused, nothing created");
      expect(result.output).toContain("upstream-issue: Refused");
      expect(leaked(result)).toEqual([]);
    }
    expect(calls).toEqual([]);
    expect((await run(issue(), { GITHUB_ACTOR: "XTimor", GITHUB_TRIGGERING_ACTOR: "xtimor", ISSUE_FLOW_OWNERS: "other, xTimor" })).code).toBe(0);
  });

  it("API_FAILS: a failing user read, list, or create exits 1 with the status only; a failed create says to read the target before dispatching again", async () => {
    answers.set("GET /user", [401, { message: `Bad credentials ${TOKEN}` }]);
    const user = await run(issue());
    expect(user.code).toBe(1);
    expect(user.stderr).toContain("GitHub answered 401");
    expect(user.summary).toContain("[redacted]");
    expect(writes()).toEqual([]);
    expect(leaked(user)).toEqual([]);

    answers = new Map([[`GET /repos/${TARGET}/issues`, [500, { message: "boom" }]]]);
    expect((await run(issue())).code).toBe(1);
    expect(writes()).toEqual([]);

    answers = new Map([["GET /user", [200, { login: "../etc" }]]]);
    expect((await run(issue())).code).toBe(1);
    expect(writes()).toEqual([]);

    answers = new Map([[`POST /repos/${TARGET}/issues`, [403, { message: `forbidden ${TOKEN}` }]]]);
    const create = await run(issue());
    expect(create.code).toBe(1);
    expect(create.stderr).toContain("read the target before dispatching again");
    expect(create.stderr).toContain("GitHub answered 403");
    expect(create.output).toContain("upstream-issue: Failed while creating");
    expect(leaked(create)).toEqual([]);

    answers = new Map([[`POST /repos/${TARGET}/issues`, [201, { id: 5 }]]]);
    expect((await run(issue())).code).toBe(1);
  });

  it("LOG_LINES: API text with newlines or a workflow command cannot fake a line", async () => {
    answers.set("GET /user", [401, { message: "line one\n::set-output name=x::y\r\n::error::fake" }]);
    const result = await run(issue());
    expect(result.code).toBe(1);
    for (const line of `${result.stdout}${result.stderr}`.split("\n").filter(Boolean)) expect(line.startsWith("upstream-issue: ")).toBe(true);
    expect(result.output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("a redirect is not followed (the token stays with the API host)", async () => {
    const moved = createServer((req, res) => {
      calls.push({ method: req.method ?? "GET", path: req.url ?? "", search: "", body: null, auth: req.headers.authorization });
      res.writeHead(302, { location: req.url ?? "/" });
      res.end();
    });
    await new Promise<void>((done) => moved.listen(0, "127.0.0.1", done));
    try {
      const result = await run(issue(), { GITHUB_API_URL: `http://127.0.0.1:${(moved.address() as AddressInfo).port}` });
      expect(result.code).toBe(1);
      expect(calls).toHaveLength(1);
      expect(leaked(result)).toEqual([]);
    } finally {
      await new Promise((done) => moved.close(done));
    }
    const down = await run(issue(), { GITHUB_API_URL: "http://127.0.0.1:1" });
    expect(down.code).toBe(1);
    expect(leaked(down)).toEqual([]);
  });

  it("MISSING_VARS: a missing or malformed variable exits 2 with no request and the token never printed", async () => {
    for (const name of ["GH_PUBLIC_TOKEN", "GITHUB_REPOSITORY", "UPSTREAM_ISSUE"]) {
      const result = await run(issue(), { [name]: undefined });
      expect(result.code, name).toBe(2);
      expect(result.stderr).toContain(name);
      expect(result.stderr).not.toContain(TOKEN);
    }
    expect((await run(issue(), { GITHUB_REPOSITORY: "nope" })).code).toBe(2);
    expect((await run(issue(), { GH_PUBLIC_TOKEN: "short" })).code).toBe(2);
    expect((await run(issue(), { GH_PUBLIC_TOKEN: "has a space inside it" })).code).toBe(2);
    expect(calls).toEqual([]);
    const noToken = await run(issue(), { GH_PUBLIC_TOKEN: undefined });
    expect(noToken.summary).toContain("Not run");
    expect(noToken.output).toContain("GH_PUBLIC_TOKEN");
  });
});

describe("upstream-issue workflow file", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "upstream-issue.yml"), "utf8");
  const flow = readFileSync(join(ROOT, ".github", "workflows", "issue-flow.yml"), "utf8");
  const relay = readFileSync(join(ROOT, ".github", "workflows", "agent-write.yml"), "utf8");

  it("pins every action by SHA like agent-write.yml, with the same two actions, and asks for nothing beyond contents: read", () => {
    const uses = (source: string) => [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses(text).map((m) => m[1])).toEqual(uses(relay).map((m) => m[1]));
    for (const [, , rest] of uses(text)) expect(rest).toMatch(/# v\d/);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text.match(/^\s+permissions:\n\s+contents: read$/gm)).toHaveLength(1);
    expect(text).not.toMatch(/: (write|admin)\b/);
    expect(text).toMatch(/NODE_VERSION: 24\.22\.0/);
  });

  it("is dispatch only, runs only on main in the agent environment, checks out main and no pull request code", () => {
    expect(text).toMatch(/^on:\n {2}workflow_dispatch:\n {4}inputs:\n {6}issue:\n(?: {8}.*\n)*? {8}required: true\n(?: {8}.*\n)*? {8}type: string\n\npermissions/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|issues|issue_comment):/m);
    expect(text).toMatch(/if: github\.ref == 'refs\/heads\/main'/);
    expect(text).toMatch(/^ {4}environment: agent$/m);
    expect(text).toMatch(/ref: refs\/heads\/main\n\s+persist-credentials: false/);
    expect(text).not.toMatch(/github\.event\.pull_request|head_ref|head\.sha|pull_request_target/);
    expect(text).toMatch(/concurrency:\n {2}group: upstream-issue\n {2}cancel-in-progress: false/);
  });

  it("passes the secret and the input through env only, masks the token before the script, and never writes it anywhere", () => {
    const runBlocks = [...text.matchAll(/ {8}run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1] ?? "");
    expect(runBlocks.length).toBe(2);
    for (const block of runBlocks) expect(block).not.toContain("${{");
    const step = runBlocks.find((block) => block.includes("upstream-issue.mjs")) ?? "";
    expect(step).toContain('echo "::add-mask::$GH_PUBLIC_TOKEN"');
    expect(step.indexOf("::add-mask::")).toBeLessThan(step.indexOf("upstream-issue.mjs"));
    expect(step).not.toMatch(/GITHUB_ENV|set -x|echo "\$GH_PUBLIC_TOKEN"|env\b.*GH_PUBLIC_TOKEN/);
    // The secret appears exactly once, as the step's env value; the input is env too.
    expect(text.match(/secrets\.GH_PUBLIC_TOKEN/g)).toHaveLength(1);
    expect(text).toContain("GH_PUBLIC_TOKEN: ${{ secrets.GH_PUBLIC_TOKEN }}");
    expect(text).toContain("UPSTREAM_ISSUE: ${{ inputs.issue }}");
    expect(text).toContain("GITHUB_TRIGGERING_ACTOR: ${{ github.triggering_actor }}");
    expect(text).toContain("GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}");
    // The step that reports the result never sees the secret.
    const report = text.slice(text.indexOf("name: Report the result"));
    expect(report).not.toContain("GH_PUBLIC_TOKEN");
    expect(report).toContain("RESULT: ${{ steps.file.outputs.result }}");
  });

  it("keeps the same owner list as issue-flow.yml and agent-write.yml", () => {
    const owners = (source: string) => source.match(/^ {2}ISSUE_FLOW_OWNERS: (.+)$/m)?.[1];
    expect(owners(text)).toBeDefined();
    expect(owners(text)).toBe(owners(flow));
    expect(owners(text)).toBe(owners(relay));
  });
});

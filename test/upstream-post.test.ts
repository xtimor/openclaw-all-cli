import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

/**
 * scripts/upstream-post.mjs against a local stub of the GitHub REST API (ticket 3.25): the owner's `upstream:post` label publishes the
 * agent's draft through the code path of scripts/upstream-issue.mjs. Every row of the plan's I/O matrix: what is published, what is
 * refused before anything goes upstream, that the label is removed and a result comment posted in each case, that a replay or a
 * withdrawn label changes nothing, that the guards of tickets 3.23 and 3.24 still apply, and that no token and no draft text reaches a
 * stream, the summary, the output file, or the comment posted back. The script runs in a child process, never spawnSync, since the stub
 * serves from this process. Nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "upstream-post.mjs");
const OURS = "xtimor/openclaw-all-cli";
const TARGET = "openclaw/openclaw";
const TOKEN = "ghp_STUB_PERSONAL_TOKEN_0123456789";
const OUR_TOKEN = "ghs_STUB_WORKFLOW_TOKEN_9876543210";
const OURS_API = `/repos/${OURS}`;
const TITLE_MARK = "TITLE_MARKER_must_not_be_echoed_5521";
const BODY_MARK = "BODY_MARKER_must_not_be_echoed_7731";
const BOT = "openclaw-all-cli-agent[bot]";
const MARKER = `Filed for ${OURS}#45`;
const NOTE_ISSUE = 172969;
const LABELED_AT = "2026-10-29T10:00:00Z";
const EDITED_AT = "2026-10-29T09:00:00Z";
const COMMENT_URL = `https://github.com/${TARGET}/issues/${NOTE_ISSUE}#issuecomment-9001`;
const ISSUE_URL = `https://github.com/${TARGET}/issues/777`;

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

const approval = (login = "xtimor", label = "status:approved") => ({ event: "labeled", label: { name: label }, actor: { login } });
const block = (attributes: string, text: string) => `<!-- upstream-draft ${attributes} -->\n${text}\n<!-- /upstream-draft -->`;
const impl = (draft: string) => `<!-- issue-impl -->\n**Status:** \`status:blocked\`: the draft waits for the owner\n**Waiting for:** @xtimor: review the draft and add upstream:post\n\n${draft}\n\n— implementation agent`;
const botComment = (body: string, overrides: Record<string, unknown> = {}) => ({ id: 3001, user: { login: BOT, type: "Bot" }, body, created_at: "2026-10-29T08:00:00Z", updated_at: EDITED_AT, ...overrides });
const COMMENT_DRAFT = block(`target=${TARGET}#${NOTE_ISSUE} op=comment`, `### Retest\n\n${BODY_MARK}`);
const CREATE_DRAFT = block(`target=${TARGET} op=create`, `Title: Plugin icon is not read ${TITLE_MARK}\n\n### Summary\n\n${BODY_MARK}`);
const ourIssue = (overrides: Record<string, unknown> = {}) => ({ number: 45, title: "Retest the stale reports", body: `Comment on ${TARGET}#${NOTE_ISSUE}.`, labels: [{ name: "status:blocked" }, { name: "upstream:post" }], ...overrides });

function defaults(method: string, path: string): Answer {
  // Our repository: issue 45 is an issue the owner approved, labeled upstream:post, with the agent's draft in its comments.
  if (method === "GET" && path === `${OURS_API}/issues/45`) return [200, ourIssue()];
  if (method === "GET" && path === `${OURS_API}/issues/45/events`) return [200, [approval(), { event: "labeled", label: { name: "type:bug" }, actor: { login: "xtimor" } }]];
  if (method === "GET" && path === `${OURS_API}/issues/45/comments`) return [200, [botComment(impl(COMMENT_DRAFT))]];
  if (method === "POST" && path === `${OURS_API}/issues/45/comments`) return [201, { id: 5001 }];
  if (method === "DELETE" && path === `${OURS_API}/issues/45/labels/upstream:post`) return [200, []];
  // The target: an issue the token's user opened, nothing recent by them.
  if (method === "GET" && path === "/user") return [200, { login: "xtimor" }];
  if (method === "GET" && path === `/repos/${TARGET}/issues/${NOTE_ISSUE}`) return [200, { number: NOTE_ISSUE, user: { login: "xtimor" }, comments: 0 }];
  if (method === "GET" && path === `/repos/${TARGET}/issues/${NOTE_ISSUE}/comments`) return [200, []];
  if (method === "POST" && path === `/repos/${TARGET}/issues/${NOTE_ISSUE}/comments`) return [201, { id: 9001 }];
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
  Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && !key.startsWith("GITHUB_") && !key.startsWith("UPSTREAM_") && !key.startsWith("ISSUE_FLOW") && !/proxy/i.test(key) && !["GH_PUBLIC_TOKEN", "GH_TOKEN", "ISSUE_NUMBER", "LABEL_NAME", "LABELER", "LABELER_TYPE", "LABELED_AT"].includes(key)));

function run(env: Record<string, string | undefined> = {}, identity: string | null = JSON.stringify({ login: BOT })): Promise<Run> {
  const dir = mkdtempSync(join(tmpdir(), "upstream-post-"));
  dirs.push(dir);
  const summaryFile = join(dir, "summary.md");
  const outputFile = join(dir, "output.txt");
  const identityFile = join(dir, "agent-identity.json");
  if (identity !== null) writeFileSync(identityFile, identity);
  const merged: Record<string, string | undefined> = {
    ...stripped(),
    GH_PUBLIC_TOKEN: TOKEN,
    GITHUB_TOKEN: OUR_TOKEN,
    GITHUB_REPOSITORY: OURS,
    GITHUB_ACTOR: "xtimor",
    GITHUB_TRIGGERING_ACTOR: "xtimor",
    GITHUB_RUN_ATTEMPT: "1",
    ISSUE_FLOW_OWNERS: "xtimor",
    ISSUE_NUMBER: "45",
    LABEL_NAME: "upstream:post",
    LABELER: "xtimor",
    LABELER_TYPE: "User",
    LABELED_AT,
    UPSTREAM_POST_IDENTITY_FILE: identityFile,
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
const upstream = () => calls.filter((call) => call.path.startsWith(`/repos/${TARGET}`) || call.path === "/user");
const upstreamWrites = () => writes().filter((call) => call.path.startsWith(`/repos/${TARGET}`));
const ourComments = () => writes().filter((call) => call.method === "POST" && call.path === `${OURS_API}/issues/45/comments`);
const labelRemovals = () => writes().filter((call) => call.method === "DELETE" && call.path === `${OURS_API}/issues/45/labels/upstream:post`);
const posted = () => ourComments().map((call) => String(call.body?.body ?? "")).join("\n---\n");
const everything = (result: Run) => `${result.stdout}\n${result.stderr}\n${result.summary}\n${result.output}\n${posted()}`;
const leaked = (result: Run, extra: string[] = []) => [TOKEN, OUR_TOKEN, TITLE_MARK, BODY_MARK, ...extra].filter((secret) => everything(result).includes(secret));
/** The label is removed and exactly one result comment is posted on our issue; nothing else is written there. */
const settled = () => {
  expect(ourComments()).toHaveLength(1);
  expect(labelRemovals()).toHaveLength(1);
  expect(String(ourComments()[0]?.body?.body).startsWith("<!-- upstream-post -->\n")).toBe(true);
};
const setComments = (...list: unknown[]) => answers.set(`GET ${OURS_API}/issues/45/comments`, [200, list]);

describe("upstream-post: the published path", () => {
  it("COMMENT: the bot's draft is published as one comment by the shared path, the result comment names the URL, the label is removed", async () => {
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(seen()).toEqual([
      `GET ${OURS_API}/issues/45`, // the label is still on the issue
      `GET ${OURS_API}/issues/45/comments`,
      `GET ${OURS_API}/issues/45`, // run() of upstream-issue.mjs: the marker's issue
      `GET ${OURS_API}/issues/45/events`,
      "GET /user",
      `GET /repos/${TARGET}/issues/${NOTE_ISSUE}`,
      `GET /repos/${TARGET}/issues/${NOTE_ISSUE}/comments`,
      `GET /repos/${TARGET}/issues`, // the cap
      `POST /repos/${TARGET}/issues/${NOTE_ISSUE}/comments`,
      `POST ${OURS_API}/issues/45/comments`,
      `DELETE ${OURS_API}/issues/45/labels/upstream:post`,
    ]);
    // The upstream text is the draft's text plus the one marker line, nothing else.
    expect(upstreamWrites()).toHaveLength(1);
    expect(upstreamWrites()[0]?.body).toEqual({ body: `### Retest\n\n${BODY_MARK}\n\n${MARKER}\n` });
    // Each token goes only to its own repository.
    for (const call of calls) expect(call.auth, `${call.method} ${call.path}`).toBe(`Bearer ${call.path.startsWith(OURS_API) ? OUR_TOKEN : TOKEN}`);
    settled();
    const comment = posted();
    expect(comment).toContain(`**Result:** ${COMMENT_URL}`);
    expect(comment).toContain("published as a comment");
    expect(comment).toContain("Requested by @xtimor");
    expect(result.stdout).toContain(`upstream-post: commented ${COMMENT_URL}`);
    expect(result.output).toBe(`result=upstream-post: commented ${COMMENT_URL}\n`);
    expect(result.summary).toContain("Upstream post");
    expect(leaked(result)).toEqual([]);
    for (const line of result.stdout.split("\n").filter(Boolean)) expect(line.startsWith("upstream-post: ")).toBe(true);
  });

  it("CREATE: an op=create draft with a Title line creates one issue; the title and body stay out of every output", async () => {
    setComments(botComment(impl(CREATE_DRAFT)));
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(upstreamWrites()).toHaveLength(1);
    expect(upstreamWrites()[0]?.path).toBe(`/repos/${TARGET}/issues`);
    expect(upstreamWrites()[0]?.body).toEqual({ title: `Plugin icon is not read ${TITLE_MARK}`, body: `### Summary\n\n${BODY_MARK}\n\n${MARKER}\n` });
    settled();
    expect(posted()).toContain(`**Result:** ${ISSUE_URL}`);
    expect(posted()).toContain("published as a new issue");
    expect(result.output).toBe(`result=upstream-post: created ${ISSUE_URL}\n`);
    expect(leaked(result)).toEqual([]);
  });

  it("LATEST: the latest bot <!-- issue-impl --> comment is the draft; an earlier one is not used", async () => {
    const older = botComment(impl(block(`target=${TARGET}#${NOTE_ISSUE} op=comment`, "OLD text")), { id: 1 });
    const newer = botComment(impl(COMMENT_DRAFT), { id: 2 });
    setComments(older, newer);
    expect((await run()).code).toBe(0);
    expect(upstreamWrites()[0]?.body).toEqual({ body: `### Retest\n\n${BODY_MARK}\n\n${MARKER}\n` });
    // If the latest one holds no block, the answer is a refusal; the older block is never reached for.
    calls = [];
    setComments(older, botComment(impl("No draft any more."), { id: 2 }));
    const none = await run();
    expect(none.code).toBe(1);
    expect(posted()).toContain("holds no upstream-draft block");
    expect(upstream()).toEqual([]);
  });

  it("EXISTING: a comment with the same marker line is returned, nothing is posted upstream, the label is still removed", async () => {
    answers.set(`GET /repos/${TARGET}/issues/${NOTE_ISSUE}/comments`, [200, [{ id: 8123, user: { login: "xtimor" }, body: `earlier\n${MARKER}\n` }]]);
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(upstreamWrites()).toEqual([]);
    settled();
    expect(posted()).toContain(`https://github.com/${TARGET}/issues/${NOTE_ISSUE}#issuecomment-8123`);
    expect(posted()).toContain("already published");
    expect(result.output).toContain("upstream-post: existing ");
  });

  it("CRLF: a draft saved with Windows line ends (a web edit) parses the same", async () => {
    setComments(botComment(impl(COMMENT_DRAFT).replace(/\n/g, "\r\n")));
    expect((await run()).code).toBe(0);
    expect(upstreamWrites()[0]?.body).toEqual({ body: `### Retest\n\n${BODY_MARK}\n\n${MARKER}\n` });
  });
});

describe("upstream-post: who may publish", () => {
  const refusedFor = async (env: Record<string, string | undefined>, text: string) => {
    const result = await run(env);
    expect(result.code, JSON.stringify(env)).toBe(1);
    expect(upstream(), JSON.stringify(env)).toEqual([]);
    // The draft is never even read for a labeler who may not publish.
    expect(seen().filter((entry) => entry.endsWith("/comments") && entry.startsWith("GET"))).toEqual([]);
    settled();
    expect(posted()).toContain(text);
    expect(leaked(result)).toEqual([]);
  };

  it("LABELER: a stranger (not in ISSUE_FLOW_OWNERS) is refused, the draft is not read, the label is removed with a reason", async () => {
    await refusedFor({ LABELER: "mallory", GITHUB_ACTOR: "mallory", GITHUB_TRIGGERING_ACTOR: "xtimor" }, "who is not an owner");
    expect(posted()).not.toContain("@mallory");
  });

  it("LABELER: a bot (the agent app, any bot) is refused even if its login were in the owner list", async () => {
    calls = [];
    await refusedFor({ LABELER: BOT, GITHUB_ACTOR: BOT, LABELER_TYPE: "Bot" }, "which is not a person");
    calls = [];
    await refusedFor({ LABELER: "xtimor", LABELER_TYPE: "Bot" }, "which is not a person");
    calls = [];
    await refusedFor({ LABELER: "xtimor[bot]", GITHUB_ACTOR: "xtimor[bot]", ISSUE_FLOW_OWNERS: "xtimor, xtimor[bot]", LABELER_TYPE: "User" }, "which is not a person");
  });

  it("LABELER: the run's actor must be the person who added the label", async () => {
    await refusedFor({ LABELER: "xtimor", GITHUB_ACTOR: "other", ISSUE_FLOW_OWNERS: "xtimor, other" }, "actor is not the person who added the label");
  });

  it("LABELER: the owner list compares ignoring case", async () => {
    expect((await run({ LABELER: "XTimor", GITHUB_ACTOR: "xtimor", GITHUB_TRIGGERING_ACTOR: "xTIMOR" })).code).toBe(0);
  });
});

describe("upstream-post: replay and withdrawal change nothing", () => {
  it("REPLAY: attempt over 1, a triggering actor outside the owners, or no attempt: exit 1, not one write, not one upstream request", async () => {
    for (const env of [{ GITHUB_RUN_ATTEMPT: "2" }, { GITHUB_RUN_ATTEMPT: undefined }, { GITHUB_TRIGGERING_ACTOR: "mallory" }, { GITHUB_TRIGGERING_ACTOR: undefined, GITHUB_RUN_ATTEMPT: "1" }]) {
      calls = [];
      const result = await run(env);
      expect(result.code, JSON.stringify(env)).toBe(1);
      expect(writes(), JSON.stringify(env)).toEqual([]);
      expect(upstream()).toEqual([]);
      expect(result.output).toContain("upstream-post: Refused, nothing changed");
      expect(leaked(result)).toEqual([]);
    }
  });

  it("WITHDRAWN: the label is no longer on the issue (the owner took it off, or this is a late run): nothing is changed", async () => {
    answers.set(`GET ${OURS_API}/issues/45`, [200, ourIssue({ labels: [{ name: "status:blocked" }] })]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(upstream()).toEqual([]);
    expect(result.stderr).toContain("no longer on the issue");
  });

  it("OTHER_LABEL: any label but upstream:post does nothing at all", async () => {
    const result = await run({ LABEL_NAME: "status:blocked" });
    expect(result.code).toBe(0);
    expect(calls).toEqual([]);
  });

  it("NOT_AN_ISSUE: our issue number that is a pull request changes nothing", async () => {
    answers.set(`GET ${OURS_API}/issues/45`, [200, ourIssue({ pull_request: { url: "x" } })]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(upstream()).toEqual([]);
  });

  it("OURS_UNREADABLE: a failing read of our issue changes nothing and says so", async () => {
    answers.set(`GET ${OURS_API}/issues/45`, [500, { message: `boom ${OUR_TOKEN}` }]);
    const result = await run();
    expect(result.code).toBe(1);
    expect(writes()).toEqual([]);
    expect(result.stderr).toContain("GitHub answered 500");
    expect(leaked(result)).toEqual([]);
  });

  it("CONFIG: a missing or malformed variable exits 2 and sends nothing", async () => {
    for (const env of [{ ISSUE_NUMBER: undefined }, { ISSUE_NUMBER: "0" }, { ISSUE_NUMBER: "4x" }, { LABELER: undefined }, { LABELER_TYPE: undefined }, { LABELED_AT: undefined }, { GITHUB_TOKEN: undefined }, { GITHUB_TOKEN: "x" }, { GITHUB_REPOSITORY: "nope" }, { LABEL_NAME: undefined }]) {
      calls = [];
      const result = await run(env);
      expect(result.code, JSON.stringify(env)).toBe(2);
      expect(calls, JSON.stringify(env)).toEqual([]);
    }
  });
});

describe("upstream-post: the draft", () => {
  const refusedDraft = async (comments: unknown[], text: string, env: Record<string, string | undefined> = {}, identity?: string | null) => {
    calls = [];
    setComments(...comments);
    const result = await run(env, identity);
    expect(result.code, text).toBe(1);
    expect(upstreamWrites(), text).toEqual([]);
    expect(upstream(), text).toEqual([]);
    settled();
    expect(posted(), text).toContain(text);
    expect(posted()).toContain("Fix the cause, then add it again");
    expect(leaked(result)).toEqual([]);
  };

  it("PARSER: no block, two blocks, a half-open or malformed tag, a wrong attribute, a wrong op or target, an empty or title-less draft are refused before any upstream request", async () => {
    const wrap = (draft: string) => [botComment(impl(draft))];
    const cases: [string, string][] = [
      ["No draft here.", "holds no upstream-draft block"],
      [`${COMMENT_DRAFT}\n\n${COMMENT_DRAFT}`, "2 opening and 2 closing"],
      [`<!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} op=comment -->\ntext`, "1 opening and 0 closing"],
      ["text\n<!-- /upstream-draft -->", "0 opening and 1 closing"],
      [`<!-- /upstream-draft -->\n<!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} op=comment -->\ntext`, "comes before the opening"],
      [`<!--upstream-draft target=${TARGET}#${NOTE_ISSUE} op=comment-->\ntext\n<!-- /upstream-draft -->`, "not exactly a draft tag"],
      [`see <!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} op=comment --> inline\ntext\n<!-- /upstream-draft -->`, "not exactly a draft tag"],
      [`<!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} -->\ntext\n<!-- /upstream-draft -->`, "exactly target=<repo or repo#n> and op="],
      [`<!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} op=comment extra=1 -->\ntext\n<!-- /upstream-draft -->`, "exactly target=<repo or repo#n> and op="],
      [`<!-- upstream-draft target=${TARGET}#${NOTE_ISSUE} target=${TARGET}#1 op=comment -->\ntext\n<!-- /upstream-draft -->`, "exactly target=<repo or repo#n> and op="],
      [block(`target=${TARGET}#${NOTE_ISSUE} op=edit`, "text"), 'op must be "comment" or "create"'],
      [block(`target=${TARGET} op=comment`, "text"), "op=comment needs target=<repo>#<issue number>"],
      [block(`target=${TARGET}#0 op=comment`, "text"), "op=comment needs target=<repo>#<issue number>"],
      [block(`target=${TARGET}#${NOTE_ISSUE} op=create`, "Title: x\n\nbody"), "op=create needs target=<repo> with no issue number"],
      [block(`target=${TARGET} op=create`, "No title line\n\nbody"), "first line 'Title: <one line>'"],
      [block(`target=${TARGET} op=create`, "Title: only a title"), "a title but no body"],
      [block(`target=${TARGET}#${NOTE_ISSUE} op=comment`, "   \n  "), "the draft is empty"],
    ];
    for (const [draft, text] of cases) await refusedDraft(wrap(draft), text);
  });

  it("REPOSITORY: a target outside the allow-list is refused by the shared path (nothing upstream)", async () => {
    await refusedDraft([botComment(impl(block(`target=evil/repo#5 op=comment`, "text")))], "repo is not allowed");
    await refusedDraft([botComment(impl(block(`target=evil/repo op=create`, "Title: t\n\nbody")))], "repo is not allowed");
  });

  it("OWN_MARKER: a draft that carries its own Filed for line is refused (exactly one line, the workflow's)", async () => {
    await refusedDraft([botComment(impl(block(`target=${TARGET}#${NOTE_ISSUE} op=comment`, `text\n\nFiled for ${OURS}#46`)))], "exactly one line");
  });

  it("AUTHOR: a block in a comment by someone else is ignored, even with the marker and the owner's login; a User named like the bot is not the bot", async () => {
    const block1 = impl(COMMENT_DRAFT);
    await refusedDraft([{ id: 1, user: { login: "mallory", type: "User" }, body: block1, updated_at: EDITED_AT }], "no <!-- issue-impl --> comment by");
    await refusedDraft([{ id: 1, user: { login: "xtimor", type: "User" }, body: block1, updated_at: EDITED_AT }], "no <!-- issue-impl --> comment by");
    await refusedDraft([{ id: 1, user: { login: BOT, type: "User" }, body: block1, updated_at: EDITED_AT }], "no <!-- issue-impl --> comment by");
    await refusedDraft([botComment(block1, { user: { login: "other-agent[bot]", type: "Bot" } })], "no <!-- issue-impl --> comment by");
    // A bot comment that is not an implementation comment (a triage comment) is not the draft either.
    await refusedDraft([botComment(`<!-- issue-triage -->\n${COMMENT_DRAFT}`)], "no <!-- issue-impl --> comment by");
    await refusedDraft([botComment(`**Status:** x\n<!-- issue-impl -->\n${COMMENT_DRAFT}`)], "no <!-- issue-impl --> comment by");
    // A stranger's later comment does not replace the bot's draft.
    setComments(botComment(block1), { id: 9, user: { login: "mallory", type: "User" }, body: `<!-- issue-impl -->\n${block(`target=${TARGET}#999 op=comment`, "evil")}`, updated_at: EDITED_AT });
    calls = [];
    expect((await run()).code).toBe(0);
    expect(upstreamWrites()[0]?.body).toEqual({ body: `### Retest\n\n${BODY_MARK}\n\n${MARKER}\n` });
  });

  it("EDITED_AFTER_LABEL: a draft edited after the label was added is refused; the same second passes", async () => {
    await refusedDraft([botComment(impl(COMMENT_DRAFT), { updated_at: "2026-10-29T10:00:01Z" })], "edited after the label was added");
    await refusedDraft([botComment(impl(COMMENT_DRAFT), { updated_at: undefined })], "no readable edit time");
    await refusedDraft([botComment(impl(COMMENT_DRAFT), { updated_at: "not a date" })], "no readable edit time");
    await refusedDraft([botComment(impl(COMMENT_DRAFT))], "the time the label was added could not be read", { LABELED_AT: "yesterday" });
    setComments(botComment(impl(COMMENT_DRAFT), { updated_at: LABELED_AT }));
    calls = [];
    expect((await run()).code).toBe(0);
  });

  it("IDENTITY: without an agent app login in .github/agent-identity.json (no file, no login, a login that is not a bot) nothing is trusted", async () => {
    for (const identity of [null, "{}", JSON.stringify({ login: "xtimor" }), JSON.stringify({ login: "" }), "not json", JSON.stringify({ login: `${BOT}\nx` })]) {
      await refusedDraft([botComment(impl(COMMENT_DRAFT))], "no agent app is configured", {}, identity);
    }
  });

  it("IDENTITY: the default identity file is the repository's own", () => {
    const login = (JSON.parse(readFileSync(join(ROOT, ".github", "agent-identity.json"), "utf8")) as { login: string }).login;
    expect(login).toMatch(/\[bot\]$/);
  });

  it("PAGES: the draft is found on page 2 of a long comment list; 20 full pages refuse", async () => {
    const filler = Array.from({ length: 100 }, (_, i) => ({ id: i + 100, user: { login: "someone", type: "User" }, body: "chatter", updated_at: EDITED_AT }));
    answers.set(`GET ${OURS_API}/issues/45/comments?page=1`, [200, filler]);
    answers.set(`GET ${OURS_API}/issues/45/comments?page=2`, [200, [botComment(impl(COMMENT_DRAFT))]]);
    expect((await run()).code).toBe(0);
    calls = [];
    answers = new Map();
    for (let page = 1; page <= 20; page++) answers.set(`GET ${OURS_API}/issues/45/comments?page=${page}`, [200, filler]);
    const many = await run();
    expect(many.code).toBe(1);
    expect(posted()).toContain("more than 2000 comments");
    expect(upstream()).toEqual([]);
  });
});

describe("upstream-post: the guards of tickets 3.23 and 3.24 still apply (same code path)", () => {
  const refused = async (text: string, env: Record<string, string | undefined> = {}) => {
    const result = await run(env);
    expect(result.code, text).toBe(1);
    expect(upstreamWrites(), text).toEqual([]);
    settled();
    expect(posted(), text).toContain(text);
    expect(leaked(result)).toEqual([]);
    return result;
  };

  it("APPROVAL: an issue of ours that no owner approved publishes nothing", async () => {
    answers.set(`GET ${OURS_API}/issues/45/events`, [200, [approval("mallory"), approval("xtimor", "status:triaged")]]);
    await refused("has no status:approved label set by an owner");
    expect(upstream()).toEqual([]);
  });

  it("NAMES_TARGET: a comment on an issue that the approved issue does not name is refused", async () => {
    answers.set(`GET ${OURS_API}/issues/45`, [200, ourIssue({ body: `Mentions ${TARGET}#1729 only.` })]);
    await refused("does not name");
  });

  it("OWN_ISSUE: a comment on someone else's issue, or a pull request, is refused", async () => {
    answers.set(`GET /repos/${TARGET}/issues/${NOTE_ISSUE}`, [200, { number: NOTE_ISSUE, user: { login: "stranger" } }]);
    await refused("was not opened by the token's user");
    calls = [];
    answers.set(`GET /repos/${TARGET}/issues/${NOTE_ISSUE}`, [200, { number: NOTE_ISSUE, user: { login: "xtimor" }, pull_request: { url: "x" } }]);
    await refused("is a pull request");
    calls = [];
    answers.set(`GET /repos/${TARGET}/issues/${NOTE_ISSUE}`, [404, { message: "Not Found" }]);
    await refused("does not exist");
  });

  it("CAP: five recent comments by the token's user refuse the sixth; three recent issues refuse a new one", async () => {
    const recent = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    answers.set(`GET /repos/${TARGET}/issues`, [200, [{ number: 5, comments: 5, created_at: recent, title: "own" }]]);
    answers.set(`GET /repos/${TARGET}/issues/5/comments`, [200, Array.from({ length: 5 }, (_, i) => ({ id: i + 1, user: { login: "xtimor" }, created_at: recent, body: "x" }))]);
    await refused("comments by the token's user were posted");
    calls = [];
    setComments(botComment(impl(CREATE_DRAFT)));
    answers.set(`GET /repos/${TARGET}/issues`, [200, Array.from({ length: 3 }, (_, i) => ({ number: 10 + i, title: `t${i}`, body: "", created_at: recent }))]);
    await refused("issues by the token's user were created");
  });

  it("IDEMPOTENT_CREATE: an owner's issue with the same marker is returned instead of a duplicate", async () => {
    setComments(botComment(impl(CREATE_DRAFT)));
    answers.set(`GET /repos/${TARGET}/issues`, [200, [{ number: 12, title: "other title", body: `x\n${MARKER}\n` }]]);
    const result = await run();
    expect(result.code, result.stderr).toBe(0);
    expect(upstreamWrites()).toEqual([]);
    settled();
    expect(posted()).toContain(`https://github.com/${TARGET}/issues/12`);
  });

  it("SHARED_PATH: the script reuses run() of upstream-issue.mjs and defines no guard of its own", () => {
    const text = readFileSync(SCRIPT, "utf8");
    expect(text).toContain('import { run as runUpstream } from "./upstream-issue.mjs";');
    expect(text).toMatch(/await runUpstream\(\{ \.\.\.env, UPSTREAM_ISSUE: JSON\.stringify\(input\) \}, log, now\)/);
    for (const name of ["checkApproved", "checkNamesTarget", "checkTarget", "findExisting", "findExistingComment", "countRecentComments", "DAILY_CAP", "COMMENT_CAP", "ALLOWED_REPOS", "POST /repos"]) expect(text, name).not.toContain(name);
    // The only write upstream is the one inside runUpstream; this script writes to its own repository only.
    expect([...text.matchAll(/ours\.rest\("(POST|DELETE)"/g)].map((match) => match[1])).toEqual(["POST", "DELETE"]);
    expect(text).not.toMatch(/theirs\.rest|client\.rest/);
  });
});

describe("upstream-post: failures and secrets", () => {
  it("UPSTREAM_FAILS: a failing upstream write is reported with the status only, the token redacted, the label removed", async () => {
    answers.set(`POST /repos/${TARGET}/issues/${NOTE_ISSUE}/comments`, [403, { message: `forbidden ${TOKEN}` }]);
    const result = await run();
    expect(result.code).toBe(1);
    settled();
    expect(posted()).toContain("Failed while commenting");
    expect(posted()).toContain("GitHub answered 403");
    expect(posted()).toContain("[redacted]");
    expect(result.output).toContain("upstream-post: Failed while commenting");
    expect(leaked(result)).toEqual([]);
  });

  it("NO_PUBLIC_TOKEN: a missing GH_PUBLIC_TOKEN publishes nothing and says which variable, in the comment on our issue", async () => {
    const result = await run({ GH_PUBLIC_TOKEN: undefined });
    expect(result.code).toBe(1);
    expect(upstream()).toEqual([]);
    settled();
    expect(posted()).toContain("missing environment variable: GH_PUBLIC_TOKEN");
    expect(leaked(result)).toEqual([]);
  });

  it("WRITE_BACK: a failing result comment or label removal is reported, the other still happens, and a published item is still named in the log", async () => {
    answers.set(`POST ${OURS_API}/issues/45/comments`, [403, { message: `no ${OUR_TOKEN}` }]);
    const noComment = await run();
    expect(noComment.code).toBe(1);
    expect(labelRemovals()).toHaveLength(1);
    expect(noComment.stderr).toContain("the result comment could not be posted");
    expect(noComment.stdout + noComment.stderr).toContain(COMMENT_URL.replace("#issuecomment-9001", ""));
    expect(leaked(noComment)).toEqual([]);

    calls = [];
    answers = new Map([[`DELETE ${OURS_API}/issues/45/labels/upstream:post`, [500, { message: "boom" }]]]);
    const noLabel = await run();
    expect(noLabel.code).toBe(1);
    expect(ourComments()).toHaveLength(1);
    expect(noLabel.stderr).toContain("the label could not be removed");

    // A label that is already gone (404) is fine.
    calls = [];
    answers = new Map([[`DELETE ${OURS_API}/issues/45/labels/upstream:post`, [404, { message: "Label does not exist" }]]]);
    expect((await run()).code).toBe(0);
  });

  it("LOG_LINES: API text with newlines or a workflow command cannot fake a line, in the log or in the output", async () => {
    answers.set(`GET ${OURS_API}/issues/45/events`, [401, { message: "line one\n::set-output name=x::y\r\n::error::fake" }]);
    const result = await run();
    expect(result.code).toBe(1);
    for (const line of `${result.stdout}${result.stderr}`.split("\n").filter(Boolean)) expect(line.startsWith("upstream-post: ")).toBe(true);
    expect(result.output.trimEnd().split("\n")).toHaveLength(1);
  });

  it("COMMENT_TEXT: the result comment is built from our own words: a reason with backticks, line breaks, or mentions stays one inert code span", async () => {
    // The reason of a refusal can carry the labeler's login; a hostile login never gets that far, but the comment still has one reason line.
    const result = await run({ LABELER: "mal`lory\n@all", GITHUB_ACTOR: "mal`lory\n@all" });
    expect(result.code).toBe(1);
    const comment = posted();
    expect(comment).not.toContain("@all");
    expect(comment).not.toContain("@mal");
    expect(comment.split("\n").filter((line) => line.startsWith("**Reason:**"))).toHaveLength(1);
    expect(comment).toContain("an unreadable login");
  });
});

describe("upstream-post: the parser (unit)", () => {
  it("parses the exact formats of the docs", async () => {
    const mod = (await import(pathToFileURL(SCRIPT).href)) as { parseDraft: (text: string) => Record<string, unknown> };
    expect(mod.parseDraft("intro\n<!-- upstream-draft target=openclaw/openclaw#172969 op=comment -->\n\nHello\n\nworld\n\n<!-- /upstream-draft -->\ntrailer")).toEqual({ op: "comment", repo: "openclaw/openclaw", issue: 172969, body: "Hello\n\nworld" });
    expect(mod.parseDraft("<!-- upstream-draft op=create target=openclaw/openclaw -->\nTitle:   A title \n\n### Summary\n\ntext\n<!-- /upstream-draft -->")).toEqual({ op: "create", repo: "openclaw/openclaw", title: "A title", body: "### Summary\n\ntext" });
    expect(() => mod.parseDraft(undefined as unknown as string)).toThrow("no upstream-draft block");
  });
});

describe("upstream-post workflow file", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "upstream-post.yml"), "utf8");
  const dispatch = readFileSync(join(ROOT, ".github", "workflows", "upstream-issue.yml"), "utf8");
  const flow = readFileSync(join(ROOT, ".github", "workflows", "issue-flow.yml"), "utf8");
  const relay = readFileSync(join(ROOT, ".github", "workflows", "agent-write.yml"), "utf8");
  const runBlocks = [...text.matchAll(/ {8}run: \|\n((?: {10}.*\n?)+)/g)].map((m) => m[1] ?? "");

  it("runs on the label event only, filtered to upstream:post in the job and on main, in the agent environment", () => {
    expect(text).toMatch(/^on:\n {2}issues:\n {4}types: \[labeled\]\n\npermissions/m);
    expect(text).not.toMatch(/^ {2}(push|pull_request|pull_request_target|schedule|workflow_run|workflow_dispatch|issue_comment|unlabeled):/m);
    expect(text).toMatch(/^ {4}if: github\.ref == 'refs\/heads\/main' && github\.event\.label\.name == 'upstream:post'$/m);
    expect(text).toMatch(/^ {4}environment: agent$/m);
    expect(text).toMatch(/ref: refs\/heads\/main\n\s+persist-credentials: false/);
    expect(text).not.toMatch(/github\.event\.pull_request|head_ref|head\.sha|pull_request_target/);
  });

  it("pins the actions like upstream-issue.yml and asks for contents: read and issues: write on the job only", () => {
    const uses = (source: string) => [...source.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses(text).map((m) => m[1])).toEqual(uses(dispatch).map((m) => m[1]));
    expect(uses(text).map((m) => m[1])).toEqual(uses(relay).map((m) => m[1]));
    for (const [, , rest] of uses(text)) expect(rest).toMatch(/# v\d/);
    expect(text).toMatch(/^permissions: \{\}$/m);
    expect(text.match(/^\s+permissions:\n\s+contents: read\n\s+issues: write$/gm)).toHaveLength(1);
    expect(text.match(/: (write|admin)\b/g)).toEqual([": write"]);
    expect(text).toMatch(/NODE_VERSION: 24\.22\.0/);
  });

  it("shares the concurrency group of the dispatch workflow, under the main condition, without cancelling", () => {
    expect(text).not.toMatch(/^concurrency:/m);
    expect(text).toMatch(/^ {4}concurrency:\n {6}group: upstream-issue\n {6}cancel-in-progress: false$/m);
    expect(dispatch).toMatch(/^ {4}concurrency:\n {6}group: upstream-issue\n {6}cancel-in-progress: false$/m);
  });

  it("passes every event field and both tokens through env only, masks the owner's token before the script, and never writes it anywhere", () => {
    expect(runBlocks.length).toBe(2);
    for (const block of runBlocks) expect(block).not.toContain("${{");
    const step = runBlocks.find((block) => block.includes("upstream-post.mjs")) ?? "";
    expect(step).toContain('echo "::add-mask::$GH_PUBLIC_TOKEN"');
    expect(step.indexOf("::add-mask::")).toBeLessThan(step.indexOf("upstream-post.mjs"));
    expect(step).not.toMatch(/GITHUB_ENV|set -x|echo "\$GH_PUBLIC_TOKEN"|env\b.*GH_PUBLIC_TOKEN/);
    expect(text.match(/secrets\.GH_PUBLIC_TOKEN/g)).toHaveLength(1);
    for (const line of [
      "GH_PUBLIC_TOKEN: ${{ secrets.GH_PUBLIC_TOKEN }}",
      "GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}",
      "GITHUB_TRIGGERING_ACTOR: ${{ github.triggering_actor }}",
      "GITHUB_RUN_ATTEMPT: ${{ github.run_attempt }}",
      "ISSUE_NUMBER: ${{ github.event.issue.number }}",
      "LABEL_NAME: ${{ github.event.label.name }}",
      "LABELER: ${{ github.event.sender.login }}",
      "LABELER_TYPE: ${{ github.event.sender.type }}",
      "LABELED_AT: ${{ github.event.issue.updated_at }}",
    ]) expect(text).toContain(line);
    // Text an outsider writes never enters the workflow: not the issue's title or body, no comment, no PR field.
    expect(text).not.toMatch(/github\.event\.(issue\.(title|body|user|labels)|comment|pull_request|head_commit)/);
    const report = text.slice(text.indexOf("name: Report the result"));
    expect(report).not.toContain("GH_PUBLIC_TOKEN");
    expect(report).not.toContain("GITHUB_TOKEN");
    expect(report).toContain("RESULT: ${{ steps.post.outputs.result }}");
  });

  it("keeps the same owner list as issue-flow.yml, agent-write.yml, and the dispatch workflow", () => {
    const owners = (source: string) => source.match(/^ {2}ISSUE_FLOW_OWNERS: (.+)$/m)?.[1];
    expect(owners(text)).toBeDefined();
    for (const other of [flow, relay, dispatch]) expect(owners(text)).toBe(owners(other));
  });

  it("the report step escapes % before it echoes, so a result cannot inject a line break or a command into the annotation", () => {
    const report = text.slice(text.indexOf("name: Report the result"));
    const block = report.match(/ {8}run: \|\n((?: {10}.*\n?)+)/)?.[1] ?? "";
    expect(block.indexOf('RESULT="${RESULT//%/%25}"')).toBeGreaterThanOrEqual(0);
    expect(block.indexOf('RESULT="${RESULT//%/%25}"')).toBeLessThan(block.indexOf("echo "));
    const hostile = "upstream-post: x%0A::error::injected %0D %25 100%";
    const ran = spawnSync("bash", ["-c", block], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", RESULT: hostile, OUTCOME: "failure" } });
    expect(ran.status).toBe(0);
    expect(ran.stdout).toBe("::error title=Upstream post::upstream-post: x%250A::error::injected %250D %2525 100%25\n");
    const ok = spawnSync("bash", ["-c", block], { encoding: "utf8", env: { PATH: process.env.PATH ?? "", RESULT: `upstream-post: created ${ISSUE_URL}`, OUTCOME: "success" } });
    expect(ok.stdout).toBe(`::notice title=Upstream post::upstream-post: created ${ISSUE_URL}\n`);
  });

  it("masks the token only when it is set, so a missing secret reaches the script (which says so on the issue)", () => {
    const step = runBlocks.find((block) => block.includes("upstream-post.mjs")) ?? "";
    expect(step).toMatch(/if \[ -n "\$GH_PUBLIC_TOKEN" \]; then\n\s+echo "::add-mask::\$GH_PUBLIC_TOKEN"\n\s+fi/);
    expect(step).not.toMatch(/exit 1/);
  });
});

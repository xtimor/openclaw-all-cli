#!/usr/bin/env node
// Applies a list of GitHub write operations as the issue agents' GitHub App (`<app-slug>[bot]`). It runs inside the
// `Agent write` workflow (.github/workflows/agent-write.yml): the session proxy swaps the owner's credentials into every
// api.github.com request, so an agent in a session cannot write as the app itself; it dispatches this workflow instead.
// Agent-neutral and dependency-free (Node standard library, global `fetch`). Design: docs/agents/identity.md.
//
//   AGENT_WRITE_OPS='[{"op":"comment","issue":12,"body":"..."}]' GH_TOKEN=<app token> AGENT_LOGIN='x[bot]' \
//     GITHUB_REPOSITORY=owner/repo GITHUB_ACTOR=<dispatcher> ISSUE_FLOW_OWNERS=owner node scripts/agent-write.mjs
//
// Operations (JSON array, at most 50, the whole input at most 60 000 characters), applied in order:
//   {op:"comment", issue, body}                            new comment on an issue or pull request
//   {op:"edit_comment", comment_id, body}                  only a comment whose author is AGENT_LOGIN
//   {op:"labels", issue, add?:[...], remove?:[...]}        names like status:x, type:x, priority:x, source:x only; add first, then remove
//                                                          (a label that is not there is fine); never add `status:approved` or `status:rework` (the owner's, by their own click) or
//                                                          `status:upstream` (the `Upstream post` workflow's); no `status:` name that is not in STATUS_LABELS (a typo, or a retired status name); no name in both lists
//   {op:"close", issue, reason}                            only a security report: reason not_planned, and SECURITY_CLOSE_COMMENT is posted on that issue by
//                                                          an earlier `comment` of the same list (agents never close an issue otherwise, see closeGuard); an issue, never a pull request
//   {op:"reopen", issue}                                   an issue, never a pull request
//   {op:"pr_create", head, title, body?, draft?}           head must be a `claude/` branch of this repository; base is main
//   {op:"pr_ready", pr}                                    only a pull request by AGENT_LOGIN
//   {op:"pr_edit", pr, title?, body?}                      only a pull request by AGENT_LOGIN
//   {op:"merge", pr, sha}                                  method merge; see checkMergeable and checkGreen; refused while a linked issue is in `status:rework` (checkNotSentBack)
//   {op:"pr_close", pr}                                    closes only an open draft titled `Issue batch (in progress)` by AGENT_LOGIN from a `claude/` branch of this repository,
//                                                          not updated for 2 hours (runs refresh their draft at least every 30 minutes), and only when its
//                                                          branch holds no built ticket (a plan at `done`/`built`) or another open batch PR of the app
//                                                          already contains its head (the work is resumed there, never lost: see builtPlans and requireCarried).
//                                                          A READY batch (title starts with `Issue batch`) is closed only when `Batch merge` holds it because a linked issue is in `status:rework`
//                                                          (checkClosableHeld) and another open batch PR of the app contains its head (always required); the run resumes it on its own branch.
//                                                          Every pr_close target is read and checked (idle, author, title, built work) before ANY operation of the list is applied: the
//                                                          comment and pr_edit that precede it in the same list refresh `updated_at`, which would otherwise make the idle check fail.
// Everything is validated first; nothing is applied when anything is refused. Applying stops at the first failure.
//
// Environment: AGENT_WRITE_OPS, GH_TOKEN (the app's installation token), GITHUB_REPOSITORY, GITHUB_ACTOR (the dispatcher),
// GITHUB_TRIGGERING_ACTOR (who started this run; differs from the actor on a re-run), GITHUB_RUN_ATTEMPT (must be "1": no
// replays), ISSUE_FLOW_OWNERS (comma separated logins allowed to dispatch; both actors must be in it), AGENT_LOGIN (`<app-slug>[bot]`), GITHUB_API_URL (default
// https://api.github.com), GITHUB_GRAPHQL_URL (default `<GITHUB_API_URL>/graphql`), GITHUB_STEP_SUMMARY (the Markdown summary).
//
// The token is never printed: every message goes through `clean`. The summary never holds a body. Every printed field is
// one line and every line starts with `agent-write:`, so no text can fake a log line or a workflow command. Exit 0 ok; 1
// refused or failed; 2 a variable is missing or malformed.
import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { REWORK, STATUS_LABELS, linkedIssues, parseOwners } from "./issue-flow/transitions.mjs";
import { planStatus } from "./plan-gate.mjs";

const DEFAULT_API = "https://api.github.com";
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_OPS = 50;
const MAX_INPUT = 60_000;
const MAX_MESSAGE = 300;
const HEAD_PREFIX = "claude/";
const BATCH_TITLE = "Issue batch";
const CLAIM_TITLE = "Issue batch (in progress)"; // a run's draft before it finishes; an owner-paused batch has another title
const BASE_BRANCH = "main";
const IDLE_MS = 2 * 60 * 60 * 1000; // a draft batch PR untouched this long counts as interrupted
const PLAN_PATH = /^_bmad-output\/.+-plan\.md$/; // a ticket's plan; its frontmatter `status` is the ticket's status of record
const BUILT_STATUSES = new Set(["done", "built"]);
const MAX_FILE_PAGES = 30; // GitHub lists at most 3000 files of a pull request
const MAX_PLAN_READS = 100;
const MAX_CARRIERS = 10; // other open batch PRs compared with an idle draft
const CLOSE_REASON = "not_planned";
/**
 * The agents never close an issue (owner decision 2026-10-28): they set `status:declined` or `status:needs-info` and the owner
 * decides. The one exception is a security report, closed at once with a pointer to SECURITY.md and no detail. The relay cannot
 * know that an issue is one, so the marker is this exact comment: a `close` is allowed only when an earlier `comment` of the same
 * list posted it, word for word, on the same issue. It leaves no room for detail, and it says in public why the issue was closed.
 * docs/agents/triage.md carries the same text (a test compares them).
 */
export const SECURITY_CLOSE_COMMENT = [
  "<!-- issue-triage -->",
  "**Status:** closed (not planned)",
  "**Waiting for:** nothing",
  "**Next:** report security issues privately as described in SECURITY.md; the owner can reopen this issue if it is not one",
  "**What happened:** the report looks like a security issue, so it is closed without discussion here.",
  "",
  "— triage agent",
].join("\n");
// The owner's own click starts agent work: approving an issue, or sending its result back with comments (ticket 3.28). Removing them is fine.
const OWNER_ONLY_LABELS = ["status:approved", "status:rework"];
// Set only by the `Upstream post` workflow, after it published a draft (ticket 3.26): an agent cannot know that it happened. Removing it is fine.
const WORKFLOW_ONLY_LABEL = "status:upstream";
// Only the project's own label families: a typo or a lookalike never creates a label, and "." or ".." never reaches a URL.
const LABEL_RE = /^(status|type|priority|source):[a-z0-9-]{1,40}$/;
const OP_KEYS = {
  comment: { required: ["issue", "body"], optional: [] },
  edit_comment: { required: ["comment_id", "body"], optional: [] },
  labels: { required: ["issue"], optional: ["add", "remove"] },
  close: { required: ["issue", "reason"], optional: [] },
  reopen: { required: ["issue"], optional: [] },
  pr_create: { required: ["head", "title"], optional: ["body", "draft"] },
  pr_ready: { required: ["pr"], optional: [] },
  pr_edit: { required: ["pr"], optional: ["title", "body"] },
  merge: { required: ["pr", "sha"], optional: [] },
  pr_close: { required: ["pr"], optional: [] },
};

/** A failure with an exit code and a message that is safe to print. `refused`: a guard said no (nothing sent for it). */
export class WriteError extends Error {
  constructor(message, { code = 1, refused = false } = {}) {
    super(message);
    this.code = code;
    this.refused = refused;
  }
}

const refuse = (message) => new WriteError(message, { refused: true });
export const lower = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isId = (value) => Number.isSafeInteger(value) && value > 0;
const isText = (value) => typeof value === "string" && value.trim() !== "";

function readConfig(env) {
  const missing = ["AGENT_WRITE_OPS", "GH_TOKEN", "GITHUB_REPOSITORY", "AGENT_LOGIN"].filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
  if (missing.length > 0) throw new WriteError(`missing environment variable: ${missing.join(", ")}`, { code: 2 });
  const repo = env.GITHUB_REPOSITORY.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new WriteError("GITHUB_REPOSITORY must look like owner/repo", { code: 2 });
  const login = env.AGENT_LOGIN.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(login)) throw new WriteError("AGENT_LOGIN must look like <app-slug>[bot]", { code: 2 });
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");
  const graphql = (env.GITHUB_GRAPHQL_URL ?? "").trim() || `${api}/graphql`;
  return {
    opsText: env.AGENT_WRITE_OPS,
    token: env.GH_TOKEN.trim(),
    repo,
    login,
    api,
    graphql,
    actor: env.GITHUB_ACTOR ?? "",
    triggering: env.GITHUB_TRIGGERING_ACTOR ?? "",
    attempt: (env.GITHUB_RUN_ATTEMPT ?? "").trim(),
    owners: parseOwners(env.ISSUE_FLOW_OWNERS ?? ""),
  };
}

// ---- validation (pure; no request) ----

function checkKeys(op, index) {
  const spec = OP_KEYS[op.op];
  const allowed = new Set(["op", ...spec.required, ...spec.optional]);
  const unknown = Object.keys(op).filter((key) => !allowed.has(key));
  if (unknown.length > 0) throw refuse(`operation ${index} (${op.op}): unknown field ${unknown.join(", ")}`);
  const absent = spec.required.filter((key) => op[key] === undefined);
  if (absent.length > 0) throw refuse(`operation ${index} (${op.op}): missing field ${absent.join(", ")}`);
}

function labelList(op, key, index) {
  const value = op[key];
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 20) throw refuse(`operation ${index} (labels): ${key} must be a list of at most 20 labels`);
  for (const entry of value) {
    if (typeof entry !== "string" || !LABEL_RE.test(entry)) throw refuse(`operation ${index} (labels): ${key} may hold only status:, type:, priority:, or source: labels (lowercase)`);
  }
  return [...new Set(value)];
}

/** Parses and checks the whole input. Returns normalized operations or throws a refusal; sends nothing. */
export function validate(text) {
  if (text.length > MAX_INPUT) throw refuse(`the input is ${text.length} characters; the limit is ${MAX_INPUT}`);
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw refuse("the input is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.length === 0) throw refuse("the input must be a non-empty JSON array of operations");
  if (parsed.length > MAX_OPS) throw refuse(`${parsed.length} operations; the limit is ${MAX_OPS}`);
  const securityPointers = new Set(); // issues that an earlier comment of this list gave the SECURITY_CLOSE_COMMENT
  return parsed.map((raw, i) => {
    const index = i + 1;
    if (!isObject(raw) || typeof raw.op !== "string") throw refuse(`operation ${index}: not an object with an "op"`);
    if (!Object.hasOwn(OP_KEYS, raw.op)) throw refuse(`operation ${index}: unknown op ${JSON.stringify(raw.op.slice(0, 40))}`);
    checkKeys(raw, index);
    const where = `operation ${index} (${raw.op})`;
    switch (raw.op) {
      case "comment":
        if (!isId(raw.issue)) throw refuse(`${where}: issue must be a positive integer`);
        if (!isText(raw.body)) throw refuse(`${where}: body must be a non-empty string`);
        if (raw.body.trim() === SECURITY_CLOSE_COMMENT) securityPointers.add(raw.issue);
        return { op: "comment", issue: raw.issue, body: raw.body };
      case "edit_comment":
        if (!isId(raw.comment_id)) throw refuse(`${where}: comment_id must be a positive integer`);
        if (!isText(raw.body)) throw refuse(`${where}: body must be a non-empty string`);
        return { op: "edit_comment", commentId: raw.comment_id, body: raw.body };
      case "labels": {
        if (!isId(raw.issue)) throw refuse(`${where}: issue must be a positive integer`);
        const add = labelList(raw, "add", index);
        const remove = labelList(raw, "remove", index);
        if (add.length + remove.length === 0) throw refuse(`${where}: add or remove must name a label`);
        // A `status:` name that is not a status of .github/labels.yml (a typo, or a retired one such as the old name of todo) would make GitHub create a stray label.
        for (const name of add) if (name.startsWith("status:") && !STATUS_LABELS.includes(name)) throw refuse(`${where}: ${name} is not a status of .github/labels.yml`);
        for (const owned of OWNER_ONLY_LABELS) if (add.includes(owned)) throw refuse(`${where}: ${owned} is the owner's to set`);
        if (add.includes(WORKFLOW_ONLY_LABEL)) throw refuse(`${where}: ${WORKFLOW_ONLY_LABEL} is set by the Upstream post workflow after it publishes a draft; an agent sets status:awaiting-post for a ready draft`);
        if (add.some((name) => remove.includes(name))) throw refuse(`${where}: a label cannot be both added and removed`);
        return { op: "labels", issue: raw.issue, add, remove };
      }
      case "close":
        if (!isId(raw.issue)) throw refuse(`${where}: issue must be a positive integer`);
        if (raw.reason !== CLOSE_REASON) throw refuse(`${where}: reason must be ${CLOSE_REASON}`);
        if (!securityPointers.has(raw.issue)) {
          throw refuse(`${where}: agents never close an issue except a security report; set status:declined or status:needs-info instead (a security close follows a comment with the exact SECURITY_CLOSE_COMMENT text on the same issue)`);
        }
        return { op: "close", issue: raw.issue, reason: raw.reason };
      case "reopen":
        if (!isId(raw.issue)) throw refuse(`${where}: issue must be a positive integer`);
        return { op: "reopen", issue: raw.issue };
      case "pr_create":
        if (typeof raw.head !== "string" || !raw.head.startsWith(HEAD_PREFIX) || !/^[\w./-]+$/.test(raw.head) || raw.head.includes("..") || raw.head.length > 200) {
          throw refuse(`${where}: head must be a ${HEAD_PREFIX} branch of this repository`);
        }
        if (!isText(raw.title)) throw refuse(`${where}: title must be a non-empty string`);
        if (raw.body !== undefined && typeof raw.body !== "string") throw refuse(`${where}: body must be a string`);
        if (raw.draft !== undefined && typeof raw.draft !== "boolean") throw refuse(`${where}: draft must be true or false`);
        return { op: "pr_create", head: raw.head, title: raw.title, body: raw.body ?? "", draft: raw.draft === true };
      case "pr_ready":
        if (!isId(raw.pr)) throw refuse(`${where}: pr must be a positive integer`);
        return { op: "pr_ready", pr: raw.pr };
      case "pr_edit":
        if (!isId(raw.pr)) throw refuse(`${where}: pr must be a positive integer`);
        if (raw.title === undefined && raw.body === undefined) throw refuse(`${where}: give a title or a body`);
        if (raw.title !== undefined && !isText(raw.title)) throw refuse(`${where}: title must be a non-empty string`);
        if (raw.body !== undefined && typeof raw.body !== "string") throw refuse(`${where}: body must be a string`);
        return { op: "pr_edit", pr: raw.pr, title: raw.title, body: raw.body };
      case "pr_close":
        if (!isId(raw.pr)) throw refuse(`${where}: pr must be a positive integer`);
        return { op: "pr_close", pr: raw.pr };
      default:
        if (!isId(raw.pr)) throw refuse(`${where}: pr must be a positive integer`);
        if (typeof raw.sha !== "string" || !/^[0-9a-f]{40}$/i.test(raw.sha)) throw refuse(`${where}: sha must be a full 40-character commit sha`);
        return { op: "merge", pr: raw.pr, sha: raw.sha.toLowerCase() };
    }
  });
}

/** The merge guards, on a freshly read pull request. Returns nothing or throws a refusal. */
export function checkMergeable(pr, op, { repo, login }) {
  if (pr.state !== "open") throw refuse(`PR #${op.pr} is not open`);
  if (pr.draft === true) throw refuse(`PR #${op.pr} is a draft`);
  if (lower(pr.user?.login) !== lower(login)) throw refuse(`PR #${op.pr} was not opened by ${login}`);
  const ref = pr.head?.ref;
  if (typeof ref !== "string" || !ref.startsWith(HEAD_PREFIX)) throw refuse(`PR #${op.pr}: head branch is not a ${HEAD_PREFIX} branch`);
  if (lower(pr.head?.repo?.full_name) !== lower(repo)) throw refuse(`PR #${op.pr}: head branch is not in ${repo}`);
  if (pr.base?.ref !== BASE_BRANCH) throw refuse(`PR #${op.pr}: base is not ${BASE_BRANCH}`);
  if (typeof pr.title !== "string" || !pr.title.startsWith(BATCH_TITLE)) throw refuse(`PR #${op.pr}: title does not start with "${BATCH_TITLE}"`);
  if (lower(pr.head?.sha) !== op.sha) throw refuse(`PR #${op.pr}: head is not ${op.sha.slice(0, 7)}`);
  if (pr.mergeable_state !== "clean") throw refuse(`PR #${op.pr}: mergeable state is ${JSON.stringify(String(pr.mergeable_state ?? "unknown"))}, not "clean"`);
}

const MAX_LINKED = 50; // issues read per batch pull request

/**
 * The issues a batch pull request links (`Fixes`, `Closes`, `Resolves`, or `Refs #N` in its body) that are in `status:rework`: the owner
 * sent that result back (ticket 3.28). An unreadable issue throws (fail closed); a missing one (404) is not an issue of this repository.
 */
export async function linkedReworkIssues(client, base, pr, repo) {
  const found = [];
  for (const { number } of linkedIssues(typeof pr?.body === "string" ? pr.body : "", repo).slice(0, MAX_LINKED)) {
    const answer = await client.rest("GET", `${base}/issues/${number}`, undefined, [404]);
    if (answer.status === 404 || !isObject(answer.data)) continue;
    const labels = Array.isArray(answer.data.labels) ? answer.data.labels.map((entry) => (typeof entry === "string" ? entry : entry?.name)) : [];
    if (labels.includes(REWORK)) found.push(number);
  }
  return found;
}

/** Refuses a batch pull request that links an issue the owner sent back with `status:rework`; shared by Batch merge and the relay's `merge`. */
export async function checkNotSentBack(client, base, pr, number, repo) {
  const [first] = await linkedReworkIssues(client, base, pr, repo);
  if (first !== undefined) throw refuse(`PR #${number}: issue #${first} is in ${REWORK} (the owner sent it back); held until the label is replaced`);
}

/**
 * The close guards for a READY batch pull request (ticket 3.28, a held batch): open, the app's, a `claude/` branch of this repository, a title
 * that starts with `Issue batch`, and held by `Batch merge` because a linked issue is in `status:rework`. It is read before the list is applied;
 * `requireCarried` then demands that another open batch PR of the app already contains its head, so the work lives on in the resumed batch.
 */
export async function checkClosableHeld(client, base, pr, op, { repo, login }) {
  if (pr.state !== "open") throw refuse(`PR #${op.pr} is not open`);
  if (lower(pr.user?.login) !== lower(login)) throw refuse(`PR #${op.pr} was not opened by ${login}`);
  const ref = pr.head?.ref;
  if (typeof ref !== "string" || !ref.startsWith(HEAD_PREFIX)) throw refuse(`PR #${op.pr}: head branch is not a ${HEAD_PREFIX} branch`);
  if (lower(pr.head?.repo?.full_name) !== lower(repo)) throw refuse(`PR #${op.pr}: head branch is not in ${repo}`);
  if (typeof pr.title !== "string" || !pr.title.startsWith(BATCH_TITLE)) throw refuse(`PR #${op.pr}: title does not start with "${BATCH_TITLE}"`);
  if ((await linkedReworkIssues(client, base, pr, repo)).length === 0) throw refuse(`PR #${op.pr}: it is ready for review and no issue it links is in ${REWORK}; only a batch held for rework is closed (it merges on its own otherwise)`);
}

/**
 * The close guards, on a freshly read pull request: an open draft batch PR of the app from a `claude/` branch of this
 * repository, not updated for 2 hours (`now()` is the run's clock in ms; a missing or unreadable `updated_at` is refused).
 */
export function checkClosable(pr, op, { repo, login, now = Date.now }) {
  if (pr.state !== "open") throw refuse(`PR #${op.pr} is not open`);
  if (pr.draft !== true) throw refuse(`PR #${op.pr} is not a draft`);
  if (lower(pr.user?.login) !== lower(login)) throw refuse(`PR #${op.pr} was not opened by ${login}`);
  const ref = pr.head?.ref;
  if (typeof ref !== "string" || !ref.startsWith(HEAD_PREFIX)) throw refuse(`PR #${op.pr}: head branch is not a ${HEAD_PREFIX} branch`);
  if (lower(pr.head?.repo?.full_name) !== lower(repo)) throw refuse(`PR #${op.pr}: head branch is not in ${repo}`);
  if (pr.title !== CLAIM_TITLE) throw refuse(`PR #${op.pr}: title is not "${CLAIM_TITLE}" (an owner-paused batch is never closed)`);
  const updated = typeof pr.updated_at === "string" ? Date.parse(pr.updated_at) : Number.NaN;
  if (!Number.isFinite(updated)) throw refuse(`PR #${op.pr}: its last update time could not be read`);
  if (now() - updated < IDLE_MS) throw refuse(`PR #${op.pr}: updated less than 2 hours ago; it may still be in use`);
}

/**
 * The plan files (a ticket's `_bmad-output/**\/*-plan.md`) a pull request changes whose status at its head is `done` or `built`: the
 * built tickets of an idle draft. Part of the pre-apply check of `pr_close`; fails closed (an unreadable list or plan refuses).
 */
export async function builtPlans(client, pr, op, { repo }) {
  const base = `/repos/${repo}`;
  const sha = typeof pr.head?.sha === "string" ? pr.head.sha.toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(sha)) throw refuse(`PR #${op.pr}: its head sha could not be read`);
  const plans = [];
  for (let page = 1; ; page++) {
    const files = (await client.rest("GET", `${base}/pulls/${op.pr}/files?per_page=100&page=${page}`)).data;
    if (!Array.isArray(files)) throw refuse(`PR #${op.pr}: its changed files could not be read`);
    for (const file of files) if (typeof file?.filename === "string" && file.status !== "removed" && PLAN_PATH.test(file.filename)) plans.push(file.filename);
    if (files.length < 100) break;
    if (page >= MAX_FILE_PAGES) throw refuse(`PR #${op.pr}: too many changed files to verify`);
  }
  if (plans.length > MAX_PLAN_READS) throw refuse(`PR #${op.pr}: too many plan files to verify (${plans.length})`);
  const built = [];
  for (const path of plans) {
    const { data } = await client.rest("GET", `${base}/contents/${path.split("/").map(encodeURIComponent).join("/")}?ref=${sha}`);
    if (!isObject(data) || typeof data.content !== "string") throw refuse(`PR #${op.pr}: the plan ${path} could not be read`);
    if (BUILT_STATUSES.has(planStatus(Buffer.from(data.content, "base64").toString("utf8")))) built.push(path);
  }
  return built;
}

/**
 * An idle draft that holds built tickets is resumed, never closed (ticket 3.21: the run that found draft #41 with six done tickets
 * set out to close it and rebuild them). Run at apply time, right before the close: another open batch PR of the app (a `claude/`
 * branch of this repository) must already contain the draft's head `sha` (the one checked before the list was applied), so the work
 * lives on. It is read now because the PR that carries it may be created by an earlier operation of the same list.
 */
export async function requireCarried(client, sha, built, op, { repo, login }) {
  const base = `/repos/${repo}`;
  const listed = (await client.rest("GET", `${base}/pulls?state=open&per_page=100`)).data;
  const carriers = (Array.isArray(listed) ? listed : [])
    .filter((other) => other?.number !== op.pr && lower(other?.user?.login) === lower(login) && typeof other?.head?.ref === "string" && other.head.ref.startsWith(HEAD_PREFIX) && lower(other.head.repo?.full_name) === lower(repo) && /^[0-9a-f]{40}$/i.test(String(other.head.sha)))
    .slice(0, MAX_CARRIERS);
  for (const other of carriers) {
    const { data } = await client.rest("GET", `${base}/compare/${sha}...${String(other.head.sha).toLowerCase()}`);
    if (data?.status === "ahead" || data?.status === "identical") return;
  }
  const names = built.slice(0, 3).join(", ");
  throw refuse(`PR #${op.pr}: its branch holds built tickets (${names}${built.length > 3 ? `, and ${built.length - 3} more` : ""}) and no other open batch PR contains it; resume it on your own branch instead of closing it (docs/agents/implement.md)`);
}

const PASSING = new Set(["success", "skipped", "neutral"]);

/**
 * The same "green" the agents check before they ask for a merge, on the head sha: the check run named `check` is present and
 * (run by GitHub Actions: `app.slug` is `github-actions`) succeeded, every other check run completed `success`, `skipped`, or `neutral`, and the combined commit status is not
 * `failure` or `pending` (no statuses at all is fine; GitHub reports that as `pending` with a zero count).
 */
export function checkGreen(runs, status, op) {
  const name = `PR #${op.pr}`;
  if (!Array.isArray(runs?.check_runs) || !Number.isSafeInteger(runs.total_count)) throw refuse(`${name}: the check runs could not be read`);
  if (runs.total_count > runs.check_runs.length) throw refuse(`${name}: too many check runs to verify (${runs.total_count})`);
  // Only the CI workflow's own run counts: any app can create a check run with this name.
  const main = runs.check_runs.filter((run) => run?.name === "check" && run.app?.slug === "github-actions");
  if (main.length === 0) throw refuse(`${name}: the "check" run is missing or not from GitHub Actions`);
  for (const run of runs.check_runs) {
    if (run?.status !== "completed") throw refuse(`${name}: check run ${JSON.stringify(String(run?.name ?? "?"))} is not completed`);
    if (!PASSING.has(run.conclusion)) throw refuse(`${name}: check run ${JSON.stringify(String(run.name ?? "?"))} concluded ${JSON.stringify(String(run.conclusion))}`);
  }
  if (main.some((run) => run.conclusion !== "success")) throw refuse(`${name}: the "check" run did not succeed`);
  if (!isObject(status) || !Number.isSafeInteger(status.total_count)) throw refuse(`${name}: the commit status could not be read`);
  if (status.total_count > 0 && status.state !== "success") throw refuse(`${name}: commit status is ${JSON.stringify(String(status.state))}`);
}

// ---- GitHub API ----

/** The REST/GraphQL client; scripts/batch-merge.mjs reuses it. `config` needs `token`, `api`, `graphql`. */
export function makeClient(config) {
  const clean = (text) => (config.token.length >= 4 ? String(text).replaceAll(config.token, "[redacted]") : String(text));
  async function send(method, url, label, body) {
    let response;
    try {
      response = await fetch(url, {
        method,
        redirect: "error", // never send the token anywhere else
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${config.token}`,
          "x-github-api-version": "2022-11-28",
          "user-agent": "openclaw-all-cli-agent-write",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      const reason = error?.name === "TimeoutError" ? "timed out" : (error?.cause?.code ?? error?.code ?? "request failed");
      throw new WriteError(`${label}: ${clean(reason)}`);
    }
    let text = "";
    try {
      text = await response.text();
    } catch {
      // an unreadable body is reported by status below
    }
    let data = null;
    try {
      data = text === "" ? null : JSON.parse(text);
    } catch {
      // not JSON
    }
    return { status: response.status, ok: response.ok, data };
  }
  /** One REST call on this repository. A failure carries the status and the API's message only; `okStatuses` also pass. */
  async function rest(method, path, body, okStatuses = []) {
    const label = `${method} ${path.replace(/^\/repos\/[^/]+\/[^/]+/, "")}`;
    const answer = await send(method, `${config.api}${path}`, label, body);
    if (!answer.ok && !okStatuses.includes(answer.status)) {
      const message = typeof answer.data?.message === "string" ? clean(answer.data.message).slice(0, MAX_MESSAGE) : "";
      throw new WriteError(`${label}: GitHub answered ${answer.status}${message === "" ? "" : ` (${message})`}`);
    }
    return answer;
  }
  async function graphql(query, variables) {
    const answer = await send("POST", config.graphql, "POST /graphql", { query, variables });
    const errors = Array.isArray(answer.data?.errors) ? answer.data.errors : [];
    if (!answer.ok || errors.length > 0) {
      const raw = typeof errors[0]?.message === "string" ? errors[0].message : typeof answer.data?.message === "string" ? answer.data.message : "";
      const message = clean(raw).slice(0, MAX_MESSAGE);
      throw new WriteError(`POST /graphql: GitHub answered ${answer.status}${message === "" ? "" : ` (${message})`}`);
    }
    return answer.data?.data ?? null;
  }
  return { rest, graphql, clean };
}

const READY_MUTATION = "mutation($id: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $id }) { pullRequest { number isDraft } } }";

function handlers(config, client) {
  const { repo, login } = config;
  const base = `/repos/${repo}`;
  const requireAuthor = (author, what) => {
    if (lower(author) !== lower(login)) throw refuse(`${what} was not written by ${login}`);
  };
  /** The issue, read fresh; an answer that is not an object, or a pull request, is refused (the agents change no pull request this way). */
  const requireIssue = async (number) => {
    const { data } = await client.rest("GET", `${base}/issues/${number}`);
    if (!isObject(data)) throw refuse(`#${number}: GitHub's answer could not be read`);
    if (data.pull_request !== undefined) throw refuse(`#${number} is a pull request; the agents never close or reopen one`);
  };
  const readPull = async (number) => (await client.rest("GET", `${base}/pulls/${number}`)).data ?? {};
  /** pr number -> {sha, built}: what `prepare` found before anything was applied. */
  const closing = new Map();

  return {
    /** Reads and checks every `pr_close` target before the first operation is applied; a refusal here applies nothing. */
    async prepare(ops) {
      for (const op of ops) {
        if (op.op !== "pr_close" || closing.has(op.pr)) continue;
        const pr = await readPull(op.pr);
        const held = pr.draft !== true;
        if (held) await checkClosableHeld(client, base, pr, op, config);
        else checkClosable(pr, op, config);
        const built = await builtPlans(client, pr, op, config);
        // A held ready batch always holds work that must live on: a carrier is demanded even when no plan is at done or built.
        closing.set(op.pr, { sha: lower(pr.head?.sha), draft: !held, built: held && built.length === 0 ? ["(a ready batch)"] : built });
      }
    },
    async comment(op) {
      const { data } = await client.rest("POST", `${base}/issues/${op.issue}/comments`, { body: op.body });
      return { target: `#${op.issue}`, result: `comment ${data?.id ?? "?"} created` };
    },
    async edit_comment(op) {
      const path = `${base}/issues/comments/${op.commentId}`;
      const { data } = await client.rest("GET", path);
      requireAuthor(data?.user?.login, `comment ${op.commentId}`);
      await client.rest("PATCH", path, { body: op.body });
      return { target: `comment ${op.commentId}`, result: "edited" };
    },
    async labels(op) {
      const done = [];
      if (op.add.length > 0) {
        await client.rest("POST", `${base}/issues/${op.issue}/labels`, { labels: op.add });
        done.push(`added ${op.add.join(", ")}`);
      }
      const removed = [];
      for (const name of op.remove) {
        // GitHub answers 404 "Label does not exist" for a label the issue does not carry: already as wanted.
        const answer = await client.rest("DELETE", `${base}/issues/${op.issue}/labels/${encodeURIComponent(name)}`, undefined, [404]);
        if (answer.status === 404 && answer.data?.message !== "Label does not exist") {
          throw new WriteError(`DELETE /issues/${op.issue}/labels: GitHub answered 404 (${client.clean(String(answer.data?.message ?? "")).slice(0, MAX_MESSAGE)})`);
        }
        removed.push(answer.status === 404 ? `${name} (was not set)` : name);
      }
      if (removed.length > 0) done.push(`removed ${removed.join(", ")}`);
      return { target: `#${op.issue}`, result: done.join("; ") };
    },
    async close(op) {
      await requireIssue(op.issue);
      await client.rest("PATCH", `${base}/issues/${op.issue}`, { state: "closed", state_reason: op.reason });
      return { target: `#${op.issue}`, result: `closed (${op.reason})` };
    },
    async reopen(op) {
      await requireIssue(op.issue);
      await client.rest("PATCH", `${base}/issues/${op.issue}`, { state: "open", state_reason: "reopened" });
      return { target: `#${op.issue}`, result: "reopened" };
    },
    async pr_create(op) {
      const { data } = await client.rest("POST", `${base}/pulls`, { title: op.title, head: op.head, base: BASE_BRANCH, body: op.body, draft: op.draft });
      const number = data?.number;
      if (!isId(number)) throw new WriteError("POST /pulls: no pull request number in the answer");
      return { target: `${op.head} -> ${BASE_BRANCH}`, result: `PR #${number} created${op.draft ? " (draft)" : ""}` };
    },
    async pr_ready(op) {
      const pr = await readPull(op.pr);
      requireAuthor(pr.user?.login, `PR #${op.pr}`);
      if (pr.draft !== true) return { target: `PR #${op.pr}`, result: "already ready for review" };
      if (typeof pr.node_id !== "string" || pr.node_id === "") throw new WriteError(`GET /pulls/${op.pr}: no node id in the answer`);
      const data = await client.graphql(READY_MUTATION, { id: pr.node_id });
      if (data?.markPullRequestReadyForReview?.pullRequest?.isDraft !== false) throw new WriteError(`PR #${op.pr}: GitHub did not mark it ready for review`);
      return { target: `PR #${op.pr}`, result: "marked ready for review" };
    },
    async pr_edit(op) {
      const pr = await readPull(op.pr);
      requireAuthor(pr.user?.login, `PR #${op.pr}`);
      const body = {};
      if (op.title !== undefined) body.title = op.title;
      if (op.body !== undefined) body.body = op.body;
      await client.rest("PATCH", `${base}/pulls/${op.pr}`, body);
      return { target: `PR #${op.pr}`, result: `edited ${Object.keys(body).join(" and ")}` };
    },
    async pr_close(op) {
      // The idle, author, title, and built-work checks ran before the list was applied (`prepare`): operations before this one in
      // the list (a comment, a pr_edit) refresh `updated_at`. Here only that the PR is still the one that was checked.
      const checked = closing.get(op.pr);
      if (checked === undefined) throw new WriteError(`PR #${op.pr}: it was not checked before the list was applied`);
      const pr = await readPull(op.pr);
      if (pr.state !== "open" || (pr.draft === true) !== checked.draft || lower(pr.head?.sha) !== checked.sha) throw refuse(`PR #${op.pr}: it changed since it was checked (closed, ready, or a new push)`);
      if (!checked.draft && (await linkedReworkIssues(client, base, pr, config.repo)).length === 0) throw refuse(`PR #${op.pr}: no issue it links is in ${REWORK} any more; it merges on its own`);
      if (checked.built.length > 0) await requireCarried(client, checked.sha, checked.built, op, config);
      await client.rest("PATCH", `${base}/pulls/${op.pr}`, { state: "closed" });
      return { target: `PR #${op.pr}`, result: "closed" };
    },
    async merge(op) {
      const pr = await readPull(op.pr);
      checkMergeable(pr, op, config);
      await checkNotSentBack(client, base, pr, op.pr, config.repo); // the owner's send-back stops this merge as it stops Batch merge
      checkGreen((await client.rest("GET", `${base}/commits/${op.sha}/check-runs?per_page=100`)).data, (await client.rest("GET", `${base}/commits/${op.sha}/status`)).data, op);
      const { data } = await client.rest("PUT", `${base}/pulls/${op.pr}/merge`, { merge_method: "merge", sha: op.sha });
      if (data?.merged !== true) throw new WriteError(`PUT /pulls/${op.pr}/merge: GitHub did not merge it`);
      return { target: `PR #${op.pr}`, result: `merged at ${String(data.sha ?? "").slice(0, 7) || "?"}` };
    },
  };
}

// ---- running and reporting ----

export const cell = (text) => String(text).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

/** The Markdown summary. It holds targets, results, and ids only: never an operation's body. */
export function formatSummary({ login, repo, actor, outcome, message, rows }) {
  const lines = [
    "### Agent write",
    "",
    `Acting as \`${login}\` on \`${repo}\`, dispatched by \`${cell(actor) || "unknown"}\`.`,
    "",
    `**${outcome}**${message ? `: ${cell(message)}` : ""}`,
  ];
  if (rows.length > 0) {
    lines.push("", "| # | Operation | Target | Result |", "| --- | --- | --- | --- |");
    rows.forEach((row, i) => lines.push(`| ${i + 1} | ${cell(row.op)} | ${cell(row.target)} | ${cell(row.result)} |`));
  }
  return `${lines.join("\n")}\n`;
}

/**
 * Runs the whole input. `log(line)` is called with each progress line as it happens (the acting login, then one per finished
 * operation). Returns `{code, outcome, message, rows}`; it writes nothing itself. A missing or malformed variable throws a
 * WriteError with code 2. `now` is the clock in ms (injected by in-process callers; the script uses the real one).
 */
export async function run(env, log = () => {}, now = Date.now) {
  const config = { ...readConfig(env), now };
  const base = { login: config.login, repo: config.repo, actor: config.actor };
  const finish = (code, outcome, message, rows = []) => ({ code, outcome, message, rows, ...base });
  log(`acting as ${config.login}`);
  // Only an owner who started this very run may use the relay, and only on its first attempt: a re-run keeps the original
  // `actor` and would replay the operations, so it is refused.
  const refused = (message) => finish(1, "Refused, nothing applied", message);
  if (config.attempt !== "1") return refused("this is a re-run (GITHUB_RUN_ATTEMPT is not 1); dispatch again instead");
  for (const [who, name] of [[config.actor, "dispatcher"], [config.triggering, "triggering actor"]]) {
    if (lower(who) === "" || !config.owners.includes(lower(who))) return refused(`the ${name} is not an owner (ISSUE_FLOW_OWNERS)`);
  }
  let ops;
  try {
    ops = validate(config.opsText);
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    return finish(error.code, "Refused, nothing applied", error.message);
  }
  const client = makeClient(config);
  const handle = handlers(config, client);
  const rows = [];
  const add = (row) => {
    rows.push(row);
    log(`${row.op} ${row.target}: ${row.result}`);
  };
  try {
    await handle.prepare(ops);
  } catch (error) {
    const safe = error instanceof WriteError;
    const reason = safe ? client.clean(error.message) : "unexpected error";
    return finish(1, safe && error.refused ? "Refused, nothing applied" : "Failed before applying anything", reason);
  }
  for (const [i, op] of ops.entries()) {
    try {
      add({ op: op.op, ...(await handle[op.op](op)) });
    } catch (error) {
      // Only our own errors carry a safe message; anything else is reported without its text.
      const safe = error instanceof WriteError;
      const reason = safe ? client.clean(error.message) : "unexpected error";
      add({ op: op.op, target: "", result: `${safe && error.refused ? "refused" : "failed"}: ${reason}` });
      for (const later of ops.slice(i + 1)) add({ op: later.op, target: "", result: "not applied" });
      return finish(1, `Stopped at operation ${i + 1} of ${ops.length}`, `${ops.length - i - 1} later operation(s) not applied`, rows);
    }
  }
  return finish(0, `Applied ${ops.length} operation(s)`, "", rows);
}

/** One line, always starting with `agent-write:`: newlines in a message cannot start a fake log line or a `::` command. */
const logLine = (text) => `agent-write: ${String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ")}\n`;

export function writeSummary(env, text) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (typeof file !== "string" || file === "") return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch {
    // the log still has the result
  }
}

async function main() {
  const env = process.env;
  try {
    const result = await run(env, (line) => process.stdout.write(logLine(line)));
    writeSummary(env, formatSummary(result));
    const stream = result.code === 0 ? process.stdout : process.stderr;
    stream.write(logLine(`${result.outcome}${result.message ? `: ${result.message}` : ""}`));
    process.exitCode = result.code;
  } catch (error) {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof WriteError;
    const message = safe ? error.message : "unexpected error";
    writeSummary(env, `### Agent write\n\n**Not run**: ${cell(message)}\n`);
    process.stderr.write(logLine(message));
    process.exitCode = safe ? error.code : 1;
  }
}

// Run when invoked as the script, also through a symlink (compare real paths).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return true;
  }
}

if (invokedDirectly()) await main();

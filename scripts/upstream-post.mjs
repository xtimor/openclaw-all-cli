#!/usr/bin/env node
// Publishes an agent's upstream draft when the owner labels our issue `upstream:post` (ticket 3.25). It runs inside the `Upstream post`
// workflow (.github/workflows/upstream-post.yml), the way `Batch merge` acts on the owner's "ready": the agent writes the draft, the
// owner's label is the approval, GitHub publishes. The routine's permission check refuses an agent's own call of
// scripts/upstream-issue.sh (a public write under the owner's name), so agents no longer make it.
// Agent-neutral and dependency-free. Design: docs/agents/identity.md ("Upstream issues"), tickets 3.23, 3.24, 3.25.
//
// What it does, in order (every write is to THIS repository, with the job's GITHUB_TOKEN, except the one upstream call):
//   1. Replay and withdrawal: attempt not 1, a triggering actor who is not an owner, or the label no longer on the issue: exit 1 and
//      change nothing (a re-run is not a new signal from the owner, and removing the label cancels the request).
//   2. From here every outcome ends the same way: one result comment on our issue and the label removed.
//   3. The labeler (`github.event.sender`) must be the workflow's actor, an owner (ISSUE_FLOW_OWNERS), a User, not a bot.
//   4. The draft: the LATEST comment of our issue whose first line is `<!-- issue-impl -->` and whose author is the agent app (the
//      login in .github/agent-identity.json, type Bot). It must hold exactly one draft block and must not have been edited after the
//      label was added (the owner approves the text they read). Comments of anyone else are ignored, a block in them included.
//   5. The input of scripts/upstream-issue.mjs is built from the block plus the line `Filed for <this repository>#<n>` and handed to
//      its `run()`: the same code path as the dispatch workflow. Every guard of tickets 3.23 and 3.24 applies there (owner actors,
//      attempt 1, approved issue, the issue names the target, own issue for a comment, caps, idempotency, size limits, one marker).
//
// The draft block, written by the agent inside its `<!-- issue-impl -->` comment (the text between the tags is the public text,
// without the `Filed for` line, which this script appends):
//
//   <!-- upstream-draft target=openclaw/openclaw#<n> op=comment -->
//   <the comment>
//   <!-- /upstream-draft -->
//
//   <!-- upstream-draft target=openclaw/openclaw op=create -->
//   Title: <one line>
//
//   <the issue body>
//   <!-- /upstream-draft -->
//
// Environment: GITHUB_TOKEN (this repository, `issues: write`), GH_PUBLIC_TOKEN (the owner's token, upstream only; handed to run()),
// GITHUB_REPOSITORY, GITHUB_ACTOR, GITHUB_TRIGGERING_ACTOR, GITHUB_RUN_ATTEMPT, ISSUE_FLOW_OWNERS, ISSUE_NUMBER (our issue), LABEL_NAME,
// LABELER and LABELER_TYPE (`github.event.sender`), LABELED_AT (`github.event.issue.updated_at` of the labeled event), GITHUB_API_URL,
// GITHUB_STEP_SUMMARY, GITHUB_OUTPUT, UPSTREAM_POST_IDENTITY_FILE (tests; default .github/agent-identity.json of this checkout).
//
// Neither token is printed. No stream, summary, output, or result comment holds a draft's title or body; the upstream issue is named
// by its URL. Every log line starts with `upstream-post:` and holds one line. Exit 0 created, commented, or existing; 1 refused or
// failed; 2 a variable is missing or malformed (nothing is written then).
import { appendFileSync, readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cell, lower, makeClient, WriteError, writeSummary } from "./agent-write.mjs";
import { parseOwners } from "./issue-flow/transitions.mjs";
import { run as runUpstream } from "./upstream-issue.mjs";

export const LABEL = "upstream:post";
export const RESULT_MARKER = "<!-- upstream-post -->";
const MAX_COMMENT_PAGES = 20; // 2000 comments on one issue of ours
const MAX_NUMBER = 999_999_999;
const IMPL_MARKER = /^\s*<!--\s*issue-impl\s*-->/;
const OPEN_TAG = /^<!--[ \t]+upstream-draft[ \t]+([^>]*?)[ \t]+-->[ \t]*$/;
const CLOSE_TAG = /^<!--[ \t]+\/upstream-draft[ \t]+-->[ \t]*$/;
const ANY_TAG = /<!--[ \t]*\/?[ \t]*upstream-draft/i;
const ATTRIBUTE = /^(target|op)=([A-Za-z0-9_.#/-]+)$/;
const REPO_PART = "[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+";
const LOGIN = /^[A-Za-z0-9][\w.-]*(?:\[bot\])?$/;
const RESULT_URL = /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/issues\/\d+(?:#issuecomment-\d+)?$/;

const refuse = (message) => new WriteError(message, { refused: true });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const trimBlank = (text) => text.replace(/^(?:[ \t]*\n)+/, "").replace(/\s+$/, "");

/**
 * Parses the one draft block of a comment body: `{op, repo, issue?, title?, body}`. Throws a refusal for no block, a second block,
 * a malformed or half-open tag, an unknown attribute or op, a target that does not fit the op, an empty body, or (create) a missing
 * `Title:` line. Text outside the block is ignored. Nothing here checks that the repository is allowed: upstream-issue.mjs does.
 */
export function parseDraft(text) {
  const lines = String(text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const opens = [];
  const closes = [];
  lines.forEach((line, index) => {
    if (!ANY_TAG.test(line)) return;
    if (OPEN_TAG.test(line)) opens.push(index);
    else if (CLOSE_TAG.test(line)) closes.push(index);
    else throw refuse("a line mentions upstream-draft but is not exactly a draft tag (use the two tags alone on their own lines)");
  });
  if (opens.length === 0 && closes.length === 0) throw refuse("the comment holds no upstream-draft block");
  if (opens.length !== 1 || closes.length !== 1) throw refuse(`the comment holds ${opens.length} opening and ${closes.length} closing upstream-draft tags; it must hold exactly one block`);
  if (closes[0] < opens[0]) throw refuse("the closing upstream-draft tag comes before the opening one");
  const attributes = new Map();
  for (const token of (OPEN_TAG.exec(lines[opens[0]])?.[1] ?? "").split(/[ \t]+/).filter((part) => part !== "")) {
    const match = ATTRIBUTE.exec(token);
    if (!match || attributes.has(match[1])) throw refuse("the opening tag takes exactly target=<repo or repo#n> and op=<comment|create>, each once");
    attributes.set(match[1], match[2]);
  }
  if (attributes.size !== 2) throw refuse("the opening tag takes exactly target=<repo or repo#n> and op=<comment|create>, each once");
  const op = attributes.get("op");
  const target = attributes.get("target");
  const inner = trimBlank(lines.slice(opens[0] + 1, closes[0]).join("\n"));
  if (op === "comment") {
    const match = new RegExp(`^(${REPO_PART})#([1-9]\\d{0,8})$`).exec(target);
    if (!match) throw refuse("op=comment needs target=<repo>#<issue number>");
    if (inner === "") throw refuse("the draft is empty");
    return { op, repo: match[1], issue: Number(match[2]), body: inner };
  }
  if (op === "create") {
    if (!new RegExp(`^${REPO_PART}$`).test(target)) throw refuse("op=create needs target=<repo> with no issue number");
    const [first = "", ...rest] = inner.split("\n");
    const title = /^Title:[ \t]+(\S.*)$/.exec(first)?.[1]?.trim();
    if (title === undefined) throw refuse("op=create needs a first line `Title: <one line>`");
    const body = trimBlank(rest.join("\n"));
    if (body === "") throw refuse("the draft has a title but no body");
    return { op, repo: target, title, body };
  }
  throw refuse('op must be "comment" or "create"');
}

/**
 * The draft of our issue from its comments (oldest first): the latest comment whose first line is the implementation marker and whose
 * author is the agent app. A comment by anyone else, with or without a block, is ignored. Refuses when there is none, when it was
 * edited after `labeledAtMs`, or when its block does not parse.
 */
export function findDraft(comments, { login, labeledAtMs }) {
  const mine = comments.filter((comment) => isObject(comment) && isObject(comment.user) && lower(comment.user.login) === lower(login) && comment.user.type === "Bot" && IMPL_MARKER.test(String(comment.body ?? "").replace(/^\uFEFF/, "")));
  const latest = mine[mine.length - 1];
  if (latest === undefined) throw refuse(`no <!-- issue-impl --> comment by ${login} on this issue`);
  const edited = typeof latest.updated_at === "string" ? Date.parse(latest.updated_at) : Number.NaN;
  if (!Number.isFinite(edited)) throw refuse("the draft comment has no readable edit time");
  if (edited > labeledAtMs) throw refuse("the draft comment was edited after the label was added; read it again, then add the label again");
  return parseDraft(latest.body);
}

/** The input of scripts/upstream-issue.mjs for a parsed draft: the draft's text plus the one `Filed for` line of this issue. */
export function buildInput(draft, ourRepo, number) {
  const body = `${draft.body}\n\nFiled for ${ourRepo}#${number}\n`;
  return draft.op === "comment" ? { op: "comment", repo: draft.repo, issue: draft.issue, body } : { op: "create", repo: draft.repo, title: draft.title, body };
}

function readConfig(env) {
  const need = ["GITHUB_TOKEN", "GITHUB_REPOSITORY", "ISSUE_NUMBER", "LABEL_NAME", "LABELER", "LABELER_TYPE", "LABELED_AT"];
  const missing = need.filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
  if (missing.length > 0) throw new WriteError(`missing environment variable: ${missing.join(", ")}`, { code: 2 });
  const repo = env.GITHUB_REPOSITORY.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new WriteError("GITHUB_REPOSITORY must look like owner/repo", { code: 2 });
  const token = env.GITHUB_TOKEN.trim();
  if (!/^\S{8,}$/.test(token)) throw new WriteError("GITHUB_TOKEN does not look like a token", { code: 2 });
  const issue = Number(env.ISSUE_NUMBER.trim());
  if (!/^[1-9]\d{0,8}$/.test(env.ISSUE_NUMBER.trim()) || issue > MAX_NUMBER) throw new WriteError("ISSUE_NUMBER must be an issue number", { code: 2 });
  const api = ((env.GITHUB_API_URL ?? "").trim() || "https://api.github.com").replace(/\/+$/, "");
  return {
    token, // makeClient reads this one: the workflow's, this repository only
    repo,
    api,
    graphql: `${api}/graphql`,
    issue,
    label: env.LABEL_NAME.trim(),
    labeler: env.LABELER.trim(),
    labelerType: env.LABELER_TYPE.trim(),
    labeledAt: env.LABELED_AT.trim(),
    actor: (env.GITHUB_ACTOR ?? "").trim(),
    triggering: (env.GITHUB_TRIGGERING_ACTOR ?? "").trim(),
    attempt: (env.GITHUB_RUN_ATTEMPT ?? "").trim(),
    owners: parseOwners(env.ISSUE_FLOW_OWNERS ?? ""),
    publicToken: (env.GH_PUBLIC_TOKEN ?? "").trim(),
    identityFile: (env.UPSTREAM_POST_IDENTITY_FILE ?? "").trim() || new URL("../.github/agent-identity.json", import.meta.url),
  };
}

/** The agent app's login from the checked-out `.github/agent-identity.json`; none means the relay is off, and there is no app to trust. */
function readAgentLogin(file) {
  let login;
  try {
    login = JSON.parse(readFileSync(file, "utf8"))?.login;
  } catch {
    login = undefined;
  }
  if (typeof login !== "string" || !/^[A-Za-z0-9][\w.-]*\[bot\]$/.test(login.trim())) {
    throw refuse("no agent app is configured (.github/agent-identity.json on main has no login), so no comment can be trusted as the agent's draft");
  }
  return login.trim();
}

/** One line safe inside a Markdown code span: no line break, no backtick, at most 500 characters. */
const oneLine = (text) => String(text).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replaceAll("`", "'").replace(/\s+/g, " ").trim().slice(0, 500);

function resultComment(result, config) {
  const requester = config.owners.includes(lower(config.labeler)) && config.labelerType === "User" && LOGIN.test(config.labeler) ? ` Requested by @${config.labeler}.` : "";
  const published = result.code === 0 && RESULT_URL.test(result.url);
  const headline = published ? { created: "published as a new issue", commented: "published as a comment", existing: "already published; nothing new was posted" }[result.kind] ?? "published" : "not published";
  return [
    RESULT_MARKER,
    `**Upstream post:** ${headline}.${requester}`,
    published ? `**Result:** ${result.url}` : `**Reason:** \`${oneLine(result.message ? `${result.outcome}: ${result.message}` : result.outcome)}\``,
    published ? `**Label:** \`${LABEL}\` removed.` : `**Label:** \`${LABEL}\` removed. Fix the cause, then add it again.`,
    "",
    "— `Upstream post` workflow (GitHub Actions, no agent)",
  ].join("\n");
}

async function readComments(ours, config) {
  const all = [];
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const list = (await ours.rest("GET", `/repos/${config.repo}/issues/${config.issue}/comments?per_page=100&page=${page}`)).data;
    if (!Array.isArray(list)) throw new WriteError(`GET /issues/${config.issue}/comments: the comments could not be read`);
    all.push(...list);
    if (list.length < 100) return all;
  }
  throw refuse(`${config.repo}#${config.issue} has more than ${MAX_COMMENT_PAGES * 100} comments; the draft cannot be found`);
}

/**
 * Runs one labeled event. `log(line)` is called with each progress line. Returns `{code, outcome, message, url, kind, ...}`; it writes
 * nothing to the streams. A missing or malformed variable throws a WriteError with code 2 (nothing written).
 */
export async function run(env, log = () => {}, now = Date.now) {
  const config = readConfig(env);
  const ours = makeClient(config);
  const theirs = config.publicToken.length >= 4 ? makeClient({ ...config, token: config.publicToken }) : null;
  const clean = (text) => (theirs ? theirs.clean(ours.clean(text)) : ours.clean(text));
  const base = { repo: config.repo, issue: config.issue, labeler: config.labeler, url: "", kind: "" };
  const finish = (code, outcome, message = "", extra = {}) => ({ code, outcome, message: clean(message), ...base, ...extra });
  if (config.label !== LABEL) return finish(0, "Ignored", `the label is not ${LABEL}`);

  // 1. Replay and withdrawal: change nothing.
  const nothing = "Refused, nothing changed";
  if (config.attempt !== "1") return finish(1, nothing, "this is a re-run (GITHUB_RUN_ATTEMPT is not 1); add the label again instead");
  if (lower(config.triggering) === "" || !config.owners.includes(lower(config.triggering))) return finish(1, nothing, "the triggering actor is not an owner (ISSUE_FLOW_OWNERS)");
  let current;
  try {
    current = (await ours.rest("GET", `/repos/${config.repo}/issues/${config.issue}`)).data;
  } catch (error) {
    return finish(1, "Failed before anything was changed", error instanceof WriteError ? error.message : "unexpected error");
  }
  if (!isObject(current) || current.pull_request !== undefined) return finish(1, nothing, `${config.repo}#${config.issue} is not an issue`);
  const names = Array.isArray(current.labels) ? current.labels.map((entry) => (typeof entry === "string" ? entry : entry?.name)) : [];
  if (!names.some((name) => typeof name === "string" && lower(name) === lower(LABEL))) return finish(1, "Nothing to publish", `the label ${LABEL} is no longer on the issue (removed, so withdrawn)`);

  // 2. From here on, every outcome gets one result comment and the label removed.
  const settle = async (result) => {
    let failure = "";
    try {
      await ours.rest("POST", `/repos/${config.repo}/issues/${config.issue}/comments`, { body: resultComment(result, config) });
    } catch (error) {
      failure = `the result comment could not be posted (${error instanceof WriteError ? clean(error.message) : "unexpected error"})`;
    }
    try {
      await ours.rest("DELETE", `/repos/${config.repo}/issues/${config.issue}/labels/${encodeURIComponent(LABEL)}`, undefined, [404]);
    } catch (error) {
      failure += `${failure === "" ? "" : "; "}the label could not be removed (${error instanceof WriteError ? clean(error.message) : "unexpected error"})`;
    }
    return failure === "" ? result : { ...result, code: result.code === 0 ? 1 : result.code, message: clean(`${result.message}${result.message === "" ? "" : "; "}${failure}`) };
  };
  const stop = (error, stage) => settle(finish(1, error instanceof WriteError && error.refused ? "Refused, nothing published" : stage, error instanceof WriteError ? error.message : "unexpected error"));

  // 3. The labeler.
  const who = LOGIN.test(config.labeler) ? config.labeler : "an unreadable login";
  if (lower(config.actor) !== lower(config.labeler)) return settle(finish(1, "Refused, nothing published", `the run's actor is not the person who added the label`));
  if (config.labelerType !== "User" || /\[bot\]$/i.test(config.labeler)) return settle(finish(1, "Refused, nothing published", `the label was added by ${who}, which is not a person; only an owner publishes a draft`));
  if (!config.owners.includes(lower(config.labeler))) return settle(finish(1, "Refused, nothing published", `the label was added by ${who}, who is not an owner (ISSUE_FLOW_OWNERS); only an owner publishes a draft`));

  // 4. The draft.
  let input;
  try {
    const labeledAtMs = Date.parse(config.labeledAt);
    if (!Number.isFinite(labeledAtMs)) throw refuse("the time the label was added could not be read");
    const login = readAgentLogin(config.identityFile);
    const draft = findDraft(await readComments(ours, config), { login, labeledAtMs });
    input = buildInput(draft, config.repo, config.issue);
  } catch (error) {
    return stop(error, "Failed while reading the draft");
  }

  // 5. The same code path as the dispatch workflow: every guard of tickets 3.23 and 3.24 runs there.
  let result;
  try {
    result = await runUpstream({ ...env, UPSTREAM_ISSUE: JSON.stringify(input) }, log, now);
  } catch (error) {
    return stop(error, "Failed before publishing");
  }
  const match = /^(created|commented|existing) (\S+)$/.exec(result.outcome);
  if (result.code === 0 && match) return settle(finish(0, result.outcome, "", { url: match[2], kind: match[1] }));
  return settle(finish(result.code === 0 ? 1 : result.code, result.outcome, result.message));
}

/** One line, always starting with `upstream-post:`: newlines in a message cannot start a fake log line or a `::` command. */
const logLine = (text) => `upstream-post: ${String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ")}\n`;

/** The Markdown summary: the issue, who labeled it, and the outcome. Never a title or a body. */
export function formatSummary({ repo, issue, labeler, outcome, message }) {
  return ["### Upstream post", "", `Label \`${LABEL}\` on \`${repo}#${issue}\` added by \`${oneLine(labeler) || "unknown"}\`.`, "", `**${cell(outcome)}**${message ? `: ${cell(message)}` : ""}`, ""].join("\n");
}

function writeOutput(env, line) {
  const file = env.GITHUB_OUTPUT;
  if (typeof file !== "string" || file === "") return;
  try {
    appendFileSync(file, `result=${line.replace(/[\r\n\u0085\u2028\u2029]+/g, " ")}\n`);
  } catch {
    // the log still has the result
  }
}

async function main() {
  const env = process.env;
  try {
    const result = await run(env, (line) => process.stdout.write(logLine(line)));
    writeSummary(env, formatSummary(result));
    const final = `${result.outcome}${result.message ? `: ${result.message}` : ""}`;
    writeOutput(env, logLine(final).trimEnd());
    (result.code === 0 ? process.stdout : process.stderr).write(logLine(final));
    process.exitCode = result.code;
  } catch (error) {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof WriteError;
    const message = safe ? error.message : "unexpected error";
    writeSummary(env, `### Upstream post\n\n**Not run**: ${cell(message)}\n`);
    writeOutput(env, logLine(`Not run: ${message}`).trimEnd());
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

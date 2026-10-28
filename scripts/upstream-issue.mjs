#!/usr/bin/env node
// Files one issue in an allow-listed upstream repository with the owner's personal token. It runs inside the `Upstream issue`
// workflow (.github/workflows/upstream-issue.yml): a cloud session's proxy swaps the owner's session credentials, which are scoped
// to this repository, into every api.github.com request, so a session cannot write to openclaw/openclaw. The owner stored a
// personal token as the environment secret GH_PUBLIC_TOKEN instead; a session dispatches the workflow (scripts/upstream-issue.sh).
// Agent-neutral and dependency-free. Design: docs/agents/identity.md ("Upstream issues"), ticket 3.23.
//
//   UPSTREAM_ISSUE='{"title":"...","body":"...\nFiled for xtimor/openclaw-all-cli#45"}' GH_PUBLIC_TOKEN=<token> \
//     GITHUB_REPOSITORY=owner/repo GITHUB_ACTOR=<dispatcher> GITHUB_TRIGGERING_ACTOR=<who started the run> \
//     ISSUE_FLOW_OWNERS=owner GITHUB_RUN_ATTEMPT=1 node scripts/upstream-issue.mjs
//
// Input (one JSON object, at most 40 000 characters): title (one line, at most 256), body (at most 30 000; exactly one line
// `Filed for <this repository>#<n>`, the issue of ours it serves), labels? (at most 5), repo? (only an ALLOWED_REPOS entry, default
// the first). Nothing else. Everything is validated before the first request; a refusal sends nothing.
// Approved issues only (ticket 3.23, security review): the marker's issue of ours must exist, be an issue, and have had `status:approved`
// labeled by an owner (ISSUE_FLOW_OWNERS; read with GITHUB_TOKEN, `issues: read`, from the repository's own events). "The owner asks"
// means the owner approves that issue first. A cap refuses a third new issue in 24 hours by the token's user in the target.
// Idempotent: before creating, it lists the issues the token's owner created in the target (`GET /user`, then `GET /issues?creator=`,
// which is consistent at once, unlike search) and returns the one with the same marker line or the same title instead of creating.
// Labels: GitHub drops, without an error, labels that a user without triage rights sets; the log says which were applied.
//
// Environment: UPSTREAM_ISSUE, GH_PUBLIC_TOKEN (the owner's token, upstream only), GITHUB_TOKEN (the workflow's, this repository only, read),
// GITHUB_REPOSITORY, GITHUB_ACTOR, GITHUB_TRIGGERING_ACTOR, GITHUB_RUN_ATTEMPT (must be
// "1"), ISSUE_FLOW_OWNERS (both actors must be in it), GITHUB_API_URL (default https://api.github.com), GITHUB_STEP_SUMMARY,
// GITHUB_OUTPUT (gets `result=<the final line>`; the workflow turns it into an annotation a session can read by REST).
//
// The token is never printed: every message goes through `clean`. Neither the log, the summary, nor the output holds a title or a
// body; the issue is named by its URL. Every line starts with `upstream-issue:` and holds one line, so no text can fake a log line or
// a workflow command. Exit 0 created or existing; 1 refused or failed; 2 a variable is missing or malformed.
import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { cell, lower, makeClient, WriteError, writeSummary } from "./agent-write.mjs";
import { parseOwners } from "./issue-flow/transitions.mjs";

const DEFAULT_API = "https://api.github.com";
/** The only repositories this workflow may write to. Code, never input or environment. */
export const ALLOWED_REPOS = ["openclaw/openclaw"];
export const MAX_INPUT = 40_000;
export const MAX_TITLE = 256; // GitHub's own limit
export const MAX_BODY = 30_000;
export const MAX_LABELS = 5;
const MAX_LABEL = 50;
const MAX_LIST_PAGES = 10; // 1000 issues of the token's owner in the target
const MAX_EVENT_PAGES = 10; // 1000 events of one issue of ours
export const DAILY_CAP = 3; // new issues by the token's user in the target within DAY_MS; the next one is refused
const DAY_MS = 24 * 60 * 60 * 1000;
const APPROVED = "status:approved";
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/; // a title or a label
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // a body may hold newlines and tabs
const MARKER_LINE = /^Filed for ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,8})[ \t\r]*$/gm;

const refuse = (message) => new WriteError(message, { refused: true });
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function readConfig(env) {
  const missing = ["UPSTREAM_ISSUE", "GH_PUBLIC_TOKEN", "GITHUB_TOKEN", "GITHUB_REPOSITORY"].filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
  if (missing.length > 0) throw new WriteError(`missing environment variable: ${missing.join(", ")}`, { code: 2 });
  const repo = env.GITHUB_REPOSITORY.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new WriteError("GITHUB_REPOSITORY must look like owner/repo", { code: 2 });
  const token = env.GH_PUBLIC_TOKEN.trim();
  if (!/^\S{8,}$/.test(token)) throw new WriteError("GH_PUBLIC_TOKEN does not look like a token", { code: 2 });
  const ours = env.GITHUB_TOKEN.trim();
  if (!/^\S{8,}$/.test(ours)) throw new WriteError("GITHUB_TOKEN does not look like a token", { code: 2 });
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");
  return {
    inputText: env.UPSTREAM_ISSUE,
    token,
    ourToken: ours,
    repo,
    api,
    graphql: `${api}/graphql`, // makeClient wants it; this script sends no GraphQL
    actor: env.GITHUB_ACTOR ?? "",
    triggering: env.GITHUB_TRIGGERING_ACTOR ?? "",
    attempt: (env.GITHUB_RUN_ATTEMPT ?? "").trim(),
    owners: parseOwners(env.ISSUE_FLOW_OWNERS ?? ""),
  };
}

/** The `Filed for <repo>#<n>` lines of a body: `[{repo, number}]`. */
export function markers(body) {
  return [...String(body ?? "").matchAll(MARKER_LINE)].map((match) => ({ repo: match[1], number: Number(match[2]) }));
}

/** Parses and checks the whole input against this repository. Returns the normalized issue or throws a refusal; sends nothing. */
export function validate(text, ourRepo) {
  if (text.length > MAX_INPUT) throw refuse(`the input is ${text.length} characters; the limit is ${MAX_INPUT}`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refuse("the input is not valid JSON");
  }
  if (!isObject(raw)) throw refuse("the input must be one JSON object");
  const unknown = Object.keys(raw).filter((key) => !["repo", "title", "body", "labels"].includes(key));
  if (unknown.length > 0) throw refuse(`unknown field ${unknown.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}`);
  let repo = ALLOWED_REPOS[0];
  if (raw.repo !== undefined) {
    const wanted = typeof raw.repo === "string" ? ALLOWED_REPOS.find((name) => name.toLowerCase() === raw.repo.trim().toLowerCase()) : undefined;
    if (wanted === undefined) throw refuse(`repo is not allowed; the allowed repositories are ${ALLOWED_REPOS.join(", ")}`);
    repo = wanted;
  }
  if (typeof raw.title !== "string" || raw.title.trim() === "") throw refuse("title must be a non-empty string");
  const title = raw.title.trim();
  if (title.length > MAX_TITLE) throw refuse(`the title is ${title.length} characters; the limit is ${MAX_TITLE}`);
  if (CONTROL.test(title)) throw refuse("the title must be one line without control characters");
  if (typeof raw.body !== "string" || raw.body.trim() === "") throw refuse("body must be a non-empty string");
  if (raw.body.length > MAX_BODY) throw refuse(`the body is ${raw.body.length} characters; the limit is ${MAX_BODY}`);
  if (BODY_CONTROL.test(raw.body)) throw refuse("the body holds control characters");
  const found = markers(raw.body);
  if (found.length !== 1) throw refuse(`the body must hold exactly one line "Filed for ${ourRepo}#<n>" (found ${found.length})`);
  if (lower(found[0].repo) !== lower(ourRepo)) throw refuse(`the marker line must name ${ourRepo}, the issue this serves`);
  let labels = [];
  if (raw.labels !== undefined) {
    if (!Array.isArray(raw.labels) || raw.labels.length > MAX_LABELS) throw refuse(`labels must be a list of at most ${MAX_LABELS} names`);
    for (const name of raw.labels) {
      if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_LABEL || CONTROL.test(name) || name.includes(",")) throw refuse(`a label must be a short name of at most ${MAX_LABEL} characters, one line, no comma`);
    }
    labels = [...new Set(raw.labels.map((name) => name.trim()))];
  }
  return { repo, title, body: raw.body, labels, marker: found[0] };
}

const issueUrl = (repo, number) => `https://github.com/${repo}/issues/${number}`;

/**
 * Reads the issue of ours that the marker names and refuses unless it exists, is an issue (never a pull request), and an owner
 * labeled it `status:approved` at some point (its events, oldest first). `ours` is the client for this repository (GITHUB_TOKEN,
 * read only). An unreadable answer refuses too. Sends no write.
 */
export async function checkApproved(ours, config, number) {
  const path = `/repos/${config.repo}/issues/${number}`;
  const answer = await ours.rest("GET", path, undefined, [404]);
  if (answer.status === 404) throw refuse(`${config.repo}#${number} does not exist`);
  if (!isObject(answer.data) || answer.data.pull_request !== undefined) throw refuse(`${config.repo}#${number} is not an issue`);
  for (let page = 1; page <= MAX_EVENT_PAGES; page++) {
    const events = (await ours.rest("GET", `${path}/events?per_page=100&page=${page}`)).data;
    if (!Array.isArray(events)) throw new WriteError(`GET /issues/${number}/events: the events could not be read`);
    for (const event of events) {
      if (event?.event === "labeled" && event.label?.name === APPROVED && config.owners.includes(lower(event.actor?.login))) return;
    }
    if (events.length < 100) break;
  }
  throw refuse(`${config.repo}#${number} has no ${APPROVED} label set by an owner (ISSUE_FLOW_OWNERS); the owner approves the issue first`);
}

/**
 * The issue the token's owner already filed in the target for the same marker line or with the same title (any state, a pull
 * request never), or null; with the count of that owner's issues created there within the last 24 hours (newest first, pull
 * requests excluded) for the daily cap. Fails closed: an unreadable answer, or more issues than MAX_LIST_PAGES pages, refuses.
 */
export async function findExisting(client, issue, now = Date.now) {
  const user = (await client.rest("GET", "/user")).data;
  if (!isObject(user) || typeof user.login !== "string" || !/^[A-Za-z0-9][\w.-]*(\[bot\])?$/.test(user.login)) throw new WriteError("GET /user: the token owner could not be read");
  const wantedTitle = issue.title.toLowerCase();
  const since = now() - DAY_MS;
  let recent = 0;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const list = (await client.rest("GET", `/repos/${issue.repo}/issues?creator=${encodeURIComponent(user.login)}&state=all&sort=created&direction=desc&per_page=100&page=${page}`)).data;
    if (!Array.isArray(list)) throw new WriteError(`GET /issues: the list of ${issue.repo} could not be read`);
    for (const item of list) {
      if (!isObject(item) || item.pull_request !== undefined || !Number.isSafeInteger(item.number) || item.number <= 0) continue;
      const sameTitle = typeof item.title === "string" && item.title.trim().toLowerCase() === wantedTitle;
      const sameMarker = markers(item.body).some((found) => lower(found.repo) === lower(issue.marker.repo) && found.number === issue.marker.number);
      if (sameTitle || sameMarker) return { existing: { number: item.number, why: sameMarker ? "same marker line" : "same title" }, recent };
      const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : Number.NaN;
      if (Number.isFinite(created) && created >= since) recent += 1;
    }
    if (list.length < 100) return { existing: null, recent };
  }
  throw refuse(`the token owner has more than ${MAX_LIST_PAGES * 100} issues in ${issue.repo}; cannot rule out a duplicate`);
}

async function create(client, issue) {
  const payload = { title: issue.title, body: issue.body };
  if (issue.labels.length > 0) payload.labels = issue.labels;
  const { data } = await client.rest("POST", `/repos/${issue.repo}/issues`, payload);
  if (!isObject(data) || !Number.isSafeInteger(data.number) || data.number <= 0) throw new WriteError("POST /issues: no issue number in the answer");
  const applied = Array.isArray(data.labels) ? data.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter((name) => typeof name === "string") : [];
  return { number: data.number, applied };
}

/**
 * Runs the whole input. `log(line)` is called with each progress line. Returns `{code, outcome, message, url, number, repo, ...}`;
 * it writes nothing itself. A missing or malformed variable throws a WriteError with code 2.
 */
export async function run(env, log = () => {}, now = Date.now) {
  const config = readConfig(env);
  const base = { repo: config.repo, actor: config.actor, target: "", url: "", number: 0 };
  const finish = (code, outcome, message = "", extra = {}) => ({ code, outcome, message, ...base, ...extra });
  const refused = (message) => finish(1, "Refused, nothing created", message);
  if (config.attempt !== "1") return refused("this is a re-run (GITHUB_RUN_ATTEMPT is not 1); dispatch again instead");
  for (const [who, name] of [[config.actor, "dispatcher"], [config.triggering, "triggering actor"]]) {
    if (lower(who) === "" || !config.owners.includes(lower(who))) return refused(`the ${name} is not an owner (ISSUE_FLOW_OWNERS)`);
  }
  let issue;
  try {
    issue = validate(config.inputText, config.repo);
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    return finish(error.code, "Refused, nothing created", error.message);
  }
  base.target = issue.repo;
  const client = makeClient(config);
  // Our own repository is read with the workflow's token; the owner's token never goes there, and neither token goes to the other API.
  const ours = makeClient({ ...config, token: config.ourToken });
  const clean = (text) => client.clean(ours.clean(text));
  const fail = (error, stage) => {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof WriteError;
    return finish(1, safe && error.refused ? "Refused, nothing created" : stage, safe ? clean(error.message) : "unexpected error", { target: issue.repo });
  };
  let found;
  try {
    await checkApproved(ours, config, issue.marker.number);
    found = await findExisting(client, issue, now);
  } catch (error) {
    return fail(error, "Failed before creating anything");
  }
  const { existing, recent } = found;
  if (existing === null && recent >= DAILY_CAP) return refused(`${recent} issues by the token's user were created in ${issue.repo} in the last 24 hours (${DAILY_CAP} or more are refused); wait, or file it by hand`);
  if (existing !== null) {
    const url = issueUrl(issue.repo, existing.number);
    log(`existing ${url} (${existing.why}); nothing created`);
    return finish(0, `existing ${url}`, "", { target: issue.repo, url, number: existing.number, kind: "existing" });
  }
  let made;
  try {
    made = await create(client, issue);
  } catch (error) {
    return fail(error, "Failed while creating the issue (read the target before dispatching again)");
  }
  const url = issueUrl(issue.repo, made.number);
  if (issue.labels.length > 0) {
    const applied = issue.labels.filter((name) => made.applied.some((got) => got.toLowerCase() === name.toLowerCase()));
    const dropped = issue.labels.filter((name) => !applied.includes(name));
    log(`labels applied: ${applied.length === 0 ? "none" : applied.join(", ")}${dropped.length === 0 ? "" : `; not applied by the target: ${dropped.join(", ")}`}`);
  }
  return finish(0, `created ${url}`, "", { target: issue.repo, url, number: made.number, kind: "created" });
}

/** One line, always starting with `upstream-issue:`: newlines in a message cannot start a fake log line or a `::` command. */
const logLine = (text) => `upstream-issue: ${String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ")}\n`;

/** The Markdown summary: the target, the dispatcher, and the outcome. Never a title, a body, or a label name. */
export function formatSummary({ repo, actor, target, outcome, message }) {
  return [
    "### Upstream issue",
    "",
    `Dispatched by \`${cell(actor) || "unknown"}\` from \`${repo}\`${target === "" ? "" : `, target \`${target}\``}.`,
    "",
    `**${cell(outcome)}**${message ? `: ${cell(message)}` : ""}`,
    "",
  ].join("\n");
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
    writeSummary(env, `### Upstream issue\n\n**Not run**: ${cell(message)}\n`);
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

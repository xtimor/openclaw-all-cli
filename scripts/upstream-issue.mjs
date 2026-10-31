#!/usr/bin/env node
// Files one issue in an allow-listed upstream repository, or comments once on the owner's own issue there, with the owner's personal token. It runs inside the `Upstream issue`
// workflow (.github/workflows/upstream-issue.yml): a cloud session's proxy swaps the owner's session credentials, which are scoped
// to this repository, into every api.github.com request, so a session cannot write to openclaw/openclaw. The owner stored a
// personal token as the environment secret GH_PUBLIC_TOKEN instead; a session dispatches the workflow (scripts/upstream-issue.sh).
// Agent-neutral and dependency-free. Design: docs/agents/identity.md ("Upstream issues"), tickets 3.23 and 3.24.
//
//   UPSTREAM_ISSUE='{"title":"...","body":"...\nFiled for xtimor/openclaw-all-cli#45"}' GH_PUBLIC_TOKEN=<token> \
//     GITHUB_REPOSITORY=owner/repo GITHUB_ACTOR=<dispatcher> GITHUB_TRIGGERING_ACTOR=<who started the run> \
//     ISSUE_FLOW_OWNERS=owner GITHUB_RUN_ATTEMPT=1 node scripts/upstream-issue.mjs
//
// Input (one JSON object, at most 40 000 characters). Create (the default; `op` absent or "create"): title (one line, at most 256),
// body (at most 30 000; exactly one line `Filed for <this repository>#<n>`, the issue of ours it serves), labels? (at most 5), repo?
// (only an ALLOWED_REPOS entry, default the first). Comment (ticket 3.24): {"op":"comment","issue":<number in the target>,"body":...}
// with the same body rules and repo?. Nothing else. Everything is validated before the first request; a refusal sends nothing.
// Approved issues only (ticket 3.23, security review): the marker's issue of ours must exist, be an issue, and have had `status:approved`
// labeled by an owner's own click (ISSUE_FLOW_OWNERS, a person, not made through a GitHub App; read with GITHUB_TOKEN, `issues: read`, from the repository's own events). "The owner asks"
// means the owner approves that issue first. A cap refuses a third new issue in 24 hours by the token's user in the target.
// Idempotent: before creating, it lists the issues the token's owner created in the target (`GET /user`, then `GET /issues?creator=`,
// which is consistent at once, unlike search) and returns the one with the same marker line or the same title instead of creating.
// Labels: GitHub drops, without an error, labels that a user without triage rights sets; the log says which were applied.
// Comment guards (ticket 3.24), on top of the above (same approval check of the marker's issue, same actors, attempt, and limits): the
// target issue must exist, not be a pull request, and have been opened by the token's user (the owner commenting on their own report);
// idempotent: a comment by the token's user on that issue that already carries the same `Filed for` line (same round: a later reply
// carries `(reply N)`, ticket 3.26) is returned, not repeated. The input never carries a round (validate refuses it); the Upstream
// post workflow passes `replyBefore` to run(), and the round is then 1 plus the highest round among the token user's comments on the
// target thread that name the same issue of ours and were created before that time; such a comment at or after it is this draft's
// own post, returned as existing (readReplyRounds)
// (listed before anything is written, fail closed past MAX_COMMENT_PAGES pages); a cap refuses a sixth comment in 24 hours by the
// token's user across the target (counted on the token user's own issues there, the only ones this operation can reach). The one
// write is `POST /issues/<n>/comments`: it never edits, closes, reopens, or labels anything.
//
// Environment: UPSTREAM_ISSUE, GH_PUBLIC_TOKEN (the owner's token, upstream only), GITHUB_TOKEN (the workflow's, this repository only, read),
// GITHUB_REPOSITORY, GITHUB_ACTOR, GITHUB_TRIGGERING_ACTOR, GITHUB_RUN_ATTEMPT (must be
// "1"), ISSUE_FLOW_OWNERS (both actors must be in it), GITHUB_API_URL (default https://api.github.com), GITHUB_STEP_SUMMARY,
// GITHUB_OUTPUT (gets `result=<the final line>`; the workflow turns it into an annotation a session can read by REST).
// The final line is `created|commented|existing <url>` (a comment's URL ends in `#issuecomment-<id>`).
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
export const COMMENT_CAP = 5; // comments by the token's user in the target within DAY_MS; the next one is refused
const MAX_COMMENT_PAGES = 10; // 1000 comments on one issue
const MAX_CAP_READS = 60; // requests the cap count may spend; more refuses (cannot count)
const MAX_NUMBER = 999_999_999; // the marker's limit too
const DAY_MS = 24 * 60 * 60 * 1000;
const APPROVED = "status:approved";
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/; // a title or a label
const BODY_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/; // a body may hold newlines and tabs
// An optional round for a later reply on the same target (ticket 3.26): `Filed for <repo>#<n> (reply 2)`. No suffix is round 1.
const MARKER_LINE = /^Filed for ([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)#([1-9]\d{0,8})(?: \(reply ([2-9]|[1-9]\d)\))?[ \t\r]*$/gm;

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

/** The `Filed for <repo>#<n>` lines of a body: `[{repo, number, round}]` (`round` is 1 without a `(reply N)` suffix). */
export function markers(body) {
  return [...String(body ?? "").matchAll(MARKER_LINE)].map((match) => ({ repo: match[1], number: Number(match[2]), round: match[3] === undefined ? 1 : Number(match[3]) }));
}

const KEYS = { create: ["repo", "title", "body", "labels"], comment: ["repo", "issue", "body"] };

/** Parses and checks the whole input against this repository. Returns the normalized request or throws a refusal; sends nothing. */
export function validate(text, ourRepo) {
  if (text.length > MAX_INPUT) throw refuse(`the input is ${text.length} characters; the limit is ${MAX_INPUT}`);
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    throw refuse("the input is not valid JSON");
  }
  if (!isObject(raw)) throw refuse("the input must be one JSON object");
  const op = raw.op === undefined ? "create" : raw.op;
  if (op !== "create" && op !== "comment") throw refuse('op must be "create" (the default) or "comment"');
  const unknown = Object.keys(raw).filter((key) => key !== "op" && !KEYS[op].includes(key));
  if (unknown.length > 0) throw refuse(`unknown field ${unknown.slice(0, 3).map((key) => JSON.stringify(key.slice(0, 40))).join(", ")}${op === "comment" ? " (a comment takes op, issue, body, repo)" : ""}`);
  let repo = ALLOWED_REPOS[0];
  if (raw.repo !== undefined) {
    const wanted = typeof raw.repo === "string" ? ALLOWED_REPOS.find((name) => name.toLowerCase() === raw.repo.trim().toLowerCase()) : undefined;
    if (wanted === undefined) throw refuse(`repo is not allowed; the allowed repositories are ${ALLOWED_REPOS.join(", ")}`);
    repo = wanted;
  }
  let title = "";
  if (op === "create") {
    if (typeof raw.title !== "string" || raw.title.trim() === "") throw refuse("title must be a non-empty string");
    title = raw.title.trim();
    if (title.length > MAX_TITLE) throw refuse(`the title is ${title.length} characters; the limit is ${MAX_TITLE}`);
    if (CONTROL.test(title)) throw refuse("the title must be one line without control characters");
  } else if (!Number.isSafeInteger(raw.issue) || raw.issue <= 0 || raw.issue > MAX_NUMBER) {
    throw refuse(`issue must be the number of an issue in ${repo} (a positive integer)`);
  }
  if (typeof raw.body !== "string" || raw.body.trim() === "") throw refuse("body must be a non-empty string");
  if (raw.body.length > MAX_BODY) throw refuse(`the body is ${raw.body.length} characters; the limit is ${MAX_BODY}`);
  if (BODY_CONTROL.test(raw.body)) throw refuse("the body holds control characters");
  const found = markers(raw.body);
  if (found.length !== 1) throw refuse(`the body must hold exactly one line "Filed for ${ourRepo}#<n>" (found ${found.length})`);
  if (lower(found[0].repo) !== lower(ourRepo)) throw refuse(`the marker line must name ${ourRepo}, the issue this serves`);
  // A round is never chosen by the caller (input, env, or an agent's draft): the Upstream post workflow numbers a reply through the `replyBefore` option of run().
  if (found[0].round !== 1) throw refuse("the marker line takes no (reply N); the Upstream post workflow numbers later replies itself");
  if (op === "comment") return { op, repo, issue: raw.issue, body: raw.body, marker: found[0] };
  let labels = [];
  if (raw.labels !== undefined) {
    if (!Array.isArray(raw.labels) || raw.labels.length > MAX_LABELS) throw refuse(`labels must be a list of at most ${MAX_LABELS} names`);
    for (const name of raw.labels) {
      if (typeof name !== "string" || name.trim() === "" || name.trim().length > MAX_LABEL || CONTROL.test(name) || name.includes(",")) throw refuse(`a label must be a short name of at most ${MAX_LABEL} characters, one line, no comma`);
    }
    labels = [...new Set(raw.labels.map((name) => name.trim()))];
  }
  return { op, repo, title, body: raw.body, labels, marker: found[0] };
}

const issueUrl = (repo, number) => `https://github.com/${repo}/issues/${number}`;

/**
 * A `labeled` event for `label` that is the owner's own click: the actor is an owner and a person (never a bot), and the event was not
 * made through a GitHub App. A Claude session writes with the owner's credentials, so its events show the owner's login but carry
 * `performed_via_github_app` (ticket 3.25, security review): they do not count as the owner's approval.
 */
export function isOwnersOwnClick(event, owners, label) {
  return (
    isObject(event) &&
    event.event === "labeled" &&
    event.label?.name === label &&
    owners.includes(lower(event.actor?.login)) &&
    (event.actor?.type ?? "User") === "User" &&
    event.performed_via_github_app == null
  );
}

/**
 * Reads the issue of ours that the marker names and refuses unless it exists, is an issue (never a pull request), and an owner
 * labeled it `status:approved` at some point, as the owner's own click (its events, oldest first; see isOwnersOwnClick). `ours` is the client for this repository (GITHUB_TOKEN,
 * read only). An unreadable answer refuses too. Sends no write. Returns the issue as fetched (title, body).
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
      if (isOwnersOwnClick(event, config.owners, APPROVED)) return answer.data;
    }
    if (events.length < 100) break;
  }
  throw refuse(`${config.repo}#${number} has no ${APPROVED} label set by an owner (ISSUE_FLOW_OWNERS) with their own click, not through an app or an agent session; the owner approves the issue first`);
}

/** The login of the token's user (`GET /user`); an unreadable or odd answer fails closed. */
export async function readUser(client) {
  const user = (await client.rest("GET", "/user")).data;
  if (!isObject(user) || typeof user.login !== "string" || !/^[A-Za-z0-9][\w.-]*(\[bot\])?$/.test(user.login)) throw new WriteError("GET /user: the token owner could not be read");
  return user.login;
}

/**
 * The issue the token's owner already filed in the target for the same marker line or with the same title (any state, a pull
 * request never), or null; with the count of that owner's issues created there within the last 24 hours (newest first, pull
 * requests excluded) for the daily cap. Fails closed: an unreadable answer, or more issues than MAX_LIST_PAGES pages, refuses.
 */
export async function findExisting(client, issue, now = Date.now) {
  const user = { login: await readUser(client) };
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

// A comment is the same one when marker and round agree: a later reply (round 2, 3, ...) on the same target is a new comment.
const sameMarker = (body, wanted) => markers(body).some((found) => lower(found.repo) === lower(wanted.repo) && found.number === wanted.number && found.round === wanted.round);
const commentUrl = (repo, issue, id) => `${issueUrl(repo, issue)}#issuecomment-${id}`;

/**
 * Reads the target issue and refuses unless it exists, is an issue (never a pull request), and was opened by the token's user: the
 * owner comments on their own report, never on someone else's issue. Sends no write.
 */
export async function checkTarget(client, request, login) {
  const answer = await client.rest("GET", `/repos/${request.repo}/issues/${request.issue}`, undefined, [404, 410]);
  if (answer.status === 404 || answer.status === 410) throw refuse(`${request.repo}#${request.issue} does not exist`);
  const data = answer.data;
  if (!isObject(data) || data.number !== request.issue) throw new WriteError(`GET /issues/${request.issue}: the issue could not be read`);
  if (data.pull_request !== undefined) throw refuse(`${request.repo}#${request.issue} is a pull request, not an issue`);
  const author = isObject(data.user) ? data.user.login : undefined;
  if (typeof author !== "string" || lower(author) !== lower(login)) throw refuse(`${request.repo}#${request.issue} was not opened by the token's user; a comment goes only on the owner's own issues`);
}

/**
 * The comment by the token's user on the target issue that already carries the request's marker line, or null. Comments are
 * listed oldest first; fails closed on an unreadable answer or past MAX_COMMENT_PAGES pages.
 */
export async function findExistingComment(client, request, login) {
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const list = (await client.rest("GET", `/repos/${request.repo}/issues/${request.issue}/comments?per_page=100&page=${page}`)).data;
    if (!Array.isArray(list)) throw new WriteError(`GET /issues/${request.issue}/comments: the comments could not be read`);
    for (const item of list) {
      if (!isObject(item) || !isObject(item.user) || lower(item.user.login) !== lower(login) || !Number.isSafeInteger(item.id) || item.id <= 0) continue;
      if (sameMarker(item.body, request.marker)) return { id: item.id };
    }
    if (list.length < 100) return null;
  }
  throw refuse(`${request.repo}#${request.issue} has more than ${MAX_COMMENT_PAGES * 100} comments; cannot rule out a duplicate`);
}

/**
 * Reads the target thread to number a reply (ticket 3.26): the comments by the token's user whose marker line names the same issue of
 * ours (any round; no suffix is round 1). Returns `{ highest, posted }`:
 *   - `highest`: the highest round among those created strictly before `beforeMs` (the creation time of the draft being posted), 0 when
 *     there is none. The reply is round `highest + 1`. A deleted comment or a marker added later to an old comment cannot shift a reply
 *     that is already posted, because of `posted`.
 *   - `posted`: the earliest such comment created at or after `beforeMs`, `{id}`, else null. It can only be this draft's own post (a
 *     dispatch posts round 1 only, and the draft is the latest implementation comment), so the draft is already posted.
 * The thread is written only with the owner's token, so neither an agent nor the state of our own comments can change the answer. Fails
 * closed on an unreadable answer or past MAX_COMMENT_PAGES pages.
 */
export async function readReplyRounds(client, request, login, beforeMs) {
  let highest = 0;
  let posted = null;
  for (let page = 1; page <= MAX_COMMENT_PAGES; page++) {
    const list = (await client.rest("GET", `/repos/${request.repo}/issues/${request.issue}/comments?per_page=100&page=${page}`)).data;
    if (!Array.isArray(list)) throw new WriteError(`GET /issues/${request.issue}/comments: the thread could not be read to number the reply`);
    for (const item of list) {
      if (!isObject(item) || !isObject(item.user) || lower(item.user.login) !== lower(login) || !Number.isSafeInteger(item.id) || item.id <= 0) continue;
      const created = typeof item.created_at === "string" ? Date.parse(item.created_at) : Number.NaN;
      if (!Number.isFinite(created)) continue;
      const rounds = markers(item.body).filter((found) => lower(found.repo) === lower(request.marker.repo) && found.number === request.marker.number).map((found) => found.round);
      if (rounds.length === 0) continue;
      if (created < beforeMs) highest = Math.max(highest, ...rounds);
      else if (posted === null || created < posted.created) posted = { id: item.id, created };
    }
    if (list.length < 100) return { highest, posted: posted === null ? null : { id: posted.id } };
  }
  throw refuse(`${request.repo}#${request.issue} has more than ${MAX_COMMENT_PAGES * 100} comments; cannot number the reply`);
}

const MAX_ROUND = 99;
const FIRST_MARKER = /^Filed for [A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+#[1-9]\d{0,8}[ \t\r]*$/m;

/** The request with `(reply N)` on its one marker line (round 2 or later); round 1 stays as it is. */
function withRound(request, round) {
  if (round === 1) return request;
  return { ...request, body: request.body.replace(FIRST_MARKER, (line) => `${line.trimEnd()} (reply ${round})`), marker: { ...request.marker, round } };
}

/**
 * Counts the comments by the token's user in the target within the last 24 hours, across the user's own issues there (the only ones
 * this operation can comment on): the issues they opened and that were updated in that time, then each one's recent comments.
 * Stops as soon as COMMENT_CAP is reached. Fails closed: an unreadable answer, or more pages or requests than the limits, refuses.
 */
export async function countRecentComments(client, request, login, now = Date.now) {
  const since = now() - DAY_MS;
  const stamp = encodeURIComponent(new Date(since).toISOString());
  let reads = 0;
  const read = async (path) => {
    reads += 1;
    if (reads > MAX_CAP_READS) throw refuse(`cannot count the token user's comments in ${request.repo}: more than ${MAX_CAP_READS} requests needed`);
    const { data } = await client.rest("GET", path);
    if (!Array.isArray(data)) throw new WriteError(`GET ${path.split("?")[0].replace(/^\/repos\/[^/]+\/[^/]+/, "")}: the list could not be read`);
    return data;
  };
  let count = 0;
  for (let page = 1; page <= MAX_LIST_PAGES; page++) {
    const issues = await read(`/repos/${request.repo}/issues?creator=${encodeURIComponent(login)}&state=all&since=${stamp}&sort=updated&direction=desc&per_page=100&page=${page}`);
    for (const item of issues) {
      if (!isObject(item) || item.pull_request !== undefined || !Number.isSafeInteger(item.number) || item.number <= 0 || item.comments === 0) continue;
      for (let at = 1; at <= MAX_COMMENT_PAGES; at++) {
        const comments = await read(`/repos/${request.repo}/issues/${item.number}/comments?since=${stamp}&per_page=100&page=${at}`);
        for (const comment of comments) {
          if (!isObject(comment) || !isObject(comment.user) || lower(comment.user.login) !== lower(login)) continue;
          const created = typeof comment.created_at === "string" ? Date.parse(comment.created_at) : Number.NaN;
          if (Number.isFinite(created) && created >= since) count += 1;
        }
        if (count >= COMMENT_CAP) return count;
        if (comments.length < 100) break;
        if (at === MAX_COMMENT_PAGES) throw refuse(`${request.repo}#${item.number} has too many recent comments to count`);
      }
    }
    if (issues.length < 100) return count;
  }
  throw refuse(`the token user has more than ${MAX_LIST_PAGES * 100} recently updated issues in ${request.repo}; cannot count their comments`);
}

/**
 * A comment is tied to the issue of ours it serves: that issue's title or body must name the target, as `<repo>#<n>` or as
 * `https://github.com/<repo>/issues/<n>`, with the number matched exactly (`#1729` is not `#172969`). So one approved issue allows
 * comments only on the upstream issues it names, not on every issue of the owner. Refuses otherwise; sends no write.
 */
export function checkNamesTarget(ourIssue, config, request) {
  const escaped = request.repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const names = new RegExp(`(?<![\\w./-])(?:${escaped}#|https://github\\.com/${escaped}/issues/)${request.issue}(?!\\d)`, "i");
  const text = `${typeof ourIssue?.title === "string" ? ourIssue.title : ""}\n${typeof ourIssue?.body === "string" ? ourIssue.body : ""}`;
  if (!names.test(text)) throw refuse(`${config.repo}#${request.marker.number} does not name ${request.repo}#${request.issue} in its title or body; the approved issue must name the issue it comments on`);
}

async function postComment(client, request) {
  const { data } = await client.rest("POST", `/repos/${request.repo}/issues/${request.issue}/comments`, { body: request.body });
  if (!isObject(data) || !Number.isSafeInteger(data.id) || data.id <= 0) throw new WriteError("POST /comments: no comment id in the answer");
  return { id: data.id };
}

/** The comment operation: approval of the marker's issue, then the target issue, an existing comment, the daily cap, the one POST. */
async function runComment({ config, issue: asked, client, ours, log, now, finish, fail, nothing, replyBefore }) {
  let login;
  let existing;
  let issue = asked;
  try {
    checkNamesTarget(await checkApproved(ours, config, issue.marker.number), config, issue);
    login = await readUser(client);
    await checkTarget(client, issue, login);
    // The workflow that numbers replies passes the creation time of its draft: the round is 1 plus the comments of ours already on the thread.
    if (replyBefore !== undefined) {
      const { highest, posted } = await readReplyRounds(client, issue, login, replyBefore);
      if (posted !== null) {
        existing = posted; // this draft's own post
      } else {
        if (highest + 1 > MAX_ROUND) throw refuse(`this thread already holds replies up to round ${highest} for ${config.repo}#${issue.marker.number}; the limit is ${MAX_ROUND - 1}`);
        issue = withRound(issue, highest + 1);
        existing = null; // nothing of ours at or after the draft, and every earlier round is lower than this one
      }
    } else {
      existing = await findExistingComment(client, issue, login);
    }
    if (existing === null) {
      const recent = await countRecentComments(client, issue, login, now);
      if (recent >= COMMENT_CAP) throw refuse(`${recent} comments by the token's user were posted in ${issue.repo} in the last 24 hours (${COMMENT_CAP} or more are refused); wait, or comment by hand`);
    }
  } catch (error) {
    return fail(error, "Failed before commenting");
  }
  const target = issue.repo;
  if (existing !== null) {
    const url = commentUrl(target, issue.issue, existing.id);
    log(`existing ${url} (same marker line); nothing posted`);
    return finish(0, `existing ${url}`, "", { target, url, number: existing.id, kind: "existing" });
  }
  let made;
  try {
    made = await postComment(client, issue);
  } catch (error) {
    return fail(error, "Failed while commenting (read the issue before dispatching again)");
  }
  const url = commentUrl(target, issue.issue, made.id);
  return finish(0, `commented ${url}`, "", { target, url, number: made.id, kind: "commented" });
}

/** Whether the input asks for a comment, judged before any check, so a refusal for the actors or the shape says the right thing. */
const asksForComment = (text) => {
  try {
    return isObject(JSON.parse(text)) && JSON.parse(text).op === "comment";
  } catch {
    return false;
  }
};

/**
 * Runs the whole input. `log(line)` is called with each progress line. Returns `{code, outcome, message, url, number, repo, ...}`;
 * it writes nothing itself. A missing or malformed variable throws a WriteError with code 2.
 */
export async function run(env, log = () => {}, now = Date.now, options = {}) {
  // Only the Upstream post workflow passes `replyBefore` (ms): the creation time of its draft. It is an option of this call, never read from env or input.
  const replyBefore = Number.isFinite(options?.replyBefore) ? options.replyBefore : undefined;
  const config = readConfig(env);
  const base = { repo: config.repo, actor: config.actor, target: "", url: "", number: 0 };
  const finish = (code, outcome, message = "", extra = {}) => ({ code, outcome, message, ...base, ...extra });
  const nothing = asksForComment(config.inputText) ? "Refused, nothing posted" : "Refused, nothing created";
  const refused = (message) => finish(1, nothing, message);
  if (config.attempt !== "1") return refused("this is a re-run (GITHUB_RUN_ATTEMPT is not 1); dispatch again instead");
  for (const [who, name] of [[config.actor, "dispatcher"], [config.triggering, "triggering actor"]]) {
    if (lower(who) === "" || !config.owners.includes(lower(who))) return refused(`the ${name} is not an owner (ISSUE_FLOW_OWNERS)`);
  }
  let issue;
  try {
    issue = validate(config.inputText, config.repo);
  } catch (error) {
    if (!(error instanceof WriteError)) throw error;
    return finish(error.code, nothing, error.message);
  }
  base.target = issue.repo;
  const comment = issue.op === "comment";
  const client = makeClient(config);
  // Our own repository is read with the workflow's token; the owner's token never goes there, and neither token goes to the other API.
  const ours = makeClient({ ...config, token: config.ourToken });
  const clean = (text) => client.clean(ours.clean(text));
  const fail = (error, stage) => {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof WriteError;
    return finish(1, safe && error.refused ? nothing : stage, safe ? clean(error.message) : "unexpected error", { target: issue.repo });
  };
  if (comment) return runComment({ config, issue, client, ours, log, now, finish, fail, nothing, replyBefore });
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

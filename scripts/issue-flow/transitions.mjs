// The deterministic part of the issue flow (design: _bmad-output/.../epic-distribution/issue-flow.md; user doc: docs/issues.md).
// Pure and dependency-free: an event and the issue's state go in, a list of actions comes out. No network, no model.
// apply.mjs runs the actions against GitHub from .github/workflows/issue-flow.yml.
//
// Issue and PR text is data. Only two things are read from it: the link keywords (`linkedIssues`) and, from the
// payload, the author login. Nothing is evaluated, and no text is copied into a comment.

/** The 8 states of .github/labels.yml, in lifecycle order. Exactly one is set on an open issue. */
export const STATUS_LABELS = Object.freeze([
  "status:new",
  "status:needs-info",
  "status:triaged",
  "status:approved",
  "status:planned",
  "status:in-progress",
  "status:in-review",
  "status:blocked",
]);

export const NEW = "status:new";
export const NEEDS_INFO = "status:needs-info";
export const APPROVED = "status:approved";
export const IN_PROGRESS = "status:in-progress";
export const PLANNED = "status:planned";
export const IN_REVIEW = "status:in-review";
export const BLOCKED = "status:blocked";

/** Days a `needs-info` issue may stay silent before the daily job closes it. */
export const STALE_DAYS = 14;

/** The actor whose events the workflow itself causes; never handled again (no loops). */
export const BOT_LOGIN = "github-actions[bot]";

const DAY_MS = 24 * 60 * 60 * 1000;
// Marks the automation's own comments; fixed text, no issue data inside.
const MARKER = "<!-- issue-flow -->";

export const NON_OWNER_APPROVAL_COMMENT = `${MARKER}\nOnly the owner approves an issue for development. The \`${APPROVED}\` label was removed and the previous status restored.`;

/** The comment for a reverted approval. `once` is a hidden key the apply layer looks for, so one label event gets one comment. */
export function approvalComment(eventId) {
  const key = `<!-- issue-flow:approval:${eventId} -->`;
  return { op: "comment", body: `${NON_OWNER_APPROVAL_COMMENT}\n${key}`, once: key };
}
export const STALE_COMMENT = `${MARKER}\nNo reply for ${STALE_DAYS} days, so this issue is closed as not planned. Reopen it to continue; it returns to \`${NEW}\`.`;

const isStatus = (label) => STATUS_LABELS.includes(label);
const lower = (value) => (typeof value === "string" ? value.toLowerCase() : "");

/** True for the workflow's own identity. */
export function isBot(login) {
  return lower(login) === BOT_LOGIN;
}

/** `"a, B"` or `["a", "B"]` to `["a", "b"]`; anything else (unset, empty) to no owners. */
export function parseOwners(value) {
  const parts = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  return parts.map((part) => (typeof part === "string" ? part.trim().toLowerCase() : "")).filter((part) => part !== "");
}

function isOwner(login, owners) {
  const wanted = lower(login);
  return wanted !== "" && parseOwners(owners).includes(wanted);
}

/**
 * Accepts a REST issue (`labels` as objects or names, `user.login`, `updated_at`, `pull_request`) or an
 * already normalized one, and returns `{number, state, labels, author, updatedAt, isPullRequest}`.
 */
export function normalizeIssue(raw) {
  const issue = raw ?? {};
  const labels = Array.isArray(issue.labels)
    ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter((name) => typeof name === "string")
    : [];
  return {
    number: issue.number,
    state: issue.state === "closed" ? "closed" : "open",
    labels,
    author: issue.user?.login ?? issue.author ?? null,
    updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
    isPullRequest: Boolean(issue.pull_request ?? issue.isPullRequest),
  };
}

const addLabel = (label) => ({ op: "addLabel", label });
const removeLabel = (label) => ({ op: "removeLabel", label });
const comment = (body) => ({ op: "comment", body });

/** Exactly `target` among the status labels: add it if missing, then remove every other one. */
function setStatus(issue, target) {
  const actions = issue.labels.includes(target) ? [] : [addLabel(target)];
  for (const label of issue.labels) if (isStatus(label) && label !== target) actions.push(removeLabel(label));
  return actions;
}

/** No status label at all. */
function clearStatus(issue) {
  return issue.labels.filter(isStatus).map(removeLabel);
}

/**
 * The label timeline: `labeled` events as `{id, label, actor, createdAt}`, oldest first. Accepts the REST events of
 * `GET /repos/{o}/{r}/issues/{n}/events` (other event kinds are dropped) or already normalized entries.
 */
export function normalizeTimeline(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw) {
    if (!item || (item.event !== undefined && item.event !== "labeled")) continue;
    const label = typeof item.label === "string" ? item.label : item.label?.name;
    if (typeof label !== "string") continue;
    const time = Date.parse(item.createdAt ?? item.created_at ?? "");
    entries.push({
      id: item.id ?? null,
      label,
      actor: (typeof item.actor === "string" ? item.actor : item.actor?.login) ?? null,
      createdAt: item.createdAt ?? item.created_at ?? null,
      time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY,
      index: entries.length,
    });
  }
  // Stable: equal times keep the order GitHub returned them in.
  return entries.sort((a, b) => a.time - b.time || a.index - b.index);
}

/** True when the labels alone cannot settle the status: several status labels, or an approval whose author matters. */
export function needsTimeline(rawIssue) {
  const issue = normalizeIssue(rawIssue);
  if (issue.state !== "open") return false;
  const statuses = issue.labels.filter(isStatus);
  return statuses.length > 1 || statuses.includes(APPROVED);
}

/** Status label to `{rank, actor, id}` of its latest `labeled` event; a later rank was labeled later. */
function latestLabeled(timeline, event) {
  const latest = new Map();
  normalizeTimeline(timeline).forEach((entry, rank) => {
    if (isStatus(entry.label)) latest.set(entry.label, { rank, actor: entry.actor, id: entry.id });
  });
  // The event being handled counts as the newest one when the timeline does not show it (not read, or lagging).
  if (event?.action === "labeled" && isStatus(event.label) && !latest.has(event.label)) {
    latest.set(event.label, { rank: Number.POSITIVE_INFINITY, actor: event.actor ?? null, id: "event" });
  }
  return latest;
}

/**
 * The status an issue should have, from its current labels and its label timeline. Order-independent and idempotent,
 * so parallel runs for one issue converge: a closed issue has no status; every `status:approved` whose latest
 * `labeled` event is by a non-owner is dropped (one comment per event); of the status labels left, the most recently
 * labeled one stays (labels with no event rank below those with one, then by lifecycle order); none left means `new`.
 */
function reconcile(issue, { timeline, owners, event }) {
  if (issue.state === "closed") return clearStatus(issue);
  const statuses = issue.labels.filter(isStatus);
  const latest = latestLabeled(timeline, event);
  let kept = statuses;
  let reverted = null;
  if (statuses.includes(APPROVED)) {
    const approval = latest.get(APPROVED);
    if (approval && !isOwner(approval.actor, owners)) {
      reverted = approval;
      kept = statuses.filter((label) => label !== APPROVED);
    }
  }
  const order = (label) => STATUS_LABELS.indexOf(label);
  const rank = (label) => latest.get(label)?.rank ?? Number.NEGATIVE_INFINITY;
  const target =
    kept.length === 0 ? NEW : kept.reduce((best, label) => (rank(label) > rank(best) || (rank(label) === rank(best) && order(label) > order(best)) ? label : best));
  const actions = setStatus(issue, target);
  if (reverted) actions.push(approvalComment(reverted.id ?? "event"));
  return actions;
}

function onIssues(event, issue, owners, timeline) {
  if (isBot(event.actor)) return [];
  if (event.action === "opened" || event.action === "reopened") {
    return issue.state === "open" ? setStatus(issue, NEW) : clearStatus(issue);
  }
  // closed, labeled, unlabeled: settle the status from the issue as it is now, whatever the event was.
  if (event.action === "closed" || event.action === "labeled" || event.action === "unlabeled") return reconcile(issue, { timeline, owners, event });
  return [];
}

function onComment(event, issue) {
  if (event.action !== "created" || isBot(event.actor)) return [];
  if (issue.state !== "open" || !issue.labels.includes(NEEDS_INFO)) return [];
  if (lower(event.actor) === "" || lower(event.actor) !== lower(issue.author)) return [];
  return setStatus(issue, NEW);
}

function onPullRequest(event, issue) {
  const kind = event.link === "fixes" ? "fixes" : event.link === "refs" ? "refs" : null;
  if (kind === null) return [];
  const has = (label) => issue.labels.includes(label);
  if (event.action === "opened" || event.action === "edited" || event.action === "reopened") {
    // Only an issue being worked on moves to review (in-review stays); a body edited after the PR closed changes nothing.
    if (event.prState === "closed" || issue.state !== "open") return [];
    return has(IN_PROGRESS) || has(IN_REVIEW) ? setStatus(issue, IN_REVIEW) : [];
  }
  if (event.action !== "closed") return [];
  if (event.merged === true) {
    // A merged `Fixes` closes the issue (GitHub does it, or the `closed` event clears the status); its status goes only
    // once it is closed, so a merge into a non-default branch leaves an open issue alone.
    if (kind === "fixes") return issue.state === "closed" ? clearStatus(issue) : [];
    return issue.state === "open" && has(IN_REVIEW) ? setStatus(issue, PLANNED) : [];
  }
  return issue.state === "open" && has(IN_REVIEW) ? setStatus(issue, BLOCKED) : [];
}

function onStale(issue) {
  if (issue.state !== "open" || !issue.labels.includes(NEEDS_INFO)) return [];
  return [comment(STALE_COMMENT), ...clearStatus(issue), { op: "close", reason: "not_planned" }];
}

/**
 * Decides what to do for one issue.
 *
 * event: `{name: "issues" | "issue_comment" | "pull_request" | "stale", action, actor, label?, merged?, prState?, link?}`
 *   - `issues`: `action` opened | reopened | closed | labeled | unlabeled; `label` is the added label.
 *   - `issue_comment`: `action` created; `actor` is the commenter.
 *   - `pull_request`: `action` opened | edited | reopened | closed; `link` is `fixes` or `refs` (how its body links this
 *     issue); `merged`, `prState` open | closed.
 *   - `stale`: the daily job found the issue.
 * issue: a REST issue or a normalized one (`normalizeIssue`), as read now.
 * options: `owners` (logins that may approve) and `timeline` (the issue's label events, see `normalizeTimeline`; read it
 *   when `needsTimeline(issue)`).
 * Returns `[{op: "addLabel" | "removeLabel", label} | {op: "comment", body} | {op: "close", reason}]`, in the order to apply.
 */
export function decide(event, issue, { owners = [], timeline = [] } = {}) {
  const current = normalizeIssue(issue);
  if (current.isPullRequest || !event) return [];
  switch (event.name) {
    case "issues":
      return onIssues(event, current, owners, timeline);
    case "issue_comment":
      return onComment(event, current);
    case "pull_request":
      return onPullRequest(event, current);
    case "stale":
      return onStale(current);
    default:
      return [];
  }
}

const LINK = /\b(fixes|closes|resolves|refs)\b:?[ \t]+(?:([\w.-]{1,100}\/[\w.-]{1,100}))?#(\d{1,9})\b/gi;

/**
 * The issues a PR body links: `Fixes|Closes|Resolves #N` (kind `fixes`) and `Refs #N` (kind `refs`), case-insensitive.
 * Only `#N` of this repository counts; `other/repo#N` is ignored (`owner/repo#N` of `repo` itself counts). If one number
 * is linked twice, `fixes` wins. Returns `[{number, kind}]` in order of first appearance.
 */
export function linkedIssues(body, repo) {
  if (typeof body !== "string" || body === "") return [];
  const here = lower(repo);
  const found = new Map();
  for (const match of body.matchAll(LINK)) {
    const [, keyword, qualified, digits] = match;
    if (qualified !== undefined && (here === "" || lower(qualified) !== here)) continue;
    const number = Number(digits);
    if (!Number.isSafeInteger(number) || number < 1) continue;
    const kind = lower(keyword) === "refs" ? "refs" : "fixes";
    if (found.get(number) !== "fixes") found.set(number, kind);
  }
  return [...found].map(([number, kind]) => ({ number, kind }));
}

/**
 * The open issues in `needs-info` whose last update is at least `days` days before `now` (a Date or epoch ms).
 * Pull requests and issues with an unreadable date are skipped. Returns the given objects, in the given order.
 */
export function staleIssues(issues, now, days = STALE_DAYS) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Array.isArray(issues) || !Number.isFinite(at)) return [];
  return issues.filter((raw) => {
    const issue = normalizeIssue(raw);
    if (issue.isPullRequest || issue.state !== "open" || !issue.labels.includes(NEEDS_INFO)) return false;
    const updated = Date.parse(issue.updatedAt ?? "");
    return Number.isFinite(updated) && at - updated >= days * DAY_MS;
  });
}

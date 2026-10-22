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

function onIssues(event, issue, owners) {
  if (isBot(event.actor)) return [];
  if (event.action === "opened" || event.action === "reopened") {
    return issue.state === "open" ? setStatus(issue, NEW) : clearStatus(issue);
  }
  if (event.action !== "labeled") return [];

  const added = event.label;
  // Not a state label, or already taken off again by the time this run reads the issue.
  if (!isStatus(added) || !issue.labels.includes(added)) return [];
  const foreignApproval = added === APPROVED && !isOwner(event.actor, owners);

  if (issue.state === "closed") return [...clearStatus(issue), ...(foreignApproval ? [comment(NON_OWNER_APPROVAL_COMMENT)] : [])];
  if (!foreignApproval) return setStatus(issue, added);

  // The previous status is the one other status label left on the issue; none, or an ambiguous pile, means `new`.
  const others = issue.labels.filter((label) => isStatus(label) && label !== APPROVED);
  return [...setStatus(issue, others.length === 1 ? others[0] : NEW), comment(NON_OWNER_APPROVAL_COMMENT)];
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
  if (event.action === "opened" || event.action === "edited" || event.action === "reopened") {
    // A body edited after the PR was closed changes nothing.
    if (event.prState === "closed" || issue.state !== "open") return [];
    return setStatus(issue, IN_REVIEW);
  }
  if (event.action !== "closed") return [];
  if (event.merged === true) {
    // GitHub closes the issue of a merged `Fixes`; it keeps no status. A merged `Refs` proposal moves it to `planned`.
    if (kind === "fixes") return clearStatus(issue);
    return issue.state === "open" ? setStatus(issue, PLANNED) : [];
  }
  return issue.state === "open" ? setStatus(issue, BLOCKED) : [];
}

function onStale(issue) {
  if (issue.state !== "open" || !issue.labels.includes(NEEDS_INFO)) return [];
  return [comment(STALE_COMMENT), ...clearStatus(issue), { op: "close", reason: "not_planned" }];
}

/**
 * Decides what to do for one issue.
 *
 * event: `{name: "issues" | "issue_comment" | "pull_request" | "stale", action, actor, label?, merged?, prState?, link?}`
 *   - `issues`: `action` opened | reopened | labeled; `label` is the added label.
 *   - `issue_comment`: `action` created; `actor` is the commenter.
 *   - `pull_request`: `action` opened | edited | reopened | closed; `link` is `fixes` or `refs` (how its body links this
 *     issue); `merged`, `prState` open | closed.
 *   - `stale`: the daily job found the issue.
 * issue: a REST issue or a normalized one (`normalizeIssue`), as read now.
 * Returns `[{op: "addLabel" | "removeLabel", label} | {op: "comment", body} | {op: "close", reason}]`, in the order to apply.
 */
export function decide(event, issue, { owners = [] } = {}) {
  const current = normalizeIssue(issue);
  if (current.isPullRequest || !event) return [];
  switch (event.name) {
    case "issues":
      return onIssues(event, current, owners);
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

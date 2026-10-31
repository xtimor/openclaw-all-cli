// The deterministic part of the issue flow (design: _bmad-output/.../epic-distribution/issue-flow.md; user doc: docs/issues.md).
// Pure and dependency-free: an event and the issue's state go in, a list of actions comes out. No network, no model.
// apply.mjs runs the actions against GitHub from .github/workflows/issue-flow.yml.
//
// Issue and PR text is data. Only two things are read from it: the link keywords (`linkedIssues`) and, from the
// payload, the author login. Nothing is evaluated, and no text is copied into a comment.

/** The 12 states of .github/labels.yml, in lifecycle order. Exactly one is set on an open issue. */
export const STATUS_LABELS = Object.freeze([
  "status:todo",
  "status:needs-info",
  "status:triaged",
  "status:approved",
  "status:planned",
  "status:in-progress",
  "status:in-review",
  "status:blocked",
  "status:declined",
  "status:awaiting-post",
  "status:upstream",
  "status:rework",
]);

/** Waiting for triage: filed, reopened, or answered by the author (ticket 3.27 renamed it from `new`). */
export const TODO = "status:todo";
/**
 * Former status names. GitHub label events keep the name a label had when the event happened, so the history of a renamed
 * label still says the old name; every place that reads label events counts it as the current name.
 */
export const LEGACY_STATUS = Object.freeze({ "status:new": TODO });
/** The status a label name stands for: the current name of a renamed one, else the name itself. */
const canonical = (label) => (typeof label === "string" && Object.hasOwn(LEGACY_STATUS, label) ? LEGACY_STATUS[label] : label);
export const NEEDS_INFO = "status:needs-info";
export const APPROVED = "status:approved";
export const IN_PROGRESS = "status:in-progress";
export const PLANNED = "status:planned";
export const IN_REVIEW = "status:in-review";
export const BLOCKED = "status:blocked";
export const DECLINED = "status:declined";
/** An agent's upstream draft is ready and only the owner acts (adds `upstream:post`). Set by the implementation agent; never stale. */
export const AWAITING_POST = "status:awaiting-post";
/** The draft was published upstream and the maintainers act. Set only by the `Upstream post` workflow; never stale (the owner closes it). */
export const UPSTREAM = "status:upstream";
/**
 * The owner sent the result back with comments (ticket 3.28); their own click is the authorization, no triage and no earlier approval. Counts only as the owner's own click, exactly like
 * `status:approved`: the implementation agent builds on it, so anyone else's (or an app's) is reverted. Never stale; triage skips it.
 */
export const REWORK = "status:rework";
/** The statuses that start agent work and so count only when the owner clicks them (not a non-owner, not an owner through an app). */
export const OWNER_ONLY_STATUSES = Object.freeze([APPROVED, REWORK]);

/**
 * The statuses the daily job closes when an issue stays in one of them: waiting for the author, or for the owner after an agent declined it.
 * `awaiting-post` and `upstream` are not here: the first is the owner's open task, the second waits for people outside this repository.
 */
export const STALE_STATUSES = Object.freeze([NEEDS_INFO, DECLINED]);

/** Days an issue may stay in a stale status (counted from the latest time the label was added) before the daily job closes it. */
export const STALE_DAYS = 30;

/** The actor whose events the workflow itself causes; never handled again (no loops). */
export const BOT_LOGIN = "github-actions[bot]";

const DAY_MS = 24 * 60 * 60 * 1000;
// Marks the automation's own comments; fixed text, no issue data inside.
const MARKER = "<!-- issue-flow -->";

export const NON_OWNER_APPROVAL_COMMENT = `${MARKER}\nOnly the owner approves an issue for development, with their own click in GitHub (not through an app or an agent session). The \`${APPROVED}\` label was removed; the issue keeps the status it had, or \`${TODO}\` if it had none. If you are the owner, add the label again yourself.`;
export const NON_OWNER_REWORK_COMMENT = `${MARKER}\nOnly the owner sends work back with \`${REWORK}\`, with their own click in GitHub (not through an app or an agent session). The \`${REWORK}\` label was removed; the issue keeps the status it had, or \`${TODO}\` if it had none. If you are the owner, add the label again yourself.`;

/** The comment for a reverted approval. `once` is a hidden key the apply layer looks for, so one label event gets one comment. */
export function approvalComment(eventId) {
  const key = `<!-- issue-flow:approval:${eventId} -->`;
  return { op: "comment", body: `${NON_OWNER_APPROVAL_COMMENT}\n${key}`, once: key };
}

/** The comment for a reverted `status:rework`; the hidden key is distinct from the approval's, so one label event gets one comment. */
export function reworkComment(eventId) {
  const key = `<!-- issue-flow:rework:${eventId} -->`;
  return { op: "comment", body: `${NON_OWNER_REWORK_COMMENT}\n${key}`, once: key };
}

// GitHub logins: letters, digits, hyphens (and `_` of managed users). A bot login (`name[bot]`) or anything else gets no mention.
const LOGIN_RE = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,38})$/;

/**
 * The comment for a stale close. A valid human login is mentioned, so GitHub notifies the author; an empty, bot, or
 * malformed login gives the same text without a mention. The login is checked against LOGIN_RE and is the only issue data used.
 */
export function staleComment(login) {
  const author = typeof login === "string" && LOGIN_RE.test(login) ? login : null;
  const subject = author === null ? "This issue has" : `@${author}, this issue has`;
  return `${MARKER}\n${subject} been in \`${NEEDS_INFO}\` for ${STALE_DAYS} days without a reply, so it is closed as not planned. Reopen it to continue; it returns to \`${TODO}\`.`;
}

/**
 * The stale-close comment for a `declined` issue: the author and every owner are mentioned (a valid login each, once), so GitHub
 * notifies them. The owner decides; an untouched issue is closed after STALE_DAYS. Logins are checked against LOGIN_RE.
 */
export function declinedStaleComment(login, owners = []) {
  const seen = new Set();
  const people = [login, ...parseOwners(owners)].filter((name) => {
    const ok = typeof name === "string" && LOGIN_RE.test(name) && !seen.has(name.toLowerCase());
    if (ok) seen.add(name.toLowerCase());
    return ok;
  });
  const who = people.length === 0 ? "This issue has" : `${people.map((name) => `@${name}`).join(", ")}: this issue has`;
  return `${MARKER}\n${who} been in \`${DECLINED}\` for ${STALE_DAYS} days without a decision, so it is closed as not planned. Reopen it to continue; it returns to \`${TODO}\`.`;
}

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
 * already normalized one, and returns `{number, state, labels, names, author, updatedAt, isPullRequest}`. `labels` reads a literal old
 * status name (`status:new`, see LEGACY_STATUS) as its current name, once; `names` keeps the literal names, because that is what a
 * label removal must send. Between a merge and the label sync the old label can still be on an issue, and it already counts as its status.
 */
export function normalizeIssue(raw) {
  const issue = raw ?? {};
  const names = Array.isArray(issue.rawLabels)
    ? issue.rawLabels.filter((name) => typeof name === "string")
    : Array.isArray(issue.labels)
      ? issue.labels.map((label) => (typeof label === "string" ? label : label?.name)).filter((name) => typeof name === "string")
      : [];
  return {
    number: issue.number,
    state: issue.state === "closed" ? "closed" : "open",
    labels: [...new Set(names.map(canonical))],
    rawLabels: names,
    author: issue.user?.login ?? issue.author ?? null,
    updatedAt: issue.updated_at ?? issue.updatedAt ?? null,
    isPullRequest: Boolean(issue.pull_request ?? issue.isPullRequest),
  };
}

const addLabel = (label) => ({ op: "addLabel", label });
const removeLabel = (label) => ({ op: "removeLabel", label });
const comment = (body) => ({ op: "comment", body });

/**
 * Exactly `target` among the status labels: add it if missing, then remove every other one. A literal old name of `target`
 * already counts as the label (never add its new name beside it); it goes only when the new name is on the issue too.
 */
function setStatus(issue, target) {
  const actions = issue.labels.includes(target) ? [] : [addLabel(target)];
  for (const name of issue.rawLabels) {
    const label = canonical(name);
    if (!isStatus(label)) continue;
    if (label !== target || (name !== label && issue.rawLabels.includes(label))) actions.push(removeLabel(name));
  }
  return actions;
}

/** No status label at all (a literal old name is removed under that name). */
function clearStatus(issue) {
  return issue.rawLabels.filter((name) => isStatus(canonical(name))).map(removeLabel);
}

/**
 * The label timeline: `labeled` and `unlabeled` events as `{id, kind, label, actor, createdAt, time}`, oldest first.
 * Accepts the REST events of `GET /repos/{o}/{r}/issues/{n}/events` (other event kinds are dropped) or already
 * normalized entries (`kind` defaults to `labeled`).
 */
export function normalizeTimeline(raw) {
  if (!Array.isArray(raw)) return [];
  const entries = [];
  for (const item of raw) {
    const kind = item?.event ?? item?.kind ?? "labeled";
    if (!item || (kind !== "labeled" && kind !== "unlabeled")) continue;
    const named = typeof item.label === "string" ? item.label : item.label?.name;
    if (typeof named !== "string") continue;
    const label = canonical(named);
    const time = Date.parse(item.createdAt ?? item.created_at ?? "");
    entries.push({
      id: item.id ?? null,
      kind,
      label,
      actor: (typeof item.actor === "string" ? item.actor : item.actor?.login) ?? null,
      // Set when the event was made through a GitHub App (a Claude session writes with the owner's login and shows `performed_via_github_app`).
      viaApp: item.viaApp === true || (item.performed_via_github_app != null && item.performed_via_github_app !== false),
      createdAt: item.createdAt ?? item.created_at ?? null,
      time: Number.isFinite(time) ? time : Number.NEGATIVE_INFINITY,
      index: entries.length,
    });
  }
  // Stable: equal times keep the order GitHub returned them in.
  return entries.sort((a, b) => a.time - b.time || a.index - b.index);
}

/** Whether the timeline shows a `labeled` event for `label` (an old status name counts as its current one). */
export function timelineHasLabeled(timeline, label) {
  const wanted = canonical(label);
  return normalizeTimeline(timeline).some((entry) => entry.kind === "labeled" && entry.label === wanted);
}

/** Whether `label` is one of the statuses (an old name counts). */
export const isStatusName = (label) => isStatus(canonical(label));

/**
 * True when the labels alone cannot settle the status: several status labels, an approval or a rework whose author matters, or an
 * opened/reopened event that must not override a status labeled after it.
 */
export function needsTimeline(rawIssue, event) {
  const issue = normalizeIssue(rawIssue);
  if (issue.state !== "open") return false;
  const statuses = issue.labels.filter(isStatus);
  const opening = event?.action === "opened" || event?.action === "reopened";
  return statuses.length > 1 || statuses.some((label) => OWNER_ONLY_STATUSES.includes(label)) || (opening && statuses.length > 0);
}

/**
 * Reads the timeline: `latest` maps a status label to `{rank, actor, id, time}` of its latest `labeled` event (a later
 * rank was labeled later), `entries` is the sorted timeline.
 */
function latestLabeled(timeline, event) {
  const latest = new Map();
  const entries = normalizeTimeline(timeline);
  entries.forEach((entry, rank) => {
    if (entry.kind === "labeled" && isStatus(entry.label)) latest.set(entry.label, { rank, actor: entry.actor, id: entry.id, time: entry.time, viaApp: entry.viaApp });
  });
  // The event being handled counts as the newest one when the timeline does not show it (not read, or lagging).
  const eventLabel = canonical(event?.label);
  if (event?.action === "labeled" && isStatus(eventLabel) && !latest.has(eventLabel)) {
    latest.set(eventLabel, { rank: Number.POSITIVE_INFINITY, actor: event.actor ?? null, id: "event", time: Number.POSITIVE_INFINITY });
  }
  return { latest, entries };
}

/** The status label (not an owner-only one) most recently unlabeled before `rank`, or null. */
function replacedBefore(entries, rank) {
  for (let i = Math.min(rank, entries.length) - 1; i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.kind === "unlabeled" && isStatus(entry.label) && !OWNER_ONLY_STATUSES.includes(entry.label)) return entry.label;
  }
  return null;
}

/**
 * The status an issue should have, from its current labels and its label timeline. Order-independent and idempotent,
 * so parallel runs for one issue converge: a closed issue has no status; every owner-only status (`status:approved`, `status:rework`) whose
 * latest `labeled` event is by a non-owner, or by an owner through a GitHub App (`performed_via_github_app`), is dropped (one comment per
 * event); of the status labels left, the most recently labeled one stays (labels with no event rank below those with one, then by
 * lifecycle order); none left means the status the foreign label replaced (the last one unlabeled before the earliest of them), else `todo`.
 */
function reconcile(issue, { timeline, owners, event }) {
  if (issue.state === "closed") return clearStatus(issue);
  const statuses = issue.labels.filter(isStatus);
  const { latest, entries } = latestLabeled(timeline, event);
  // The owner's own click only: an owner login on an event made through an app (an agent session) is reverted too.
  const reverted = [];
  for (const label of OWNER_ONLY_STATUSES) {
    const click = statuses.includes(label) ? latest.get(label) : undefined;
    if (click && (!isOwner(click.actor, owners) || click.viaApp === true)) reverted.push({ label, ...click });
  }
  const kept = statuses.filter((label) => !reverted.some((entry) => entry.label === label));
  const order = (label) => STATUS_LABELS.indexOf(label);
  const rank = (label) => latest.get(label)?.rank ?? Number.NEGATIVE_INFINITY;
  const restored = kept.length === 0 && reverted.length > 0 ? replacedBefore(entries, Math.min(...reverted.map((entry) => entry.rank))) : null;
  const target =
    kept.length === 0 ? (restored ?? TODO) : kept.reduce((best, label) => (rank(label) > rank(best) || (rank(label) === rank(best) && order(label) > order(best)) ? label : best));
  const actions = setStatus(issue, target);
  for (const entry of reverted) actions.push(entry.label === REWORK ? reworkComment(entry.id ?? "event") : approvalComment(entry.id ?? "event"));
  return actions;
}

function onIssues(event, issue, owners, timeline) {
  if (isBot(event.actor)) return [];
  if (event.action === "opened" || event.action === "reopened") {
    if (issue.state !== "open") return clearStatus(issue);
    // `todo` unless a current status was labeled after this event (that run's label wins, whichever run is first).
    const at = Date.parse(event.at ?? "");
    const { latest } = latestLabeled(timeline, null);
    const later = Number.isFinite(at) && issue.labels.some((label) => isStatus(label) && (latest.get(label)?.time ?? Number.NEGATIVE_INFINITY) > at);
    return later ? reconcile(issue, { timeline, owners, event }) : setStatus(issue, TODO);
  }
  // closed, labeled, unlabeled: settle the status from the issue as it is now, whatever the event was.
  if (event.action === "closed" || event.action === "labeled" || event.action === "unlabeled") return reconcile(issue, { timeline, owners, event });
  return [];
}

/** A comment that starts with one of these markers is an issue agent's (triage or implementation); it never counts as the author's reply. */
export const AGENT_MARKER_RE = /^\s*<!--\s*issue-(?:triage|impl)\s*-->/;

function onComment(event, issue, owners, agents) {
  // The issue agents write as an owner (no app configured) or as their own GitHub App (a login in `agents`); their marker
  // comment is never the author's reply. Anyone else's is. An agent login is not an owner, so it can never approve.
  if (event.action !== "created" || isBot(event.actor) || (event.agent === true && (isOwner(event.actor, owners) || isOwner(event.actor, agents)))) return [];
  if (issue.state !== "open" || !issue.labels.includes(NEEDS_INFO)) return [];
  if (lower(event.actor) === "" || lower(event.actor) !== lower(issue.author)) return [];
  return setStatus(issue, TODO);
}

function onPullRequest(event, issue, owners) {
  // Only a pull request from this repository, or by an owner, moves states; a fork or outsider PR changes nothing.
  const sameRepo = lower(event.repo) !== "" && lower(event.headRepo) === lower(event.repo);
  if (!sameRepo && !isOwner(event.author, owners)) return [];
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

/** The stale status an open issue carries (`needs-info` first), or null. */
export function staleStatus(rawIssue) {
  const issue = normalizeIssue(rawIssue);
  if (issue.isPullRequest || issue.state !== "open") return null;
  return STALE_STATUSES.find((label) => issue.labels.includes(label)) ?? null;
}

function onStale(issue, owners) {
  const status = staleStatus(issue);
  if (status === null) return [];
  const body = status === DECLINED ? declinedStaleComment(issue.author, owners) : staleComment(issue.author);
  return [comment(body), ...clearStatus(issue), { op: "close", reason: "not_planned" }];
}

/**
 * Decides what to do for one issue.
 *
 * event: `{name: "issues" | "issue_comment" | "pull_request" | "stale", action, actor, label?, merged?, prState?, link?}`
 *   - `issues`: `action` opened | reopened | closed | labeled | unlabeled; `label` is the added label.
 *   - `issue_comment`: `action` created; `actor` is the commenter.
 *   - `pull_request`: `action` opened | edited | reopened | closed; `link` is `fixes` or `refs` (how its body links this
 *     issue); `merged`, `prState` open | closed; `repo` (this repository, `owner/repo`), `headRepo` (the PR's head
 *     repository), `author`: it counts only when `headRepo` is `repo` or `author` is an owner.
 *   - opened | reopened also carry `at`, the event time (ISO).
 *   - `stale`: the daily job found the issue (in `needs-info` or `declined`; `owners` are mentioned on a declined one).
 * issue: a REST issue or a normalized one (`normalizeIssue`), as read now.
 * options: `owners` (logins that may approve), `agents` (logins of the issue agents' GitHub App; their marker comments are
 *   not replies, and they are not owners), and `timeline` (the issue's label events, see `normalizeTimeline`; read it
 *   when `needsTimeline(issue)`).
 * Returns `[{op: "addLabel" | "removeLabel", label} | {op: "comment", body} | {op: "close", reason}]`, in the order to apply.
 */
export function decide(event, issue, { owners = [], agents = [], timeline = [] } = {}) {
  const current = normalizeIssue(issue);
  if (current.isPullRequest || !event) return [];
  switch (event.name) {
    case "issues":
      return onIssues(event, current, owners, timeline);
    case "issue_comment":
      return onComment(event, current, owners, agents);
    case "pull_request":
      return onPullRequest(event, current, owners);
    case "stale":
      return onStale(current, owners);
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
 * When `label` (default `status:needs-info`) was last added: the latest `labeled` event for it in the issue's events (REST or
 * normalized, see `normalizeTimeline`), as epoch ms; null when there is none or its time is unreadable.
 */
export function statusSince(events, label = NEEDS_INFO) {
  let since = null;
  for (const entry of normalizeTimeline(events)) {
    if (entry.kind === "labeled" && entry.label === label && Number.isFinite(entry.time)) since = since === null ? entry.time : Math.max(since, entry.time);
  }
  return since;
}

/** `statusSince` for `status:needs-info`. */
export const needsInfoSince = (events) => statusSince(events, NEEDS_INFO);

/**
 * The open issues in `needs-info` or `declined` that have been in that status for at least `days` days before `now` (a Date or
 * epoch ms). `since` maps an issue number to the time its status label was last added (epoch ms, Date, or ISO string; a Map or a plain
 * object); an issue with no readable entry falls back to its last update. Pull requests and issues with no readable time
 * are skipped. Returns the given objects, in the given order.
 */
export function staleIssues(issues, now, days = STALE_DAYS, since = new Map()) {
  const at = now instanceof Date ? now.getTime() : Number(now);
  if (!Array.isArray(issues) || !Number.isFinite(at)) return [];
  const lookup = (number) => (since instanceof Map ? since.get(number) : since?.[number]);
  const toMs = (value) => (value instanceof Date ? value.getTime() : typeof value === "string" ? Date.parse(value) : typeof value === "number" ? value : Number.NaN);
  return issues.filter((raw) => {
    const issue = normalizeIssue(raw);
    if (staleStatus(issue) === null) return false;
    const labeled = toMs(lookup(issue.number));
    const from = Number.isFinite(labeled) ? labeled : Date.parse(issue.updatedAt ?? "");
    return Number.isFinite(from) && at - from >= days * DAY_MS;
  });
}

// Applies the decisions of transitions.mjs to GitHub. Entry points for .github/workflows/issue-flow.yml, which
// calls them from actions/github-script (`github` is its octokit, `context` the event, `core` the logger).
// No model, no text from an issue is evaluated; the owner list comes from the workflow's ISSUE_FLOW_OWNERS, the agent logins from ISSUE_FLOW_AGENTS.
import { STALE_DAYS, STALE_STATUSES, decide, isBot, isStatusName, linkedIssues, needsTimeline, parseOwners, staleIssues, staleStatus, statusSince, canonicalStatus, issueHasLabel, latestEventIsLabeled, OWNER_ONLY_STATUSES, AGENT_MARKER_RE } from "./transitions.mjs";

const EVENT_ATTEMPTS = 4; // the events list can lag a moment behind the event that started the run (as in scripts/upstream-post.mjs)
const EVENT_DELAY_MS = 2000;

/** Sending the label requests one by one keeps their order: the new status first, then the old ones go. */
export async function applyActions(github, context, issueNumber, actions) {
  const { owner, repo } = context.repo;
  const issues = github.rest.issues;
  const applied = [];
  let existing = null; // comment bodies, read once and only when a comment carries a `once` key
  for (const action of actions) {
    switch (action.op) {
      case "addLabel":
        await issues.addLabels({ owner, repo, issue_number: issueNumber, labels: [action.label] });
        break;
      case "removeLabel":
        try {
          await issues.removeLabel({ owner, repo, issue_number: issueNumber, name: action.label });
        } catch (error) {
          // Already gone (a second run, or a person removed it): the goal is met.
          if (error?.status !== 404) throw error;
        }
        break;
      case "comment":
        if (action.once) {
          existing ??= (await github.paginate(issues.listComments, { owner, repo, issue_number: issueNumber, per_page: 100 }))
            .filter((c) => isBot(c.user?.login)) // only our own comments count; anyone else can quote the key
            .map((c) => c.body ?? "");
          // A run that raced this one (or an earlier pass) already said it for this event.
          if (existing.some((body) => body.includes(action.once))) break;
        }
        await issues.createComment({ owner, repo, issue_number: issueNumber, body: action.body });
        break;
      case "close":
        await issues.update({ owner, repo, issue_number: issueNumber, state: "closed", state_reason: action.reason ?? "not_planned" });
        break;
      default:
        throw new Error(`issue-flow: unknown action ${JSON.stringify(action.op)}`);
    }
    applied.push(action);
  }
  return applied;
}

/** The issue's label events, oldest first, as the REST API returns them (the module keeps the `labeled` ones). */
async function readTimeline(github, context, issueNumber) {
  const { owner, repo } = context.repo;
  return github.paginate(github.rest.issues.listEvents, { owner, repo, issue_number: issueNumber, per_page: 100 });
}

async function readIssue(github, context, issueNumber) {
  const { owner, repo } = context.repo;
  try {
    return (await github.rest.issues.get({ owner, repo, issue_number: issueNumber })).data;
  } catch (error) {
    if (error?.status === 404) return null;
    throw error;
  }
}

const describeActions = (actions) => actions.map((action) => (action.label ? `${action.op} ${action.label}` : action.op)).join(", ");

/** Runs `work` for each item; one failure does not stop the rest, and the run fails at the end if any did. */
async function eachSafely(items, core, work) {
  const failures = [];
  for (const item of items) {
    try {
      await work(item);
    } catch (error) {
      failures.push(`#${item.number ?? item}: ${error?.message ?? error}`);
      core.warning(`issue-flow: ${failures.at(-1)}`);
    }
  }
  if (failures.length > 0) throw new Error(`issue-flow: ${failures.length} of ${items.length} failed: ${failures.join("; ")}`);
}

/**
 * Handles one `issues`, `issue_comment`, or `pull_request_target` event.
 * Returns `[{issue, actions}]` (the actions that were applied), for tests and the log.
 */
export async function runEvent({ github, context, core, env = process.env }) {
  const owners = parseOwners(env.ISSUE_FLOW_OWNERS);
  const agents = parseOwners(env.ISSUE_FLOW_AGENTS); // the agents' GitHub App bot login(s); never an owner
  const payload = context.payload ?? {};
  const sender = payload.sender?.login ?? null;
  const results = [];

  const handle = async (number, event) => {
    const issue = await readIssue(github, context, number);
    if (issue === null) {
      core.info(`issue-flow: #${number} not found, skipped`);
      return;
    }
    let timeline = [];
    if (event.name === "issues" && needsTimeline(issue, event)) {
      timeline = await readTimeline(github, context, number);
      // The handled status label's `labeled` event is not the latest event for it yet (not in the list, or only an older removal is): read
      // again a few times, as scripts/upstream-post.mjs does. Without it the author and the app flag of this click are unknown.
      const delay = String(env.ISSUE_FLOW_EVENT_DELAY_MS ?? "").trim() !== "" && Number.isFinite(Number(env.ISSUE_FLOW_EVENT_DELAY_MS)) ? Number(env.ISSUE_FLOW_EVENT_DELAY_MS) : EVENT_DELAY_MS;
      const handled = event.action === "labeled" && isStatusName(event.label) && issueHasLabel(issue, event.label) ? event.label : null;
      for (let attempt = 1; attempt < EVENT_ATTEMPTS && handled !== null && !latestEventIsLabeled(timeline, handled); attempt += 1) {
        await new Promise((done) => setTimeout(done, delay));
        timeline = await readTimeline(github, context, number);
      }
      // Still not there for an owner-only status (approved, rework): whose click it was cannot be told, and guessing "the owner's" would
      // let a stranger's click stand. Apply nothing; the owner's next event, or the next run of this workflow, settles it.
      if (handled !== null && !latestEventIsLabeled(timeline, handled) && OWNER_ONLY_STATUSES.includes(canonicalStatus(handled))) {
        core.warning(`issue-flow: #${number} the ${handled} label event was not found in the issue's events; nothing applied`);
        return;
      }
    }
    const actions = decide(event, issue, { owners, agents, timeline });
    if (actions.length === 0) {
      core.info(`issue-flow: #${number} nothing to do (${event.name} ${event.action})`);
      return;
    }
    const applied = await applyActions(github, context, number, actions);
    core.info(`issue-flow: #${number} ${event.name} ${event.action}: ${describeActions(applied)}`);
    results.push({ issue: number, actions: applied });
  };

  if (context.eventName === "issues" || context.eventName === "issue_comment") {
    const isComment = context.eventName === "issue_comment";
    if (isBot(sender)) {
      core.info("issue-flow: event of the workflow's own identity, ignored");
      return results;
    }
    if (!payload.issue || (isComment && payload.issue.pull_request)) return results;
    const actor = isComment ? (payload.comment?.user?.login ?? sender) : sender;
    // The time of an opened/reopened event: the issue's creation, or its last update (the reopen) as the event carried it.
    const at = payload.action === "opened" ? payload.issue.created_at : payload.issue.updated_at;
    await handle(payload.issue.number, { name: context.eventName, action: payload.action, actor, label: payload.label?.name, at, agent: isComment && AGENT_MARKER_RE.test(payload.comment?.body ?? "") });
    return results;
  }

  if (context.eventName === "pull_request_target") {
    const pr = payload.pull_request;
    if (!pr) return results;
    const { owner, repo } = context.repo;
    const links = linkedIssues(pr.body, `${owner}/${repo}`);
    await eachSafely(
      links.map((link) => ({ number: link.number, kind: link.kind })),
      core,
      (link) =>
        handle(link.number, {
          name: "pull_request",
          action: payload.action,
          actor: sender,
          repo: `${owner}/${repo}`,
          headRepo: pr.head?.repo?.full_name ?? null,
          author: pr.user?.login ?? null,
          link: link.kind,
          merged: pr.merged === true,
          prState: pr.state,
        }),
    );
    return results;
  }

  core.info(`issue-flow: event ${context.eventName} is not handled here`);
  return results;
}

/** `workflow_dispatch` lists only unless its `dry_run` input is exactly "false"; the schedule always acts. */
export function isDryRun(eventName, input) {
  return eventName === "workflow_dispatch" && String(input).trim().toLowerCase() !== "false";
}

/**
 * The daily job: close `needs-info` and `declined` issues that have been in that status for STALE_DAYS days, counted from the
 * latest time the label was added (the issue's events; the last update when they cannot be read). A declined issue's comment
 * mentions the author and the owners (`ISSUE_FLOW_OWNERS`). With `dryRun` only lists them.
 * Returns the numbers of the issues it closed (or, in a dry run, would close).
 */
export async function runStale({ github, context, core, dryRun = true, now = Date.now(), env = process.env }) {
  const { owner, repo } = context.repo;
  const owners = parseOwners(env.ISSUE_FLOW_OWNERS);
  const open = [];
  for (const label of STALE_STATUSES) {
    const found = await github.paginate(github.rest.issues.listForRepo, { owner, repo, state: "open", labels: label, per_page: 100 });
    for (const issue of found) if (!open.some((known) => known.number === issue.number)) open.push(issue);
  }
  const since = new Map();
  for (const issue of open) {
    if (issue.pull_request) continue;
    // The label is never newer than the last update, so an issue not updated for STALE_DAYS is stale without its events.
    const updated = Date.parse(issue.updated_at ?? "");
    if (Number.isFinite(updated) && now - updated >= STALE_DAYS * 24 * 60 * 60 * 1000) continue;
    try {
      const time = statusSince(await readTimeline(github, context, issue.number), staleStatus(issue));
      if (time !== null) since.set(issue.number, time);
    } catch (error) {
      // Unreadable events: the issue falls back to its last update (never earlier than the label, so never too early).
      core.warning(`issue-flow: #${issue.number} events not read, using its last update: ${error?.message ?? error}`);
    }
  }
  const stale = staleIssues(open, now, STALE_DAYS, since);
  core.info(`issue-flow: ${stale.length} stale issue(s) of ${open.length} in ${STALE_STATUSES.join(" or ")}${dryRun ? " (dry run, nothing changed)" : ""}`);
  const handled = [];
  await eachSafely(stale, core, async (issue) => {
    const actions = decide({ name: "stale" }, issue, { owners });
    if (actions.length === 0) return;
    if (dryRun) {
      const from = since.has(issue.number) ? `${staleStatus(issue)} since ${new Date(since.get(issue.number)).toISOString()}` : `last update ${issue.updated_at}`;
      core.info(`issue-flow: would close #${issue.number} as not planned (${from})`);
    } else {
      await applyActions(github, context, issue.number, actions);
      core.info(`issue-flow: closed #${issue.number} as not planned`);
    }
    handled.push(issue.number);
  });
  return handled;
}

import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * scripts/issue-flow (ticket 3.7): the pure decisions, and the GitHub calls against a fake octokit.
 * Every row of the matrix is a test; nothing here reaches the real GitHub API.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FLOW_DIR = join(ROOT, "scripts", "issue-flow");

type Action = { op: "addLabel" | "removeLabel"; label: string } | { op: "comment"; body: string; once?: string } | { op: "close"; reason: string };
interface IssueIn {
  number?: number;
  state?: "open" | "closed";
  labels?: Array<string | { name: string }>;
  user?: { login: string };
  author?: string;
  updated_at?: string;
  pull_request?: object;
}
interface Event {
  name: string;
  action?: string;
  actor?: string | null;
  label?: string;
  merged?: boolean;
  prState?: string;
  link?: string;
  at?: string;
  repo?: string;
  headRepo?: string | null;
  author?: string | null;
  agent?: boolean;
}
interface Transitions {
  STATUS_LABELS: string[];
  AWAITING_POST: string;
  UPSTREAM: string;
  STALE_DAYS: number;
  STALE_STATUSES: string[];
  AGENT_MARKER_RE: RegExp;
  NON_OWNER_APPROVAL_COMMENT: string;
  staleComment(login: unknown): string;
  declinedStaleComment(login: unknown, owners?: unknown): string;
  staleStatus(issue: IssueIn): string | null;
  statusSince(events: unknown, label?: string): number | null;
  needsInfoSince(events: unknown): number | null;
  decide(event: Event, issue: IssueIn, options?: { owners?: string[]; agents?: string[]; timeline?: unknown[] }): Action[];
  approvalComment(eventId: unknown): Action;
  needsTimeline(issue: IssueIn, event?: Event): boolean;
  normalizeTimeline(raw: unknown): Array<{ id: unknown; label: string; actor: string | null }>;
  linkedIssues(body: unknown, repo?: string): Array<{ number: number; kind: "fixes" | "refs" }>;
  staleIssues(issues: IssueIn[], now: Date | number, days?: number, since?: Map<number, unknown> | Record<number, unknown>): IssueIn[];
  parseOwners(value: unknown): string[];
  isBot(login: unknown): boolean;
}
interface Apply {
  applyActions(github: unknown, context: unknown, issueNumber: number, actions: Action[]): Promise<Action[]>;
  runEvent(args: { github: unknown; context: unknown; core: unknown; env?: Record<string, string> }): Promise<Array<{ issue: number; actions: Action[] }>>;
  runStale(args: { github: unknown; context: unknown; core: unknown; dryRun?: boolean; now?: number; env?: Record<string, string> }): Promise<number[]>;
  isDryRun(eventName: string, input: unknown): boolean;
}

// The scripts are plain .mjs with no type declarations; a variable specifier keeps TypeScript out of them.
const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(FLOW_DIR, file)).href)) as T;
const t = await load<Transitions>("transitions.mjs");
const apply = await load<Apply>("apply.mjs");

const OWNERS = ["xtimor"];
const REPO = "xtimor/openclaw-all-cli";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const DAY = 24 * 3600 * 1000;
const daysAgo = (days: number) => new Date(NOW - days * 24 * 3600 * 1000).toISOString();
const issue = (labels: string[], extra: IssueIn = {}): IssueIn => ({ number: 12, state: "open", labels, user: { login: "alice" }, ...extra });
const add = (label: string): Action => ({ op: "addLabel", label });
const remove = (label: string): Action => ({ op: "removeLabel", label });
/** A REST `labeled` event of the issue timeline; `minutes` after a fixed start. */
const labeledAt = (label: string, actor: string, minutes: number, id: number): Record<string, unknown> => ({
  id,
  event: "labeled",
  actor: { login: actor },
  created_at: new Date(Date.parse("2026-10-20T10:00:00Z") + minutes * 60_000).toISOString(),
  label: { name: label },
});
const revert = (id: unknown): Action => t.approvalComment(id);

describe("STATUS_LABELS", () => {
  it("are the 11 states of .github/labels.yml, in order", () => {
    const text = readFileSync(join(ROOT, ".github", "labels.yml"), "utf8");
    const fromFile = [...text.matchAll(/^- name: "(status:[^"]+)"/gm)].map((match) => match[1]);
    expect(fromFile).toHaveLength(11);
    expect(fromFile.slice(-3)).toEqual(["status:declined", "status:awaiting-post", "status:upstream"]);
    expect(t.STATUS_LABELS).toEqual(fromFile);
  });
});

describe("decide: issues", () => {
  it("OPENED: adds status:new and removes other status labels", () => {
    expect(t.decide({ name: "issues", action: "opened", actor: "alice" }, issue(["type:bug"]))).toEqual([add("status:new")]);
    expect(t.decide({ name: "issues", action: "opened", actor: "alice" }, issue(["status:triaged", "type:bug", "status:blocked"]))).toEqual([
      add("status:new"),
      remove("status:triaged"),
      remove("status:blocked"),
    ]);
  });

  it("OPENED: an issue that already has exactly status:new needs nothing", () => {
    expect(t.decide({ name: "issues", action: "opened", actor: "alice" }, issue(["status:new", "type:idea"]))).toEqual([]);
  });

  it("REOPENED: a reopened issue is status:new", () => {
    expect(t.decide({ name: "issues", action: "reopened", actor: "alice" }, issue(["status:needs-info"]))).toEqual([add("status:new"), remove("status:needs-info")]);
    expect(t.decide({ name: "issues", action: "reopened", actor: "alice" }, issue([]))).toEqual([add("status:new")]);
  });

  it("a closed issue keeps no status:*", () => {
    expect(t.decide({ name: "issues", action: "opened", actor: "alice" }, issue(["status:new", "type:bug"], { state: "closed" }))).toEqual([remove("status:new")]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "xtimor", label: "status:triaged" }, issue(["status:triaged", "type:bug"], { state: "closed" }))).toEqual([
      remove("status:triaged"),
    ]);
  });

  it("CLOSED: closing an issue removes every status:*", () => {
    const closed = { name: "issues", action: "closed", actor: "xtimor" };
    expect(t.decide(closed, issue(["status:in-review", "status:blocked", "type:bug"], { state: "closed" }))).toEqual([remove("status:in-review"), remove("status:blocked")]);
    expect(t.decide(closed, issue(["type:bug"], { state: "closed" }))).toEqual([]);
  });

  it("CLOSED: a close event that finds the issue open again (reopened meanwhile) leaves its status", () => {
    expect(t.decide({ name: "issues", action: "closed", actor: "xtimor" }, issue(["status:new"]))).toEqual([]);
  });

  it("UNLABELED: an open issue left with no status becomes new", () => {
    const unlabeled = { name: "issues", action: "unlabeled", actor: "bob", label: "status:triaged" };
    expect(t.decide(unlabeled, issue(["type:bug"]))).toEqual([add("status:new")]);
    expect(t.decide(unlabeled, issue(["status:in-review"]))).toEqual([]);
    expect(t.decide(unlabeled, issue(["type:bug"], { state: "closed" }))).toEqual([]);
    expect(t.decide({ ...unlabeled, label: "type:bug" }, issue(["status:triaged"]))).toEqual([]);
  });

  it("TWO_STATUS: a newly added status label wins and the others go", () => {
    const labeled = (label: string) => ({ name: "issues", action: "labeled", actor: "xtimor", label });
    expect(t.decide(labeled("status:triaged"), issue(["status:new", "status:triaged", "type:bug"]), { owners: OWNERS })).toEqual([remove("status:new")]);
    expect(t.decide(labeled("status:in-review"), issue(["status:triaged", "status:in-review", "status:blocked"]), { owners: OWNERS })).toEqual([
      remove("status:triaged"),
      remove("status:blocked"),
    ]);
  });

  it("TWO_STATUS: the most recently labeled status stays, from the timeline, whichever event is handled", () => {
    const labels = ["status:new", "status:triaged", "type:bug"];
    const timeline = [labeledAt("status:new", "alice", 0, 1), labeledAt("type:bug", "alice", 0, 2), labeledAt("status:triaged", "bob", 5, 3)];
    for (const label of ["status:new", "status:triaged", "type:bug"]) {
      expect(t.decide({ name: "issues", action: "labeled", actor: "x", label }, issue(labels), { owners: OWNERS, timeline })).toEqual([remove("status:new")]);
    }
    // Same labels, timeline the other way round: the other label stays, with the same result for either event.
    const flipped = [labeledAt("status:triaged", "bob", 0, 1), labeledAt("status:new", "alice", 5, 2)];
    for (const label of ["status:new", "status:triaged"]) {
      expect(t.decide({ name: "issues", action: "labeled", actor: "x", label }, issue(labels), { owners: OWNERS, timeline: flipped })).toEqual([remove("status:triaged")]);
    }
  });

  it("TWO_STATUS: a re-added label counts by its latest event; labels with no event rank lowest", () => {
    const labels = ["status:triaged", "status:blocked"];
    const timeline = [labeledAt("status:blocked", "bob", 0, 1), labeledAt("status:triaged", "bob", 1, 2), labeledAt("status:blocked", "bob", 2, 3)];
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "x" }, issue(labels), { timeline })).toEqual([remove("status:triaged")]);
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "x" }, issue(labels), { timeline: [labeledAt("status:triaged", "bob", 0, 1)] })).toEqual([remove("status:blocked")]);
    // No events at all: the label further along the lifecycle stays, the same every run.
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "x" }, issue(labels))).toEqual([remove("status:triaged")]);
  });

  it("a label that is not a status label changes nothing on a settled issue, and settles an unsettled one", () => {
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice", label: "type:bug" }, issue(["status:new", "type:bug"]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice", label: "status:triaged" }, issue(["status:new"]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice" }, issue(["status:new"]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice", label: "type:bug" }, issue(["type:bug"]))).toEqual([add("status:new")]);
  });

  it("NON_OWNER_APPROVED: removes approved, keeps the previous status, comments", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS })).toEqual([remove("status:approved"), revert("event")]);
  });

  it("NON_OWNER_APPROVED: no previous status gives status:new", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    expect(t.decide(event, issue(["status:approved", "type:bug"]), { owners: OWNERS })).toEqual([add("status:new"), remove("status:approved"), revert("event")]);
  });

  it("NON_OWNER_APPROVED: of several previous statuses the most recently labeled stays", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    const timeline = [labeledAt("status:blocked", "bob", 0, 1), labeledAt("status:triaged", "bob", 1, 2), labeledAt("status:approved", "mallory", 2, 3)];
    expect(t.decide(event, issue(["status:triaged", "status:blocked", "status:approved"]), { owners: OWNERS, timeline })).toEqual([
      remove("status:blocked"),
      remove("status:approved"),
      revert(3),
    ]);
  });

  it("NON_OWNER_APPROVED: an empty owner list makes everyone a non-owner", () => {
    const event = { name: "issues", action: "labeled", actor: "xtimor", label: "status:approved" };
    for (const options of [undefined, { owners: [] }, { owners: parseOwnersOf("") }]) {
      expect(t.decide(event, issue(["status:triaged", "status:approved"]), options)).toEqual([remove("status:approved"), revert("event")]);
    }
  });

  it("NON_OWNER_APPROVED: a missing actor is a non-owner", () => {
    const event = { name: "issues", action: "labeled", actor: null, label: "status:approved" };
    expect(t.decide(event, issue(["status:approved"]), { owners: OWNERS })[0]).toEqual(add("status:new"));
  });

  it("NON_OWNER_APPROVED: found from the timeline whichever event this run handles (a dropped or late run)", () => {
    const labels = ["status:triaged", "status:approved", "type:bug"];
    const timeline = [labeledAt("status:triaged", "xtimor", 0, 1), labeledAt("status:approved", "mallory", 3, 2), labeledAt("type:bug", "alice", 4, 3)];
    for (const event of [
      { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" },
      { name: "issues", action: "labeled", actor: "alice", label: "type:bug" },
      { name: "issues", action: "unlabeled", actor: "alice", label: "priority:p1" },
      { name: "issues", action: "labeled", actor: "xtimor", label: "status:triaged" },
    ]) {
      expect(t.decide(event, issue(labels), { owners: OWNERS, timeline })).toEqual([remove("status:approved"), revert(2)]);
    }
  });

  it("NON_OWNER_APPROVED: an approval is judged by its latest labeled event, not an older one", () => {
    const event = { name: "issues", action: "labeled", actor: "xtimor", label: "status:approved" };
    // The owner approved last (after a non-owner's label was removed and re-added): it stays.
    const ownerLast = [labeledAt("status:triaged", "bob", 0, 1), labeledAt("status:approved", "mallory", 1, 2), labeledAt("status:approved", "xtimor", 9, 3)];
    expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS, timeline: ownerLast })).toEqual([remove("status:triaged")]);
    // A non-owner re-added it after the owner had.
    const strangerLast = [labeledAt("status:triaged", "bob", 0, 1), labeledAt("status:approved", "xtimor", 1, 2), labeledAt("status:approved", "mallory", 9, 3)];
    expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS, timeline: strangerLast })).toEqual([remove("status:approved"), revert(3)]);
  });

  it("OWNER_APPROVED: a newer owner approval beats an older status, and an older approval loses to a newer status", () => {
    const labels = ["status:triaged", "status:approved"];
    const approvedNewer = [labeledAt("status:triaged", "bob", 0, 1), labeledAt("status:approved", "xtimor", 1, 2)];
    const triagedNewer = [labeledAt("status:approved", "xtimor", 0, 1), labeledAt("status:triaged", "bob", 1, 2)];
    for (const label of ["status:approved", "status:triaged"]) {
      const event = { name: "issues", action: "labeled", actor: "x", label };
      expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: approvedNewer })).toEqual([remove("status:triaged")]);
      expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: triagedNewer })).toEqual([remove("status:approved")]);
    }
  });

  it("OPENED / REOPENED: a status labeled after the event is kept; one labeled at or before it is reset to new", () => {
    const at = "2026-10-20T10:00:00Z";
    for (const action of ["opened", "reopened"]) {
      const event = { name: "issues", action, actor: "alice", at };
      const later = [labeledAt("status:new", "alice", 0, 1), labeledAt("status:triaged", "bob", 5, 2)];
      expect(t.decide(event, issue(["status:new", "status:triaged"]), { owners: OWNERS, timeline: later })).toEqual([remove("status:new")]);
      expect(t.decide(event, issue(["status:triaged"]), { owners: OWNERS, timeline: later })).toEqual([]);
      const before = [labeledAt("status:triaged", "bob", -5, 1)];
      expect(t.decide(event, issue(["status:triaged"]), { owners: OWNERS, timeline: before })).toEqual([add("status:new"), remove("status:triaged")]);
      // Same second counts as not later; no time or no timeline keeps the old rule.
      expect(t.decide(event, issue(["status:triaged"]), { owners: OWNERS, timeline: [labeledAt("status:triaged", "bob", 0, 1)] })).toEqual([add("status:new"), remove("status:triaged")]);
      expect(t.decide({ ...event, at: undefined }, issue(["status:triaged"]), { timeline: later })).toEqual([add("status:new"), remove("status:triaged")]);
      expect(t.decide(event, issue(["status:triaged"]))).toEqual([add("status:new"), remove("status:triaged")]);
      // A foreign approval labeled after the event is still reverted.
      const approved = [labeledAt("status:approved", "mallory", 5, 3)];
      expect(t.decide(event, issue(["status:approved"]), { owners: OWNERS, timeline: approved })).toEqual([add("status:new"), remove("status:approved"), revert(3)]);
    }
    expect(t.needsTimeline(issue(["status:triaged"]), { name: "issues", action: "opened" } as Event)).toBe(true);
    expect(t.needsTimeline(issue(["type:bug"]), { name: "issues", action: "opened" } as Event)).toBe(false);
    expect(t.needsTimeline(issue(["status:triaged"]))).toBe(false);
  });

  it("NON_OWNER_APPROVED: a replaced status comes back (unlabeled X, then labeled approved)", () => {
    const timeline = [
      labeledAt("status:triaged", "xtimor", 0, 1),
      { ...labeledAt("status:triaged", "mallory", 5, 2), event: "unlabeled" },
      labeledAt("status:approved", "mallory", 5, 3),
    ];
    for (const event of [
      { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" },
      { name: "issues", action: "unlabeled", actor: "mallory", label: "status:triaged" },
    ]) {
      expect(t.decide(event, issue(["status:approved"]), { owners: OWNERS, timeline })).toEqual([add("status:triaged"), remove("status:approved"), revert(3)]);
    }
    // Only an unlabeled event before the approval counts, and never the approval itself.
    const after = [labeledAt("status:approved", "mallory", 5, 3), { ...labeledAt("status:triaged", "mallory", 6, 4), event: "unlabeled" }];
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "mallory" }, issue(["status:approved"]), { owners: OWNERS, timeline: after })).toEqual([
      add("status:new"),
      remove("status:approved"),
      revert(3),
    ]);
    const self = [labeledAt("status:approved", "xtimor", 0, 1), { ...labeledAt("status:approved", "mallory", 1, 2), event: "unlabeled" }, labeledAt("status:approved", "mallory", 2, 3)];
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "mallory" }, issue(["status:approved"]), { owners: OWNERS, timeline: self })).toEqual([
      add("status:new"),
      remove("status:approved"),
      revert(3),
    ]);
    // The synthetic event of this run (timeline lagging) restores the last unlabeled status too.
    const lagging = [labeledAt("status:blocked", "bob", 0, 1), { ...labeledAt("status:blocked", "mallory", 5, 2), event: "unlabeled" }];
    expect(t.decide({ name: "issues", action: "labeled", actor: "mallory", label: "status:approved" }, issue(["status:approved"]), { owners: OWNERS, timeline: lagging })).toEqual([
      add("status:blocked"),
      remove("status:approved"),
      revert("event"),
    ]);
  });

  it("an approval whose author cannot be told (no timeline entry, not this event) stays", () => {
    expect(t.decide({ name: "issues", action: "unlabeled", actor: "bob" }, issue(["status:approved"]), { owners: OWNERS })).toEqual([]);
  });

  it("needsTimeline: only an approval or several statuses need the label history", () => {
    expect(t.needsTimeline(issue(["status:new", "type:bug"]))).toBe(false);
    expect(t.needsTimeline(issue(["type:bug"]))).toBe(false);
    expect(t.needsTimeline(issue(["status:approved"]))).toBe(true);
    expect(t.needsTimeline(issue(["status:new", "status:triaged"]))).toBe(true);
    expect(t.needsTimeline(issue(["status:new", "status:triaged"], { state: "closed" }))).toBe(false);
  });

  it("normalizeTimeline keeps labeled and unlabeled events, oldest first, from REST or normalized entries", () => {
    const raw = [
      { id: 9, event: "unlabeled", label: { name: "status:new" }, created_at: "2026-10-22T10:00:00Z" },
      { id: 8, event: "commented" },
      labeledAt("status:triaged", "bob", 5, 2),
      labeledAt("status:new", "alice", 0, 1),
      { id: 3, label: "status:blocked", actor: "carol", createdAt: "2026-10-21T10:00:00Z" },
      null,
    ];
    expect(t.normalizeTimeline(raw).map((e) => [e.id, e.label, e.actor])).toEqual([
      [1, "status:new", "alice"],
      [2, "status:triaged", "bob"],
      [3, "status:blocked", "carol"],
      [9, "status:new", null],
    ]);
    expect(t.normalizeTimeline(undefined)).toEqual([]);
  });

  it("OWNER_APPROVED: keeps approved and removes the other status (case-insensitive login)", () => {
    for (const actor of ["xtimor", "XTimor"]) {
      const event = { name: "issues", action: "labeled", actor, label: "status:approved" };
      expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS })).toEqual([remove("status:triaged")]);
    }
    expect(t.decide({ name: "issues", action: "labeled", actor: "xtimor", label: "status:approved" }, issue(["status:approved"]), { owners: OWNERS })).toEqual([]);
  });

  it("BOT_EVENT: a label change by github-actions[bot] does nothing", () => {
    const event = { name: "issues", action: "labeled", actor: "github-actions[bot]", label: "status:approved" };
    expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS })).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "GitHub-Actions[bot]", label: "status:triaged" }, issue(["status:new", "status:triaged"]))).toEqual([]);
    expect(t.isBot("github-actions[bot]")).toBe(true);
    expect(t.isBot("dependabot[bot]")).toBe(false);
  });

  it("a pull request is never handled as an issue", () => {
    const pr = issue(["status:new", "status:triaged"], { pull_request: {} });
    expect(t.decide({ name: "issues", action: "labeled", actor: "xtimor", label: "status:triaged" }, pr, { owners: OWNERS })).toEqual([]);
    expect(t.decide({ name: "stale" }, { ...pr, labels: ["status:needs-info"] })).toEqual([]);
  });

  it("an unknown event or no event does nothing", () => {
    expect(t.decide({ name: "something" }, issue([]))).toEqual([]);
    expect(t.decide(undefined as unknown as Event, issue([]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "edited", actor: "alice" }, issue([]))).toEqual([]);
  });
});

function parseOwnersOf(value: string): string[] {
  return t.parseOwners(value);
}

describe("decide: status:declined", () => {
  const labeled = (label: string, actor: string) => ({ name: "issues", action: "labeled", actor, label });

  it("DECLINED: is a status; the latest status wins over it in both directions", () => {
    expect(t.STATUS_LABELS).toContain("status:declined");
    // An agent declines a new issue: the old status goes.
    expect(t.decide(labeled("status:declined", "agent[bot]"), issue(["status:new", "status:declined"]), { owners: OWNERS, timeline: [labeledAt("status:new", "x", 0, 1), labeledAt("status:declined", "agent[bot]", 5, 2)] })).toEqual([remove("status:new")]);
    // The owner moves it to new for a re-triage: declined goes.
    expect(t.decide(labeled("status:new", "xtimor"), issue(["status:declined", "status:new"]), { owners: OWNERS, timeline: [labeledAt("status:declined", "agent[bot]", 0, 1), labeledAt("status:new", "xtimor", 5, 2)] })).toEqual([remove("status:declined")]);
    // The owner approves a declined issue: the approval stands and declined goes.
    expect(t.decide(labeled("status:approved", "xtimor"), issue(["status:declined", "status:approved"]), { owners: OWNERS, timeline: [labeledAt("status:declined", "agent[bot]", 0, 1), labeledAt("status:approved", "xtimor", 5, 2)] })).toEqual([remove("status:declined")]);
  });

  it("DECLINED: a stranger's approval is reverted and the declined status comes back", () => {
    const timeline = [labeledAt("status:declined", "agent[bot]", 0, 1), { ...labeledAt("status:declined", "x", 3, 2), event: "unlabeled" }, labeledAt("status:approved", "mallory", 4, 3)];
    expect(t.decide(labeled("status:approved", "mallory"), issue(["status:approved"]), { owners: OWNERS, timeline })).toEqual([add("status:declined"), remove("status:approved"), revert(3)]);
  });

  it("DECLINED: closing the issue clears it, and a reopen sets new", () => {
    expect(t.decide({ name: "issues", action: "closed", actor: "xtimor" }, issue(["status:declined", "type:bug"], { state: "closed" }))).toEqual([remove("status:declined")]);
    expect(t.decide({ name: "issues", action: "reopened", actor: "xtimor" }, issue(["status:declined"]))).toEqual([add("status:new"), remove("status:declined")]);
  });

  it("DECLINED: the author's reply does not move it (only needs-info is moved by a reply); the owner decides", () => {
    expect(t.decide({ name: "issue_comment", action: "created", actor: "alice" }, issue(["status:declined"]))).toEqual([]);
  });
});

describe("decide: status:awaiting-post and status:upstream (ticket 3.26)", () => {
  const labeled = (label: string, actor: string) => ({ name: "issues", action: "labeled", actor, label });

  it("both are statuses, and neither is stale", () => {
    expect(t.STATUS_LABELS).toContain("status:awaiting-post");
    expect(t.STATUS_LABELS).toContain("status:upstream");
    expect(t.AWAITING_POST).toBe("status:awaiting-post");
    expect(t.UPSTREAM).toBe("status:upstream");
    expect(t.STALE_STATUSES).not.toContain("status:awaiting-post");
    expect(t.STALE_STATUSES).not.toContain("status:upstream");
  });

  it("the latest status wins over them in both directions (the agent drafts, the workflow publishes, the owner moves on)", () => {
    // The agent sets awaiting-post on an in-progress issue: in-progress goes.
    expect(t.decide(labeled("status:awaiting-post", "agent[bot]"), issue(["status:in-progress", "status:awaiting-post"]), { owners: OWNERS, timeline: [labeledAt("status:in-progress", "agent[bot]", 0, 1), labeledAt("status:awaiting-post", "agent[bot]", 5, 2)] })).toEqual([remove("status:in-progress")]);
    // A late event with both labels (the workflow's move, then a stale run): the later one stays.
    expect(t.decide(labeled("status:upstream", "x"), issue(["status:awaiting-post", "status:upstream"]), { owners: OWNERS, timeline: [labeledAt("status:awaiting-post", "agent[bot]", 0, 1), labeledAt("status:upstream", "github-actions[bot]", 5, 2)] })).toEqual([remove("status:awaiting-post")]);
    // The owner approves a follow-up on an issue in upstream: the approval stands, upstream goes.
    expect(t.decide(labeled("status:approved", "xtimor"), issue(["status:upstream", "status:approved"]), { owners: OWNERS, timeline: [labeledAt("status:upstream", "github-actions[bot]", 0, 1), labeledAt("status:approved", "xtimor", 5, 2)] })).toEqual([remove("status:upstream")]);
    // The agent answers an upstream request: awaiting-post replaces upstream.
    expect(t.decide(labeled("status:awaiting-post", "agent[bot]"), issue(["status:upstream", "status:awaiting-post"]), { owners: OWNERS, timeline: [labeledAt("status:upstream", "github-actions[bot]", 0, 1), labeledAt("status:awaiting-post", "agent[bot]", 5, 2)] })).toEqual([remove("status:upstream")]);
  });

  it("a stranger's approval on them is reverted and the status comes back; closing clears them; a reopen sets new", () => {
    for (const status of ["status:awaiting-post", "status:upstream"]) {
      const timeline = [labeledAt(status, "agent[bot]", 0, 1), { ...labeledAt(status, "x", 3, 2), event: "unlabeled" }, labeledAt("status:approved", "mallory", 4, 3)];
      expect(t.decide(labeled("status:approved", "mallory"), issue(["status:approved"]), { owners: OWNERS, timeline })).toEqual([add(status), remove("status:approved"), revert(3)]);
      expect(t.decide({ name: "issues", action: "closed", actor: "xtimor" }, issue([status, "type:bug"], { state: "closed" }))).toEqual([remove(status)]);
      expect(t.decide({ name: "issues", action: "reopened", actor: "xtimor" }, issue([status]))).toEqual([add("status:new"), remove(status)]);
    }
  });

  it("the author's reply and the workflow's own events change nothing", () => {
    for (const status of ["status:awaiting-post", "status:upstream"]) {
      expect(t.decide({ name: "issue_comment", action: "created", actor: "alice" }, issue([status]))).toEqual([]);
      expect(t.decide(labeled(status, "github-actions[bot]"), issue([status]))).toEqual([]);
    }
  });

  it("STALE: neither status is listed or closed by the daily job, however old", () => {
    const old = (status: string, number: number): IssueIn => ({ number, state: "open", labels: [{ name: status }], updated_at: daysAgo(400), user: { login: "alice" } });
    expect(t.staleIssues([old("status:awaiting-post", 1), old("status:upstream", 2)], NOW, 30, new Map([[1, NOW - 400 * DAY], [2, NOW - 400 * DAY]]))).toEqual([]);
    expect(t.staleStatus(old("status:upstream", 2))).toBeNull();
    expect(t.decide({ name: "stale" }, old("status:awaiting-post", 1), { owners: OWNERS })).toEqual([]);
  });

  it("a pull request that closes unmerged moves only an in-review issue (awaiting-post and upstream stay)", () => {
    const closed = { name: "pull_request", action: "closed", actor: "xtimor", repo: REPO, headRepo: REPO, author: "xtimor", link: "refs", merged: false, prState: "closed" };
    for (const status of ["status:awaiting-post", "status:upstream"]) expect(t.decide(closed, issue([status]), { owners: OWNERS })).toEqual([]);
  });
});

describe("decide: issue_comment", () => {
  const comment = (actor: string | null) => ({ name: "issue_comment", action: "created", actor });

  it("AUTHOR_REPLY: the author's comment on needs-info moves it to new", () => {
    expect(t.decide(comment("alice"), issue(["status:needs-info", "type:bug"]))).toEqual([add("status:new"), remove("status:needs-info")]);
    expect(t.decide(comment("ALICE"), issue(["status:needs-info"]))).toEqual([add("status:new"), remove("status:needs-info")]);
  });

  it("AUTHOR_REPLY: an issue agent's comment (marker) is not a reply, even under the author's account", () => {
    for (const marker of ["issue-triage", "issue-impl"]) {
      expect(t.AGENT_MARKER_RE.test(`<!-- ${marker} -->\n**Status:** needs-info`)).toBe(true);
      expect(t.AGENT_MARKER_RE.test(`I quote <!-- ${marker} --> here`)).toBe(false);
      expect(t.AGENT_MARKER_RE.test(`<!--${marker}-->\ntext`)).toBe(true);
    }
    expect(t.AGENT_MARKER_RE.test("<!-- issue-other -->\ntext")).toBe(false);
    // An owner's agent comment (either marker) changes nothing.
    expect(t.decide({ ...comment("alice"), agent: true }, issue(["status:needs-info"]), { owners: ["alice"] })).toEqual([]);
    expect(t.decide({ ...comment("xtimor"), agent: true }, issue(["status:needs-info"]), { owners: OWNERS })).toEqual([]);
    // A reporter who is not an owner and starts a reply with a marker still counts as replying.
    expect(t.decide({ ...comment("alice"), agent: true }, issue(["status:needs-info"]), { owners: ["owner"] })).toEqual([add("status:new"), remove("status:needs-info")]);
    // A plain author reply (no agent flag) counts as a reply, even for an author who is an owner.
    expect(t.decide(comment("alice"), issue(["status:needs-info"]), { owners: ["alice"] })).toEqual([add("status:new"), remove("status:needs-info")]);
  });

  it("AGENT_MARKER: a marker comment by an agent login is not a reply; the same text by anyone else, or without the marker, is", () => {
    const APP = "oac-issue-agents[bot]";
    const open = issue(["status:needs-info"], { user: { login: APP } }); // an issue the agent app itself opened
    const reply = (actor: string, agent: boolean) => t.decide({ ...comment(actor), agent }, open, { owners: OWNERS, agents: [APP.toLowerCase()] });
    expect(reply(APP, true)).toEqual([]);
    expect(reply("OAC-Issue-Agents[bot]", true)).toEqual([]);
    // Not the agent's login: still a reply when it is the author's.
    const other = issue(["status:needs-info"], { user: { login: "alice" } });
    expect(t.decide({ ...comment("alice"), agent: true }, other, { owners: OWNERS, agents: [APP] })).toEqual([add("status:new"), remove("status:needs-info")]);
    // No agent list (app not configured): the app login's marker comment counts like anyone's.
    expect(t.decide({ ...comment(APP), agent: true }, open, { owners: OWNERS })).toEqual([add("status:new"), remove("status:needs-info")]);
    // The agent's comment without the marker is not an agent comment.
    expect(reply(APP, false)).toEqual([add("status:new"), remove("status:needs-info")]);
  });

  it("APPROVAL_BY_AGENT: an approval by an agent login is reverted like anyone's (agents are not owners)", () => {
    const APP = "oac-issue-agents[bot]";
    const approved = t.decide({ name: "issues", action: "labeled", actor: APP, label: "status:approved" }, issue(["status:triaged", "status:approved"]), {
      owners: OWNERS,
      agents: [APP],
      timeline: [labeledAt("status:triaged", "xtimor", 0, 1), labeledAt("status:approved", APP, 3, 2)],
    });
    expect(approved).toEqual([remove("status:approved"), revert(2)]);
  });

  it("APPROVAL_VIA_APP: an owner's approval made through a GitHub App (a Claude session writes as the owner) is reverted; the owner's own click stays (ticket 3.25)", () => {
    const viaApp = (label: string, actor: string, minutes: number, id: number) => ({ ...labeledAt(label, actor, minutes, id), performed_via_github_app: { slug: "claude", id: 1 } });
    const event = { name: "issues", action: "labeled", actor: "xtimor", label: "status:approved" };
    const labels = ["status:triaged", "status:approved"];
    expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: [labeledAt("status:triaged", "bob", 0, 1), viaApp("status:approved", "xtimor", 3, 2)] })).toEqual([remove("status:approved"), revert(2)]);
    // Found from any event this run handles, and after an unrelated later label.
    for (const other of [{ name: "issues", action: "labeled", actor: "bob", label: "type:bug" }, { name: "issues", action: "unlabeled", actor: "bob", label: "priority:p1" }]) {
      expect(t.decide(other, issue([...labels, "type:bug"]), { owners: OWNERS, timeline: [labeledAt("status:triaged", "bob", 0, 1), viaApp("status:approved", "xtimor", 3, 2), labeledAt("type:bug", "bob", 4, 3)] })).toEqual([remove("status:approved"), revert(2)]);
    }
    // performed_via_github_app: null (the field GitHub sends for a person's click) and false are not an app.
    for (const field of [null, undefined, false]) {
      const own = { ...labeledAt("status:approved", "xtimor", 3, 2), performed_via_github_app: field };
      expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: [labeledAt("status:triaged", "bob", 0, 1), own] })).toEqual([remove("status:triaged")]);
    }
    // The owner's own click after the app's approval stands (the latest labeled event decides).
    expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: [viaApp("status:approved", "xtimor", 1, 1), labeledAt("status:approved", "xtimor", 5, 2)] })).toEqual([remove("status:triaged")]);
    // An app event after the owner's click reverts again.
    expect(t.decide(event, issue(labels), { owners: OWNERS, timeline: [labeledAt("status:approved", "xtimor", 1, 1), viaApp("status:approved", "xtimor", 5, 2)] })).toEqual([remove("status:approved"), revert(2)]);
    expect(t.NON_OWNER_APPROVAL_COMMENT).toContain("with their own click (not through an app or an agent session)");
  });

  it("AUTHOR_REPLY: a comment by someone else does nothing", () => {
    expect(t.decide(comment("bob"), issue(["status:needs-info"]))).toEqual([]);
    expect(t.decide(comment("xtimor"), issue(["status:needs-info"]), { owners: OWNERS })).toEqual([]);
    expect(t.decide(comment(null), issue(["status:needs-info"], { user: undefined }))).toEqual([]);
  });

  it("AUTHOR_REPLY: the author's comment in any other state does nothing", () => {
    expect(t.decide(comment("alice"), issue(["status:triaged"]))).toEqual([]);
    expect(t.decide(comment("alice"), issue(["status:needs-info"], { state: "closed" }))).toEqual([]);
  });

  it("ignores edits and the bot's own comments, and comments on pull requests", () => {
    expect(t.decide({ name: "issue_comment", action: "edited", actor: "alice" }, issue(["status:needs-info"]))).toEqual([]);
    expect(t.decide(comment("github-actions[bot]"), issue(["status:needs-info"], { user: { login: "github-actions[bot]" } }))).toEqual([]);
    expect(t.decide(comment("alice"), issue(["status:needs-info"], { pull_request: {} }))).toEqual([]);
  });
});

describe("linkedIssues", () => {
  it("PR_OPENED: finds Fixes, Closes, Resolves, and Refs, case-insensitive", () => {
    expect(t.linkedIssues("Fixes #12\n\nrefs #13", REPO)).toEqual([
      { number: 12, kind: "fixes" },
      { number: 13, kind: "refs" },
    ]);
    expect(t.linkedIssues("CLOSES #1, resolves: #2 and Refs   #3", REPO)).toEqual([
      { number: 1, kind: "fixes" },
      { number: 2, kind: "fixes" },
      { number: 3, kind: "refs" },
    ]);
  });

  it("ignores links to other repositories, but accepts this one spelled out", () => {
    expect(t.linkedIssues("Fixes other/repo#5", REPO)).toEqual([]);
    expect(t.linkedIssues("Fixes https://github.com/other/repo/issues/5", REPO)).toEqual([]);
    expect(t.linkedIssues("Fixes xtimor/openclaw-all-cli#5", REPO)).toEqual([{ number: 5, kind: "fixes" }]);
    expect(t.linkedIssues("Fixes XTimor/OpenClaw-All-CLI#5", REPO)).toEqual([{ number: 5, kind: "fixes" }]);
    expect(t.linkedIssues("Fixes xtimor/openclaw-all-cli#5")).toEqual([]);
    expect(t.linkedIssues("Fixes #6 and Fixes other/repo#7", REPO)).toEqual([{ number: 6, kind: "fixes" }]);
  });

  it("needs a keyword, a space, and digits", () => {
    for (const body of ["See #12", "prefixes #12", "Fixes#12", "Fixes #", "Fixes #abc", "Fixed #12", "Fixes #0", "Fixes #12345678901", "", null, undefined, 42]) {
      expect(t.linkedIssues(body, REPO)).toEqual([]);
    }
  });

  it("lists a number once, and Fixes wins over Refs", () => {
    expect(t.linkedIssues("Refs #4\nFixes #4\nFixes #4", REPO)).toEqual([{ number: 4, kind: "fixes" }]);
    expect(t.linkedIssues("Fixes #4\nRefs #4", REPO)).toEqual([{ number: 4, kind: "fixes" }]);
  });

  it("runs in linear time on hostile text", () => {
    const hostile = `${"Fixes ".repeat(50_000)}${"a/".repeat(50_000)}#`;
    const started = performance.now();
    expect(t.linkedIssues(hostile, REPO)).toEqual([]);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

describe("decide: pull_request", () => {
  const pr = (action: string, link: string, extra: Partial<Event> = {}): Event => ({
    name: "pull_request",
    action,
    actor: "carol",
    link,
    prState: action === "closed" ? "closed" : "open",
    repo: REPO,
    headRepo: REPO,
    author: "carol",
    ...extra,
  });

  it("PR_OPENED: opened, edited, and reopened move an in-progress issue to in-review; in-review stays", () => {
    for (const action of ["opened", "edited", "reopened"]) {
      expect(t.decide(pr(action, "fixes"), issue(["status:in-progress", "type:bug"]))).toEqual([add("status:in-review"), remove("status:in-progress")]);
      expect(t.decide(pr(action, "refs"), issue(["status:in-progress"]))).toEqual([add("status:in-review"), remove("status:in-progress")]);
      expect(t.decide(pr(action, "fixes"), issue(["status:in-review"]))).toEqual([]);
    }
  });

  it("a fork or outsider PR changes nothing; the owner's PR from a fork still counts", () => {
    const states = [issue(["status:in-progress"]), issue(["status:in-review"], { state: "open" })];
    const fork = { headRepo: "mallory/openclaw-all-cli", author: "mallory" };
    for (const action of ["opened", "edited", "reopened"]) expect(t.decide(pr(action, "fixes", fork), states[0]!, { owners: OWNERS })).toEqual([]);
    expect(t.decide(pr("closed", "refs", { ...fork, merged: true }), states[1]!, { owners: OWNERS })).toEqual([]);
    expect(t.decide(pr("closed", "fixes", { ...fork, merged: false }), states[1]!, { owners: OWNERS })).toEqual([]);
    expect(t.decide(pr("closed", "fixes", { ...fork, merged: true }), issue(["status:in-review"], { state: "closed" }), { owners: OWNERS })).toEqual([]);
    // No head repository (a deleted fork) and no repo given are untrusted too.
    expect(t.decide(pr("opened", "fixes", { headRepo: null }), states[0]!, { owners: OWNERS })).toEqual([]);
    expect(t.decide(pr("opened", "fixes", { repo: undefined, headRepo: undefined }), states[0]!, { owners: OWNERS })).toEqual([]);
    // Same repository: counts, whatever the case of the name; an owner's fork PR counts.
    expect(t.decide(pr("opened", "fixes", { headRepo: REPO.toUpperCase() }), states[0]!, { owners: OWNERS })).toEqual([add("status:in-review"), remove("status:in-progress")]);
    expect(t.decide(pr("opened", "fixes", { ...fork, author: "XTimor" }), states[0]!, { owners: OWNERS })).toEqual([add("status:in-review"), remove("status:in-progress")]);
    expect(t.decide(pr("opened", "fixes", fork), states[0]!)).toEqual([]);
  });

  it("PR_OPENED: any other state is left alone (an outsider's PR moves nothing)", () => {
    for (const status of ["new", "needs-info", "triaged", "approved", "planned", "blocked"]) {
      expect(t.decide(pr("opened", "fixes"), issue([`status:${status}`]))).toEqual([]);
    }
    expect(t.decide(pr("opened", "fixes"), issue(["type:bug"]))).toEqual([]);
  });

  it("PR_OPENED: a linked issue that is a PR or closed is skipped", () => {
    expect(t.decide(pr("opened", "fixes"), issue(["status:in-progress"], { pull_request: {} }))).toEqual([]);
    expect(t.decide(pr("opened", "fixes"), issue(["status:in-progress"], { state: "closed" }))).toEqual([]);
  });

  it("an edit after the PR was closed changes nothing", () => {
    expect(t.decide(pr("edited", "fixes", { prState: "closed" }), issue(["status:in-progress"]))).toEqual([]);
  });

  it("PR_MERGED_FIX: a merged Fixes clears the status only when the issue is closed", () => {
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["status:in-review"], { state: "closed" }))).toEqual([remove("status:in-review")]);
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["type:bug"], { state: "closed" }))).toEqual([]);
  });

  it("PR_MERGED_FIX: merged into a non-default branch, the issue stays open and keeps its status", () => {
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["status:in-review", "type:bug"]))).toEqual([]);
  });

  it("PR_MERGED_REFS: a merged Refs moves an in-review issue to planned", () => {
    expect(t.decide(pr("closed", "refs", { merged: true }), issue(["status:in-review"]))).toEqual([add("status:planned"), remove("status:in-review")]);
    expect(t.decide(pr("closed", "refs", { merged: true }), issue(["status:in-review"], { state: "closed" }))).toEqual([]);
    for (const status of ["new", "triaged", "approved", "in-progress", "blocked", "planned"]) {
      expect(t.decide(pr("closed", "refs", { merged: true }), issue([`status:${status}`]))).toEqual([]);
    }
  });

  it("PR_CLOSED: closed unmerged moves an in-review issue to blocked, nothing else", () => {
    for (const link of ["fixes", "refs"]) {
      expect(t.decide(pr("closed", link, { merged: false }), issue(["status:in-review"]))).toEqual([add("status:blocked"), remove("status:in-review")]);
      expect(t.decide(pr("closed", link), issue(["status:in-review"]))).toEqual([add("status:blocked"), remove("status:in-review")]);
      for (const status of ["new", "triaged", "approved", "in-progress", "planned"]) {
        expect(t.decide(pr("closed", link, { merged: false }), issue([`status:${status}`]))).toEqual([]);
      }
    }
    expect(t.decide(pr("closed", "fixes", { merged: false }), issue(["status:in-review"], { state: "closed" }))).toEqual([]);
  });

  it("an unknown link kind or action does nothing", () => {
    expect(t.decide(pr("opened", "mentions"), issue(["status:new"]))).toEqual([]);
    expect(t.decide(pr("synchronize", "fixes"), issue(["status:new"]))).toEqual([]);
  });
});

describe("staleIssues and decide: stale", () => {
  const needsInfo = (number: number, days: number, extra: IssueIn = {}): IssueIn => ({
    number,
    state: "open",
    labels: [{ name: "status:needs-info" }, { name: "type:bug" }],
    updated_at: daysAgo(days),
    user: { login: "alice" },
    ...extra,
  });

  it("STALE: 31 days is stale, 29 days is not, exactly 30 days is", () => {
    const issues = [needsInfo(1, 31), needsInfo(2, 29), needsInfo(3, 30), needsInfo(4, 100)];
    expect(t.staleIssues(issues, NOW, 30).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(t.staleIssues(issues, new Date(NOW)).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(t.STALE_DAYS).toBe(30);
  });

  it("STALE: counts from the label, not from the last update (old label, updated yesterday)", () => {
    const issues = [needsInfo(1, 1)];
    expect(t.staleIssues(issues, NOW)).toEqual([]);
    expect(t.staleIssues(issues, NOW, 30, new Map([[1, NOW - 31 * DAY]])).map((i) => i.number)).toEqual([1]);
    expect(t.staleIssues(issues, NOW, 30, { 1: daysAgo(31) }).map((i) => i.number)).toEqual([1]);
    expect(t.staleIssues(issues, NOW, 30, new Map([[1, new Date(NOW - 31 * DAY)]])).map((i) => i.number)).toEqual([1]);
  });

  it("STALE: a recent label stays open even when the issue was last updated long ago", () => {
    const issues = [needsInfo(1, 60)];
    expect(t.staleIssues(issues, NOW, 30, new Map([[1, NOW - 29 * DAY]]))).toEqual([]);
  });

  it("STALE: no label time for an issue falls back to its last update", () => {
    const issues = [needsInfo(1, 31), needsInfo(2, 29), needsInfo(3, 31)];
    const since = new Map<number, unknown>([[3, "not a date"]]);
    expect(t.staleIssues(issues, NOW, 30, since).map((i) => i.number)).toEqual([1, 3]);
    expect(t.staleIssues(issues, NOW, 30, undefined).map((i) => i.number)).toEqual([1, 3]);
    expect(t.staleIssues(issues, NOW, 30, null as never).map((i) => i.number)).toEqual([1, 3]);
  });

  it("needsInfoSince: the latest needs-info labeled event counts (relabeled)", () => {
    const event = (label: string, kind: string, daysBefore: number, id: number) => ({ id, event: kind, label: { name: label }, created_at: daysAgo(daysBefore) });
    const events = [
      event("status:needs-info", "labeled", 40, 1),
      event("status:needs-info", "unlabeled", 38, 2),
      event("status:triaged", "labeled", 38, 3),
      event("status:needs-info", "labeled", 5, 4),
      event("type:bug", "labeled", 1, 5),
      { id: 6, event: "commented", created_at: daysAgo(0) },
    ];
    expect(t.needsInfoSince(events)).toBe(NOW - 5 * DAY);
    expect(t.needsInfoSince([event("status:needs-info", "unlabeled", 3, 1)])).toBeNull();
    expect(t.needsInfoSince([{ id: 1, event: "labeled", label: { name: "status:needs-info" }, created_at: "garbage" }])).toBeNull();
    for (const value of [[], undefined, null, "x"]) expect(t.needsInfoSince(value)).toBeNull();
    // Relabeled 5 days ago: not stale although the first label is 40 days old.
    expect(t.staleIssues([needsInfo(1, 1)], NOW, 30, new Map([[1, t.needsInfoSince(events)]]))).toEqual([]);
  });

  it("skips other states, pull requests, closed issues, and unreadable dates", () => {
    const issues = [
      needsInfo(1, 60, { labels: ["status:triaged"] }),
      needsInfo(2, 60, { pull_request: {} }),
      needsInfo(3, 60, { state: "closed" }),
      needsInfo(4, 60, { updated_at: "not a date" }),
      needsInfo(5, 60, { updated_at: undefined }),
      needsInfo(6, -3),
    ];
    expect(t.staleIssues(issues, NOW)).toEqual([]);
    expect(t.staleIssues(issues, Number.NaN)).toEqual([]);
    expect(t.staleIssues(undefined as unknown as IssueIn[], NOW)).toEqual([]);
  });

  it("STALE: closes as not planned with a comment that mentions the author and keeps no status", () => {
    expect(t.decide({ name: "stale" }, needsInfo(1, 31))).toEqual([
      { op: "comment", body: t.staleComment("alice") },
      remove("status:needs-info"),
      { op: "close", reason: "not_planned" },
    ]);
    expect(t.staleComment("alice")).toContain("@alice, this issue has been in `status:needs-info` for 30 days");
    expect(t.decide({ name: "stale" }, needsInfo(1, 31, { labels: ["status:triaged"] }))).toEqual([]);
    expect(t.decide({ name: "stale" }, needsInfo(1, 31, { state: "closed" }))).toEqual([]);
  });

  it("STALE: an author that is a bot, missing, or malformed gets a comment without a mention", () => {
    const plain = t.staleComment("");
    expect(plain).not.toContain("@");
    expect(plain).toMatch(/^<!-- issue-flow -->\nThis issue has been in `status:needs-info` for 30 days/);
    for (const login of [undefined, null, "", "dependabot[bot]", "a b", "-x", "x".repeat(40), "@evil", "a\n@b", 5]) expect(t.staleComment(login)).toBe(plain);
    expect(t.staleComment("octo_cat-1")).toContain("@octo_cat-1, this issue");
    const noAuthor = needsInfo(1, 31, { user: undefined });
    expect(t.decide({ name: "stale" }, noAuthor)[0]).toEqual({ op: "comment", body: plain });
    expect(t.decide({ name: "stale" }, needsInfo(1, 31, { user: { login: "github-actions[bot]" } }))[0]).toEqual({ op: "comment", body: plain });
  });

  it("the comments keep the workflow's marker and carry no issue text beyond a checked login", () => {
    for (const body of [t.staleComment(""), t.NON_OWNER_APPROVAL_COMMENT]) {
      expect(body).toMatch(/^<!-- issue-flow -->\n/);
      expect(body).not.toMatch(/\$\{|@\w/);
    }
    expect(t.staleComment("alice")).toMatch(/^<!-- issue-flow -->\n@alice, /);
    expect(t.staleComment("")).toContain("30 days");
  });

  const declined = (number: number, days: number, extra: IssueIn = {}): IssueIn => needsInfo(number, days, { labels: [{ name: "status:declined" }, { name: "type:bug" }], ...extra });

  it("DECLINED: 31 days is stale, 29 days is not, exactly 30 days is; the label time wins over the last update", () => {
    expect(t.STALE_STATUSES).toEqual(["status:needs-info", "status:declined"]);
    const issues = [declined(1, 31), declined(2, 29), declined(3, 30), needsInfo(4, 31)];
    expect(t.staleIssues(issues, NOW).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(t.staleIssues([declined(1, 1)], NOW)).toEqual([]);
    expect(t.staleIssues([declined(1, 1)], NOW, 30, new Map([[1, NOW - 31 * DAY]])).map((i) => i.number)).toEqual([1]);
    expect(t.staleIssues([declined(1, 60), declined(2, 60, { state: "closed" }), declined(3, 60, { pull_request: {} })], NOW).map((i) => i.number)).toEqual([1]);
  });

  it("DECLINED: statusSince reads the latest label event of the asked status only", () => {
    const event = (label: string, kind: string, daysBefore: number, id: number) => ({ id, event: kind, label: { name: label }, created_at: daysAgo(daysBefore) });
    const events = [event("status:declined", "labeled", 40, 1), event("status:declined", "unlabeled", 38, 2), event("status:declined", "labeled", 5, 3), event("status:needs-info", "labeled", 1, 4)];
    expect(t.statusSince(events, "status:declined")).toBe(NOW - 5 * DAY);
    expect(t.statusSince(events, "status:needs-info")).toBe(NOW - 1 * DAY);
    expect(t.statusSince(events)).toBe(NOW - 1 * DAY);
    expect(t.statusSince([event("status:declined", "unlabeled", 3, 1)], "status:declined")).toBeNull();
    expect(t.staleStatus(declined(1, 1))).toBe("status:declined");
    expect(t.staleStatus(needsInfo(1, 1))).toBe("status:needs-info");
    expect(t.staleStatus(declined(1, 1, { state: "closed" }))).toBeNull();
    expect(t.staleStatus(needsInfo(1, 1, { labels: ["status:triaged"] }))).toBeNull();
  });

  it("DECLINED: the stale close removes the status, closes as not planned, and mentions the author and the owner", () => {
    expect(t.decide({ name: "stale" }, declined(1, 31), { owners: OWNERS })).toEqual([
      { op: "comment", body: t.declinedStaleComment("alice", OWNERS) },
      remove("status:declined"),
      { op: "close", reason: "not_planned" },
    ]);
    const body = t.declinedStaleComment("alice", ["xtimor"]);
    expect(body).toMatch(/^<!-- issue-flow -->\n@alice, @xtimor: this issue has been in `status:declined` for 30 days without a decision, so it is closed as not planned\./);
    expect(body).toContain("Reopen it to continue; it returns to `status:new`.");
  });

  it("DECLINED: logins are checked and listed once; a bot author, no owners, or odd logins give no bad mention", () => {
    expect(t.declinedStaleComment("xtimor", ["XTimor", "bob"])).toContain("\n@xtimor, @bob: this issue has");
    expect(t.declinedStaleComment("dependabot[bot]", ["xtimor"])).toContain("\n@xtimor: this issue has");
    expect(t.declinedStaleComment("alice")).toContain("\n@alice: this issue has");
    const plain = t.declinedStaleComment("", []);
    expect(plain).toMatch(/^<!-- issue-flow -->\nThis issue has been in `status:declined`/);
    for (const login of [undefined, null, "a b", "@evil", "a\nb", 5]) expect(t.declinedStaleComment(login, ["-bad", "a b", "@x"])).toBe(plain);
    expect(t.declinedStaleComment("alice", "xtimor, bob")).toContain("@alice, @xtimor, @bob: this issue");
    expect(plain).not.toMatch(/\$\{|@\w/);
  });

  it("DECLINED: a needs-info stale close still mentions only the author", () => {
    expect(t.decide({ name: "stale" }, needsInfo(1, 31), { owners: OWNERS })[0]).toEqual({ op: "comment", body: t.staleComment("alice") });
  });
});

describe("parseOwners", () => {
  it("splits, trims, lower-cases, and drops empty entries", () => {
    expect(t.parseOwners(" XTimor, bob ,,")).toEqual(["xtimor", "bob"]);
    expect(t.parseOwners(["A", " b "])).toEqual(["a", "b"]);
    for (const value of ["", "  ", undefined, null, 5]) expect(t.parseOwners(value)).toEqual([]);
  });
});

// A fake octokit: records every call in order and keeps issue state, so the apply layer is judged on its requests.
interface FakeIssue extends IssueIn {
  number: number;
}
function fakeGithub(
  issues: FakeIssue[],
  options: { missingLabels?: Set<string>; failOn?: (call: string) => Error | undefined; events?: Record<number, unknown[]>; comments?: Record<number, Array<string | { body: string; login: string }>> } = {},
) {
  const calls: string[] = [];
  const byNumber = new Map(issues.map((i) => [i.number, structuredClone(i)]));
  const record = async <T>(line: string, work: () => T): Promise<T> => {
    calls.push(line);
    const error = options.failOn?.(line);
    if (error) throw error;
    return work();
  };
  const rest = {
    issues: {
      get: ({ issue_number }: { issue_number: number }) =>
        record(`get ${issue_number}`, () => {
          const found = byNumber.get(issue_number);
          if (!found) throw Object.assign(new Error("Not Found"), { status: 404 });
          return { data: structuredClone(found) };
        }),
      addLabels: ({ issue_number, labels }: { issue_number: number; labels: string[] }) =>
        record(`add ${issue_number} ${labels.join(",")}`, () => {
          const found = byNumber.get(issue_number)!;
          for (const label of labels) found.labels = [...(found.labels ?? []), label];
        }),
      removeLabel: ({ issue_number, name }: { issue_number: number; name: string }) =>
        record(`remove ${issue_number} ${name}`, () => {
          const found = byNumber.get(issue_number)!;
          const names = (found.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
          if (!names.includes(name) || options.missingLabels?.has(name)) throw Object.assign(new Error("Label does not exist"), { status: 404 });
          found.labels = names.filter((n) => n !== name);
        }),
      createComment: ({ issue_number, body }: { issue_number: number; body: string }) =>
        record(`comment ${issue_number} ${body.split("\n")[1]?.slice(0, 20)}`, () => {
          (options.comments ??= {})[issue_number] = [...(options.comments[issue_number] ?? []), body]; // written by the workflow (the bot)
        }),
      listEvents: Symbol("listEvents"),
      listComments: Symbol("listComments"),
      update: ({ issue_number, state, state_reason }: { issue_number: number; state: "closed"; state_reason: string }) =>
        record(`update ${issue_number} ${state} ${state_reason}`, () => {
          byNumber.get(issue_number)!.state = state;
        }),
      listForRepo: Symbol("listForRepo"),
    },
  };
  const github = {
    rest,
    paginate: async (method: unknown, params: { state: string; labels: string; issue_number: number }) => {
      if (method === rest.issues.listEvents) {
        calls.push(`events ${params.issue_number}`);
        const error = options.failOn?.(`events ${params.issue_number}`);
        if (error) throw error;
        return structuredClone(options.events?.[params.issue_number] ?? []);
      }
      if (method === rest.issues.listComments) {
        calls.push(`comments ${params.issue_number}`);
        return (options.comments?.[params.issue_number] ?? []).map((c) => (typeof c === "string" ? { body: c, user: { login: "github-actions[bot]" } } : { body: c.body, user: { login: c.login } }));
      }
      calls.push(`paginate ${params.state} ${params.labels}`);
      expect(method).toBe(rest.issues.listForRepo);
      return [...byNumber.values()]
        .filter((i) => i.state === params.state && (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).includes(params.labels))
        .map((i) => structuredClone(i));
    },
  };
  const labelsOf = (number: number) => (byNumber.get(number)?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  return { github, calls, labelsOf, comments: (number: number) => (options.comments?.[number] ?? []).map((c) => (typeof c === "string" ? c : c.body)), state: (number: number) => byNumber.get(number)?.state };
}

const ctx = (eventName: string, payload: object) => ({ eventName, payload, repo: { owner: "xtimor", repo: "openclaw-all-cli" } });
function fakeCore() {
  const lines: string[] = [];
  return { lines, info: (m: string) => lines.push(`info: ${m}`), warning: (m: string) => lines.push(`warning: ${m}`) };
}

describe("applyActions", () => {
  it("sends each action in order and returns them", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:triaged"] }]);
    const actions: Action[] = [add("status:new"), remove("status:triaged"), { op: "comment", body: "x\ny" }, { op: "close", reason: "not_planned" }];
    expect(await apply.applyActions(fake.github, ctx("issues", {}), 12, actions)).toEqual(actions);
    expect(fake.calls).toEqual(["add 12 status:new", "remove 12 status:triaged", "comment 12 y", "update 12 closed not_planned"]);
    expect(fake.labelsOf(12)).toEqual(["status:new"]);
  });

  it("a comment with a once key is skipped when that key is already in a comment", async () => {
    const key = "<!-- issue-flow:approval:7 -->";
    const stranger = fakeGithub([{ number: 12, state: "open", labels: [] }], { comments: { 12: [{ body: `quote ${key}`, login: "mallory" }] } });
    await apply.applyActions(stranger.github, ctx("issues", {}), 12, [{ op: "comment", body: `text\n${key}`, once: key }]);
    expect(stranger.calls).toEqual(["comments 12", "comment 12 <!-- issue-flow:appr"]);
    const posted = fakeGithub([{ number: 12, state: "open", labels: [] }], { comments: { 12: [`earlier\n${key}`] } });
    await apply.applyActions(posted.github, ctx("issues", {}), 12, [{ op: "comment", body: `text\n${key}`, once: key }]);
    expect(posted.calls).toEqual(["comments 12"]);
    const fresh = fakeGithub([{ number: 12, state: "open", labels: [] }], { comments: { 12: [`earlier\n<!-- issue-flow:approval:6 -->`] } });
    await apply.applyActions(fresh.github, ctx("issues", {}), 12, [{ op: "comment", body: `text\n${key}`, once: key }, { op: "comment", body: "plain\nbody" }]);
    expect(fresh.calls).toEqual(["comments 12", "comment 12 <!-- issue-flow:appr", "comment 12 body"]);
  });

  it("ignores a 404 when removing a label that is not there", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: [] }]);
    await expect(apply.applyActions(fake.github, ctx("issues", {}), 12, [remove("status:new"), add("status:triaged")])).resolves.toHaveLength(2);
    expect(fake.calls).toEqual(["remove 12 status:new", "add 12 status:triaged"]);
  });

  it("does not hide other errors, and stops at the first one", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:new"] }], {
      failOn: (call) => (call.startsWith("remove") ? Object.assign(new Error("Forbidden"), { status: 403 }) : undefined),
    });
    await expect(apply.applyActions(fake.github, ctx("issues", {}), 12, [remove("status:new"), add("status:triaged")])).rejects.toThrow("Forbidden");
    expect(fake.calls).toEqual(["remove 12 status:new"]);
  });

  it("rejects an unknown action", async () => {
    const fake = fakeGithub([]);
    await expect(apply.applyActions(fake.github, ctx("issues", {}), 1, [{ op: "delete" } as unknown as Action])).rejects.toThrow("unknown action");
  });
});

describe("runEvent", () => {
  const env = { ISSUE_FLOW_OWNERS: "xtimor" };
  const HEAD = { head: { repo: { full_name: REPO } }, user: { login: "carol" } };

  it("OPENED: sets status:new on the issue as it is now", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:triaged", "type:bug"], user: { login: "alice" } }]);
    const core = fakeCore();
    const payload = { action: "opened", sender: { login: "alice" }, issue: { number: 12, labels: [] } };
    const result = await apply.runEvent({ github: fake.github, context: ctx("issues", payload), core, env });
    expect(fake.labelsOf(12).filter((l) => l.startsWith("status:"))).toEqual(["status:new"]);
    expect(result).toEqual([{ issue: 12, actions: [add("status:new"), remove("status:triaged")] }]);
  });

  it("NON_OWNER_APPROVED: reverts through the API", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:triaged", "status:approved"], user: { login: "alice" } }]);
    const payload = { action: "labeled", label: { name: "status:approved" }, sender: { login: "mallory" }, issue: { number: 12 } };
    await apply.runEvent({ github: fake.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(fake.labelsOf(12)).toEqual(["status:triaged"]);
    expect(fake.calls).toEqual(["get 12", "events 12", "remove 12 status:approved", "comments 12", "comment 12 Only the owner appro"]);
  });

  it("APPROVAL_VIA_APP: runEvent reads performed_via_github_app from the issue's events and reverts an owner's approval made through an app", async () => {
    const make = (field: unknown) =>
      fakeGithub([{ number: 12, state: "open", labels: ["status:triaged", "status:approved"], user: { login: "alice" } }], {
        events: { 12: [labeledAt("status:triaged", "bob", 0, 1), { ...labeledAt("status:approved", "xtimor", 3, 2), performed_via_github_app: field }] },
      });
    const payload = { action: "labeled", label: { name: "status:approved" }, sender: { login: "xtimor" }, issue: { number: 12 } };
    const viaClaude = make({ slug: "claude" });
    await apply.runEvent({ github: viaClaude.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(viaClaude.labelsOf(12)).toEqual(["status:triaged"]);
    expect(viaClaude.calls).toContain("remove 12 status:approved");
    const click = make(null);
    await apply.runEvent({ github: click.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(click.labelsOf(12)).toEqual(["status:approved"]);
  });

  it("OWNER_APPROVED: the owner list comes from ISSUE_FLOW_OWNERS", async () => {
    const make = () => fakeGithub([{ number: 12, state: "open", labels: ["status:triaged", "status:approved"], user: { login: "alice" } }]);
    const payload = { action: "labeled", label: { name: "status:approved" }, sender: { login: "xtimor" }, issue: { number: 12 } };
    const owner = make();
    await apply.runEvent({ github: owner.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(owner.labelsOf(12)).toEqual(["status:approved"]);
    const nobody = make();
    await apply.runEvent({ github: nobody.github, context: ctx("issues", payload), core: fakeCore(), env: {} });
    expect(nobody.labelsOf(12)).toEqual(["status:triaged"]);
  });

  it("BOT_EVENT: reads nothing and changes nothing", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:approved"] }]);
    const payload = { action: "labeled", label: { name: "status:approved" }, sender: { login: "github-actions[bot]" }, issue: { number: 12 } };
    expect(await apply.runEvent({ github: fake.github, context: ctx("issues", payload), core: fakeCore(), env })).toEqual([]);
    expect(fake.calls).toEqual([]);
  });

  it("AUTHOR_REPLY: the commenter is the comment's author; a comment on a PR is not read", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:needs-info"], user: { login: "alice" } }]);
    const comment = (login: string, issueExtra = {}) => ({ action: "created", sender: { login }, comment: { user: { login } }, issue: { number: 12, ...issueExtra } });
    await apply.runEvent({ github: fake.github, context: ctx("issue_comment", comment("bob")), core: fakeCore(), env });
    expect(fake.labelsOf(12)).toEqual(["status:needs-info"]);
    await apply.runEvent({ github: fake.github, context: ctx("issue_comment", comment("alice", { pull_request: {} })), core: fakeCore(), env });
    expect(fake.labelsOf(12)).toEqual(["status:needs-info"]);
    await apply.runEvent({ github: fake.github, context: ctx("issue_comment", comment("alice")), core: fakeCore(), env });
    expect(fake.labelsOf(12)).toEqual(["status:new"]);
  });

  it("AUTHOR_REPLY: runEvent reads the marker at the start of the body, for the owner only", async () => {
    const send = async (login: string, body: string, owners: string) => {
      const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:needs-info"], user: { login } }]);
      const payload = { action: "created", sender: { login }, comment: { user: { login }, body }, issue: { number: 12 } };
      await apply.runEvent({ github: fake.github, context: ctx("issue_comment", payload), core: fakeCore(), env: { ISSUE_FLOW_OWNERS: owners } });
      return fake.labelsOf(12);
    };
    expect(await send("xtimor", "<!-- issue-impl -->\n**Status:** needs-info", "xtimor")).toEqual(["status:needs-info"]);
    expect(await send("xtimor", "<!-- issue-triage -->\nx", "xtimor")).toEqual(["status:needs-info"]);
    expect(await send("xtimor", "I quote <!-- issue-impl --> here", "xtimor")).toEqual(["status:new"]);
    expect(await send("alice", "<!-- issue-impl -->\nx", "xtimor")).toEqual(["status:new"]);
    expect(await send("alice", "plain reply", "xtimor")).toEqual(["status:new"]);
  });

  it("AGENT_MARKER: runEvent reads the agent logins from ISSUE_FLOW_AGENTS; an agent approval is reverted", async () => {
    const APP = "oac-issue-agents[bot]";
    const send = async (agents: string | undefined, body: string) => {
      const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:needs-info"], user: { login: APP } }]);
      const payload = { action: "created", sender: { login: APP }, comment: { user: { login: APP }, body }, issue: { number: 12 } };
      await apply.runEvent({ github: fake.github, context: ctx("issue_comment", payload), core: fakeCore(), env: { ISSUE_FLOW_OWNERS: "xtimor", ...(agents === undefined ? {} : { ISSUE_FLOW_AGENTS: agents }) } });
      return fake.labelsOf(12);
    };
    expect(await send("Oac-Issue-Agents[bot], other[bot]", "<!-- issue-impl -->\n**Status:** needs-info")).toEqual(["status:needs-info"]);
    expect(await send("Oac-Issue-Agents[bot]", "<!-- issue-triage -->\nx")).toEqual(["status:needs-info"]);
    expect(await send("Oac-Issue-Agents[bot]", "plain text")).toEqual(["status:new"]);
    expect(await send(undefined, "<!-- issue-impl -->\nx")).toEqual(["status:new"]);
    expect(await send("", "<!-- issue-impl -->\nx")).toEqual(["status:new"]);

    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:triaged", "status:approved"], user: { login: "alice" } }]);
    const approval = { action: "labeled", label: { name: "status:approved" }, sender: { login: APP }, issue: { number: 12 } };
    await apply.runEvent({ github: fake.github, context: ctx("issues", approval), core: fakeCore(), env: { ISSUE_FLOW_OWNERS: "xtimor", ISSUE_FLOW_AGENTS: APP } });
    expect(fake.labelsOf(12)).toEqual(["status:triaged"]);
  });

  it("PR_OPENED: links #12 and #13, skips a PR, a closed issue, a missing issue, and another repository", async () => {
    const fake = fakeGithub([
      { number: 12, state: "open", labels: ["status:in-progress"] },
      { number: 13, state: "open", labels: ["status:in-progress"] },
      { number: 14, state: "open", labels: ["status:new"], pull_request: {} },
      { number: 15, state: "closed", labels: [] },
      { number: 17, state: "open", labels: ["status:approved"] },
    ]);
    const body = "Fixes #12\nrefs #13\nFixes #14\nFixes #15\nFixes #99\nFixes other/repo#16\nFixes #17";
    const payload = { action: "opened", sender: { login: "carol" }, pull_request: { number: 20, body, state: "open", merged: false, ...HEAD } };
    const core = fakeCore();
    const result = await apply.runEvent({ github: fake.github, context: ctx("pull_request_target", payload), core, env });
    expect(result.map((r) => r.issue)).toEqual([12, 13]);
    expect(fake.labelsOf(12)).toEqual(["status:in-review"]);
    expect(fake.labelsOf(13)).toEqual(["status:in-review"]);
    expect(fake.labelsOf(14)).toEqual(["status:new"]);
    expect(fake.labelsOf(17)).toEqual(["status:approved"]);
    expect(fake.calls.filter((c) => c.startsWith("get"))).toEqual(["get 12", "get 13", "get 14", "get 15", "get 99", "get 17"]);
    expect(core.lines.join("\n")).toContain("#99 not found");
  });

  it("PR_MERGED_FIX, PR_MERGED_REFS, PR_CLOSED through the API", async () => {
    const make = () =>
      fakeGithub([
        { number: 12, state: "closed", labels: ["status:in-review"] },
        { number: 13, state: "open", labels: ["status:in-review"] },
      ]);
    const closed = (merged: boolean, body: string) => ({ action: "closed", sender: { login: "xtimor" }, pull_request: { number: 20, body, state: "closed", merged, ...HEAD } });

    const fixed = make();
    await apply.runEvent({ github: fixed.github, context: ctx("pull_request_target", closed(true, "Fixes #12")), core: fakeCore(), env });
    expect(fixed.labelsOf(12)).toEqual([]);

    const planned = make();
    await apply.runEvent({ github: planned.github, context: ctx("pull_request_target", closed(true, "Refs #13")), core: fakeCore(), env });
    expect(planned.labelsOf(13)).toEqual(["status:planned"]);

    const blocked = make();
    await apply.runEvent({ github: blocked.github, context: ctx("pull_request_target", closed(false, "Fixes #13")), core: fakeCore(), env });
    expect(blocked.labelsOf(13)).toEqual(["status:blocked"]);
  });

  it("a fork PR or a PR without a head repository changes nothing; an owner's fork PR does", async () => {
    const make = () => fakeGithub([{ number: 12, state: "open", labels: ["status:in-progress"] }]);
    const payload = (head: object, user: string) => ({ action: "opened", sender: { login: user }, pull_request: { number: 20, body: "Fixes #12", state: "open", head, user: { login: user } } });
    const fork = make();
    await apply.runEvent({ github: fork.github, context: ctx("pull_request_target", payload({ repo: { full_name: "mallory/openclaw-all-cli" } }, "mallory")), core: fakeCore(), env });
    await apply.runEvent({ github: fork.github, context: ctx("pull_request_target", payload({ repo: null }, "mallory")), core: fakeCore(), env });
    expect(fork.labelsOf(12)).toEqual(["status:in-progress"]);
    const owner = make();
    await apply.runEvent({ github: owner.github, context: ctx("pull_request_target", payload({ repo: { full_name: "xtimor/fork" } }, "xtimor")), core: fakeCore(), env });
    expect(owner.labelsOf(12)).toEqual(["status:in-review"]);
    const same = make();
    await apply.runEvent({ github: same.github, context: ctx("pull_request_target", payload({ repo: { full_name: REPO } }, "carol")), core: fakeCore(), env });
    expect(same.labelsOf(12)).toEqual(["status:in-review"]);
  });

  it("OPENED and a status labeled after it converge in either order (timeline read)", async () => {
    const events = { 12: [labeledAt("status:new", "alice", 0, 1), labeledAt("status:triaged", "bob", 5, 2)] };
    const openedAt = new Date(Date.parse("2026-10-20T10:00:00Z")).toISOString();
    const opened = { action: "opened", sender: { login: "alice" }, issue: { number: 12, created_at: openedAt } };
    const labeled = { action: "labeled", label: { name: "status:triaged" }, sender: { login: "bob" }, issue: { number: 12 } };
    const labels = ["status:new", "status:triaged"];
    for (const order of [[opened, labeled], [labeled, opened]]) {
      const fake = fakeGithub([{ number: 12, state: "open", labels }], { events });
      for (const payload of order) await apply.runEvent({ github: fake.github, context: ctx("issues", payload), core: fakeCore(), env });
      expect(fake.labelsOf(12)).toEqual(["status:triaged"]);
    }
    // The triaged label already there, the late opened run alone: it must not reset it.
    const only = fakeGithub([{ number: 12, state: "open", labels: ["status:triaged"] }], { events });
    await apply.runEvent({ github: only.github, context: ctx("issues", opened), core: fakeCore(), env });
    expect(only.labelsOf(12)).toEqual(["status:triaged"]);
    expect(only.calls).toEqual(["get 12", "events 12"]);
  });

  it("PR_MERGED_FIX into a non-default branch leaves the open issue's status; the close event clears it later", async () => {
    const fake = fakeGithub([{ number: 12, state: "open", labels: ["status:in-review"] }]);
    const merged = { action: "closed", sender: { login: "xtimor" }, pull_request: { number: 20, body: "Fixes #12", state: "closed", merged: true, ...HEAD } };
    await apply.runEvent({ github: fake.github, context: ctx("pull_request_target", merged), core: fakeCore(), env });
    expect(fake.labelsOf(12)).toEqual(["status:in-review"]);
  });

  it("CLOSED and UNLABELED through the API", async () => {
    const closing = fakeGithub([{ number: 12, state: "closed", labels: ["status:in-review", "type:bug"] }]);
    await apply.runEvent({ github: closing.github, context: ctx("issues", { action: "closed", sender: { login: "xtimor" }, issue: { number: 12 } }), core: fakeCore(), env });
    expect(closing.labelsOf(12)).toEqual(["type:bug"]);
    expect(closing.calls).toEqual(["get 12", "remove 12 status:in-review"]);

    const bare = fakeGithub([{ number: 13, state: "open", labels: ["type:bug"] }]);
    const payload = { action: "unlabeled", label: { name: "status:triaged" }, sender: { login: "bob" }, issue: { number: 13 } };
    await apply.runEvent({ github: bare.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(bare.labelsOf(13)).toEqual(["type:bug", "status:new"]);
  });

  it("reads the label timeline only when the labels need it", async () => {
    const settled = fakeGithub([{ number: 12, state: "open", labels: ["status:new", "type:bug"] }]);
    const payload = { action: "labeled", label: { name: "type:bug" }, sender: { login: "bob" }, issue: { number: 12 } };
    await apply.runEvent({ github: settled.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(settled.calls).toEqual(["get 12"]);
  });

  it("TWO_STATUS and NON_OWNER_APPROVED: a dropped or late run reaches the same result from the timeline", async () => {
    const events = {
      12: [labeledAt("status:triaged", "xtimor", 0, 1), labeledAt("status:approved", "mallory", 3, 2), labeledAt("type:bug", "alice", 4, 3)],
    };
    const labels = ["status:triaged", "status:approved", "type:bug"];
    // Only the run for the unrelated, later label survives: it still reverts the foreign approval.
    const late = fakeGithub([{ number: 12, state: "open", labels }], { events });
    const payload = { action: "labeled", label: { name: "type:bug" }, sender: { login: "alice" }, issue: { number: 12 } };
    await apply.runEvent({ github: late.github, context: ctx("issues", payload), core: fakeCore(), env });
    expect(late.labelsOf(12)).toEqual(["status:triaged", "type:bug"]);
    expect(late.comments(12)).toHaveLength(1);
    // Running it again (or the approval's own run after it) changes nothing and says nothing more.
    const again = { action: "labeled", label: { name: "status:approved" }, sender: { login: "mallory" }, issue: { number: 12 } };
    await apply.runEvent({ github: late.github, context: ctx("issues", again), core: fakeCore(), env });
    expect(late.labelsOf(12)).toEqual(["status:triaged", "type:bug"]);
    expect(late.comments(12)).toHaveLength(1);

    // Parallel runs for both events converge on the same labels.
    const parallel = fakeGithub([{ number: 12, state: "open", labels }], { events });
    await Promise.all([
      apply.runEvent({ github: parallel.github, context: ctx("issues", payload), core: fakeCore(), env }),
      apply.runEvent({ github: parallel.github, context: ctx("issues", again), core: fakeCore(), env }),
    ]);
    expect(parallel.labelsOf(12).sort()).toEqual(["status:triaged", "type:bug"]);
  });

  it("one failing issue does not stop the others, and the run fails at the end", async () => {
    const fake = fakeGithub(
      [
        { number: 12, state: "open", labels: ["status:in-progress"] },
        { number: 13, state: "open", labels: ["status:in-progress"] },
      ],
      { failOn: (call) => (call === "add 12 status:in-review" ? Object.assign(new Error("Server Error"), { status: 500 }) : undefined) },
    );
    const payload = { action: "opened", sender: { login: "carol" }, pull_request: { number: 20, body: "Fixes #12\nFixes #13", state: "open", ...HEAD } };
    await expect(apply.runEvent({ github: fake.github, context: ctx("pull_request_target", payload), core: fakeCore(), env })).rejects.toThrow(/1 of 2 failed: #12: Server Error/);
    expect(fake.labelsOf(13)).toEqual(["status:in-review"]);
  });

  it("an unhandled event does nothing", async () => {
    const fake = fakeGithub([]);
    expect(await apply.runEvent({ github: fake.github, context: ctx("push", {}), core: fakeCore(), env })).toEqual([]);
    expect(fake.calls).toEqual([]);
  });
});

describe("runStale", () => {
  const issues = (): FakeIssue[] => [
    { number: 1, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(1), user: { login: "alice" } },
    { number: 2, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(29), user: { login: "bob" } },
    { number: 3, state: "open", labels: ["status:triaged"], updated_at: daysAgo(60) },
    { number: 4, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(60), pull_request: {} },
  ];
  const events = (): Record<number, unknown[]> => ({
    1: [labeledAt("status:needs-info", "xtimor", 0, 1)].map((e) => ({ ...e, created_at: daysAgo(31) })),
    2: [{ ...labeledAt("status:needs-info", "xtimor", 0, 2), created_at: daysAgo(29) }],
  });
  const labeledDaysAgo = (id: number, days: number) => ({ ...labeledAt("status:needs-info", "xtimor", 0, id), created_at: daysAgo(days) });

  it("STALE: closes the issue labeled 31 days ago (updated yesterday) with a comment that mentions its author, leaves the 29-day one", async () => {
    const fake = fakeGithub(issues(), { events: events() });
    const core = fakeCore();
    expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core, dryRun: false, now: NOW })).toEqual([1]);
    expect(fake.calls).toEqual(["paginate open status:needs-info", "paginate open status:declined", "events 1", "events 2", "comment 1 @alice, this issue h", "remove 1 status:needs-info", "update 1 closed not_planned"]);
    expect(fake.comments(1)).toEqual([t.staleComment("alice")]);
    expect(fake.state(1)).toBe("closed");
    expect(fake.labelsOf(1)).toEqual([]);
    expect(fake.state(2)).toBe("open");
    expect(fake.labelsOf(2)).toEqual(["status:needs-info"]);
  });

  it("STALE: relabeled issue (added 40 days ago, removed, added 5 days ago) stays open", async () => {
    const fake = fakeGithub([{ number: 1, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(5) }], {
      events: {
        1: [
          labeledDaysAgo(1, 40),
          { id: 2, event: "unlabeled", created_at: daysAgo(38), label: { name: "status:needs-info" } },
          labeledDaysAgo(3, 5),
        ],
      },
    });
    expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW })).toEqual([]);
    expect(fake.state(1)).toBe("open");
  });

  it("STALE: an issue not updated for 30 days is closed without reading its events", async () => {
    const fake = fakeGithub([{ number: 1, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(31), user: { login: "alice" } }]);
    expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW })).toEqual([1]);
    expect(fake.calls).toEqual(["paginate open status:needs-info", "paginate open status:declined", "comment 1 @alice, this issue h", "remove 1 status:needs-info", "update 1 closed not_planned"]);
  });

  it("STALE: unreadable or missing label events fall back to the last update (still open)", async () => {
    const list: FakeIssue[] = [
      { number: 1, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(10) },
      { number: 2, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(29) },
    ];
    const fake = fakeGithub(list, {
      events: { 2: [{ id: 9, event: "labeled", created_at: daysAgo(35), label: { name: "type:bug" } }] },
      failOn: (call) => (call === "events 1" ? Object.assign(new Error("Server Error"), { status: 500 }) : undefined),
    });
    const core = fakeCore();
    expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core, dryRun: false, now: NOW })).toEqual([]);
    expect(core.lines.join("\n")).toContain("warning: issue-flow: #1 events not read, using its last update: Server Error");
    expect(fake.state(1)).toBe("open");
    expect(fake.state(2)).toBe("open");
  });

  it("STALE: a dry run lists and changes nothing", async () => {
    const fake = fakeGithub(issues(), { events: events() });
    const core = fakeCore();
    expect(await apply.runStale({ github: fake.github, context: ctx("workflow_dispatch", {}), core, dryRun: true, now: NOW })).toEqual([1]);
    expect(fake.calls).toEqual(["paginate open status:needs-info", "paginate open status:declined", "events 1", "events 2"]);
    expect(core.lines.join("\n")).toContain("would close #1");
    expect(fake.state(1)).toBe("open");
    expect(fake.comments(1)).toEqual([]);
  });

  describe("declined", () => {
    const env = { ISSUE_FLOW_OWNERS: "xtimor" };
    const declinedEvent = (id: number, days: number) => ({ ...labeledAt("status:declined", "agent[bot]", 0, id), created_at: daysAgo(days) });
    const list = (): FakeIssue[] => [
      { number: 1, state: "open", labels: ["status:declined", "type:bug"], updated_at: daysAgo(1), user: { login: "alice" } },
      { number: 2, state: "open", labels: ["status:declined"], updated_at: daysAgo(29), user: { login: "bob" } },
      { number: 3, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(40), user: { login: "carol" } },
    ];

    it("STALE: closes the issue declined 31 days ago (updated yesterday) mentioning the author and the owner, leaves the 29-day one", async () => {
      const fake = fakeGithub(list(), { events: { 1: [declinedEvent(1, 31)], 2: [declinedEvent(2, 29)] } });
      expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW, env })).toEqual([3, 1]);
      expect(fake.comments(1)).toEqual([t.declinedStaleComment("alice", ["xtimor"])]);
      expect(fake.comments(1)[0]).toContain("@alice, @xtimor: this issue");
      expect(fake.comments(3)).toEqual([t.staleComment("carol")]);
      expect(fake.state(1)).toBe("closed");
      expect(fake.labelsOf(1)).toEqual(["type:bug"]);
      expect(fake.state(2)).toBe("open");
      expect(fake.labelsOf(2)).toEqual(["status:declined"]);
    });

    it("STALE: re-declined after a status change counts from the latest declined label; unreadable events fall back to the last update", async () => {
      const relabeled = fakeGithub([list()[0]!], { events: { 1: [declinedEvent(1, 40), { id: 2, event: "unlabeled", created_at: daysAgo(38), label: { name: "status:declined" } }, declinedEvent(3, 5)] } });
      expect(await apply.runStale({ github: relabeled.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW, env })).toEqual([]);
      const unreadable = fakeGithub([list()[0]!], { failOn: (call) => (call === "events 1" ? new Error("down") : undefined) });
      expect(await apply.runStale({ github: unreadable.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW, env })).toEqual([]);
      expect(unreadable.state(1)).toBe("open");
    });

    it("STALE: an issue that carries both stale labels is listed once, handled as needs-info, and closed once", async () => {
      const both: FakeIssue = { number: 7, state: "open", labels: ["status:needs-info", "status:declined"], updated_at: daysAgo(40), user: { login: "alice" } };
      const fake = fakeGithub([both]);
      expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW, env })).toEqual([7]);
      expect(fake.comments(7)).toEqual([t.staleComment("alice")]);
      expect(fake.calls.filter((call) => call.startsWith("update"))).toEqual(["update 7 closed not_planned"]);
    });

    it("STALE: a dry run names the status and changes nothing; with no owner list only the author is mentioned", async () => {
      const dry = fakeGithub(list(), { events: { 1: [declinedEvent(1, 31)], 2: [declinedEvent(2, 29)] } });
      const core = fakeCore();
      expect(await apply.runStale({ github: dry.github, context: ctx("workflow_dispatch", {}), core, dryRun: true, now: NOW, env })).toEqual([3, 1]);
      expect(core.lines.join("\n")).toContain("would close #1 as not planned (status:declined since");
      expect(dry.state(1)).toBe("open");
      const none = fakeGithub(list(), { events: { 1: [declinedEvent(1, 31)] } });
      await apply.runStale({ github: none.github, context: ctx("schedule", {}), core: fakeCore(), dryRun: false, now: NOW, env: {} });
      expect(none.comments(1)).toEqual([t.declinedStaleComment("alice", [])]);
    });
  });

  it("is a dry run unless asked otherwise", async () => {
    const fake = fakeGithub(issues(), { events: events() });
    await apply.runStale({ github: fake.github, context: ctx("workflow_dispatch", {}), core: fakeCore(), now: NOW });
    expect(fake.calls).toEqual(["paginate open status:needs-info", "paginate open status:declined", "events 1", "events 2"]);
  });

  it("isDryRun: dispatch defaults to a dry run, the schedule never is", () => {
    expect(apply.isDryRun("workflow_dispatch", "true")).toBe(true);
    expect(apply.isDryRun("workflow_dispatch", true)).toBe(true);
    expect(apply.isDryRun("workflow_dispatch", "")).toBe(true);
    expect(apply.isDryRun("workflow_dispatch", undefined)).toBe(true);
    expect(apply.isDryRun("workflow_dispatch", "false")).toBe(false);
    expect(apply.isDryRun("schedule", "")).toBe(false);
    expect(apply.isDryRun("schedule", "true")).toBe(false);
  });
});

describe("workflow file", () => {
  const text = readFileSync(join(ROOT, ".github", "workflows", "issue-flow.yml"), "utf8");

  it("pins every action by SHA and asks for no more than issues: write", () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)];
    expect(uses).toHaveLength(3);
    for (const [, ref, rest] of uses) {
      expect(ref).toMatch(/@[0-9a-f]{40}$/);
      expect(rest).toMatch(/# v\d/);
    }
    expect(text).toContain("actions/github-script@3a2844b7e9c422d3c10d287c895573f7108da1b3 # v9.0.0");
    expect(text).toMatch(/permissions:\n {2}issues: write\n {2}pull-requests: read\n {2}contents: read\n/);
  });

  it("keeps the owner list in the workflow and never in the module", () => {
    expect(text).toMatch(/^ {2}ISSUE_FLOW_OWNERS: xtimor$/m);
    expect(text).toMatch(/^ {2}ISSUE_FLOW_AGENTS: "openclaw-all-cli-agent\[bot\]"$/m);
    for (const file of ["transitions.mjs", "apply.mjs"]) expect(readFileSync(join(FLOW_DIR, file), "utf8")).not.toContain("xtimor");
  });

  it("has the close and unlabeled triggers and no concurrency group", () => {
    expect(text).toMatch(/issues:\n {4}types: \[opened, reopened, closed, labeled, unlabeled\]/);
    expect(text).not.toMatch(/^\s*concurrency:/m);
  });

  it("runs no PR code and passes no event text into the scripts", () => {
    expect(text).not.toMatch(/ref:\s*\$\{\{/);
    // The only expressions inside a script are the trusted workspace path.
    const scripts = [...text.matchAll(/script: \|\n((?: {12}.*\n?)+)/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    for (const script of scripts) expect([...(script ?? "").matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1]?.trim())).toEqual(["github.workspace"]);
  });
});

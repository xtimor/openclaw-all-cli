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

type Action = { op: "addLabel" | "removeLabel"; label: string } | { op: "comment"; body: string } | { op: "close"; reason: string };
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
}
interface Transitions {
  STATUS_LABELS: string[];
  STALE_DAYS: number;
  NON_OWNER_APPROVAL_COMMENT: string;
  STALE_COMMENT: string;
  decide(event: Event, issue: IssueIn, options?: { owners?: string[] }): Action[];
  linkedIssues(body: unknown, repo?: string): Array<{ number: number; kind: "fixes" | "refs" }>;
  staleIssues(issues: IssueIn[], now: Date | number, days?: number): IssueIn[];
  parseOwners(value: unknown): string[];
  isBot(login: unknown): boolean;
}
interface Apply {
  applyActions(github: unknown, context: unknown, issueNumber: number, actions: Action[]): Promise<Action[]>;
  runEvent(args: { github: unknown; context: unknown; core: unknown; env?: Record<string, string> }): Promise<Array<{ issue: number; actions: Action[] }>>;
  runStale(args: { github: unknown; context: unknown; core: unknown; dryRun?: boolean; now?: number }): Promise<number[]>;
  isDryRun(eventName: string, input: unknown): boolean;
}

// The scripts are plain .mjs with no type declarations; a variable specifier keeps TypeScript out of them.
const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(FLOW_DIR, file)).href)) as T;
const t = await load<Transitions>("transitions.mjs");
const apply = await load<Apply>("apply.mjs");

const OWNERS = ["xtimor"];
const REPO = "xtimor/openclaw-all-cli";
const NOW = Date.parse("2026-10-22T12:00:00Z");
const daysAgo = (days: number) => new Date(NOW - days * 24 * 3600 * 1000).toISOString();
const issue = (labels: string[], extra: IssueIn = {}): IssueIn => ({ number: 12, state: "open", labels, user: { login: "alice" }, ...extra });
const add = (label: string): Action => ({ op: "addLabel", label });
const remove = (label: string): Action => ({ op: "removeLabel", label });

describe("STATUS_LABELS", () => {
  it("are the 8 states of .github/labels.yml, in order", () => {
    const text = readFileSync(join(ROOT, ".github", "labels.yml"), "utf8");
    const fromFile = [...text.matchAll(/^- name: "(status:[^"]+)"/gm)].map((match) => match[1]);
    expect(fromFile).toHaveLength(8);
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

  it("TWO_STATUS: a newly added status label wins and the others go", () => {
    const labeled = (label: string) => ({ name: "issues", action: "labeled", actor: "xtimor", label });
    expect(t.decide(labeled("status:triaged"), issue(["status:new", "status:triaged", "type:bug"]), { owners: OWNERS })).toEqual([remove("status:new")]);
    expect(t.decide(labeled("status:in-review"), issue(["status:triaged", "status:in-review", "status:blocked"]), { owners: OWNERS })).toEqual([
      remove("status:triaged"),
      remove("status:blocked"),
    ]);
  });

  it("a label that is not a status label, or is already gone, changes nothing", () => {
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice", label: "type:bug" }, issue(["status:new", "status:triaged", "type:bug"]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice", label: "status:triaged" }, issue(["status:new"]))).toEqual([]);
    expect(t.decide({ name: "issues", action: "labeled", actor: "alice" }, issue(["status:new"]))).toEqual([]);
  });

  it("NON_OWNER_APPROVED: removes approved, restores the previous status, comments", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    expect(t.decide(event, issue(["status:triaged", "status:approved"]), { owners: OWNERS })).toEqual([
      remove("status:approved"),
      { op: "comment", body: t.NON_OWNER_APPROVAL_COMMENT },
    ]);
  });

  it("NON_OWNER_APPROVED: no previous status gives status:new", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    expect(t.decide(event, issue(["status:approved", "type:bug"]), { owners: OWNERS })).toEqual([
      add("status:new"),
      remove("status:approved"),
      { op: "comment", body: t.NON_OWNER_APPROVAL_COMMENT },
    ]);
  });

  it("NON_OWNER_APPROVED: an ambiguous pile of previous statuses gives status:new", () => {
    const event = { name: "issues", action: "labeled", actor: "mallory", label: "status:approved" };
    expect(t.decide(event, issue(["status:triaged", "status:blocked", "status:approved"]), { owners: OWNERS })).toEqual([
      add("status:new"),
      remove("status:triaged"),
      remove("status:blocked"),
      remove("status:approved"),
      { op: "comment", body: t.NON_OWNER_APPROVAL_COMMENT },
    ]);
  });

  it("NON_OWNER_APPROVED: an empty owner list makes everyone a non-owner", () => {
    const event = { name: "issues", action: "labeled", actor: "xtimor", label: "status:approved" };
    for (const options of [undefined, { owners: [] }, { owners: parseOwnersOf("") }]) {
      expect(t.decide(event, issue(["status:triaged", "status:approved"]), options)).toEqual([
        remove("status:approved"),
        { op: "comment", body: t.NON_OWNER_APPROVAL_COMMENT },
      ]);
    }
  });

  it("NON_OWNER_APPROVED: a missing actor is a non-owner", () => {
    const event = { name: "issues", action: "labeled", actor: null, label: "status:approved" };
    expect(t.decide(event, issue(["status:approved"]), { owners: OWNERS })[0]).toEqual(add("status:new"));
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

describe("decide: issue_comment", () => {
  const comment = (actor: string | null) => ({ name: "issue_comment", action: "created", actor });

  it("AUTHOR_REPLY: the author's comment on needs-info moves it to new", () => {
    expect(t.decide(comment("alice"), issue(["status:needs-info", "type:bug"]))).toEqual([add("status:new"), remove("status:needs-info")]);
    expect(t.decide(comment("ALICE"), issue(["status:needs-info"]))).toEqual([add("status:new"), remove("status:needs-info")]);
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
  const pr = (action: string, link: string, extra: Partial<Event> = {}): Event => ({ name: "pull_request", action, actor: "carol", link, prState: action === "closed" ? "closed" : "open", ...extra });

  it("PR_OPENED: opened, edited, and reopened move the issue to in-review", () => {
    for (const action of ["opened", "edited", "reopened"]) {
      expect(t.decide(pr(action, "fixes"), issue(["status:approved", "type:bug"]))).toEqual([add("status:in-review"), remove("status:approved")]);
      expect(t.decide(pr(action, "refs"), issue(["status:in-progress"]))).toEqual([add("status:in-review"), remove("status:in-progress")]);
    }
    expect(t.decide(pr("edited", "fixes"), issue(["status:in-review"]))).toEqual([]);
  });

  it("PR_OPENED: a linked issue that is a PR or closed is skipped", () => {
    expect(t.decide(pr("opened", "fixes"), issue(["status:new"], { pull_request: {} }))).toEqual([]);
    expect(t.decide(pr("opened", "fixes"), issue([], { state: "closed" }))).toEqual([]);
  });

  it("an edit after the PR was closed changes nothing", () => {
    expect(t.decide(pr("edited", "fixes", { prState: "closed" }), issue(["status:blocked"]))).toEqual([]);
  });

  it("PR_MERGED_FIX: a merged Fixes removes the status (open or already closed by GitHub)", () => {
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["status:in-review", "type:bug"]))).toEqual([remove("status:in-review")]);
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["status:in-review"], { state: "closed" }))).toEqual([remove("status:in-review")]);
    expect(t.decide(pr("closed", "fixes", { merged: true }), issue(["type:bug"], { state: "closed" }))).toEqual([]);
  });

  it("PR_MERGED_REFS: a merged Refs moves the issue to planned", () => {
    expect(t.decide(pr("closed", "refs", { merged: true }), issue(["status:in-review"]))).toEqual([add("status:planned"), remove("status:in-review")]);
    expect(t.decide(pr("closed", "refs", { merged: true }), issue(["status:in-review"], { state: "closed" }))).toEqual([]);
  });

  it("PR_CLOSED: closed unmerged moves the issue to blocked", () => {
    for (const link of ["fixes", "refs"]) {
      expect(t.decide(pr("closed", link, { merged: false }), issue(["status:in-review"]))).toEqual([add("status:blocked"), remove("status:in-review")]);
      expect(t.decide(pr("closed", link), issue(["status:in-review"]))).toEqual([add("status:blocked"), remove("status:in-review")]);
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

  it("STALE: 15 days is stale, 13 days is not, exactly 14 days is", () => {
    const issues = [needsInfo(1, 15), needsInfo(2, 13), needsInfo(3, 14), needsInfo(4, 100)];
    expect(t.staleIssues(issues, NOW, 14).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(t.staleIssues(issues, new Date(NOW)).map((i) => i.number)).toEqual([1, 3, 4]);
    expect(t.STALE_DAYS).toBe(14);
  });

  it("skips other states, pull requests, closed issues, and unreadable dates", () => {
    const issues = [
      needsInfo(1, 30, { labels: ["status:triaged"] }),
      needsInfo(2, 30, { pull_request: {} }),
      needsInfo(3, 30, { state: "closed" }),
      needsInfo(4, 30, { updated_at: "not a date" }),
      needsInfo(5, 30, { updated_at: undefined }),
      needsInfo(6, -3),
    ];
    expect(t.staleIssues(issues, NOW)).toEqual([]);
    expect(t.staleIssues(issues, Number.NaN)).toEqual([]);
    expect(t.staleIssues(undefined as unknown as IssueIn[], NOW)).toEqual([]);
  });

  it("STALE: closes as not planned with a comment and keeps no status", () => {
    expect(t.decide({ name: "stale" }, needsInfo(1, 15))).toEqual([
      { op: "comment", body: t.STALE_COMMENT },
      remove("status:needs-info"),
      { op: "close", reason: "not_planned" },
    ]);
    expect(t.decide({ name: "stale" }, needsInfo(1, 15, { labels: ["status:triaged"] }))).toEqual([]);
    expect(t.decide({ name: "stale" }, needsInfo(1, 15, { state: "closed" }))).toEqual([]);
  });

  it("the comments are fixed text with no issue data in them", () => {
    for (const body of [t.STALE_COMMENT, t.NON_OWNER_APPROVAL_COMMENT]) {
      expect(body).toMatch(/^<!-- issue-flow -->\n/);
      expect(body).not.toMatch(/\$\{|@\w/);
    }
    expect(t.STALE_COMMENT).toContain("14 days");
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
function fakeGithub(issues: FakeIssue[], options: { missingLabels?: Set<string>; failOn?: (call: string) => Error | undefined } = {}) {
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
      createComment: ({ issue_number, body }: { issue_number: number; body: string }) => record(`comment ${issue_number} ${body.split("\n")[1]?.slice(0, 20)}`, () => undefined),
      update: ({ issue_number, state, state_reason }: { issue_number: number; state: "closed"; state_reason: string }) =>
        record(`update ${issue_number} ${state} ${state_reason}`, () => {
          byNumber.get(issue_number)!.state = state;
        }),
      listForRepo: Symbol("listForRepo"),
    },
  };
  const github = {
    rest,
    paginate: async (method: unknown, params: { state: string; labels: string }) => {
      calls.push(`paginate ${params.state} ${params.labels}`);
      expect(method).toBe(rest.issues.listForRepo);
      return [...byNumber.values()]
        .filter((i) => i.state === params.state && (i.labels ?? []).map((l) => (typeof l === "string" ? l : l.name)).includes(params.labels))
        .map((i) => structuredClone(i));
    },
  };
  const labelsOf = (number: number) => (byNumber.get(number)?.labels ?? []).map((l) => (typeof l === "string" ? l : l.name));
  return { github, calls, labelsOf, state: (number: number) => byNumber.get(number)?.state };
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
    expect(fake.calls).toEqual(["get 12", "remove 12 status:approved", "comment 12 Only the owner appro"]);
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

  it("PR_OPENED: links #12 and #13, skips a PR, a closed issue, a missing issue, and another repository", async () => {
    const fake = fakeGithub([
      { number: 12, state: "open", labels: ["status:approved"] },
      { number: 13, state: "open", labels: ["status:planned"] },
      { number: 14, state: "open", labels: ["status:new"], pull_request: {} },
      { number: 15, state: "closed", labels: [] },
    ]);
    const body = "Fixes #12\nrefs #13\nFixes #14\nFixes #15\nFixes #99\nFixes other/repo#16";
    const payload = { action: "opened", sender: { login: "carol" }, pull_request: { number: 20, body, state: "open", merged: false } };
    const core = fakeCore();
    const result = await apply.runEvent({ github: fake.github, context: ctx("pull_request_target", payload), core, env });
    expect(result.map((r) => r.issue)).toEqual([12, 13]);
    expect(fake.labelsOf(12)).toEqual(["status:in-review"]);
    expect(fake.labelsOf(13)).toEqual(["status:in-review"]);
    expect(fake.labelsOf(14)).toEqual(["status:new"]);
    expect(fake.calls.filter((c) => c.startsWith("get"))).toEqual(["get 12", "get 13", "get 14", "get 15", "get 99"]);
    expect(core.lines.join("\n")).toContain("#99 not found");
  });

  it("PR_MERGED_FIX, PR_MERGED_REFS, PR_CLOSED through the API", async () => {
    const make = () =>
      fakeGithub([
        { number: 12, state: "closed", labels: ["status:in-review"] },
        { number: 13, state: "open", labels: ["status:in-review"] },
      ]);
    const closed = (merged: boolean, body: string) => ({ action: "closed", sender: { login: "xtimor" }, pull_request: { number: 20, body, state: "closed", merged } });

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

  it("one failing issue does not stop the others, and the run fails at the end", async () => {
    const fake = fakeGithub(
      [
        { number: 12, state: "open", labels: ["status:approved"] },
        { number: 13, state: "open", labels: ["status:approved"] },
      ],
      { failOn: (call) => (call === "add 12 status:in-review" ? Object.assign(new Error("Server Error"), { status: 500 }) : undefined) },
    );
    const payload = { action: "opened", sender: { login: "carol" }, pull_request: { number: 20, body: "Fixes #12\nFixes #13", state: "open" } };
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
    { number: 1, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(15) },
    { number: 2, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(13) },
    { number: 3, state: "open", labels: ["status:triaged"], updated_at: daysAgo(40) },
    { number: 4, state: "open", labels: ["status:needs-info"], updated_at: daysAgo(14), pull_request: {} },
  ];

  it("STALE: closes the 15-day issue with a comment, leaves the 13-day one", async () => {
    const fake = fakeGithub(issues());
    const core = fakeCore();
    expect(await apply.runStale({ github: fake.github, context: ctx("schedule", {}), core, dryRun: false, now: NOW })).toEqual([1]);
    expect(fake.calls).toEqual(["paginate open status:needs-info", "comment 1 No reply for 14 days", "remove 1 status:needs-info", "update 1 closed not_planned"]);
    expect(fake.state(1)).toBe("closed");
    expect(fake.labelsOf(1)).toEqual([]);
    expect(fake.state(2)).toBe("open");
  });

  it("STALE: a dry run lists and changes nothing", async () => {
    const fake = fakeGithub(issues());
    const core = fakeCore();
    expect(await apply.runStale({ github: fake.github, context: ctx("workflow_dispatch", {}), core, dryRun: true, now: NOW })).toEqual([1]);
    expect(fake.calls).toEqual(["paginate open status:needs-info"]);
    expect(core.lines.join("\n")).toContain("would close #1");
    expect(fake.state(1)).toBe("open");
  });

  it("is a dry run unless asked otherwise", async () => {
    const fake = fakeGithub(issues());
    await apply.runStale({ github: fake.github, context: ctx("workflow_dispatch", {}), core: fakeCore(), now: NOW });
    expect(fake.calls).toEqual(["paginate open status:needs-info"]);
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
    for (const file of ["transitions.mjs", "apply.mjs"]) expect(readFileSync(join(FLOW_DIR, file), "utf8")).not.toContain("xtimor");
  });

  it("runs no PR code and passes no event text into the scripts", () => {
    expect(text).not.toMatch(/ref:\s*\$\{\{/);
    // The only expressions inside a script are the trusted workspace path.
    const scripts = [...text.matchAll(/script: \|\n((?: {12}.*\n?)+)/g)].map((m) => m[1]);
    expect(scripts).toHaveLength(2);
    for (const script of scripts) expect([...(script ?? "").matchAll(/\$\{\{([^}]*)\}\}/g)].map((m) => m[1]?.trim())).toEqual(["github.workspace"]);
  });
});

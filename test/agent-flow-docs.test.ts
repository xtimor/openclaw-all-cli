import { readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The issue agents' procedure as documents (ticket 3.21): what the docs must keep saying, because a run follows them. These
 * are pins, not proofs: the scripts they name have their own tests (plan-gate, batch-pending, agent-write, batch-merge).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (...parts: string[]) => readFileSync(join(ROOT, ...parts), "utf8");
const implement = read("docs", "agents", "implement.md");
const triage = read("docs", "agents", "triage.md");
const issues = read("docs", "issues.md");

/** The text between a heading and the next heading of the same or a higher level. */
function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no section ${heading}`);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const rest = text.slice(start + heading.length + 2);
  const next = rest.search(new RegExp(`^#{1,${level}} `, "m"));
  return next < 0 ? rest : rest.slice(0, next);
}

describe("the relay is called alone (c)", () => {
  const files = [...readdirSync(join(ROOT, "docs", "agents")).map((name) => join("docs", "agents", name)), join("docs", "issues.md")];
  const SHAPE = /^scripts\/agent-relay\.sh( (\/tmp\/agent-ops-<n>\.json|<file>))?$/;

  it("every code span or code line that names scripts/agent-relay.sh is the bare command, with no chaining", () => {
    const seen: string[] = [];
    for (const file of files) {
      const text = read(file);
      for (const [, span] of text.matchAll(/`([^`\n]*agent-relay\.sh[^`\n]*)`/g)) seen.push(`${file}: ${span}`);
      let fenced = false;
      for (const line of text.split("\n")) {
        if (line.trimStart().startsWith("```")) fenced = !fenced;
        else if (fenced && line.includes("agent-relay.sh")) seen.push(`${file}: ${line.trim()}`);
      }
    }
    expect(seen.length).toBeGreaterThanOrEqual(5);
    for (const entry of seen) expect(entry.slice(entry.indexOf(": ") + 2), entry).toMatch(SHAPE);
  });

  it("implement.md, triage.md, and identity.md each say the call stands alone and that a chained one is refused", () => {
    for (const [name, text] of [["implement.md", implement], ["triage.md", triage], ["identity.md", read("docs", "agents", "identity.md")]] as const) {
      expect(text, name).toContain("scripts/agent-relay.sh /tmp/agent-ops-<n>.json");
      expect(text, name).toMatch(/nothing (chained )?(before or after|after it)|by itself|the whole call|as a call by itself|whole call/i);
      expect(text, name).toMatch(/permission check/);
    }
  });
});

describe("a run ends only after its batch pull request is ready (a)", () => {
  const checklist = section(implement, "## Run checklist");
  const items = checklist.split("\n").filter((line) => /^\d+\. /.test(line));

  it("the Run checklist is one numbered procedure from the first check to the report, in this order", () => {
    expect(items).toHaveLength(9);
    const order = [/Identity/, /Before the batch/, /batch-pending\.sh set/, /Per issue/, /dev-orchestrator/, /plan-gate/, /Open the pull request.*pr_ready/s, /in-review.*batch-pending\.sh clear/s, /report/i];
    items.forEach((item, i) => expect(item, `item ${i + 1}`).toMatch(order[i] as RegExp));
    expect(items[8]).toMatch(/draft/);
    expect(checklist).toMatch(/first thing after `dev-orchestrator` returns/);
  });

  it("the marker is set at the claim and cleared only after the issues are marked in-review, in the steps themselves", () => {
    const before = section(implement, "## Before the batch");
    expect(before).toContain("scripts/batch-pending.sh set <branch>");
    const open = section(implement, "## Open the pull request");
    const ready = open.indexOf("`pr_ready`");
    const inReview = open.indexOf("status:in-review");
    const clear = open.indexOf("scripts/batch-pending.sh clear");
    expect(ready).toBeGreaterThan(0);
    expect(inReview).toBeGreaterThan(ready);
    expect(clear).toBeGreaterThan(inReview);
    expect(implement).toMatch(/Failure\.\*\* .*batch-pending\.sh clear/);
  });

  it("the report names the pull request's ready state, and triage's report is not the end of the run", () => {
    expect(section(implement, "## Report")).toMatch(/ready for review \(`draft: false`\)/);
    expect(triage).toMatch(/The triage report is not the end of the run/);
    expect(triage).toContain("implement.md#run-checklist");
  });

  it("the owner section gives the routine prompt and a stop-hook snippet that matches the script", () => {
    const setup = section(issues, "## Routine setup (owner)");
    expect(setup).toContain("The run ends only when the implementation part");
    const json = /```json\n([\s\S]*?)```/.exec(setup)?.[1] ?? "";
    const parsed = JSON.parse(json) as { permissions: { allow: string[] }; hooks: { Stop: { hooks: { type: string; command: string }[] }[] } };
    expect(parsed.hooks.Stop[0]?.hooks[0]?.command).toBe("$CLAUDE_PROJECT_DIR/scripts/batch-pending.sh stop-hook");
    expect(parsed.permissions.allow).toEqual(["Bash(scripts/batch-pending.sh set *)", "Bash(scripts/batch-pending.sh clear)"]);
  });
});

describe("an idle draft is resumed, never rebuilt (b)", () => {
  const before = section(implement, "## Before the batch");

  it("step 2 resumes an idle `Issue batch (in progress)` draft and step 7 merges it into the session branch", () => {
    expect(before).toMatch(/\*\*Resume an idle draft; never rebuild what it built\.\*\*/);
    expect(before).toContain("git merge --no-edit origin/<head>");
    expect(before).toMatch(/a run pushes only its own session branch/i);
    expect(before).not.toMatch(/Close it yourself/);
  });

  it("the old draft is closed only in the dispatch that opens the new one, in order, and a conflict never closes built work", () => {
    expect(before).toMatch(/`pr_create` \(yours\), a `comment` op[\s\S]*`pr_edit` op[\s\S]*and `pr_close`/);
    expect(before).toMatch(/A plan at `done` or `built`: leave the draft open/);
  });

  it("the build treats a built ticket of a resumed draft as built, not as a block", () => {
    const build = section(implement, "## Build the batch");
    expect(build).toContain("**Built (resumed)**");
    expect(build).toMatch(/a built ticket of a resumed draft is the Built path, not a block/);
  });

  it("identity.md describes the relay's pr_close guard the way the script enforces it", () => {
    const row = read("docs", "agents", "identity.md").split("\n").find((line) => line.trim().startsWith("| `pr_close`")) ?? "";
    expect(row).toMatch(/`done` or `built`/);
    expect(row).toMatch(/already contains its head/);
  });
});

describe("a plan that says blocked or review not run is not closed done (e)", () => {
  it("the build step runs plan-gate before npm run ci and blocks the issue on a failure", () => {
    const build = section(implement, "## Build the batch");
    const gate = build.indexOf("node scripts/plan-gate.mjs <plan>");
    expect(gate).toBeGreaterThan(0);
    expect(build.indexOf("npm run ci", gate)).toBeGreaterThan(gate);
    expect(build).toMatch(/block the issue \(\[step 3\]\(#3-block-an-issue\)\)/);
  });

  it("the orchestrator is told to run the gate before it marks a ticket done", () => {
    const toml = read("_bmad", "custom", "dev-orchestrator.toml");
    expect(toml).toContain("scripts/plan-gate.mjs");
    expect(toml).toMatch(/before `close` runs `tickets\.py mark <ref> done`/);
  });
});

describe("Batch merge waits for a final state (d)", () => {
  it("the docs and the workflow say so", () => {
    expect(implement).toMatch(/waits for it, about 5 minutes at most/);
    expect(read(".github", "workflows", "batch-merge.yml")).toMatch(/waits for it inside the script, about 5 minutes at most/);
    expect(read("scripts", "batch-merge.mjs")).toContain("BATCH_MERGE_WAIT_MS");
  });
});

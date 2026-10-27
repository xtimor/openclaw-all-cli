import { execFile } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/plan-gate.mjs (ticket 3.21 e): a ticket whose plan says blocked or "review not run" is not closed as done.
 * The fixtures are the two shapes found live (ticket 10 of the 2026-10-26 run, and an earlier backlog bug).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "plan-gate.mjs");

interface Gate {
  planProblems: (text: string) => string[];
  planStatus: (text: string) => string;
}
let gate: Gate;
beforeAll(async () => {
  gate = (await import(pathToFileURL(SCRIPT).href)) as Gate;
});

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});

const plan = (front: Record<string, string> = {}, result = "Status: built. `npm run ci` passed. Review: inline self-review (no subagents).") => {
  const fields: Record<string, string> = { status: "done", review: "'quick'", ...front };
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${value}`);
  return `---\ntitle: 'x'\n${lines.join("\n")}\ndeferred: []\n---\n\n## Review Triage Log\n\n## Auto Run Result\n\n${result}\n\n## Later\n\nStatus: blocked (not part of the result)\n`;
};

describe("plan-gate", () => {
  it("OK: a finished plan whose review ran, in any form (a quick lens, an inline self-review), passes", () => {
    expect(gate.planProblems(plan())).toEqual([]);
    expect(gate.planProblems(plan({ status: "built", review: "'thorough'" }, "- Review: 9 findings; 2 patched.\n- Live check: not run."))).toEqual([]);
    expect(gate.planProblems(plan({ review: "quick # none | quick | thorough" }))).toEqual([]);
    expect(gate.planStatus(plan({ status: "built" }))).toBe("built");
  });

  it("TICKET_10: status done but review empty, Status: blocked, a blocking condition, and Review not run is refused with each reason", () => {
    const ticket10 = plan(
      { review: "''" },
      "Status: blocked\nBlocking condition: no subagents (step 4 Quick review needs a reviewer subagent; this worker cannot launch one)\n\n- Implemented and verified.\n- Review not run.",
    );
    const problems = gate.planProblems(ticket10).join(" | ");
    expect(problems).toContain("review is empty");
    expect(problems).toContain("says the status is blocked");
    expect(problems).toContain("names a blocking condition");
    expect(problems).toContain("review did not run");
  });

  it("BACKLOG_CLASH: a review named quick in the frontmatter but 'Review: not run' / 'no review ran' in the result is refused", () => {
    for (const result of ["Status: blocked. Blocking condition: `no subagents`. No review ran, no findings.", "- Review: not run. Deferred: none.", "Review not run.", "- The quick review itself is still owed.", "- review: skipped"]) {
      expect(gate.planProblems(plan({}, result)), result).not.toEqual([]);
    }
  });

  it("STATUS: a plan that is not done or built, or carries blocked_at / blocked_reason (a HALT wrote them), is refused", () => {
    for (const status of ["blocked", "in-progress", "in-review", "ready-for-dev", "draft", "dropped", "''"]) {
      expect(gate.planProblems(plan({ status })).join(" "), status).toContain("not done or built");
    }
    expect(gate.planProblems(plan({ blocked_reason: "'no subagents'" })).join(" ")).toContain("blocked_reason");
    expect(gate.planProblems(plan({ blocked_at: "2026-10-26" })).join(" ")).toContain("blocked_reason");
    expect(gate.planProblems("no frontmatter at all").join(" ")).toContain("not done or built");
  });

  it("NO_FALSE_POSITIVES: words that merely contain the phrases, a live check not run, and text outside the Auto Run Result do not trip it", () => {
    const fine = [
      "- Review: no findings; live Cursor check not run.",
      "Status: built. Reviewed inline; the owner's review of the PR is still ahead.",
      "- Follow-up review recommended: false.",
      "- Unblocked earlier: status was blocked in the first attempt.",
    ];
    for (const result of fine) expect(gate.planProblems(plan({}, result)), result).toEqual([]);
  });

  it("CLI: one line per plan, exit 0 when all are ok, 1 when any is not, 2 for no arguments or an unreadable plan", async () => {
    const dir = mkdtempSync(join(tmpdir(), "plan-gate-"));
    dirs.push(dir);
    const good = join(dir, "good-plan.md");
    const bad = join(dir, "bad-plan.md");
    writeFileSync(good, plan());
    writeFileSync(bad, plan({ review: "''" }, "Status: blocked\nReview not run."));
    const run = (args: string[]) =>
      new Promise<{ code: number; stdout: string; stderr: string }>((done) => {
        execFile(process.execPath, [SCRIPT, ...args], { timeout: 20_000 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
      });
    const ok = await run([good]);
    expect(ok).toMatchObject({ code: 0, stdout: `plan-gate: ${good}: ok (done)\n` });
    const mixed = await run([good, bad]);
    expect(mixed.code).toBe(1);
    expect(mixed.stdout).toContain(`plan-gate: ${good}: ok (done)`);
    expect(mixed.stdout).toMatch(new RegExp(`plan-gate: ${bad}: not ok: review is empty`));
    expect((await run([])).code).toBe(2);
    const missing = await run([join(dir, "nope-plan.md")]);
    expect(missing.code).toBe(2);
    expect(missing.stdout).toContain("not ok: the plan cannot be read");
  });
});

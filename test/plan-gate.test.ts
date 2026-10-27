import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
    for (const result of ["Status: blocked. Blocking condition: `no subagents`. No review ran, no findings.", "- Review: not run. Deferred: none.", "Review not run.", "- Review: not run (no subagents).", "- review: skipped"]) {
      expect(gate.planProblems(plan({}, result)), result).not.toEqual([]);
    }
  });

  it("CRLF: a plan saved with Windows line endings reads the same", () => {
    expect(gate.planProblems(plan().replaceAll("\n", "\r\n"))).toEqual([]);
    expect(gate.planProblems(plan({ review: "''" }, "Status: blocked").replaceAll("\n", "\r\n")).length).toBeGreaterThan(0);
  });

  it("SECTIONS: only the last Auto Run Result section counts, and in it the latest status line; a retry that finished clears an earlier block", () => {
    const blocked = "## Auto Run Result\n\nStatus: blocked. Blocking condition: `no subagents`.\nReview not run.\n";
    const retried = "## Auto Run Result (review pass 1)\n\n- Review: thorough, 9 findings.\n";
    const base = plan({}, "x").split("## Auto Run Result")[0];
    expect(gate.planProblems(`${base}${blocked}\n${retried}`)).toEqual([]);
    expect(gate.planProblems(`${base}${retried}\n${blocked}`).join(" ")).toContain("says the status is blocked");
    // Same section: the blocked line first, the finished status after it.
    expect(gate.planProblems(plan({}, "Status: blocked. Blocking condition: `no subagents`.\nStatus: built. Review: inline, 3 findings."))).toEqual([]);
    expect(gate.planProblems(plan({}, "Status: built. Review: inline.\nStatus: blocked after the rebase."))).not.toEqual([]);
    // A blocking condition that is a real condition still counts when there is no later finished status.
    expect(gate.planProblems(plan({}, "Blocking condition: `no subagents`")).join(" ")).toContain("blocking condition");
    // Only "Status:" lines are status lines: a later "Status of the live check" does not hide a block.
    expect(gate.planProblems(plan({}, "Status: blocked. Blocking condition: `no subagents`.\n- Status of the live check: not run.")).join(" ")).toContain("says the status is blocked");
    expect(gate.planProblems(plan({}, "**Status:** `built`. Review: inline."))).toEqual([]);
    // "has not run" is the review-not-run wording too.
    expect(gate.planProblems(plan({}, "Status: built. Review has not run.")).join(" ")).toMatch(/review/i);
  });

  it("REVIEW_NONE: a review skipped on purpose (review: none) may say so; a blocked status still fails", () => {
    expect(gate.planProblems(plan({ review: "'none'" }, "Status: built. Review: skipped (none was asked for)."))).toEqual([]);
    expect(gate.planProblems(plan({ review: "'none'" }, "Status: blocked\nReview: skipped")).join(" ")).toContain("says the status is blocked");
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
      "Status: built.\nBlocking condition: none.",
      "- Blocking condition: `none`",
      "- Edge-case lens review skipped (diff too small); blind review ran.",
      "- Review: 4 findings. A follow-up review is still owed for the live Control UI render.",
      "- The quick review itself is still owed after the live check.",
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

  describe("--changed <base>: CI gates the finished plans a batch adds or changes", () => {
    const BAD = plan({ review: "''" }, "Status: blocked\nReview not run.");
    const git = (cwd: string, ...args: string[]) =>
      new Promise<void>((done, fail) => {
        execFile("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...args], { cwd }, (error) => (error ? fail(error) : done()));
      });
    const gate = (cwd: string, args: string[], env: Record<string, string> = {}) =>
      new Promise<{ code: number; stdout: string }>((done) => {
        const clean = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "CI" && !key.startsWith("VITEST")));
        execFile(process.execPath, [SCRIPT, ...args], { cwd, env: { ...clean, ...env }, timeout: 20_000 }, (error, stdout) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout }));
      });
    const put = (cwd: string, name: string, text: string) => {
      mkdirSync(join(cwd, "_bmad-output", "backlog"), { recursive: true });
      writeFileSync(join(cwd, "_bmad-output", "backlog", name), text);
    };
    async function repo(): Promise<string> {
      const dir = mkdtempSync(join(tmpdir(), "plan-gate-git-"));
      dirs.push(dir);
      await git(dir, "init", "-q", "-b", "main");
      put(dir, "old-bad-plan.md", BAD); // history that predates the gate: never flagged unless it changes
      put(dir, "old-good-plan.md", plan());
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "base");
      await git(dir, "branch", "base");
      return dir;
    }

    it("nothing changed: nothing to say; in-progress plans are ignored even if bad", async () => {
      const dir = await repo();
      expect(await gate(dir, ["--changed", "base"])).toEqual({ code: 0, stdout: "plan-gate: no plan became finished (done or built) since base\n" });
      put(dir, "wip-plan.md", plan({ status: "in-progress", review: "''" }, "Status: blocked"));
      expect((await gate(dir, ["--changed", "base"])).code).toBe(0);
    });

    it("a committed and an untracked new finished plan are each checked; a bad one makes the run exit 1", async () => {
      const dir = await repo();
      put(dir, "new-good-plan.md", plan());
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "good");
      let out = await gate(dir, ["--changed", "base"]);
      expect(out.code).toBe(0);
      expect(out.stdout).toContain("new-good-plan.md: ok (done)");
      expect(out.stdout).not.toContain("old-bad-plan.md");

      put(dir, "ticket10-plan.md", BAD); // untracked
      out = await gate(dir, ["--changed", "base"]);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/ticket10-plan\.md: not ok: review is empty/);
    });

    it("HISTORY: a plan already done or built at the base that keeps its status is never newly red, edited or renamed; an old bad plan not touched is not looked at", async () => {
      const dir = await repo();
      put(dir, "old-bad-plan.md", `${BAD}\nedited\n`); // edited, still done: history stays as it is
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "edit");
      await git(dir, "mv", "_bmad-output/backlog/old-good-plan.md", "_bmad-output/backlog/moved-good-plan.md");
      await git(dir, "mv", "_bmad-output/backlog/old-bad-plan.md", "_bmad-output/backlog/moved-bad-plan.md"); // renamed (and edited), still done
      await git(dir, "commit", "-q", "-m", "move");
      const out = await gate(dir, ["--changed", "base"]);
      expect(out).toEqual({ code: 0, stdout: "plan-gate: no plan became finished (done or built) since base\n" });
    });

    it("BECOMES_FINISHED: a plan that was in progress at the base and is done and bad now is red, also when it was renamed; problems the base already had are not repeated", async () => {
      const dir = await repo();
      put(dir, "wip-plan.md", plan({ status: "in-progress", review: "''" }, "Status: blocked"));
      put(dir, "built-bad-plan.md", plan({ status: "built", review: "''" }, "Status: blocked")); // built at the base, with its problems
      await git(dir, "add", "-A");
      await git(dir, "commit", "-q", "-m", "wip");
      await git(dir, "branch", "-f", "base");
      put(dir, "wip-plan.md", BAD); // becomes done
      put(dir, "built-bad-plan.md", plan({ status: "done", review: "''" }, "Status: blocked\nReview not run.")); // built -> done: only the new problem counts
      await git(dir, "add", "-A");
      await git(dir, "mv", "_bmad-output/backlog/wip-plan.md", "_bmad-output/backlog/renamed-plan.md");
      await git(dir, "commit", "-q", "-m", "finish");
      const out = await gate(dir, ["--changed", "base"]);
      expect(out.code).toBe(1);
      expect(out.stdout).toMatch(/renamed-plan\.md: not ok: review is empty/);
      expect(out.stdout).toMatch(/built-bad-plan\.md: not ok: the Auto Run Result says the review did not run\n/);
      expect(out.stdout).not.toMatch(/built-bad-plan\.md: not ok: .*review is empty/);
    });

    it("an unknown base exits 2 in CI and is skipped with a note elsewhere; a missing base argument is a usage error", async () => {
      const dir = await repo();
      expect(await gate(dir, ["--changed", "nope"], { CI: "true" })).toEqual({ code: 2, stdout: "plan-gate: base nope not found; cannot check\n" });
      expect(await gate(dir, ["--changed", "nope"])).toEqual({ code: 0, stdout: "plan-gate: base nope not found; skipped\n" });
      expect((await gate(dir, ["--changed"])).code).toBe(2);
    });
  });
});

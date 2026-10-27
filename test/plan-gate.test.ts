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
    for (const result of ["Status: blocked. Blocking condition: `no subagents`. No review ran, no findings.", "- Review: not run. Deferred: none.", "Review not run.", "- The quick review itself is still owed.", "- review: skipped"]) {
      expect(gate.planProblems(plan({}, result)), result).not.toEqual([]);
    }
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

    it("nothing changed: ok; old bad plans are not flagged; in-progress plans are ignored even if bad", async () => {
      const dir = await repo();
      expect(await gate(dir, ["--changed", "base"])).toEqual({ code: 0, stdout: "plan-gate: no finished plan changed since base\n" });
      put(dir, "wip-plan.md", plan({ status: "in-progress", review: "''" }, "Status: blocked"));
      expect((await gate(dir, ["--changed", "base"])).code).toBe(0);
    });

    it("a committed, a staged-and-edited, and an untracked finished plan are each checked; a bad one makes the run exit 1", async () => {
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

      rmSync(join(dir, "_bmad-output", "backlog", "ticket10-plan.md"));
      put(dir, "old-bad-plan.md", `${BAD}\nedited\n`); // an old bad plan that a batch touches is checked
      out = await gate(dir, ["--changed", "base"]);
      expect(out.code).toBe(1);
      expect(out.stdout).toContain("old-bad-plan.md: not ok");
    });

    it("an unknown base exits 2 in CI and is skipped with a note elsewhere; a missing base argument is a usage error", async () => {
      const dir = await repo();
      expect(await gate(dir, ["--changed", "nope"], { CI: "true" })).toEqual({ code: 2, stdout: "plan-gate: base nope not found; cannot check\n" });
      expect(await gate(dir, ["--changed", "nope"])).toEqual({ code: 0, stdout: "plan-gate: base nope not found; skipped\n" });
      expect((await gate(dir, ["--changed"])).code).toBe(2);
    });
  });
});

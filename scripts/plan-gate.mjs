#!/usr/bin/env node
// Done gate for a built ticket: is its plan really finished and reviewed? Agent-neutral and dependency-free.
// The orchestrator runs it before `tickets.py mark <ref> done`, and the implementation agent after `dev-orchestrator`
// returns (docs/agents/implement.md). Found live 2026-10-26: ticket 10's plan said "Status: blocked ... Review not run" in
// its Auto Run Result and the run still closed it as done.
//
//   node scripts/plan-gate.mjs <plan.md>...
//   node scripts/plan-gate.mjs --changed <base>     # the plans (_bmad-output/**/*-plan.md) a branch adds, changes, or renames since
//                                                   # <base> that newly claim to be finished; `npm run ci` runs it with origin/main
//
// One line per plan on stdout: `plan-gate: <path>: ok (<status>)` or `plan-gate: <path>: not ok: <reason>; <reason>`.
// Exit 0 when every plan is ok, 1 when any is not, 2 on bad usage or an unreadable file. A plan is not ok when:
//   - its status is not `done` or `built`, or `blocked_at`/`blocked_reason` are set (a HALT wrote them);
//   - `review` is empty (the review step never started; `none`, asked for on purpose, is fine);
//   - the LAST `## Auto Run Result...` section (a retry or a review pass appends a newer one) has, as its latest status line,
//     `Status: blocked`; names a blocking condition other than none while its latest status is not a finished one; or states, as a
//     sentence of its own, that the review did not run ("Review not run.", "Review: skipped."). Lens-level wording ("edge-case lens
//     review skipped (diff too small)", "a follow-up review is still owed") is not such a statement.
// A review run in the build's own session (no subagents) counts as run when the plan says so. Plans are not scanned for
// anything else: the gate answers "may this ticket be closed", not "is it good".
//
// `--changed` flags only what a branch makes newly true. A plan that was already done or built at the merge base (found at the same
// path, or at its rename source) and keeps that status is never newly red, and a problem a finished base version already had is not
// reported again; history that predates the gate stays as it is. A new plan, or one that becomes done or built, is judged in full.
import { execFileSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FINISHED = new Set(["done", "built"]);
const PLAN_PATH = /^_bmad-output\/.+-plan\.md$/;
// A sentence of its own: the start of a line (after a bullet or bold marks) or of a sentence.
const SENTENCE = String.raw`(?:^|[.;]\s+)[\s>*_-]*`;
const REVIEW_NOT_RUN = [
  new RegExp(String.raw`${SENTENCE}review(?: step)?\W{0,4}(?:was |is |did |has )?not run\b(?=\s*(?:[.;,(]|$))`, "im"),
  new RegExp(String.raw`${SENTENCE}review\W{0,4}skipped(?=\s*(?:[.;]|$))`, "im"),
  new RegExp(String.raw`${SENTENCE}no review (?:ran|was run)\b`, "im"),
];

const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";

/** A plain `key: value` frontmatter value without quotes or a trailing comment; "" when absent or empty. */
function field(front, key) {
  const match = new RegExp(`^${key}:[ \\t]*(?:'([^']*)'|"([^"]*)"|([^\\s#]*))`, "m").exec(front);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/**
 * The text of the last section whose heading starts with `## Auto Run Result` (a retry or a follow-up pass adds a newer one:
 * "## Auto Run Result (review pass 1)"), up to the next `## ` heading; "" when the plan has none.
 */
function autoRunResult(text) {
  let start = null;
  for (const match of text.matchAll(/^## Auto Run Result.*$/gm)) start = match;
  if (!start) return "";
  const rest = text.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
}

/** The latest status word in a result section ("Status: built." gives "built"), or "" when it has no status line. */
function latestStatus(result) {
  let word = "";
  for (const match of result.matchAll(/^[\s>*_-]*status\s*:[\s*_`]*([a-z][a-z-]*)/gim)) word = match[1].toLowerCase();
  return word;
}

/** The reasons a plan's ticket must not be closed as done. An empty list means ok. */
export function planProblems(text) {
  const front = frontmatter(text);
  const problems = [];
  const status = field(front, "status");
  if (!FINISHED.has(status)) problems.push(`status is ${JSON.stringify(status || "missing")}, not done or built`);
  if (field(front, "blocked_reason") !== "" || field(front, "blocked_at") !== "") problems.push("the plan carries a blocked_reason or blocked_at");
  if (field(front, "review") === "") problems.push("review is empty: the review step never started");
  const result = autoRunResult(text);
  const latest = latestStatus(result);
  if (latest === "blocked") problems.push("the Auto Run Result says the status is blocked");
  // "Blocking condition: none" is an answer, not a block; and a later finished status overrides an earlier block in the same section.
  if (latest === "" || latest === "blocked") {
    let value = null;
    for (const match of result.matchAll(new RegExp(String.raw`${SENTENCE}blocking condition\W*(.*)$`, "gim"))) value = match[1].trim();
    if (value !== null && !/^(?:none|n\/a|no|nil|-+)\W*$/i.test(value.replace(/^[`'"*_\s]+/, ""))) problems.push("the Auto Run Result names a blocking condition");
  }
  const reviewSkippedOnPurpose = field(front, "review") === "none"; // `none` was asked for; the text then rightly says no review ran
  if (!reviewSkippedOnPurpose && REVIEW_NOT_RUN.some((pattern) => pattern.test(result))) problems.push("the Auto Run Result says the review did not run");
  return problems;
}

export const planStatus = (text) => field(frontmatter(text), "status");

const git = (...args) => execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });

/**
 * The plans a branch adds, changes, or renames since the merge base with `base` (committed, staged, edited, or new), each with the
 * path its base version had (`from`, the rename source or the same path) or null when it is new. Returns null when `base` cannot
 * be resolved.
 */
function changedPlans(base) {
  let mergeBase;
  try {
    mergeBase = git("merge-base", base, "HEAD").trim();
  } catch {
    return null;
  }
  const found = new Map(); // path -> source path or null
  for (const line of git("diff", "--name-status", "-M", "--diff-filter=AMR", mergeBase, "--").split("\n")) {
    const [kind, first, second] = line.split("\t");
    if (!kind) continue;
    if (kind.startsWith("R")) found.set(second, first);
    else found.set(first, kind === "A" ? null : first);
  }
  for (const path of git("ls-files", "--others", "--exclude-standard").split("\n")) if (path) found.set(path, null);
  const plans = [];
  for (const [path, from] of found) if (PLAN_PATH.test(path)) plans.push({ path, from, mergeBase });
  return plans.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/** The base version of a plan, or null when it did not exist there. */
function baseText({ from, mergeBase }) {
  if (from === null) return null;
  try {
    return git("show", `${mergeBase}:${from}`);
  } catch {
    return null;
  }
}

const oneLine = (text) => String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ");

/** Prints the verdict for one plan and returns its exit code; `problems` is what counts against it. */
function report(path, text, problems) {
  if (problems.length === 0) {
    process.stdout.write(`plan-gate: ${oneLine(path)}: ok (${planStatus(text)})\n`);
    return 0;
  }
  process.stdout.write(`plan-gate: ${oneLine(path)}: not ok: ${problems.join("; ")}\n`);
  return 1;
}

function changedMode(base) {
  const plans = changedPlans(base);
  if (plans === null) {
    // Without the base nothing can be compared: a CI run must not pass silently, a local run just says so.
    process.stdout.write(`plan-gate: base ${oneLine(base)} not found; ${process.env.CI ? "cannot check" : "skipped"}\n`);
    return process.env.CI ? 2 : 0;
  }
  let code = 0;
  let checked = 0;
  for (const plan of plans) {
    let text;
    try {
      text = readFileSync(plan.path, "utf8");
    } catch {
      continue; // deleted in the working tree
    }
    const status = planStatus(text);
    if (!FINISHED.has(status)) continue;
    const before = baseText(plan);
    // Already finished at the base and still the same status: not newly finished, never newly red.
    if (before !== null && planStatus(before) === status) continue;
    // Problems the base already had are history only when the base claimed to be finished; an unfinished base is judged in full.
    const had = new Set(before !== null && FINISHED.has(planStatus(before)) ? planProblems(before) : []);
    checked++;
    code = Math.max(code, report(plan.path, text, planProblems(text).filter((problem) => !had.has(problem))));
  }
  if (checked === 0) process.stdout.write(`plan-gate: no plan became finished (done or built) since ${oneLine(base)}\n`);
  return code;
}

function main(args) {
  if (args[0] === "--changed") {
    if (args.length !== 2) {
      process.stderr.write("plan-gate: usage: node scripts/plan-gate.mjs --changed <base>\n");
      return 2;
    }
    return changedMode(args[1]);
  }
  if (args.length === 0) {
    process.stderr.write("plan-gate: usage: node scripts/plan-gate.mjs <plan.md>...\n");
    return 2;
  }
  let code = 0;
  for (const path of args) {
    let text;
    try {
      text = readFileSync(path, "utf8");
    } catch {
      process.stdout.write(`plan-gate: ${oneLine(path)}: not ok: the plan cannot be read\n`);
      code = Math.max(code, 2);
      continue;
    }
    code = Math.max(code, report(path, text, planProblems(text)));
  }
  return code;
}

function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return true;
  }
}

if (invokedDirectly()) process.exitCode = main(process.argv.slice(2));

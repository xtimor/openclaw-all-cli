#!/usr/bin/env node
// Done gate for a built ticket: is its plan really finished and reviewed? Agent-neutral and dependency-free.
// The orchestrator runs it before `tickets.py mark <ref> done`, and the implementation agent after `dev-orchestrator`
// returns (docs/agents/implement.md). Found live 2026-10-26: ticket 10's plan said "Status: blocked ... Review not run" in
// its Auto Run Result and the run still closed it as done.
//
//   node scripts/plan-gate.mjs <plan.md>...
//
// One line per plan on stdout: `plan-gate: <path>: ok (<status>)` or `plan-gate: <path>: not ok: <reason>; <reason>`.
// Exit 0 when every plan is ok, 1 when any is not, 2 on bad usage or an unreadable file. A plan is not ok when:
//   - its status is not `done` or `built`, or `blocked_at`/`blocked_reason` are set (a HALT wrote them);
//   - `review` is empty (the review step never started; `none`, asked for on purpose, is fine);
//   - its `## Auto Run Result` says the status is blocked, names a blocking condition, or says the review did not run.
// A review run in the build's own session (no subagents) counts as run when the plan says so. Plans are not scanned for
// anything else: the gate answers "may this ticket be closed", not "is it good".
import { readFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

const FINISHED = new Set(["done", "built"]);
// Phrases the build workflow and its workers write when the review did not happen.
const REVIEW_NOT_RUN = [/\breview[:\s]+(?:was |is )?(?:not run|skipped|owed)\b/i, /\bno review (?:ran|was run)\b/i, /\breview\b[^.\n]*\bstill owed\b/i];

const frontmatter = (text) => /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] ?? "";

/** A plain `key: value` frontmatter value without quotes or a trailing comment; "" when absent or empty. */
function field(front, key) {
  const match = new RegExp(`^${key}:[ \\t]*(?:'([^']*)'|"([^"]*)"|([^\\s#]*))`, "m").exec(front);
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? "").trim();
}

/** The text under `## Auto Run Result`, up to the next `## ` heading; "" when the plan has none. */
function autoRunResult(text) {
  const start = /^## Auto Run Result[ \t]*$/m.exec(text);
  if (!start) return "";
  const rest = text.slice(start.index + start[0].length);
  const next = /^## /m.exec(rest);
  return next ? rest.slice(0, next.index) : rest;
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
  const reviewSkippedOnPurpose = field(front, "review") === "none"; // `none` was asked for; the text then rightly says no review ran
  if (/^[\s>*_-]*status\W*blocked\b/im.test(result)) problems.push("the Auto Run Result says the status is blocked");
  if (/^[\s>*_-]*blocking condition\b/im.test(result)) problems.push("the Auto Run Result names a blocking condition");
  if (!reviewSkippedOnPurpose && REVIEW_NOT_RUN.some((pattern) => pattern.test(result))) problems.push("the Auto Run Result says the review did not run");
  return problems;
}

export const planStatus = (text) => field(frontmatter(text), "status");

const oneLine = (text) => String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ");

function main(args) {
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
    const problems = planProblems(text);
    if (problems.length === 0) process.stdout.write(`plan-gate: ${oneLine(path)}: ok (${planStatus(text)})\n`);
    else {
      process.stdout.write(`plan-gate: ${oneLine(path)}: not ok: ${problems.join("; ")}\n`);
      code = Math.max(code, 1);
    }
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

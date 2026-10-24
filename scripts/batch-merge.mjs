#!/usr/bin/env node
// Merges the agents' green batch pull requests as the issue agents' GitHub App. It runs inside the `Batch merge` workflow
// (.github/workflows/batch-merge.yml), after CI completes, when a pull request is marked ready, hourly, and on dispatch.
// The routine's permission check refuses an agent's merge of its own PR, so the agent only marks the batch ready; this script
// merges it with the same guards the relay's `merge` operation has (checkMergeable and checkGreen of scripts/agent-write.mjs,
// on the PR's current head sha). It only merges: no comment, label, close, or edit. Agent-neutral and dependency-free.
// Design: docs/agents/implement.md ("Merging the batch pull request"), docs/agents/identity.md.
//
//   GH_TOKEN=<app token> AGENT_LOGIN='x[bot]' GITHUB_REPOSITORY=owner/repo [BATCH_PR=20] node scripts/batch-merge.mjs
//
// Lists the open pull requests titled `Issue batch...` by AGENT_LOGIN (BATCH_PR, a number from the triggering event, is checked
// first), reads each fresh, and merges it only when every guard holds (method `merge`, expected head sha = the head read). A PR
// that fails a guard is skipped. GitHub computes `mergeable_state` lazily: an `unknown` PR is re-read up to 3 more times, 10 s apart
// (BATCH_MERGE_UNKNOWN_DELAY_MS, for tests), then skipped; the next trigger retries.
//
// Environment: GH_TOKEN (the app's installation token), AGENT_LOGIN (`<app-slug>[bot]`), GITHUB_REPOSITORY, BATCH_PR (optional),
// BATCH_MERGE_UNKNOWN_DELAY_MS (test knob, default 10000), GITHUB_API_URL (default https://api.github.com), GITHUB_GRAPHQL_URL (unused), GITHUB_STEP_SUMMARY (the Markdown summary).
//
// Output: one line per PR, `batch-merge: #N merged|skipped|failed: <reason>`. The token is never printed (every message goes
// through the client's `clean`); the summary and the log hold no PR title or body. Exit 0 unless a merge call failed or the list
// could not be read (1), or a variable is missing or malformed (2).
import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkGreen, checkMergeable, makeClient, WriteError } from "./agent-write.mjs";

const DEFAULT_API = "https://api.github.com";
const BATCH_TITLE = "Issue batch";
const UNKNOWN_RETRIES = 3; // re-reads of a PR whose mergeable state GitHub has not computed yet
const UNKNOWN_DELAY_MS = 10_000;

const lower = (value) => (typeof value === "string" ? value.trim().toLowerCase() : "");

function readConfig(env) {
  const missing = ["GH_TOKEN", "AGENT_LOGIN", "GITHUB_REPOSITORY"].filter((name) => typeof env[name] !== "string" || env[name].trim() === "");
  if (missing.length > 0) throw new WriteError(`missing environment variable: ${missing.join(", ")}`, { code: 2 });
  const repo = env.GITHUB_REPOSITORY.trim();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new WriteError("GITHUB_REPOSITORY must look like owner/repo", { code: 2 });
  const login = env.AGENT_LOGIN.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9-]*\[bot\]$/.test(login)) throw new WriteError("AGENT_LOGIN must look like <app-slug>[bot]", { code: 2 });
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");
  const rawPr = (env.BATCH_PR ?? "").trim();
  if (rawPr !== "" && !/^[1-9]\d{0,9}$/.test(rawPr)) throw new WriteError("BATCH_PR must be a pull request number", { code: 2 });
  const delay = (env.BATCH_MERGE_UNKNOWN_DELAY_MS ?? "").trim();
  if (delay !== "" && !/^\d{1,6}$/.test(delay)) throw new WriteError("BATCH_MERGE_UNKNOWN_DELAY_MS must be a number of milliseconds", { code: 2 });
  return { unknownDelayMs: delay === "" ? UNKNOWN_DELAY_MS : Number(delay), token: env.GH_TOKEN.trim(), repo, login, api, graphql: `${api}/graphql`, hint: rawPr === "" ? null : Number(rawPr) };
}

/** The refusal's text without its `PR #N` lead, so a line reads `#N skipped: <reason>`. */
const reasonOf = (error) => String(error.message).replace(/^PR #\d+:? /, "");

/**
 * Runs the whole check. `log(line)` gets each result line as it happens. Returns `{code, rows, message}`; it writes nothing
 * itself. A missing or malformed variable throws a WriteError with code 2.
 */
export async function run(env, log = () => {}) {
  const config = readConfig(env);
  const client = makeClient(config);
  const base = `/repos/${config.repo}`;
  const rows = [];
  const add = (number, result, reason) => {
    rows.push({ pr: number, result, reason });
    log(`#${number} ${result}: ${reason}`);
  };
  let failed = false;

  let listed;
  try {
    listed = (await client.rest("GET", `${base}/pulls?state=open&per_page=100`)).data;
  } catch (error) {
    return { code: 1, rows, message: error instanceof WriteError ? client.clean(error.message) : "unexpected error" };
  }
  if (!Array.isArray(listed)) return { code: 1, rows, message: "the pull request list could not be read" };

  const batches = listed.filter((pr) => typeof pr?.title === "string" && pr.title.startsWith(BATCH_TITLE) && lower(pr.user?.login) === lower(config.login) && Number.isSafeInteger(pr.number));
  const order = batches.map((pr) => pr.number);
  if (config.hint !== null) {
    if (order.includes(config.hint)) order.sort((a, b) => Number(b === config.hint) - Number(a === config.hint));
    else add(config.hint, "skipped", "not an open agent batch pull request");
  }

  for (const number of order) {
    try {
      let pr = (await client.rest("GET", `${base}/pulls/${number}`)).data;
      // GitHub computes the mergeable state lazily (right after CI it is often `unknown`): ask again a few times before skipping.
      for (let retry = 0; retry < UNKNOWN_RETRIES && pr?.mergeable_state === "unknown" && pr.draft !== true; retry++) {
        await new Promise((done) => setTimeout(done, config.unknownDelayMs));
        pr = (await client.rest("GET", `${base}/pulls/${number}`)).data;
      }
      if (pr === null || typeof pr !== "object" || Array.isArray(pr)) throw new WriteError(`PR #${number}: GitHub's answer could not be read`, { refused: true });
      if (pr.draft === true) {
        add(number, "skipped", "draft");
        continue;
      }
      const sha = typeof pr.head?.sha === "string" ? pr.head.sha.toLowerCase() : "";
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new WriteError(`PR #${number}: its head sha could not be read`, { refused: true });
      const op = { pr: number, sha };
      checkMergeable(pr, op, config);
      const runs = (await client.rest("GET", `${base}/commits/${sha}/check-runs?per_page=100`)).data;
      const status = (await client.rest("GET", `${base}/commits/${sha}/status`)).data;
      checkGreen(runs, status, op);
      const { data } = await client.rest("PUT", `${base}/pulls/${number}/merge`, { merge_method: "merge", sha });
      if (data?.merged !== true) throw new WriteError(`PUT /pulls/${number}/merge: GitHub did not merge it`);
      add(number, "merged", `at ${String(data.sha ?? "").slice(0, 7) || "?"}`);
    } catch (error) {
      const safe = error instanceof WriteError;
      const reason = safe ? client.clean(reasonOf(error)) : "unexpected error";
      if (safe && error.refused) {
        add(number, "skipped", reason);
      } else {
        // Only a failed merge call is an error of this run; a failed read is retried by the next trigger.
        const merging = /^PUT \/pulls\/\d+\/merge/.test(reason);
        if (merging) failed = true;
        add(number, merging ? "failed" : "skipped", reason);
      }
    }
  }
  return { code: failed ? 1 : 0, rows, message: "" };
}

const cell = (text) => String(text).replaceAll("|", "\\|").replace(/\s+/g, " ").trim();

/** The Markdown summary: PR numbers, results, and reasons only; never a title or a body. */
export function formatSummary({ rows, message }) {
  const lines = ["### Batch merge", ""];
  if (message) lines.push(`**Not run**: ${cell(message)}`);
  else if (rows.length === 0) lines.push("No open agent batch pull request.");
  else {
    lines.push("| PR | Result | Reason |", "| --- | --- | --- |");
    for (const row of rows) lines.push(`| #${row.pr} | ${cell(row.result)} | ${cell(row.reason)} |`);
  }
  return `${lines.join("\n")}\n`;
}

/** One line, always starting with `batch-merge:`: newlines in a message cannot start a fake log line or a `::` command. */
const logLine = (text) => `batch-merge: ${String(text).replace(/[\r\n\u0085\u2028\u2029]+/g, " ")}\n`;

function writeSummary(env, text) {
  const file = env.GITHUB_STEP_SUMMARY;
  if (typeof file !== "string" || file === "") return;
  try {
    appendFileSync(file, `${text}\n`);
  } catch {
    // the log still has the result
  }
}

async function main() {
  const env = process.env;
  try {
    const result = await run(env, (line) => process.stdout.write(logLine(line)));
    writeSummary(env, formatSummary(result));
    if (result.message) process.stderr.write(logLine(result.message));
    else if (result.rows.length === 0) process.stdout.write(logLine("no open agent batch pull request"));
    process.exitCode = result.code;
  } catch (error) {
    // Only our own errors carry a safe message; anything else is reported without its text.
    const safe = error instanceof WriteError;
    const message = safe ? error.message : "unexpected error";
    writeSummary(env, formatSummary({ rows: [], message }));
    process.stderr.write(logLine(message));
    process.exitCode = safe ? error.code : 1;
  }
}

// Run when invoked as the script, also through a symlink (compare real paths).
function invokedDirectly() {
  if (!process.argv[1]) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    return true;
  }
}

if (invokedDirectly()) await main();

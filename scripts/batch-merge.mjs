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
// Lists (all pages of) the open pull requests titled `Issue batch...` by AGENT_LOGIN (BATCH_PR, a number from the triggering event, is checked
// first), reads each fresh, and merges it only when every guard holds (method `merge`, expected head sha = the head read). A PR
// that fails a guard is skipped, also one that changes a protected file (.github/, scripts/, _bmad/, .claude/, .agents/, docs/agents/,
// AGENTS.md, SECURITY.md, or the scripts, publishConfig, name, bin, or a lost `files` entry of package.json): it stays open for the
// owner. A PR whose state is not final yet is re-read until it is, within a bound (ticket 3.21 d): GitHub computes `mergeable_state`
// lazily and can still answer `unknown`, or `draft` for a PR that was just marked ready (batch PR #41's `ready_for_review` run found
// that and merged nothing), and CI may still be running. Not final: that mergeable state, no `check` run yet, a run that is not
// completed, a commit status `pending`. The wait is a budget of re-reads for the whole run (BATCH_MERGE_WAIT_MS / BATCH_MERGE_POLL_MS,
// default 300000 / 15000, so about 5 minutes); when it is spent the PR is skipped with "after N re-reads" and the next trigger retries.
// A final state that is not clean or green (dirty, behind, a red check) is skipped at once.
//
// Environment: GH_TOKEN (the app's installation token), AGENT_LOGIN (`<app-slug>[bot]`), GITHUB_REPOSITORY, BATCH_PR (optional),
// BATCH_MERGE_WAIT_MS / BATCH_MERGE_POLL_MS (the wait budget and the pause between re-reads; test knobs), GITHUB_API_URL (default https://api.github.com), GITHUB_GRAPHQL_URL (unused), GITHUB_STEP_SUMMARY (the Markdown summary).
//
// Output: one line per PR, `batch-merge: #N merged|skipped|failed: <reason>`. The token is never printed (every message goes
// through the client's `clean`); the summary and the log hold no PR title or body. Exit 0 unless a merge call failed or the list
// could not be read (1), or a variable is missing or malformed (2).
import { appendFileSync, realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { checkGreen, checkMergeable, makeClient, WriteError } from "./agent-write.mjs";

const DEFAULT_API = "https://api.github.com";
const BATCH_TITLE = "Issue batch";
const WAIT_MS = 300_000; // the whole run's budget for re-reading PRs that are not final yet
const POLL_MS = 15_000;

const MAX_LIST_PAGES = 20; // 2000 open pull requests
const MAX_FILE_PAGES = 30; // GitHub lists at most 3000 files of a pull request
// A batch must not change what guards it or what later runs execute (docs/agents/implement.md, "Protected files").
const PROTECTED_PREFIXES = [".github/", "scripts/", "_bmad/", ".claude/", ".agents/", "docs/agents/"];
const PROTECTED_FILES = new Set(["agents.md", "security.md"]);
const PACKAGE_FIELDS = ["scripts", "publishConfig", "name", "bin"];

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
  const times = {};
  for (const [name, key, fallback] of [["BATCH_MERGE_WAIT_MS", "waitMs", WAIT_MS], ["BATCH_MERGE_POLL_MS", "pollMs", POLL_MS]]) {
    const value = (env[name] ?? "").trim();
    if (value !== "" && !/^\d{1,7}$/.test(value)) throw new WriteError(`${name} must be a number of milliseconds`, { code: 2 });
    times[key] = value === "" ? fallback : Number(value);
  }
  return { ...times, token: env.GH_TOKEN.trim(), repo, login, api, graphql: `${api}/graphql`, hint: rawPr === "" ? null : Number(rawPr) };
}

/** The refusal's text without its `PR #N` lead, so a line reads `#N skipped: <reason>`. */
const reasonOf = (error) => String(error.message).replace(/^PR #\d+:? /, "");

const protectedPath = (path) => {
  const name = lower(path);
  return PROTECTED_FILES.has(name) || PROTECTED_PREFIXES.some((prefix) => name.startsWith(prefix));
};

const stable = (value) => JSON.stringify(value, (_key, item) => (item !== null && typeof item === "object" && !Array.isArray(item) ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) : item));

/** The guarded `package.json` fields that differ: scripts, publishConfig, name, bin, and `files` when an entry was lost or changed (added entries are fine). */
function changedPackageFields(before, after) {
  const changed = PACKAGE_FIELDS.filter((field) => stable(before[field]) !== stable(after[field]));
  const kept = new Set((Array.isArray(after.files) ? after.files : []).map(stable));
  if ((Array.isArray(before.files) ? before.files : []).some((entry) => !kept.has(stable(entry)))) changed.push("files");
  return changed;
}

/**
 * Whether GitHub has not settled the pull request's own state yet: `mergeable_state` missing or `unknown` (computed lazily), or
 * `draft` on a PR that is no longer a draft (right after `ready_for_review` the old value can linger).
 */
const stateUnsettled = (pr) => pr.draft !== true && (!pr.mergeable_state || pr.mergeable_state === "unknown" || pr.mergeable_state === "draft");

/**
 * Whether the checks of the head can still change: no `check` run from GitHub Actions yet (CI has not started), a run that is not
 * completed, or a pending commit status. A shape this cannot read is not "unsettled": the guards refuse it. A run that already
 * failed makes the answer final (red stays red; the guards say which run), so a red PR is never waited for.
 */
function checksUnsettled(runs, status) {
  if (!Array.isArray(runs?.check_runs) || !Number.isSafeInteger(runs.total_count) || runs.total_count > runs.check_runs.length) return false;
  if (runs.check_runs.some((run) => run?.status === "completed" && !["success", "skipped", "neutral"].includes(run.conclusion))) return false;
  if (!runs.check_runs.some((run) => run?.name === "check" && run.app?.slug === "github-actions")) return true;
  if (runs.check_runs.some((run) => run?.status !== "completed")) return true;
  return status !== null && typeof status === "object" && Number.isSafeInteger(status.total_count) && status.total_count > 0 && status.state === "pending";
}

/** Every guard of checkMergeable except the mergeable state (a PR that fails one is final: its checks are not worth reading). */
function passesStructure(pr, number, sha, config) {
  try {
    checkMergeable({ ...pr, mergeable_state: "clean" }, { pr: number, sha }, config);
    return true;
  } catch (error) {
    if (error instanceof WriteError && error.refused) return false;
    throw error;
  }
}

/** Whether a pull request is an open `Issue batch` PR of the app (the list filter, also used for the hinted one). */
const isAgentBatch = (pr, login) => pr?.state === "open" && typeof pr.title === "string" && pr.title.startsWith(BATCH_TITLE) && lower(pr.user?.login) === lower(login) && Number.isSafeInteger(pr.number);

/**
 * Refuses a pull request that changes a protected file (a workflow, a script, the agents' docs, ...), or the guarded fields of
 * `package.json` (compared at the base and head shas). Such a batch stays open for the owner.
 */
async function checkUnprotected(client, base, pr, number, sha) {
  const paths = [];
  for (let page = 1; ; page++) {
    const files = (await client.rest("GET", `${base}/pulls/${number}/files?per_page=100&page=${page}`)).data;
    if (!Array.isArray(files)) throw new WriteError(`PR #${number}: the changed files could not be read`, { refused: true });
    for (const file of files) paths.push(file?.filename, file?.previous_filename);
    if (files.length < 100) break;
    if (page >= MAX_FILE_PAGES) throw new WriteError(`PR #${number}: too many changed files to verify`, { refused: true });
  }
  const names = paths.filter((path) => typeof path === "string");
  const hit = [...new Set(names.filter(protectedPath))];
  if (hit.length > 0) throw new WriteError(`PR #${number}: touches protected files: ${hit.slice(0, 5).join(", ")}${hit.length > 5 ? `, and ${hit.length - 5} more` : ""}`, { refused: true });
  if (!names.includes("package.json")) return;
  const baseSha = typeof pr.base?.sha === "string" ? pr.base.sha.toLowerCase() : "";
  if (!/^[0-9a-f]{40}$/.test(baseSha)) throw new WriteError(`PR #${number}: its base sha could not be read`, { refused: true });
  const read = async (ref) => {
    const { data } = await client.rest("GET", `${base}/contents/package.json?ref=${ref}`);
    try {
      const parsed = JSON.parse(Buffer.from(String(data?.content ?? ""), "base64").toString("utf8"));
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
    } catch {
      // reported below
    }
    throw new WriteError(`PR #${number}: package.json could not be read at ${ref.slice(0, 7)}`, { refused: true });
  };
  const before = await read(baseSha);
  const changed = changedPackageFields(before, await read(sha));
  if (changed.length > 0) throw new WriteError(`PR #${number}: touches protected files: package.json (${changed.join(", ")})`, { refused: true });
}

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

  const batches = [];
  try {
    for (let page = 1; ; page++) {
      const listed = (await client.rest("GET", `${base}/pulls?state=open&per_page=100&page=${page}`)).data;
      if (!Array.isArray(listed)) return { code: 1, rows, message: "the pull request list could not be read" };
      batches.push(...listed.filter((pr) => isAgentBatch(pr, config.login)).map((pr) => pr.number));
      if (listed.length < 100 || page >= MAX_LIST_PAGES) break;
    }
  } catch (error) {
    return { code: 1, rows, message: error instanceof WriteError ? client.clean(error.message) : "unexpected error" };
  }
  const order = [...new Set(batches)];
  if (config.hint !== null) {
    // The pull request of the event is read directly (it may be outside the pages above) and filtered the same way; it goes first.
    let hinted = null;
    try {
      hinted = (await client.rest("GET", `${base}/pulls/${config.hint}`)).data;
    } catch (error) {
      add(config.hint, "skipped", error instanceof WriteError ? client.clean(error.message) : "unexpected error");
    }
    if (hinted !== null) {
      if (isAgentBatch(hinted, config.login) && hinted.number === config.hint) order.splice(0, order.length, config.hint, ...order.filter((number) => number !== config.hint));
      else add(config.hint, "skipped", "not an open agent batch pull request");
    }
  }

  // The re-read budget is shared by the whole run: a few PRs never stretch it, and the job's timeout stays out of reach.
  let rereads = config.pollMs > 0 ? Math.floor(config.waitMs / config.pollMs) : 0;
  const sleep = (ms) => new Promise((done) => setTimeout(done, ms));
  for (const number of order) {
    let merging = false; // set at the merge call: an error there leaves the outcome unknown
    let waited = 0;
    let settling = false;
    try {
      let pr;
      let runs = null;
      let status = null;
      for (;;) {
        pr = (await client.rest("GET", `${base}/pulls/${number}`)).data;
        if (pr === null || typeof pr !== "object" || Array.isArray(pr)) throw new WriteError(`PR #${number}: GitHub's answer could not be read`, { refused: true });
        if (pr.draft === true) break;
        runs = null;
        status = null;
        settling = stateUnsettled(pr);
        const sha = typeof pr.head?.sha === "string" ? pr.head.sha.toLowerCase() : "";
        // The checks are read only for a PR that passes every guard but the mergeable state, and only where they can still decide it:
        // `clean`, or `blocked`/`unstable` (pending checks give those). `dirty`, `behind`, and the like are final without them.
        if (!settling && /^[0-9a-f]{40}$/.test(sha) && ["clean", "blocked", "unstable"].includes(pr.mergeable_state) && passesStructure(pr, number, sha, config)) {
          runs = (await client.rest("GET", `${base}/commits/${sha}/check-runs?per_page=100`)).data;
          status = (await client.rest("GET", `${base}/commits/${sha}/status`)).data;
          settling = checksUnsettled(runs, status);
        }
        if (!settling || rereads <= 0) break;
        rereads--;
        waited++;
        await sleep(config.pollMs);
      }
      if (pr.draft === true) {
        add(number, "skipped", "draft");
        continue;
      }
      const sha = typeof pr.head?.sha === "string" ? pr.head.sha.toLowerCase() : "";
      if (!/^[0-9a-f]{40}$/.test(sha)) throw new WriteError(`PR #${number}: its head sha could not be read`, { refused: true });
      const op = { pr: number, sha };
      try {
        checkMergeable(pr, op, config);
        if (runs === null) {
          runs = (await client.rest("GET", `${base}/commits/${sha}/check-runs?per_page=100`)).data;
          status = (await client.rest("GET", `${base}/commits/${sha}/status`)).data;
        }
        checkGreen(runs, status, op);
      } catch (error) {
        // Say that the wait ran out, so a log reader knows the state was not final rather than wrong.
        if (error instanceof WriteError && error.refused && settling && waited > 0) error.message += ` (not final after ${waited} re-read${waited === 1 ? "" : "s"})`;
        throw error;
      }
      await checkUnprotected(client, base, pr, number, sha);
      merging = true;
      const { data } = await client.rest("PUT", `${base}/pulls/${number}/merge`, { merge_method: "merge", sha });
      if (data?.merged !== true) throw new WriteError(`PUT /pulls/${number}/merge: GitHub did not merge it`);
      add(number, "merged", `at ${String(data.sha ?? "").slice(0, 7) || "?"}`);
    } catch (error) {
      const safe = error instanceof WriteError;
      const reason = safe ? client.clean(reasonOf(error)) : "unexpected error";
      if (safe && error.refused) {
        add(number, "skipped", reason);
      } else if (merging) {
        // Only a failed merge call is an error of this run; a failed read is retried by the next trigger.
        failed = true;
        add(number, "failed", safe ? reason : "merge outcome unknown");
      } else {
        add(number, "skipped", reason);
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

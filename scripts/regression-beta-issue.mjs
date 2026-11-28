#!/usr/bin/env node
// The weekly beta run's issue (epic-regression-gate ticket 4, .github/workflows/regression-beta.yml): when the Gateway
// regression tier is red on OpenClaw `beta`, open one issue labelled `regression:beta`, or, while such an issue is open,
// comment on it instead. A green run does nothing: an open issue stays open for a person to close. A run reports once:
// its marker (`<!-- regression-beta run=<id> -->`) in the open issue or a comment, or in one of the 100 newest issues (one
// that lost its label), makes a re-run of the job a no-op.
// A regression finding is fixed at once (owner decision 2026-11-28, epic-regression-gate ticket 11): the issue is opened with
// `source:regression`, `type:bug`, and `status:todo`, so triage skips it and the next implementation run builds it without the
// owner's approval (docs/agents/implement.md, "Regression issues"); that run reproduces it and hands it to the owner when the fault
// is in OpenClaw beta and no plugin-side fix exists. A GITHUB_TOKEN-made issue starts no issue-flow run, so the script sets the status
// itself. Dependency-free, like scripts/regression-ledger.mjs.
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/regression-beta-issue.mjs report \
//     --outcome <success|failure|cancelled|skipped> --results <file> --run-url <url> [--run-id <id>]
//
// --outcome is the regression job's result (`needs.<job>.result`); only `failure` reports. --results is the JSON array
// regression.yml outputs (`results`: version, requests, result, seconds, sha256, failed); missing, empty, or unreadable
// counts as no result, and a red run still reports. --run-id defaults to GITHUB_RUN_ID. Exit 0: done or nothing to do;
// 1: no GITHUB_TOKEN on a red run, or the API failed; 2: usage. GITHUB_REPOSITORY defaults to the repository in
// package.json; GITHUB_API_URL overrides the API base (default https://api.github.com), for tests.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const DEFAULT_API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 20;
const REQUEST_TIMEOUT_MS = 30_000;
const LABEL = "regression:beta";
const STATUS = "status:todo";
// The regression shortcut (no triage, no approval) and the type the ledger check reads. Set only on an issue this script opens.
const SOURCE = "source:regression";
const TYPE = "type:bug";
const LABELS = [LABEL, SOURCE, TYPE, STATUS];
const MAX_FAILED = 30;
const MAX_LINE = 300;

class ReportError extends Error {}
class UsageError extends ReportError {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  if (command !== "report") throw new UsageError("usage: regression-beta-issue.mjs report --outcome <result> --results <file> --run-url <url> [--run-id <id>]");
  const names = { "--outcome": "outcome", "--results": "results", "--run-url": "runUrl", "--run-id": "runId" };
  const options = {};
  for (let i = 0; i < rest.length; i += 2) {
    const name = Object.hasOwn(names, rest[i]) ? names[rest[i]] : undefined;
    if (!name || rest[i + 1] === undefined) throw new UsageError(`unknown or incomplete argument ${JSON.stringify(rest[i])}`);
    options[name] = rest[i + 1];
  }
  if (!options.outcome) throw new UsageError("--outcome is required");
  return options;
}

/** The results array of regression.yml; anything else is no result. */
function readResults(file) {
  if (!file) return [];
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  return Array.isArray(parsed) ? parsed.filter((row) => row && typeof row === "object") : [];
}

/** One line of Markdown: no line breaks, no HTML comment that could forge a marker, bounded length. */
const line = (text) => {
  const flat = String(text).replace(/\s+/g, " ").replace(/<!--/g, "<!- -").trim();
  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat;
};
const code = (text) => `\`${line(text).replace(/`/g, "'")}\``;
const minutes = (seconds) => (Number.isFinite(seconds) && seconds >= 0 ? `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s` : "-");

const marker = (runId) => `<!-- regression-beta run=${runId} -->`;

/** The versions the run tested, for the title: the resolved ones, else the requests. */
function versionsOf(results) {
  const versions = [...new Set(results.map((row) => row.version).filter((v) => typeof v === "string" && v))];
  return versions.length > 0 ? versions.join(", ") : "unknown version";
}

/** The part both the issue and a comment carry: a table per version, the failing tests, the run link. */
function details(results, runUrl) {
  const out = [];
  if (results.length === 0) {
    out.push("No tier result reached this job: the run stopped before the tier (resolving `beta`, setup, or a timeout). See the run.");
  } else {
    out.push("| Requested | OpenClaw | Result | Time | Plugin sha256 |", "| --- | --- | --- | --- | --- |");
    for (const row of results) {
      const requests = Array.isArray(row.requests) ? row.requests.join(", ") : line(row.requested ?? "beta");
      out.push(`| ${line(requests)} | ${line(row.version ?? "-")} | ${line(row.result ?? "no result")} | ${minutes(row.seconds)} | ${row.sha256 ? code(row.sha256) : "-"} |`);
    }
    for (const row of results) {
      const failed = Array.isArray(row.failed) ? row.failed : [];
      if (failed.length === 0) continue;
      out.push("", `Failing on OpenClaw ${line(row.version ?? "-")}:`, "");
      for (const name of failed.slice(0, MAX_FAILED)) out.push(`- ${code(name)}`);
      if (failed.length > MAX_FAILED) out.push(`- and ${failed.length - MAX_FAILED} more (see the run)`);
    }
  }
  out.push("", `Run: ${runUrl}`);
  return out.join("\n");
}

function issueBody(results, runUrl, runId) {
  return [
    marker(runId),
    "The weekly Gateway regression tier (`.github/workflows/regression-beta.yml`, `scripts/regression.sh gateway`) is red on OpenClaw `beta`.",
    "",
    details(results, runUrl),
    "",
    `A regression finding is fixed at once: \`${SOURCE}\` skips triage and the owner's approval, and the next implementation run takes it (docs/agents/implement.md, "Regression issues"). It reproduces it on \`main\` (\`scripts/regression.sh gateway --openclaw <version>\`) and fixes the plugin through the normal batch pull request; when the OpenClaw beta is at fault and no plugin-side fix exists, it hands the issue to the owner (\`status:blocked\`).`,
    "",
    `While this issue is open, a red weekly run comments here instead of opening another. A green run changes nothing, so close it once it is settled; the next red run then opens a new one. The label \`${LABEL}\` marks it.`,
  ].join("\n");
}

function commentBody(results, runUrl, runId) {
  return [marker(runId), `Red again on OpenClaw beta (${line(versionsOf(results))}).`, "", details(results, runUrl)].join("\n");
}

function client(api, token) {
  return async (method, path, body) => {
    let response;
    try {
      response = await fetch(`${api}${path}`, {
        method,
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "regression-beta-issue",
          "x-github-api-version": "2022-11-28",
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new ReportError(`${method} ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new ReportError(`${method} ${path}: GitHub answered ${response.status}`);
    return response.json().catch(() => null);
  };
}

/** Every row of a paged list. */
async function all(request, path) {
  const rows = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = await request("GET", `${path}${path.includes("?") ? "&" : "?"}per_page=${PAGE_SIZE}&page=${page}`);
    if (!Array.isArray(batch)) throw new ReportError(`GET ${path}: GitHub answered with no list`);
    rows.push(...batch);
    if (batch.length < PAGE_SIZE) return rows;
  }
  throw new ReportError(`GET ${path}: more than ${MAX_PAGES * PAGE_SIZE} rows`);
}

/** owner/repo from package.json `repository.url`, for a run outside Actions; empty when it names no GitHub repository. */
function packageRepo() {
  try {
    const url = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).repository?.url ?? "";
    return /github\.com\/([\w.-]+\/[\w.-]+?)(?:\.git)?$/.exec(url)?.[1] ?? "";
  } catch {
    return "";
  }
}

async function main(argv, env) {
  const options = parseArgs(argv);
  if (options.outcome !== "failure") {
    console.log(`regression-beta-issue: the regression run's result is ${options.outcome}: nothing to report`);
    return 0;
  }
  const token = (env.GITHUB_TOKEN ?? "").trim();
  if (!token) throw new ReportError("the run is red but GITHUB_TOKEN is not set");
  const repo = (env.GITHUB_REPOSITORY ?? "").trim() || packageRepo();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new ReportError("GITHUB_REPOSITORY must be owner/repo");
  const runId = (options.runId ?? env.GITHUB_RUN_ID ?? "").trim();
  if (!/^\d+$/.test(runId)) throw new UsageError("--run-id (or GITHUB_RUN_ID) must be a run id");
  const runUrl = line(options.runUrl ?? "");
  if (!/^https?:\/\/\S+$/.test(runUrl)) throw new UsageError("--run-url must be the run's URL");
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");
  const request = client(api, token);
  const results = readResults(options.results);
  const base = `/repos/${repo}/issues`;

  const open = (await all(request, `${base}?state=open&labels=${encodeURIComponent(LABEL)}`))
    .filter((row) => row && typeof row.number === "number" && !row.pull_request)
    .sort((a, b) => a.number - b.number);
  if (open.length > 0) {
    const issue = open[0];
    const seen = String(issue.body ?? "").includes(marker(runId)) || (await all(request, `${base}/${issue.number}/comments`)).some((row) => String(row?.body ?? "").includes(marker(runId)));
    if (seen) {
      console.log(`regression-beta-issue: run ${runId} is already reported on #${issue.number}`);
      return 0;
    }
    await request("POST", `${base}/${issue.number}/comments`, { body: commentBody(results, runUrl, runId) });
    console.log(`regression-beta-issue: commented on the open issue #${issue.number}`);
    return 0;
  }

  // An issue this run already opened but that lost its label (GitHub dropped it and the re-add failed) is found by its
  // marker among the newest issues, open or closed, so a re-run never opens a second one.
  const recent = await request("GET", `${base}?state=all&sort=created&direction=desc&per_page=${PAGE_SIZE}&page=1`);
  if (!Array.isArray(recent)) throw new ReportError(`GET ${base}: GitHub answered with no list`);
  const own = recent.find((row) => row && typeof row.number === "number" && !row.pull_request && String(row.body ?? "").includes(marker(runId)));
  if (own) {
    // Only the marker label: the issue's status is the issue flow's by now. Never `source:regression`: the marker is plain text that
    // anyone can put in an issue, and the label must stay on issues this script opened itself.
    if (own.state === "open") await ensureLabels(request, base, own, [LABEL]);
    console.log(`regression-beta-issue: run ${runId} is already reported on #${own.number}`);
    return 0;
  }

  const created = await request("POST", base, {
    title: `OpenClaw beta ${versionsOf(results)}: the Gateway regression tier is red`,
    body: issueBody(results, runUrl, runId),
    labels: LABELS,
  });
  if (!created || typeof created.number !== "number") throw new ReportError(`POST ${base}: GitHub answered with no issue`);
  console.log(`regression-beta-issue: opened #${created.number}`);
  await ensureLabels(request, base, created, LABELS);
  return 0;
}

/** GitHub drops labels silently for a token that may not set them; add them again so the next run finds the issue. */
async function ensureLabels(request, base, issue, wanted) {
  const names = new Set((Array.isArray(issue.labels) ? issue.labels : []).map((label) => (typeof label === "string" ? label : label?.name)));
  const missing = wanted.filter((name) => !names.has(name));
  if (missing.length > 0) await request("POST", `${base}/${issue.number}/labels`, { labels: missing });
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`regression-beta-issue: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof UsageError ? 2 : 1;
}

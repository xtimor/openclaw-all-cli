#!/usr/bin/env node
// The regression ledger's CI check (epic-regression-gate ticket 1): every closed `type:bug` issue of the repository has
// a [[bug]] entry in test/regression/ledger.toml. The offline half (named tests exist, schema) is
// test/regression/ledger.test.ts in `npm test`; this half needs the GitHub API, so it runs only in CI.
// Dependency-free: the ledger parser is test/regression/ledger.ts, loaded through Node's type stripping (Node 24).
//
//   GITHUB_TOKEN=... GITHUB_REPOSITORY=owner/repo node scripts/regression-ledger.mjs check-issues [--ledger <path>]
//
// Without GITHUB_TOKEN it prints "skipped: no GITHUB_TOKEN" and exits 0. Exit 1: an issue has no entry, the ledger
// does not parse, or the API failed. GITHUB_REPOSITORY defaults to the repository in package.json; GITHUB_API_URL
// overrides the API base (default https://api.github.com), for tests.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { LEDGER_PATH, ROOT, loadLedger } from "../test/regression/ledger.ts";

const DEFAULT_API = "https://api.github.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 50;
const REQUEST_TIMEOUT_MS = 30_000;
const LABEL = "type:bug";

class CheckError extends Error {}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  let ledger = LEDGER_PATH;
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--ledger" && rest[i + 1]) {
      ledger = rest[i + 1];
      i += 1;
    } else throw new CheckError(`unknown argument ${JSON.stringify(rest[i])}`);
  }
  if (command !== "check-issues") throw new CheckError("usage: regression-ledger.mjs check-issues [--ledger <path>]");
  return { ledger };
}

/** Every closed issue with the type:bug label, pull requests left out. */
async function closedBugs(api, repo, token) {
  const numbers = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const path = `/repos/${repo}/issues?state=closed&labels=${encodeURIComponent(LABEL)}&per_page=${PAGE_SIZE}&page=${page}`;
    let response;
    try {
      response = await fetch(`${api}${path}`, {
        headers: {
          accept: "application/vnd.github+json",
          authorization: `Bearer ${token}`,
          "user-agent": "regression-ledger",
          "x-github-api-version": "2022-11-28",
        },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new CheckError(`GET ${path} failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!response.ok) throw new CheckError(`GET ${path}: GitHub answered ${response.status}`);
    const rows = await response.json().catch(() => null);
    if (!Array.isArray(rows)) throw new CheckError(`GET ${path}: GitHub answered ${response.status} with no list`);
    for (const row of rows) if (row && typeof row.number === "number" && !row.pull_request) numbers.push(row.number);
    if (rows.length < PAGE_SIZE) return numbers.sort((a, b) => a - b);
  }
  throw new CheckError(`more than ${MAX_PAGES * PAGE_SIZE} closed ${LABEL} issues; raise MAX_PAGES`);
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
  const { ledger } = parseArgs(argv);
  const token = (env.GITHUB_TOKEN ?? "").trim();
  if (!token) {
    console.log("regression-ledger: skipped: no GITHUB_TOKEN");
    return 0;
  }
  const repo = (env.GITHUB_REPOSITORY ?? "").trim() || packageRepo();
  if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new CheckError("GITHUB_REPOSITORY must be owner/repo");
  const api = ((env.GITHUB_API_URL ?? "").trim() || DEFAULT_API).replace(/\/+$/, "");

  const listed = new Set(loadLedger(ledger).map((bug) => bug.issue));
  const bugs = await closedBugs(api, repo, token);
  const missing = bugs.filter((issue) => !listed.has(issue));
  if (missing.length > 0) {
    console.error(`regression-ledger: ${missing.length} closed ${LABEL} issue(s) of ${repo} have no entry in the ledger: ${missing.map((n) => `#${n}`).join(", ")}`);
    console.error("Add a [[bug]] entry for each (docs/agents/implement.md, \"Regression ledger\").");
    return 1;
  }
  console.log(`regression-ledger: ${bugs.length} closed ${LABEL} issues of ${repo}, every one in the ledger`);
  return 0;
}

try {
  process.exitCode = await main(process.argv.slice(2), process.env);
} catch (error) {
  console.error(`regression-ledger: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = error instanceof CheckError && error.message.startsWith("usage:") ? 2 : 1;
}

#!/usr/bin/env node
// The JSON summary of one Gateway regression run (epic-regression-gate ticket 4): `scripts/regression.sh gateway
// --result <file>` calls this from its EXIT trap, so a run that stopped early writes one too. Dependency-free.
//
//   node scripts/regression-result.mjs --out <file> --requested <request> [--version <v>] [--sha256 <sha>]
//     [--tier-status <code>] --exit-code <code> --seconds <n> [--report <vitest json report>]
//
// Writes {requested, version, sha256, result, exitCode, seconds, failed}. `result` is passed (the tier ran and exited 0),
// failed (it ran and did not), or error (no --tier-status: the run stopped before the tier finished). `failed` lists
// each failing test of the Vitest JSON report as `<file> > <full name>`, or `<file>: <first message line>` for a file
// that failed outside its tests (a hook, an import); no or an unreadable report lists none. Exit 2: usage.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const FLAGS = { "--out": "out", "--requested": "requested", "--version": "version", "--sha256": "sha256", "--tier-status": "tierStatus", "--exit-code": "exitCode", "--seconds": "seconds", "--report": "report" };

function parseArgs(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = Object.hasOwn(FLAGS, argv[i]) ? FLAGS[argv[i]] : undefined;
    if (!name || argv[i + 1] === undefined) throw new Error(`unknown or incomplete argument ${JSON.stringify(argv[i])}`);
    options[name] = argv[i + 1];
  }
  if (!options.out) throw new Error("--out is required");
  return options;
}

/** The failing tests of a Vitest JSON report; none when there is no readable report. */
function failedTests(report) {
  let parsed;
  try {
    parsed = report ? JSON.parse(readFileSync(report, "utf8")) : null;
  } catch {
    return [];
  }
  const failed = [];
  for (const suite of Array.isArray(parsed?.testResults) ? parsed.testResults : []) {
    const name = basename(String(suite?.name ?? ""));
    const tests = (Array.isArray(suite?.assertionResults) ? suite.assertionResults : []).filter((test) => test?.status === "failed");
    for (const test of tests) failed.push(`${name} > ${test.fullName ?? test.title}`);
    if (tests.length === 0 && suite?.status === "failed") failed.push(`${name}: ${String(suite.message || "failed").split("\n")[0]}`);
  }
  return failed;
}

const number = (text) => (text === undefined || text === "" || !Number.isFinite(Number(text)) ? null : Number(text));

try {
  const options = parseArgs(process.argv.slice(2));
  const tierStatus = options.tierStatus ?? "";
  const result = tierStatus === "" ? "error" : tierStatus === "0" ? "passed" : "failed";
  const summary = {
    requested: options.requested ?? null,
    version: options.version || null,
    sha256: options.sha256 || null,
    result,
    exitCode: number(options.exitCode),
    seconds: number(options.seconds),
    failed: failedTests(options.report),
  };
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  console.error(`regression-result: ${error instanceof Error ? error.message : String(error)}`);
  console.error("usage: regression-result.mjs --out <file> --requested <request> [--version <v>] [--sha256 <sha>] [--tier-status <code>] --exit-code <code> --seconds <n> [--report <file>]");
  process.exitCode = 2;
}

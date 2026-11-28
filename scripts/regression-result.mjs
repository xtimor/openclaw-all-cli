#!/usr/bin/env node
// The JSON summary of one regression run (epic-regression-gate tickets 4 and 4.5): `scripts/regression.sh <tier>
// --result <file>` calls this from its EXIT trap, so a run that stopped early writes one too. Dependency-free.
//
//   node scripts/regression-result.mjs --out <file> --requested <request> [--version <v>] [--sha256 <sha>]
//     [--tier-status <code>] --exit-code <code> --seconds <n> [--report <vitest json report>]
//     [--tier live --turn-cap <n> [--tries <file>] [--turns <file>] [--tokens <file>] [--measurements <file>]]
//
// Writes {requested, version, sha256, result, exitCode, seconds, failed}. `result` is passed (the tier ran and exited 0),
// failed (it ran and did not), or error (no --tier-status: the run stopped before the tier finished). `failed` lists
// each failing test of the Vitest JSON report as `<file> > <full name>`, or `<file>: <first message line>` for a file
// that failed outside its tests (a hook, an import); no or an unreadable report lists none. Exit 2: usage.
//
// The live tier (`--tier live`) adds `tier: "live"`, `tests` (file, name, state, tries, seconds, and the last failure's
// first line, from the tries reporter test/live/tries-reporter.ts), `files` (per file: result, tests, the most tries one
// of its tests took, seconds), `neededRetries` (tests that passed after their first try), `turns` and `refusedTurns`
// (the turn meter's log, test/live/turn-meter.mjs), `turnCap`, `tokens` (scripts/live-tokens.mjs: the summed counts,
// or null while unknown, never 0), and `measurements` ({name: [values]}, from `recordMeasurement` in
// test/live/harness.ts). Its `failed` entries end with the last failure message (`<file> > <name>: <message>`), and
// refused turns add `turn cap <n> reached: <m> turns refused` and make it failed.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname } from "node:path";

const FLAGS = {
  "--out": "out",
  "--requested": "requested",
  "--version": "version",
  "--sha256": "sha256",
  "--tier-status": "tierStatus",
  "--exit-code": "exitCode",
  "--seconds": "seconds",
  "--report": "report",
  "--tier": "tier",
  "--turn-cap": "turnCap",
  "--tries": "tries",
  "--turns": "turns",
  "--tokens": "tokens",
  "--measurements": "measurements",
};

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

const readJson = (file) => {
  try {
    return file ? JSON.parse(readFileSync(file, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};

/** The turn meter's log: turns started and turns refused at the cap; null when there is no log. */
function turnCounts(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch {
    return { turns: null, refusedTurns: null };
  }
  let turns = 0;
  let refusedTurns = 0;
  for (const line of text.split("\n")) {
    if (line.includes('"kind":"prompt"')) turns += 1;
    else if (line.includes('"kind":"refused"')) refusedTurns += 1;
  }
  return { turns, refusedTurns };
}

/** `{name: [values]}` from the measurement lines (JSON `{name, value}` per line); unreadable lines are skipped. */
function measurementsOf(file) {
  const out = {};
  let text = "";
  try {
    text = file ? readFileSync(file, "utf8") : "";
  } catch {
    return out;
  }
  for (const line of text.split("\n")) {
    try {
      const { name, value } = JSON.parse(line);
      if (typeof name === "string" && Number.isFinite(value)) (out[name] ??= []).push(value);
    } catch {
      // Not a measurement line.
    }
  }
  return out;
}

/** The live tier's fields, from the tries reporter, the meter's log, and the token reader. */
function liveFields(options, failed) {
  const tries = readJson(options.tries);
  const tests = (Array.isArray(tries?.tests) ? tries.tests : []).map((row) => ({
    file: basename(String(row?.file ?? "")),
    name: String(row?.name ?? ""),
    state: String(row?.state ?? ""),
    tries: Number.isFinite(row?.tries) ? row.tries : 0,
    seconds: Number.isFinite(row?.seconds) ? row.seconds : 0,
    ...(row?.message ? { message: String(row.message) } : {}),
  }));
  const byFile = new Map();
  for (const test of tests) {
    const entry = byFile.get(test.file) ?? { file: test.file, result: "passed", tests: 0, tries: 0, seconds: 0 };
    entry.tests += 1;
    entry.tries = Math.max(entry.tries, test.tries);
    entry.seconds = Math.round((entry.seconds + test.seconds) * 10) / 10;
    if (test.state === "failed") entry.result = "failed";
    byFile.set(test.file, entry);
  }
  for (const error of Array.isArray(tries?.fileErrors) ? tries.fileErrors : []) {
    const file = basename(String(error?.file ?? ""));
    byFile.set(file, { ...(byFile.get(file) ?? { file, tests: 0, tries: 0, seconds: 0 }), result: "failed" });
  }
  const messages = new Map(tests.filter((test) => test.state === "failed" && test.message).map((test) => [`${test.file} > ${test.name}`, test.message]));
  const withMessages = failed.map((entry) => (messages.has(entry) ? `${entry}: ${messages.get(entry)}` : entry));
  const { turns, refusedTurns } = turnCounts(options.turns);
  if (refusedTurns) withMessages.push(`turn cap ${options.turnCap} reached: ${refusedTurns} turns refused`);
  const tokens = readJson(options.tokens);
  return {
    failed: withMessages,
    live: {
      tests,
      files: [...byFile.values()],
      neededRetries: tests.filter((test) => test.state === "passed" && test.tries > 1).map((test) => `${test.file} > ${test.name} (tries ${test.tries})`),
      turns,
      refusedTurns,
      turnCap: number(options.turnCap),
      // Unknown is null, never 0: the reader writes a total only when every finished turn's events were found.
      tokens: tokens && typeof tokens === "object" && Number.isFinite(tokens.total) && tokens.total > 0 ? tokens : null,
      measurements: measurementsOf(options.measurements),
    },
  };
}

try {
  const options = parseArgs(process.argv.slice(2));
  const tierStatus = options.tierStatus ?? "";
  const result = tierStatus === "" ? "error" : tierStatus === "0" ? "passed" : "failed";
  let failed = failedTests(options.report);
  let live;
  if (options.tier === "live") ({ failed, live } = liveFields(options, failed));
  const summary = {
    requested: options.requested ?? null,
    version: options.version || null,
    sha256: options.sha256 || null,
    ...(live ? { tier: "live" } : {}),
    result: live?.refusedTurns && result === "passed" ? "failed" : result,
    exitCode: number(options.exitCode),
    seconds: number(options.seconds),
    failed,
    ...live,
  };
  mkdirSync(dirname(options.out), { recursive: true });
  writeFileSync(options.out, `${JSON.stringify(summary, null, 2)}\n`);
} catch (error) {
  console.error(`regression-result: ${error instanceof Error ? error.message : String(error)}`);
  console.error("usage: regression-result.mjs --out <file> --requested <request> [--version <v>] [--sha256 <sha>] [--tier-status <code>] --exit-code <code> --seconds <n> [--report <file>] [--tier live --turn-cap <n> --tries <file> --turns <file> --tokens <file> --measurements <file>]");
  process.exitCode = 2;
}

import { writeFileSync } from "node:fs";
import type { Reporter, TestModule } from "vitest/node";

/**
 * The live tier's tries record (epic-regression-gate ticket 4.5): a Vitest reporter that `scripts/regression.sh live`
 * adds with `--reporter=./test/live/tries-reporter.ts`. At the end of the run it writes `OAC_LIVE_TRIES_FILE`: one row
 * per test (file, full name, state, tries = Vitest retries + 1, seconds, the first line of the last error, or a skipped
 * test's reason) and one row per error outside a test: the file's own (an import) and every suite's (a failed
 * `beforeAll` of a `describe`, after which Vitest reports its tests as skipped). The live config retries a failing test
 * twice, so a test passes when any of its 3 tries passes; `scripts/regression-result.mjs` reads this file into the
 * tier's result. Messages quote Gateway answers and stderr, so the Cursor key (`CURSOR_API_KEY`) is replaced by
 * `<CURSOR_API_KEY>` in every one.
 */
export type TriesRow = {
  file: string;
  name: string;
  state: "passed" | "failed" | "skipped" | "pending";
  tries: number;
  seconds: number;
  message?: string;
  /** A skipped test's reason (`ctx.skip(note)`). */
  note?: string;
};

export type TriesFile = { tests: TriesRow[]; fileErrors: Array<{ file: string; message: string }> };

/** The first line of `text`, at most 300 characters, with the key replaced. */
function firstLine(text: unknown): string {
  const key = process.env.CURSOR_API_KEY?.trim();
  const line = String(text ?? "").split("\n")[0]!;
  return (key ? line.split(key).join("<CURSOR_API_KEY>") : line).slice(0, 300);
}

export function triesOf(modules: ReadonlyArray<TestModule>): TriesFile {
  const tests: TriesRow[] = [];
  const fileErrors: TriesFile["fileErrors"] = [];
  for (const module of modules) {
    const file = module.relativeModuleId;
    for (const test of module.children.allTests()) {
      const result = test.result();
      const diagnostic = test.diagnostic();
      const errors = result.state === "failed" ? result.errors : undefined;
      const note = result.state === "skipped" ? result.note : undefined;
      tests.push({
        file,
        name: test.fullName,
        state: result.state,
        tries: (diagnostic?.retryCount ?? 0) + (result.state === "skipped" || result.state === "pending" ? 0 : 1),
        seconds: Math.round((diagnostic?.duration ?? 0) / 100) / 10,
        ...(errors && errors.length > 0 ? { message: firstLine(errors.at(-1)?.message) } : {}),
        ...(note ? { note: firstLine(note) } : {}),
      });
    }
    for (const error of module.errors()) fileErrors.push({ file, message: firstLine(error.message) });
    for (const suite of module.children.allSuites()) {
      for (const error of suite.errors()) fileErrors.push({ file, message: firstLine(`${suite.fullName}: ${error.message}`) });
    }
  }
  return { tests, fileErrors };
}

export default class TriesReporter implements Reporter {
  onTestRunEnd(modules: ReadonlyArray<TestModule>): void {
    const out = process.env.OAC_LIVE_TRIES_FILE;
    if (out) writeFileSync(out, `${JSON.stringify(triesOf(modules), null, 2)}\n`);
  }
}

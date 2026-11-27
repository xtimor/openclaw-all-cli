import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LEDGER_PATH, LedgerError, loadLedger, missingTests, parseLedger, testTitles } from "./ledger.ts";

// The regression ledger (epic-regression-gate ticket 1): offline, in `npm test`. The CI half (every closed
// type:bug issue has an entry) is scripts/regression-ledger.mjs, tested in test/regression-ledger-script.test.ts.

/** The 20 closed `type:bug` issues on 2026-11-27, when the ledger was backfilled. */
const BACKFILLED = [11, 12, 13, 14, 35, 36, 38, 39, 40, 44, 45, 46, 67, 74, 75, 76, 80, 97, 98, 99];

const entry = (body: string) => `[[bug]]\n${body}\n`;
const BASE = [
  "issue = 7",
  'title = "a bug"',
  'family = "some-family"',
  'tier = "gateway"',
  "fixed = true",
  'tests = [ { file = "test/a.test.ts", name = "does the thing", tier = "unit", reproduces = false } ]',
].join("\n");
const withKey = (line: string) => entry(`${BASE}\n${line}`);
const replacing = (from: string, to: string) => {
  if (!BASE.includes(from)) throw new Error(`fixture has no ${from}`);
  return entry(BASE.replace(from, to));
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "regression-ledger-"));
  dirs.push(root);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(join(root, path, ".."), { recursive: true });
    writeFileSync(join(root, path), text);
  }
  return root;
}

describe("the committed ledger", () => {
  const bugs = loadLedger();

  it("parses, and has exactly one entry for each closed bug it was backfilled with", () => {
    const issues = bugs.map((bug) => bug.issue);
    expect(new Set(issues).size).toBe(issues.length);
    for (const issue of BACKFILLED) expect(issues, `issue #${issue}`).toContain(issue);
  });

  it("names only test files and titles that exist", () => {
    expect(missingTests(bugs)).toEqual([]);
  });

  it("is honest: a bug with no reproducing test at its own tier names the ticket that will add one, or why none comes", () => {
    const unplanned = bugs
      .filter((bug) => !bug.tests.some((test) => test.tier === bug.tier && test.reproduces))
      .filter((bug) => bug.planned === undefined && bug.no_test_reason === undefined)
      .map((bug) => `#${bug.issue}`);
    expect(unplanned).toEqual([]);
  });

  it("marks #13 as closed with no plugin fix", () => {
    expect(bugs.find((bug) => bug.issue === 13)?.fixed).toBe(false);
  });
});

describe("Missing test", () => {
  const ledger = (file: string, name: string) =>
    parseLedger(entry(BASE.replace('file = "test/a.test.ts", name = "does the thing"', `file = "${file}", name = "${name}"`)));
  const source = 'describe("group", () => {\n  it("does the thing well", () => {});\n});\n';

  it("passes when the file exists and a title contains the name", () => {
    expect(missingTests(ledger("test/a.test.ts", "does the thing"), repo({ "test/a.test.ts": source }))).toEqual([]);
  });

  it("fails naming the issue and the file when the file is missing", () => {
    expect(missingTests(ledger("test/gone.test.ts", "does the thing"), repo({ "test/a.test.ts": source }))).toEqual([
      "issue #7: test file test/gone.test.ts does not exist",
    ]);
  });

  it("fails naming the issue and the name when no title contains it", () => {
    const problems = missingTests(ledger("test/a.test.ts", "does another thing"), repo({ "test/a.test.ts": source }));
    expect(problems).toEqual(['issue #7: no describe/it/test title in test/a.test.ts contains "does another thing"']);
  });

  it("does not count text outside a title (a comment or an assertion string)", () => {
    const root = repo({ "test/a.test.ts": '// does the thing\nit("other", () => expect("does the thing").toBe("x"));\n' });
    expect(missingTests(ledger("test/a.test.ts", "does the thing"), root)).toHaveLength(1);
  });

  it("fails on the committed ledger when one name is changed to text that is in no test (mutation)", () => {
    const text = readFileSync(LEDGER_PATH, "utf8");
    const target = 'name = "registers the cursor-cli backend exactly once"';
    expect(text).toContain(target);
    const mutated = parseLedger(text.replace(target, 'name = "registers the cursor-cli backend exactly twice"'));
    expect(missingTests(mutated)).toEqual(['issue #14: no describe/it/test title in test/backend.test.ts contains "registers the cursor-cli backend exactly twice"']);
  });
});

describe("test titles", () => {
  it("reads describe/it/test titles with modifiers, multi-line calls, the project wrappers, and template titles", () => {
    const source = [
      'describe.skipIf(!ok)("skipped group", () => {});',
      "it(\n  'multi line',\n  () => {});",
      'describeLive("live group", () => {});',
      'describeRegression("gateway group", () => {});',
      "it(`${file} keeps its docs`, () => {});",
      'it("an \\"escaped\\" quote", () => {});',
      'it.each([1, 2])("each %s", () => {});',
      'test("plain test", () => {});',
      'split("not a title");',
    ].join("\n");
    expect(testTitles(source)).toEqual([
      "skipped group",
      "multi line",
      "live group",
      "gateway group",
      "${file} keeps its docs",
      'an "escaped" quote',
      "each %s",
      "plain test",
    ]);
  });
});

describe("Bad entry", () => {
  const fails = (text: string, message: RegExp) => expect(() => parseLedger(text)).toThrow(message);

  it("accepts the minimal valid entry", () => {
    expect(parseLedger(entry(BASE))).toEqual([
      { line: 1, issue: 7, title: "a bug", family: "some-family", tier: "gateway", fixed: true, tests: [{ file: "test/a.test.ts", name: "does the thing", tier: "unit", reproduces: false }] },
    ]);
  });

  it("refuses a duplicate issue, naming both lines", () => {
    fails(entry(BASE) + "\n" + entry(BASE), /^ledger line 10: issue #7: listed twice \(first at line 1\)$/);
  });

  it("refuses an unknown entry tier and an unknown test tier", () => {
    fails(replacing('tier = "gateway"', 'tier = "browser"'), /ledger line 5: issue #7: unknown tier "browser"/);
    fails(replacing('tier = "unit"', 'tier = "e2e"'), /ledger line 7: issue #7: tests\[0\]: unknown tier "e2e"/);
  });

  it("refuses an entry with neither tests nor planned nor no_test_reason, and accepts each alone", () => {
    const empty = BASE.replace(/tests = .*/, "tests = []");
    fails(entry(empty), /issue #7: has no test, no "planned" ticket, and no "no_test_reason"/);
    expect(parseLedger(entry(`${empty}\nplanned = "4.3"`))[0]?.planned).toBe("4.3");
    expect(parseLedger(entry(`${empty}\nno_test_reason = "host-only"`))[0]?.no_test_reason).toBe("host-only");
  });

  it("refuses an unknown key in an entry and in a test", () => {
    fails(withKey('note = "x"'), /ledger line 8: issue #7: unknown key "note"/);
    fails(replacing("reproduces = false", "reproduces = false, why = \"x\""), /issue #7: tests\[0\]: unknown key "why"/);
  });

  it("refuses a missing required key", () => {
    fails(entry(BASE.replace("fixed = true\n", "")), /issue #7: missing "fixed"/);
    fails(replacing(', reproduces = false', ""), /issue #7: tests\[0\]: missing "reproduces"/);
  });

  it("refuses wrong value types", () => {
    fails(replacing("issue = 7", 'issue = "7"'), /the \[\[bug\]\] on line 1: "issue" must be a positive integer/);
    fails(replacing("fixed = true", 'fixed = "yes"'), /issue #7: "fixed" must be true or false/);
    fails(replacing('family = "some-family"', 'family = "Some Family"'), /"family" must be lower-case kebab-case/);
    fails(withKey('planned = "soon"'), /"planned" must name tickets like "4.3"/);
    fails(replacing('file = "test/a.test.ts"', 'file = "../a.test.ts"'), /"file" must be a repository-relative path/);
  });

  it("refuses a unit test that claims to reproduce a bug from a higher tier, and a test file outside its tier's folder", () => {
    fails(replacing("reproduces = false", "reproduces = true"), /a unit test cannot reproduce a bug that showed at the gateway tier/);
    fails(replacing('tier = "unit"', 'tier = "live"'), /a live test must be under test\/live\//);
    fails(replacing('tier = "unit"', 'tier = "gateway"'), /a gateway test must be under test\/regression\/gateway\//);
  });

  it("refuses TOML the subset parser does not accept, naming the line", () => {
    fails(withKey("planned = 4.3"), /^ledger line 8: unsupported value "4.3"/);
    fails(withKey("planned = 'x'"), /^ledger line 8: literal \(single-quoted\) strings are not supported/);
    fails(withKey('planned = """x"""'), /^ledger line 8: multi-line strings are not supported/);
    fails(withKey("when = 2026-11-27"), /^ledger line 8: unsupported value "2026-11-27"/);
    fails(withKey("nested = [[1]]"), /^ledger line 8: an array holds only double-quoted strings or inline tables/);
    fails(withKey("inline = { a = 1 }"), /^ledger line 8: an inline table is only accepted inside an array/);
    fails(withKey('t = [ { a = [1] } ]'), /^ledger line 8: "a" in an inline table must be a string/);
    fails(withKey('t = [ { a = "x",\n b = "y" } ]'), /^ledger line 8: an inline table must stay on one line/);
    fails(withKey("tests = []"), /^ledger line 8: duplicate key "tests"/);
    fails(`issue = 1\n${entry(BASE)}`, /^ledger line 1: "issue" is outside a \[\[bug\]\] table/);
    fails(`[bug]\n${BASE}`, /^ledger line 1: only \[\[bug\]\] table headers are supported/);
    fails(`[[issue]]\n${BASE}`, /^ledger line 1: only \[\[bug\]\] table headers are supported/);
    fails(withKey('t = "open'), /^ledger line 8: unterminated string/);
    fails(withKey('t = [\n  "a",\n'), /^ledger line 11: unterminated array \(opened on line 8\)/);
    fails(withKey('t = "a" "b"'), /^ledger line 8: unexpected "\\"" after the value/);
    fails(withKey("bare"), /^ledger line 8: expected "=" after "bare"/);
  });

  it("reads comments, blank lines, CRLF line ends, multi-line arrays with trailing commas, and string escapes", () => {
    const text = [
      "# header",
      "",
      "[[bug]]  # trailing comment",
      "issue = 7",
      'title = "a \\"quoted\\" bug # not a comment \\u00e9"',
      'family = "some-family"',
      'tier = "gateway"',
      "fixed = false",
      "tests = [",
      "  # a comment inside an array",
      '  { file = "test/a.test.ts", name = "does the thing", tier = "unit", reproduces = false },',
      '  { file = "test/b.test.ts", name = "another", tier = "unit", reproduces = false },',
      "]",
      'planned = "4.3, 4.6"',
    ].join("\r\n");
    const [bug] = parseLedger(text);
    expect(bug).toMatchObject({ line: 3, issue: 7, title: 'a "quoted" bug # not a comment é', fixed: false, planned: "4.3, 4.6" });
    expect(bug?.tests.map((test) => test.file)).toEqual(["test/a.test.ts", "test/b.test.ts"]);
  });

  it("throws a LedgerError", () => {
    expect(() => parseLedger("[[bug]]\nissue = 1.5\n")).toThrow(LedgerError);
  });
});

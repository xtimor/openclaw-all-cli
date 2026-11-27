import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The regression ledger (epic-regression-gate ticket 1): `test/regression/ledger.toml` lists one `[[bug]]` per
 * closed `type:bug` issue with the test that guards it and the tier it runs at. This module reads exactly the TOML
 * subset that file uses and throws with the line number on anything else; `ledger.test.ts` and
 * `scripts/regression-ledger.mjs` (through Node's type stripping, no build step) share it. No dependency.
 */

/** Where a bug showed, or where a test runs: vitest with no host, a real Gateway with fake Cursor, the Control UI, real Cursor. */
export const TIERS = ["unit", "gateway", "ui", "live"] as const;
export type Tier = (typeof TIERS)[number];

export interface LedgerTest {
  /** Repository-relative path of the test file. */
  file: string;
  /** A substring of a `describe`/`it`/`test` title in that file. */
  name: string;
  tier: Tier;
  /** True when the test recreates the bug's original conditions; false for a lower-tier proxy. */
  reproduces: boolean;
}

export interface LedgerBug {
  /** Line of the entry's `[[bug]]` header. */
  line: number;
  issue: number;
  title: string;
  family: string;
  tier: Tier;
  fixed: boolean;
  tests: LedgerTest[];
  /** The epic-regression-gate ticket(s) that will add the test at the bug's tier, like `"4.3"` or `"4.3, 4.6"`. */
  planned?: string;
  no_test_reason?: string;
}

/** Repository root. */
export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const LEDGER_PATH = join(ROOT, "test", "regression", "ledger.toml");

/** A ledger the parser or the schema refuses; the message names the line or the issue. */
export class LedgerError extends Error {
  name = "LedgerError";
}

type Scalar = string | number | boolean;
type InlineTable = Record<string, Scalar>;
type Value = Scalar | Array<string | InlineTable>;
interface RawTable {
  line: number;
  values: Map<string, { value: Value; line: number }>;
}

/**
 * Parses the TOML subset: blank lines, `#` comments, `[[bug]]` headers, and `key = value` where the value is a basic
 * string, an integer, a boolean, or an array (one or more lines) of basic strings or one-line inline tables whose
 * values are strings, integers, or booleans. Anything else throws with its line number.
 */
export function parseTomlSubset(text: string): RawTable[] {
  const tables: RawTable[] = [];
  let pos = 0;
  let line = 1;
  const fail = (message: string, at = line): never => {
    throw new LedgerError(`ledger line ${at}: ${message}`);
  };
  const peek = (offset = 0) => text[pos + offset] ?? "";
  const skipSpaces = () => {
    while (peek() === " " || peek() === "\t") pos += 1;
  };
  const skipComment = () => {
    if (peek() !== "#") return;
    while (pos < text.length && peek() !== "\n") pos += 1;
  };
  /** Spaces, comments, and line ends (inside an array, between statements). */
  const skipBlank = () => {
    for (;;) {
      skipSpaces();
      skipComment();
      if (peek() === "\r" && peek(1) === "\n") pos += 1;
      if (peek() !== "\n") return;
      pos += 1;
      line += 1;
    }
  };
  const endOfLine = () => {
    skipSpaces();
    skipComment();
    if (peek() === "\r" && peek(1) === "\n") pos += 1;
    if (pos >= text.length) return;
    if (peek() !== "\n") fail(`unexpected ${JSON.stringify(peek())} after the value`);
    pos += 1;
    line += 1;
  };
  const bareKey = (): string => {
    const match = /^[A-Za-z0-9_-]+/.exec(text.slice(pos, pos + 200));
    if (!match) fail(`expected a bare key, found ${JSON.stringify(peek() || "end of file")}`);
    pos += match![0].length;
    return match![0];
  };
  const basicString = (): string => {
    if (text.startsWith('"""', pos)) fail("multi-line strings are not supported");
    pos += 1;
    let out = "";
    for (;;) {
      const ch = peek();
      if (ch === "" || ch === "\n" || ch === "\r") fail("unterminated string");
      pos += 1;
      if (ch === '"') return out;
      if (ch !== "\\") {
        out += ch;
        continue;
      }
      const esc = peek();
      pos += 1;
      if (esc === '"' || esc === "\\") out += esc;
      else if (esc === "n") out += "\n";
      else if (esc === "t") out += "\t";
      else if (esc === "u" && /^[0-9A-Fa-f]{4}$/.test(text.slice(pos, pos + 4))) {
        out += String.fromCharCode(Number.parseInt(text.slice(pos, pos + 4), 16));
        pos += 4;
      } else fail(`unsupported escape \\${esc}`);
    }
  };
  const scalar = (): Scalar => {
    const ch = peek();
    if (ch === '"') return basicString();
    if (ch === "'") fail("literal (single-quoted) strings are not supported; use a double-quoted string");
    const word = /^[^\s,\]}#]+/.exec(text.slice(pos, pos + 200))?.[0] ?? "";
    if (word === "true" || word === "false") {
      pos += word.length;
      return word === "true";
    }
    if (/^[+-]?(0|[1-9][0-9]*)$/.test(word)) {
      pos += word.length;
      return Number(word);
    }
    return fail(`unsupported value ${JSON.stringify(word || ch || "end of file")} (accepted: "string", integer, true, false, [array])`);
  };
  const inlineTable = (): InlineTable => {
    const start = line;
    pos += 1;
    const out: InlineTable = {};
    skipSpaces();
    if (peek() === "}") {
      pos += 1;
      return out;
    }
    const oneLine = () => fail(`an inline table must stay on one line and close with "}" (opened on line ${start})`);
    for (;;) {
      skipSpaces();
      if (peek() === "\n" || peek() === "\r" || peek() === "") oneLine();
      const key = bareKey();
      skipSpaces();
      if (peek() !== "=") fail(`expected "=" after "${key}" in an inline table`);
      pos += 1;
      skipSpaces();
      if (peek() === "[" || peek() === "{") fail(`"${key}" in an inline table must be a string, an integer, or a boolean`);
      if (Object.hasOwn(out, key)) fail(`duplicate key "${key}" in an inline table`);
      out[key] = scalar();
      skipSpaces();
      if (peek() === ",") {
        pos += 1;
        continue;
      }
      if (peek() === "}") {
        pos += 1;
        return out;
      }
      return oneLine();
    }
  };
  const array = (): Array<string | InlineTable> => {
    const start = line;
    pos += 1;
    const out: Array<string | InlineTable> = [];
    for (;;) {
      skipBlank();
      if (pos >= text.length) fail(`unterminated array (opened on line ${start})`);
      if (peek() === "]") {
        pos += 1;
        return out;
      }
      if (peek() === "{") out.push(inlineTable());
      else if (peek() === '"') out.push(basicString());
      else fail("an array holds only double-quoted strings or inline tables");
      skipBlank();
      if (peek() === ",") {
        pos += 1;
        continue;
      }
      if (peek() === "]") continue;
      fail(`expected "," or "]" in an array (opened on line ${start})`);
    }
  };

  for (;;) {
    skipBlank();
    if (pos >= text.length) return tables;
    if (peek() === "[") {
      const header = /^\[\[[ \t]*([A-Za-z0-9_-]+)[ \t]*\]\]/.exec(text.slice(pos, pos + 200));
      if (!header || header[1] !== "bug") fail("only [[bug]] table headers are supported");
      pos += header![0].length;
      tables.push({ line, values: new Map() });
      endOfLine();
      continue;
    }
    const keyLine = line;
    const key = bareKey();
    skipSpaces();
    if (peek() !== "=") fail(`expected "=" after "${key}"`);
    pos += 1;
    skipSpaces();
    const table = tables[tables.length - 1];
    if (!table) fail(`"${key}" is outside a [[bug]] table`);
    if (table!.values.has(key)) fail(`duplicate key "${key}"`);
    const value: Value = peek() === "[" ? array() : peek() === "{" ? fail("an inline table is only accepted inside an array") : scalar();
    table!.values.set(key, { value, line: keyLine });
    endOfLine();
  }
}

const BUG_KEYS = ["issue", "title", "family", "tier", "fixed", "tests", "planned", "no_test_reason"] as const;
const REQUIRED_BUG_KEYS = ["issue", "title", "family", "tier", "fixed", "tests"] as const;
const TEST_KEYS = ["file", "name", "tier", "reproduces"] as const;
const PLANNED = /^\d+\.\d+(, \d+\.\d+)*$/;

const isTier = (value: unknown): value is Tier => typeof value === "string" && (TIERS as readonly string[]).includes(value);

/** Where a test file of each tier lives; a `ui` test has no fixed folder yet (ticket 4.6 adds it). */
function tierFolderProblem(test: LedgerTest): string | undefined {
  const live = test.file.startsWith("test/live/");
  const gateway = test.file.startsWith("test/regression/gateway/");
  if (test.tier === "live" && !live) return `a live test must be under test/live/`;
  if (test.tier === "gateway" && !gateway) return `a gateway test must be under test/regression/gateway/`;
  if (test.tier === "unit" && (live || gateway)) return `a unit test cannot be under test/live/ or test/regression/gateway/`;
  if (test.tier === "unit" && !test.file.startsWith("src/") && !test.file.startsWith("test/")) return `a unit test must be under src/ or test/`;
  return undefined;
}

/** Parses the ledger and checks its schema; throws a {@link LedgerError} naming the line or the issue. */
export function parseLedger(text: string): LedgerBug[] {
  const bugs: LedgerBug[] = [];
  const seen = new Map<number, number>();
  for (const table of parseTomlSubset(text)) {
    const at = (key: string) => table.values.get(key)?.line ?? table.line;
    const fail = (key: string, message: string): never => {
      const issue = table.values.get("issue")?.value;
      const who = typeof issue === "number" ? `issue #${issue}` : `the [[bug]] on line ${table.line}`;
      throw new LedgerError(`ledger line ${at(key)}: ${who}: ${message}`);
    };
    for (const key of table.values.keys()) {
      if (!(BUG_KEYS as readonly string[]).includes(key)) fail(key, `unknown key "${key}" (known: ${BUG_KEYS.join(", ")})`);
    }
    for (const key of REQUIRED_BUG_KEYS) if (!table.values.has(key)) fail(key, `missing "${key}"`);
    const get = (key: string) => table.values.get(key)?.value;

    const issue = get("issue");
    if (typeof issue !== "number" || issue < 1) fail("issue", `"issue" must be a positive integer`);
    const first = seen.get(issue as number);
    if (first !== undefined) fail("issue", `listed twice (first at line ${first})`);
    seen.set(issue as number, table.line);

    const strings: Record<string, string> = {};
    for (const key of ["title", "family", "planned", "no_test_reason"]) {
      const value = get(key);
      if (value === undefined) continue;
      if (typeof value !== "string" || value.trim() === "") fail(key, `"${key}" must be a non-empty string`);
      strings[key] = value as string;
    }
    if (!/^[a-z][a-z0-9-]*$/.test(strings.family ?? "")) fail("family", `"family" must be lower-case kebab-case`);
    const tier = get("tier");
    if (!isTier(tier)) fail("tier", `unknown tier ${JSON.stringify(tier)} (known: ${TIERS.join(", ")})`);
    if (typeof get("fixed") !== "boolean") fail("fixed", `"fixed" must be true or false`);
    if (strings.planned !== undefined && !PLANNED.test(strings.planned)) fail("planned", `"planned" must name tickets like "4.3" or "4.3, 4.6"`);

    const rawTests = get("tests");
    if (!Array.isArray(rawTests)) fail("tests", `"tests" must be an array (it may be empty)`);
    const tests: LedgerTest[] = [];
    for (const [index, raw] of (rawTests as Array<string | InlineTable>).entries()) {
      const nth = `tests[${index}]`;
      if (typeof raw !== "object") fail("tests", `${nth} must be an inline table { file, name, tier, reproduces }`);
      const entry = raw as InlineTable;
      for (const key of Object.keys(entry)) {
        if (!(TEST_KEYS as readonly string[]).includes(key)) fail("tests", `${nth}: unknown key "${key}" (known: ${TEST_KEYS.join(", ")})`);
      }
      for (const key of TEST_KEYS) if (!(key in entry)) fail("tests", `${nth}: missing "${key}"`);
      const { file, name, reproduces } = entry;
      if (typeof file !== "string" || file === "" || isAbsolute(file) || normalize(file).split(sep).includes("..") || file.includes("\\")) {
        fail("tests", `${nth}: "file" must be a repository-relative path with forward slashes`);
      }
      if (typeof name !== "string" || name.trim() === "") fail("tests", `${nth}: "name" must be a non-empty string`);
      if (!isTier(entry.tier)) fail("tests", `${nth}: unknown tier ${JSON.stringify(entry.tier)} (known: ${TIERS.join(", ")})`);
      if (typeof reproduces !== "boolean") fail("tests", `${nth}: "reproduces" must be true or false`);
      const test: LedgerTest = { file: file as string, name: name as string, tier: entry.tier as Tier, reproduces: reproduces as boolean };
      const folder = tierFolderProblem(test);
      if (folder) fail("tests", `${nth}: ${folder} (${test.file})`);
      if (test.reproduces && test.tier === "unit" && tier !== "unit") {
        fail("tests", `${nth}: a unit test cannot reproduce a bug that showed at the ${tier as string} tier; set reproduces = false`);
      }
      tests.push(test);
    }
    if (tests.length === 0 && strings.planned === undefined && strings.no_test_reason === undefined) {
      fail("tests", `has no test, no "planned" ticket, and no "no_test_reason"`);
    }

    const bug: LedgerBug = {
      line: table.line,
      issue: issue as number,
      title: strings.title as string,
      family: strings.family as string,
      tier: tier as Tier,
      fixed: get("fixed") as boolean,
      tests,
    };
    if (strings.planned !== undefined) bug.planned = strings.planned;
    if (strings.no_test_reason !== undefined) bug.no_test_reason = strings.no_test_reason;
    bugs.push(bug);
  }
  return bugs;
}

/** Reads and parses the committed ledger (or another file). */
export function loadLedger(path: string = LEDGER_PATH): LedgerBug[] {
  return parseLedger(readFileSync(path, "utf8"));
}

/**
 * The titles of `describe`/`it`/`test` calls (with modifiers such as `.skipIf(...)` or `.each(...)`, and the
 * project's `describeLive`/`describeRegression`) in a test file's text, as written between the quotes.
 */
export function testTitles(source: string): string[] {
  const titles: string[] = [];
  const call = /\b(?:describe|it|test|describeLive|describeRegression)(?:\.\w+(?:\([^()]*\))?)*\(\s*(["'`])/g;
  for (let match = call.exec(source); match; match = call.exec(source)) {
    const quote = match[1] as string;
    let index = call.lastIndex;
    let title = "";
    while (index < source.length && source[index] !== quote) {
      if (source[index] === "\\" && index + 1 < source.length) {
        title += source[index + 1];
        index += 2;
        continue;
      }
      if (quote !== "`" && source[index] === "\n") break;
      title += source[index];
      index += 1;
    }
    if (source[index] === quote) titles.push(title);
  }
  return titles;
}

/** One line per ledger test whose file is missing or has no title containing its name; empty when all are found. */
export function missingTests(bugs: readonly LedgerBug[], root: string = ROOT): string[] {
  const problems: string[] = [];
  const titlesOf = new Map<string, string[] | undefined>();
  for (const bug of bugs) {
    for (const test of bug.tests) {
      if (!titlesOf.has(test.file)) {
        const path = join(root, test.file);
        titlesOf.set(test.file, existsSync(path) ? testTitles(readFileSync(path, "utf8")) : undefined);
      }
      const titles = titlesOf.get(test.file);
      if (!titles) problems.push(`issue #${bug.issue}: test file ${test.file} does not exist`);
      else if (!titles.some((title) => title.includes(test.name))) {
        problems.push(`issue #${bug.issue}: no describe/it/test title in ${test.file} contains ${JSON.stringify(test.name)}`);
      }
    }
  }
  return problems;
}

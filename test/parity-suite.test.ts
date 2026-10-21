import { readFileSync, readdirSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { cursorManifest } from "../src/adapters/cursor/manifest.ts";

/**
 * The parity suite, enforced: Cursor's manifest, the parity matrix (`claude-cli-parity.md`), the provider
 * doc (`docs/providers/cursor.md`), and the live test files must agree. Every decided row (`match` or
 * `approx`) has a live test that names it in a `describeLive` title, and the matrix cell and the docs row
 * both name a live file that covers it. A gap row carries its reason in all three places and needs no live
 * file. Needs no host and no Cursor login: it reads files.
 */
const path = (relative: string) => fileURLToPath(new URL(relative, import.meta.url));
const MATRIX = path("../_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md");
const DOCS = path("../docs/providers/cursor.md");
const LIVE_DIR = path("./live/");

type Row = { id: string; status: string; cell: string };

/** Splits a Markdown table row into its cells (an escaped `\|` stays inside a cell). */
function cellsOf(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split(/(?<!\\)\|/)
    .map((cell) => cell.trim());
}

/** The `| P<n> | ... |` rows of a table, with the status and the text the given column holds. */
function tableRows(file: string, columns: { status: (cells: string[]) => string; text: (cells: string[]) => string }): Map<string, Row> {
  const rows = new Map<string, Row>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    const cells = /^\|\s*P\d+\s*\|/.test(line) ? cellsOf(line) : undefined;
    if (cells) rows.set(cells[0]!, { id: cells[0]!, status: columns.status(cells), cell: columns.text(cells) });
  }
  return rows;
}

// Matrix: `| # | feature | mechanism | cursor-cli | Antigravity |`; the cursor-cli cell is "<status>: <text>".
const matrix = tableRows(MATRIX, {
  status: (cells) => /^(\w+):/.exec(cells[3] ?? "")?.[1] ?? "",
  text: (cells) => cells[3] ?? "",
});
// Docs: `| P<n> | Feature | Status | Notes |`.
const docs = tableRows(DOCS, { status: (cells) => cells[2] ?? "", text: (cells) => cells[3] ?? "" });

/** The live files, by the parity rows their `describeLive` titles name. */
const liveFiles = readdirSync(LIVE_DIR)
  .filter((name) => name.endsWith(".live.test.ts"))
  .map((name) => {
    const source = readFileSync(`${LIVE_DIR}${name}`, "utf8");
    const titles = [...source.matchAll(/describeLive\(\s*(["'`])((?:\\.|(?!\1).)*)\1/g)].map((match) => match[2]!);
    return { file: `test/live/${name}`, titles, rows: new Set(titles.flatMap((title) => [...title.matchAll(/\bP\d+\b/g)].map((match) => match[0]))) };
  });

const manifestRows = Object.entries(cursorManifest.rows) as Array<[string, { status: string; note: string }]>;
const decided = manifestRows.filter(([, row]) => row.status === "match" || row.status === "approx");
const namedFiles = (text: string) => [...text.matchAll(/test\/live\/[\w.-]+\.live\.test\.ts/g)].map((match) => match[0]);
const coveringFiles = (id: string) => liveFiles.filter((live) => live.rows.has(id)).map((live) => live.file);

describe("parity suite", () => {
  it("has the matrix, the docs table, and live files to read", () => {
    expect(matrix.size, "rows in the parity matrix").toBeGreaterThan(0);
    expect(docs.size, "rows in the docs parity table").toBeGreaterThan(0);
    expect(liveFiles.length, "live files").toBeGreaterThan(0);
  });

  it("every live file has at least one describeLive", () => {
    const without = liveFiles.filter((live) => live.titles.length === 0).map((live) => live.file);
    expect(without, "live files with no describeLive title").toEqual([]);
  });

  it("the manifest, the matrix, and the docs table list the same rows with the same status", () => {
    const problems: string[] = [];
    for (const [id, row] of manifestRows) {
      const inMatrix = matrix.get(id);
      const inDocs = docs.get(id);
      if (!inMatrix) problems.push(`${id}: missing from the parity matrix (${MATRIX})`);
      else if (inMatrix.status !== row.status) problems.push(`${id}: manifest says ${row.status}, the parity matrix says ${inMatrix.status || "(no status)"}`);
      if (!inDocs) problems.push(`${id}: missing from the docs parity table (${DOCS})`);
      else if (inDocs.status !== row.status) problems.push(`${id}: manifest says ${row.status}, docs/providers/cursor.md says ${inDocs.status || "(no status)"}`);
    }
    for (const id of matrix.keys()) if (!(id in cursorManifest.rows)) problems.push(`${id}: in the parity matrix but not in the manifest`);
    for (const id of docs.keys()) if (!(id in cursorManifest.rows)) problems.push(`${id}: in the docs table but not in the manifest`);
    expect(problems).toEqual([]);
  });

  it("every decided row has a live test that names it, and the matrix and the docs name a file that covers it", () => {
    const problems: string[] = [];
    expect(decided.length, "decided rows in the manifest").toBeGreaterThan(0);
    for (const [id] of decided) {
      const covering = coveringFiles(id);
      if (covering.length === 0) {
        problems.push(`${id}: no describeLive title names it (add "(${id})" to the title of the live test that covers it)`);
        continue;
      }
      for (const [where, row] of [
        ["the parity matrix", matrix.get(id)],
        ["docs/providers/cursor.md", docs.get(id)],
      ] as const) {
        const named = row ? namedFiles(row.cell) : [];
        for (const file of named) if (!existsSync(path(`../${file}`))) problems.push(`${id}: ${where} names ${file}, which does not exist`);
        if (!named.some((file) => covering.includes(file))) {
          problems.push(`${id}: ${where} names ${named.length ? named.join(", ") : "no live file"}; none has a describeLive title naming ${id} (covering: ${covering.join(", ")})`);
        }
      }
    }
    expect(problems).toEqual([]);
  });

  it("every gap row has its reason in the manifest, the matrix, and the docs", () => {
    const problems: string[] = [];
    const gaps = manifestRows.filter(([, row]) => row.status === "gap");
    expect(gaps.length, "gap rows in the manifest").toBeGreaterThan(0);
    for (const [id, row] of gaps) {
      if (row.note.trim().length === 0) problems.push(`${id}: the manifest note is empty`);
      const inMatrix = matrix.get(id);
      if (!inMatrix || !/^gap:\s*\S/.test(inMatrix.cell)) problems.push(`${id}: the parity matrix cell does not start with "gap:" and a reason`);
      const inDocs = docs.get(id);
      if (!inDocs || inDocs.cell.trim().length === 0) problems.push(`${id}: the docs row has no reason`);
    }
    expect(problems).toEqual([]);
  });
});

import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * scripts/changelog.mjs (backlog 9): which lines become a release's notes, how `Unreleased` is stamped, the layout
 * check, and the real CHANGELOG.md. Pure functions plus the CLI in a child process; no network.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "scripts", "changelog.mjs");

interface Changelog {
  parse(text: string): { preamble: string[]; sections: Array<{ name: string; date: string; body: string[] }> };
  hasContent(body: string[]): boolean;
  releaseNotes(text: string, version: string): { source: string; notes: string } | null;
  stamp(text: string, version: string, date: string): string;
  validate(text: string): string[];
}
let lib: Changelog;
let work: string;

beforeAll(async () => {
  lib = (await import(pathToFileURL(SCRIPT).href)) as Changelog;
  work = mkdtempSync(join(tmpdir(), "changelog-"));
});
afterAll(() => rmSync(work, { recursive: true, force: true }));

const SAMPLE = `# Changelog

Intro.

## Unreleased

### Added

- Pending line.

## 1.0.1 - 2026-02-02

### Fixed

- Fixed thing. ([#7](https://example.test/7))

## 1.0.0 - 2026-01-01

### Added

- First.
`;

const cli = (...args: string[]) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: "utf8" });

describe("releaseNotes", () => {
  it("returns the section named for the version, without its heading", () => {
    const found = lib.releaseNotes(SAMPLE, "1.0.1");
    expect(found?.source).toBe("1.0.1");
    expect(found?.notes).toBe("### Fixed\n\n- Fixed thing. ([#7](https://example.test/7))");
  });

  it("takes Unreleased when no section is named for the version", () => {
    const found = lib.releaseNotes(SAMPLE, "1.0.2");
    expect(found?.source).toBe("Unreleased");
    expect(found?.notes).toBe("### Added\n\n- Pending line.");
  });

  it("the named section wins over Unreleased", () => {
    expect(lib.releaseNotes(SAMPLE, "1.0.0")?.notes).toBe("### Added\n\n- First.");
  });

  it("accepts a v prefix, brackets, and Unreleased in any case", () => {
    const text = "## [unreleased]\n\n- a\n\n## [v2.0.0] - 2026-03-03\n\n- b\n";
    expect(lib.releaseNotes(text, "v2.0.0")?.notes).toBe("- b");
    expect(lib.releaseNotes(text, "2.0.1")?.source).toBe("Unreleased");
  });

  it("a prerelease version is its own name", () => {
    const text = "## Unreleased\n\n- u\n\n## 2.0.0-rc.1 - 2026-03-03\n\n- rc\n";
    expect(lib.releaseNotes(text, "2.0.0-rc.1")?.notes).toBe("- rc");
    expect(lib.releaseNotes(text, "2.0.0")?.source).toBe("Unreleased");
  });

  it("is null when there is no section for the version and Unreleased is empty", () => {
    expect(lib.releaseNotes("## Unreleased\n\n## 1.0.0 - 2026-01-01\n\n- a\n", "1.0.1")).toBeNull();
  });

  it("an empty named section falls through to Unreleased", () => {
    const text = "## Unreleased\n\n- u\n\n## 1.0.1 - 2026-02-02\n\n### Added\n";
    expect(lib.releaseNotes(text, "1.0.1")?.source).toBe("Unreleased");
  });

  it("headings only, blank lines, and HTML comments are empty", () => {
    const text = "## Unreleased\n\n### Added\n\n<!-- nothing yet -->\n\n<!--\nmulti\nline\n-->\n\n### Fixed\n";
    expect(lib.releaseNotes(text, "1.0.0")).toBeNull();
  });

  it("is null for a missing or unrelated file body", () => {
    expect(lib.releaseNotes("", "1.0.0")).toBeNull();
    expect(lib.releaseNotes("# Changelog\n\nNo sections.\n", "1.0.0")).toBeNull();
  });

  it("reads CRLF files and does not cut a section at a ### heading", () => {
    const text = "## Unreleased\r\n\r\n### Added\r\n\r\n- a\r\n\r\n### Fixed\r\n\r\n- b\r\n";
    expect(lib.releaseNotes(text, "9.9.9")?.notes).toBe("### Added\n\n- a\n\n### Fixed\n\n- b");
  });
});

describe("stamp", () => {
  it("moves the Unreleased lines to a new section below an empty Unreleased", () => {
    const out = lib.stamp(SAMPLE, "1.0.2", "2026-03-03");
    expect(out).toContain("## Unreleased\n\n## 1.0.2 - 2026-03-03\n\n### Added\n\n- Pending line.\n\n## 1.0.1 - 2026-02-02");
    expect(lib.releaseNotes(out, "1.0.2")?.notes).toBe("### Added\n\n- Pending line.");
    expect(lib.releaseNotes(out, "1.0.3")).toBeNull();
    expect(out.startsWith("# Changelog\n\nIntro.\n\n## Unreleased")).toBe(true);
    expect(lib.validate(out)).toEqual([]);
  });

  it("keeps older sections byte for byte", () => {
    const out = lib.stamp(SAMPLE, "1.0.2", "2026-03-03");
    expect(out.endsWith(SAMPLE.slice(SAMPLE.indexOf("## 1.0.1")))).toBe(true);
  });

  it("refuses an Unreleased with no lines, a version that exists, and bad input", () => {
    expect(() => lib.stamp("## Unreleased\n\n### Added\n\n## 1.0.0 - 2026-01-01\n\n- a\n", "1.0.1", "2026-03-03")).toThrow(/no lines/);
    expect(() => lib.stamp(SAMPLE, "1.0.1", "2026-03-03")).toThrow(/already has a section/);
    expect(() => lib.stamp("## 1.0.0 - 2026-01-01\n\n- a\n", "1.0.1", "2026-03-03")).toThrow(/no `## Unreleased`/);
    expect(() => lib.stamp(SAMPLE, "v1.0.2", "2026-03-03")).toThrow(/not a version/);
    expect(() => lib.stamp(SAMPLE, "1.0", "2026-03-03")).toThrow(/not a version/);
    expect(() => lib.stamp(SAMPLE, "1.0.2", "2026-02-30")).toThrow(/not a date/);
    expect(() => lib.stamp(SAMPLE, "1.0.2", "today")).toThrow(/not a date/);
  });
});

describe("validate", () => {
  it("accepts the sample", () => expect(lib.validate(SAMPLE)).toEqual([]));

  it("reports each layout problem", () => {
    const bad = [
      "## 1.0.1 - 2026-01-01\n\n- a\n",
      "## Unreleased\n\n## 1.0.0\n\n- a\n\n## 1.0.0 - 2026-01-01\n\n- b\n\n## 1.0.2 - 2026-05-05\n\n- c\n\n## 1.0.3 - 2026-06-31\n\n### Misc\n\n- d\n\n## 1.0.4 - 2026-01-01\n",
    ].join("");
    const problems = lib.validate(bad).join("\n");
    expect(problems).toContain("first section must be `## Unreleased`");
    expect(problems).toContain("section 1.0.0: needs a date");
    expect(problems).toContain("section 1.0.0: listed twice");
    expect(problems).toContain("section 1.0.2: dated after the section above it");
    expect(problems).toContain("section 1.0.3: needs a date");
    expect(problems).toContain('"### Misc" is not one of');
    expect(problems).toContain("section 1.0.4: has no lines");
  });

  it("a file without sections is a problem", () => expect(lib.validate("# Changelog\n")).toHaveLength(1));
});

describe("CHANGELOG.md", () => {
  const text = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");

  it("is well formed", () => expect(lib.validate(text)).toEqual([]));

  it("has Unreleased first and the released versions with their dates", () => {
    const { sections } = lib.parse(text);
    expect(sections[0]?.name).toBe("Unreleased");
    const dates = Object.fromEntries(sections.map((section) => [section.name, section.date]));
    expect(dates["0.1.2"]).toBe("2026-10-25");
    expect(dates["0.1.1"]).toBe("2026-10-22");
    expect(dates["0.1.0"]).toBe("2026-10-22");
  });

  it("gives every released version notes", () => {
    for (const version of ["0.1.2", "0.1.1", "0.1.0"]) {
      const found = lib.releaseNotes(text, version);
      expect(found?.source, version).toBe(version);
      expect(found?.notes, version).toMatch(/^### /);
    }
  });

  it("holds no ticket bookkeeping or run-log noise", () => {
    expect(text).not.toMatch(/\b[Tt]icket \d|\bbacklog\b|run log|_bmad|MEMORY\.md|batch PR|Issue batch/);
  });
});

describe("command line", () => {
  const file = () => {
    const path = join(work, `changelog-${Math.random().toString(36).slice(2)}.md`);
    writeFileSync(path, SAMPLE);
    return path;
  };

  it("section prints the notes on stdout and the source on stderr", () => {
    const run = cli("section", "1.0.1", file());
    expect(run.status).toBe(0);
    expect(run.stdout).toBe("### Fixed\n\n- Fixed thing. ([#7](https://example.test/7))\n");
    expect(run.stderr).toBe("changelog: notes from section 1.0.1\n");
    expect(cli("section", "1.0.2", file()).stderr).toBe("changelog: notes from Unreleased\n");
  });

  it("section exits 1 with a reason when there is nothing, or no file", () => {
    const empty = join(work, "empty.md");
    writeFileSync(empty, "## Unreleased\n");
    const none = cli("section", "1.0.2", empty);
    expect(none.status).toBe(1);
    expect(none.stdout).toBe("");
    expect(none.stderr).toContain("no lines under 1.0.2 or Unreleased");
    const missing = cli("section", "1.0.2", join(work, "missing.md"));
    expect(missing.status).toBe(1);
    expect(missing.stderr).toMatch(/^changelog: ENOENT/);
  });

  it("stamp rewrites the file and a second stamp of the same version fails", () => {
    const path = file();
    const first = cli("stamp", "1.0.2", "2026-03-03", path);
    expect(first.status, first.stderr).toBe(0);
    expect(readFileSync(path, "utf8")).toContain("## 1.0.2 - 2026-03-03");
    const again = cli("stamp", "1.0.2", "2026-03-03", path);
    expect(again.status).toBe(1);
    expect(again.stderr).toContain("already has a section");
  });

  it("check passes the sample and the real file, fails a bad one", () => {
    expect(cli("check", file()).status).toBe(0);
    expect(cli("check").status).toBe(0);
    const bad = join(work, "bad.md");
    writeFileSync(bad, "## 1.0.0\n");
    const run = cli("check", bad);
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("first section must be");
  });

  it("a wrong command or argument count exits 2 with the usage", () => {
    for (const args of [[], ["section"], ["stamp", "1.0.0"], ["publish"]]) {
      const run = cli(...args);
      expect(run.status, args.join(" ")).toBe(2);
      expect(run.stderr).toContain("usage:");
    }
  });
});

#!/usr/bin/env node
// CHANGELOG.md helper for releases (docs/release.md, "Changelog"). Agent-neutral, no dependencies.
//
//   changelog.mjs section <version> [file]        print the release notes for <version>: the section named for
//                                                  it, else `Unreleased`; exit 1 (reason on stderr) when neither has
//                                                  content, so the release falls back to generated notes
//   changelog.mjs stamp <version> <date> [file]    move the lines under `Unreleased` into a new `## <version> - <date>`
//   changelog.mjs check [file]                     validate the layout; exit 1 and list the problems
//
// Layout: `## Unreleased` first, then `## X.Y.Z - YYYY-MM-DD`, newest first; `### Added|Changed|...` inside.
// A `[x]` around the name and a `v` before the version are read too. A section ends at the next `## `.

import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z-]+(\.[0-9A-Za-z-]+)*)?$/;
const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const HEADING = /^##[ \t]+\[?([^\]\s]+)\]?(?:[ \t]+[-–—][ \t]+(\S.*?))?[ \t]*$/;
const KINDS = new Set(["Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"]);

/** @returns {{ preamble: string[], sections: Array<{ name: string, date: string, heading: string, body: string[] }> }} */
export function parse(text) {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const preamble = [];
  const sections = [];
  let current = null;
  for (const line of lines) {
    if (/^##[ \t]/.test(line)) {
      const match = HEADING.exec(line);
      const raw = match ? match[1] : line.slice(2).trim();
      const name = raw.toLowerCase() === "unreleased" ? "Unreleased" : raw.replace(/^v(?=\d)/, "");
      current = { name, date: match?.[2] ?? "", heading: line, body: [] };
      sections.push(current);
    } else (current ? current.body : preamble).push(line);
  }
  return { preamble, sections };
}

/** Lines that say something: not blank, not a heading, not inside an HTML comment. */
export function hasContent(body) {
  const text = body.join("\n").replace(/<!--[\s\S]*?-->/g, "");
  return text.split("\n").some((line) => line.trim() !== "" && !line.trim().startsWith("#"));
}

const trimBlank = (body) => {
  let start = 0;
  let end = body.length;
  while (start < end && body[start].trim() === "") start++;
  while (end > start && body[end - 1].trim() === "") end--;
  return body.slice(start, end);
};

/**
 * The release notes for `version`: the section named for it, else `Unreleased`; null when neither has content.
 * @returns {{ source: string, notes: string } | null}
 */
export function releaseNotes(text, version) {
  const wanted = String(version).replace(/^v(?=\d)/, "");
  const { sections } = parse(text);
  for (const name of [wanted, "Unreleased"]) {
    const found = sections.find((section) => section.name === name && hasContent(section.body));
    if (found) return { source: found.name, notes: trimBlank(found.body).join("\n") };
  }
  return null;
}

/** Move the lines under `Unreleased` into a new section for `version`; throws a readable Error when it cannot. */
export function stamp(text, version, date) {
  if (!VERSION.test(version)) throw new Error(`"${version}" is not a version (X.Y.Z, no "v").`);
  const day = DATE.exec(date);
  const valid = day && new Date(`${date}T00:00:00Z`).toISOString().startsWith(date);
  if (!valid) throw new Error(`"${date}" is not a date (YYYY-MM-DD).`);
  const { preamble, sections } = parse(text);
  const unreleased = sections.find((section) => section.name === "Unreleased");
  if (!unreleased) throw new Error("there is no `## Unreleased` section.");
  if (sections.some((section) => section.name === version)) throw new Error(`version ${version} already has a section.`);
  if (!hasContent(unreleased.body)) throw new Error("`Unreleased` has no lines to move.");
  const moved = { name: version, date, heading: `## ${version} - ${date}`, body: ["", ...trimBlank(unreleased.body), ""] };
  const out = [...preamble];
  for (const section of sections) {
    if (section === unreleased) out.push(section.heading, "", moved.heading, ...moved.body);
    else out.push(section.heading, ...section.body);
  }
  return `${trimBlank(out).join("\n")}\n`;
}

/** Layout problems, as readable strings; empty when the file is well formed. */
export function validate(text) {
  const problems = [];
  const { sections } = parse(text);
  if (sections.length === 0) return ["no `## ` sections."];
  if (sections[0].name !== "Unreleased") problems.push("the first section must be `## Unreleased`.");
  const seen = new Set();
  let previous = "";
  for (const section of sections) {
    if (section.name === "Unreleased") {
      if (section !== sections[0]) problems.push("`Unreleased` must be the first section only.");
      continue;
    }
    const where = `section ${section.name}`;
    if (!VERSION.test(section.name)) problems.push(`${where}: not a version (X.Y.Z).`);
    if (seen.has(section.name)) problems.push(`${where}: listed twice.`);
    seen.add(section.name);
    if (!DATE.test(section.date) || !new Date(`${section.date}T00:00:00Z`).toISOString().startsWith(section.date)) {
      problems.push(`${where}: needs a date, \`## ${section.name} - YYYY-MM-DD\`.`);
    } else {
      if (previous && section.date > previous) problems.push(`${where}: dated after the section above it (newest first).`);
      previous = section.date;
    }
    if (!hasContent(section.body)) problems.push(`${where}: has no lines.`);
  }
  for (const section of sections) {
    for (const line of section.body) {
      const kind = /^###[ \t]+(.*?)[ \t]*$/.exec(line)?.[1];
      if (kind !== undefined && !KINDS.has(kind)) problems.push(`section ${section.name}: "### ${kind}" is not one of ${[...KINDS].join(", ")}.`);
    }
  }
  return problems;
}

function main(argv) {
  const [command, ...args] = argv;
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const fileOf = (arg) => (arg ? resolve(arg) : join(root, "CHANGELOG.md"));
  const usage = () => {
    console.error("usage: changelog.mjs section <version> [file] | stamp <version> <date> [file] | check [file]");
    return 2;
  };
  try {
    if (command === "section" && args.length >= 1 && args.length <= 2) {
      const found = releaseNotes(readFileSync(fileOf(args[1]), "utf8"), args[0]);
      if (!found) {
        console.error(`changelog: no lines under ${args[0]} or Unreleased`);
        return 1;
      }
      console.error(`changelog: notes from ${found.source === "Unreleased" ? "Unreleased" : `section ${found.source}`}`);
      process.stdout.write(`${found.notes}\n`);
      return 0;
    }
    if (command === "stamp" && args.length >= 2 && args.length <= 3) {
      const file = fileOf(args[2]);
      writeFileSync(file, stamp(readFileSync(file, "utf8"), args[0], args[1]));
      console.log(`changelog: Unreleased moved to ${args[0]} - ${args[1]}`);
      return 0;
    }
    if (command === "check" && args.length <= 1) {
      const problems = validate(readFileSync(fileOf(args[0]), "utf8"));
      for (const problem of problems) console.error(`changelog: ${problem}`);
      return problems.length === 0 ? 0 : 1;
    }
  } catch (error) {
    console.error(`changelog: ${error instanceof Error ? error.message : error}`);
    return 1;
  }
  return usage();
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));

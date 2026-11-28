#!/usr/bin/env node
// Replaces the Cursor key in every file under the given directories with `<CURSOR_API_KEY>`, before the live tier
// uploads them as an artifact (ticket 4.5: the key never reaches an artifact). The key comes from the environment
// (CURSOR_API_KEY) and is never printed; the script prints only how many files it changed. Dependency-free.
//
//   CURSOR_API_KEY=… node scripts/scrub-key.mjs <dir>...
//
// Files are read and written as latin1, so any byte sequence survives unchanged except the key itself. No key: nothing
// to scrub, exit 0. A path that does not exist is skipped. Exit 2: usage.
import { existsSync, lstatSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

/** Every regular file under `path` (symbolic links are not followed). */
function filesUnder(path) {
  const stat = lstatSync(path);
  if (stat.isFile()) return [path];
  if (!stat.isDirectory()) return [];
  return readdirSync(path).flatMap((name) => filesUnder(join(path, name)));
}

/** Scrubs `key` from the files under `paths`; returns the files it changed. */
export function scrubKey(key, paths) {
  const changed = [];
  if (!key) return changed;
  for (const path of paths) {
    if (!existsSync(path)) continue;
    for (const file of filesUnder(path)) {
      const text = readFileSync(file, "latin1");
      if (!text.includes(key)) continue;
      writeFileSync(file, text.split(key).join("<CURSOR_API_KEY>"), "latin1");
      changed.push(file);
    }
  }
  return changed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const paths = process.argv.slice(2);
  if (paths.length === 0) {
    console.error("usage: CURSOR_API_KEY=… scrub-key.mjs <dir>...");
    process.exitCode = 2;
  } else {
    const changed = scrubKey((process.env.CURSOR_API_KEY ?? "").trim(), paths);
    console.log(`scrub-key: the key removed from ${changed.length} file(s)`);
  }
}

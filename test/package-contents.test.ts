import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * The published tarball holds only the allowlist: built JavaScript, the manifest, the README, and the
 * license (npm adds package.json). Runs `npm pack --dry-run`, so it reflects `files` in package.json.
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const FIXED = new Set(["package.json", "README.md", "LICENSE", "openclaw.plugin.json"]);
const DIST_ENTRIES = ["dist/plugin.js", "dist/provider-discovery.js"];

const allowed = (path: string) => FIXED.has(path) || /^dist\/.+\.js$/.test(path);

function packedPaths(): string[] {
  const run = spawnSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
    cwd: ROOT,
    encoding: "utf8",
  });
  if (run.status !== 0) throw new Error(`npm pack --dry-run failed (${run.status}): ${run.stderr}`);
  const report = JSON.parse(run.stdout) as Array<{ files: Array<{ path: string }> }>;
  return (report[0]?.files ?? []).map((file) => file.path.split("\\").join("/"));
}

describe("package contents", () => {
  const paths = packedPaths();

  it("packs only allowlisted paths", () => {
    const extra = paths.filter((path) => !allowed(path));
    expect(extra, `outside the allowlist: ${extra.join(", ")}`).toEqual([]);
  });

  it("packs the fixed files", () => {
    for (const path of FIXED) expect(paths, `missing ${path}`).toContain(path);
  });

  it.runIf(existsSync(join(ROOT, "dist")))("packs both dist entry files when dist/ exists", () => {
    for (const path of DIST_ENTRIES) expect(paths, `missing ${path}`).toContain(path);
  });
});

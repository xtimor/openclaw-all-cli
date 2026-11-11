import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * ClawHub accepts a code plugin only with `openclaw.compat.pluginApi` and `openclaw.build.openclawVersion` in
 * package.json, and takes at most one catalog category from the manifest (ticket 3.30). CI also runs ClawHub's own
 * validate and dry-run publish on the packed tarball (`.github/workflows/ci.yml`, job `clawhub`); a release publishes
 * the same tarball with the same pinned CLI (`scripts/release.sh`, ticket 3.31).
 */

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const read = (path: string) => readFileSync(join(ROOT, path), "utf8");
const pkg = JSON.parse(read("package.json"));
const manifest = JSON.parse(read("openclaw.plugin.json"));

describe("ClawHub package metadata", () => {
  it("declares the plugin API range and the OpenClaw version it was built against", () => {
    expect(pkg.openclaw?.compat?.pluginApi).toMatch(/^>=\d{4}\.\d+\.\d+/);
    expect(pkg.openclaw?.build?.openclawVersion).toMatch(/^\d{4}\.\d+\.\d+$/);
  });

  it("names the OpenClaw version CI and the dev scripts actually test against", () => {
    const built = pkg.openclaw.build.openclawVersion;
    const pinned = (workflow: string) => read(workflow).match(/^\s*OPENCLAW_VERSION:\s*(\S+)\s*$/m)?.[1];
    // CI tests this version; the release run builds, tests, and publishes the tarball under its own copy.
    expect(pinned(".github/workflows/ci.yml")).toBe(built);
    expect(pinned(".github/workflows/release.yml")).toBe(built);
    expect(read("scripts/dev-openclaw.sh")).toContain(`OPENCLAW_VERSION="\${OPENCLAW_VERSION:-${built}}"`);
  });

  it("runs ClawHub's CLI in CI at an exact version", () => {
    const ci = read(".github/workflows/ci.yml");
    expect(ci).toMatch(/^\s*CLAWHUB_VERSION:\s*\d+\.\d+\.\d+\s*$/m);
    expect(ci).toContain('npx --yes "clawhub@${CLAWHUB_VERSION}" package validate');
    expect(ci).toContain('npx --yes "clawhub@${CLAWHUB_VERSION}" package publish "$PWD"/');
  });

  it("pins the same clawhub CLI version in CI, the release workflow, and the release script", () => {
    // ci.yml checks the package with this CLI; scripts/release.sh publishes with it (ticket 3.31).
    const pinned = (path: string) => read(path).match(/^\s*CLAWHUB_VERSION:\s*(\S+)\s*$/m)?.[1];
    const ci = pinned(".github/workflows/ci.yml");
    expect(ci).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pinned(".github/workflows/release.yml")).toBe(ci);
    expect(read("scripts/release.sh")).toContain(`CLAWHUB_VERSION="\${CLAWHUB_VERSION:-${ci}}"`);
  });

  it("declares exactly one ClawHub catalog category: models", () => {
    expect(manifest.categories).toEqual(["models"]);
  });
});

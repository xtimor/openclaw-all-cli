import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Issue #80: current OpenClaw refuses `plugins update` while the Gateway runs, so the Update docs give two paths.

const FORCE_INSTALL = /install openclaw-all-cli --accept-capabilities --force/;

/** The text between a heading and the next heading of the same level. */
function section(file: string, heading: string): string {
  const text = readFileSync(file, "utf8");
  const start = text.indexOf(`\n${heading}\n`);
  if (start < 0) throw new Error(`no section ${heading} in ${file}`);
  const rest = text.slice(start + heading.length + 2);
  const level = heading.match(/^#+/)?.[0].length ?? 2;
  const end = rest.search(new RegExp(`\\n#{1,${level}} `));
  return end < 0 ? rest : rest.slice(0, end);
}

for (const file of ["README.md", "docs/setup.md"]) {
  it(`${file} does not say a running Gateway is refreshed by plugins update`, () => {
    const text = readFileSync(file, "utf8");
    expect(text).not.toMatch(/running local Gateway is refreshed by the update/i);
  });
}

it("README Update section gives a path that works with the Gateway running or stopped", () => {
  const text = readFileSync("README.md", "utf8");
  const update = text.slice(text.indexOf("## Update"), text.indexOf("## Status"));
  expect(update).toMatch(/gateway stop|stop the gateway/i);
  expect(update).toMatch(/install openclaw-all-cli --accept-capabilities --force/);
});

for (const [file, heading] of [
  ["README.md", "## Update"],
  ["docs/setup.md", "## 2. Install the plugin"],
] as const) {
  it(`${file} gives both update paths for a running or stopped Gateway and names the 2026.10.3 exception`, () => {
    const text = section(file, heading);
    expect(text).toMatch(FORCE_INSTALL);
    expect(text).toMatch(/openclaw gateway stop/);
    expect(text).toMatch(/Docker Compose/);
    expect(text).toMatch(/openclaw plugins update openclaw-all-cli/);
    expect(text).toMatch(/2026\.10\.3 still accepts `plugins update` with the Gateway running/);
  });
}

it("CHANGELOG.md lists the Gateway update docs fix under Unreleased with issue 80", () => {
  const unreleased = section("CHANGELOG.md", "## Unreleased");
  expect(unreleased).toMatch(/issues\/80\)/);
});

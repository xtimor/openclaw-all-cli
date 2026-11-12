import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

// Issue #80: current OpenClaw refuses `plugins update` while the Gateway runs, so the Update docs give two paths.
// The reinstall path installs from ClawHub (ticket 3.32); `--force` replaces the existing install.

const FORCE_INSTALL = /install clawhub:openclaw-all-cli --accept-capabilities --force/;

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
  expect(update).toMatch(FORCE_INSTALL);
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

// Ticket 3.32: the docs lead with the ClawHub install and keep npm as the fallback. Measured on OpenClaw 2026.11.3:
// a ClawHub install needs `--accept-capabilities` but no `--force`; an npm install still needs `--force`.
const CLAWHUB = "openclaw plugins install clawhub:openclaw-all-cli --accept-capabilities\n";
const NPM = "openclaw plugins install openclaw-all-cli --accept-capabilities --force\n";

for (const [file, heading] of [
  ["README.md", "## Install"],
  ["docs/setup.md", "## 2. Install the plugin"],
] as const) {
  it(`${file} gives the ClawHub install first and the npm install second`, () => {
    const text = section(file, heading);
    expect(text).toContain(CLAWHUB);
    expect(text).toContain(NPM);
    expect(text.indexOf(CLAWHUB)).toBeLessThan(text.indexOf(NPM));
  });

  it(`${file} names the ClawHub security audit shown before the install`, () => {
    expect(section(file, heading)).toMatch(/security audit/);
  });
}

it("docs/setup.md says how an npm install moves to ClawHub", () => {
  expect(section("docs/setup.md", "## 2. Install the plugin")).toMatch(/Moving from npm to ClawHub/);
});

it("docs/setup.md no longer says provenance-invalid is seen for the npm install", () => {
  expect(readFileSync("docs/setup.md", "utf8")).not.toMatch(/seen for the npm install too/);
});

// Not pinned to Unreleased: a release stamps the line into its version section.
it("CHANGELOG.md lists the Gateway update docs fix with issue 80", () => {
  const changelog = readFileSync("CHANGELOG.md", "utf8");
  expect(changelog).toMatch(/plugins update.*issues\/80\)/);
});

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { HOST_DIST, hostAvailable } from "./fixtures/host-code.js";

// Backlog bug 14 (issue #39): no plugin-side stop-gap for "Not configured" on the provider card in OpenClaw
// 2026.10.3. These tests pin the host facts that decision rests on, and that the limit is documented.
const read = (url: string) => readFileSync(new URL(url, import.meta.url), "utf8");
const hostFile = (prefix: string, contains: string, dir = HOST_DIST) => {
  const sources = readdirSync(dir)
    .filter((name) => name.startsWith(prefix) && /\.m?js$/.test(name))
    .map((name) => readFileSync(join(dir, name), "utf8"))
    .filter((source) => source.includes(contains));
  expect(sources, `${prefix} holding ${contains}`).toHaveLength(1);
  return sources[0]!;
};

describe.skipIf(!hostAvailable)("what the provider card reads (OpenClaw host)", () => {
  it("honors manifest nonSecretAuthMarkers for bundled plugins only", () => {
    expect(hostFile("model-auth-markers-", "nonSecretAuthMarkers")).toMatch(/plugin\.origin === "bundled" \? normalizeTrimmedStringList\(plugin\.manifest\.nonSecretAuthMarkers\)/);
  });

  it("derives the credential summary from config keys, env keys, and profiles, not from synthetic auth", () => {
    const source = hostFile("models-auth-status-", "function resolveProviderApiKeys(");
    expect(source).toMatch(/apiKeys\.set\(provider, \{ source: "config" \}\)/);
    expect(source).toMatch(/resolveProviderEnvAuthEvidence\(provider, process\.env/);
    expect(source).not.toMatch(/syntheticAuth/);
  });

  it("draws 'Not configured' when there is no profile, config key, or env key", () => {
    expect(hostFile("en-settings-", "Not configured", join(HOST_DIST, "control-ui", "assets"))).toContain("none:`Not configured`");
  });
});

describe("the documented limit", () => {
  it("is in docs/setup.md and CHANGELOG.md with the upstream issue", () => {
    for (const text of [read("../docs/setup.md"), read("../CHANGELOG.md")]) {
      expect(text).toContain("Not configured");
      expect(text).toContain("openclaw/openclaw#184700");
    }
    expect(read("../CHANGELOG.md")).toContain("issues/39");
  });

  it("writes no key-like value for the card: the login method stores nothing", () => {
    const manifest = JSON.parse(read("../openclaw.plugin.json"));
    expect(JSON.stringify(manifest.providerAuthChoices)).not.toMatch(/apiKey|sk-|key_/i);
  });
});

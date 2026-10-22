import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const backends: string[] = manifest.cliBackends;
const hints: Record<string, Record<string, unknown>> = manifest.uiHints;
const sectionOf = (backend: string) => manifest.configSchema.properties[backend];

// The config schema has one section per backend (`buildConfigJsonSchema`), so every backend needs its own hints.
describe.each(backends)("settings form hints (uiHints) for %s", (backend) => {
  const section = sectionOf(backend);

  it("gives every field a label and help", () => {
    const paths = [backend, ...Object.keys(section.properties).map((key) => `${backend}.${key}`), `${backend}.env.*`];
    for (const path of paths) {
      const hint = hints[path];
      expect(hint, path).toBeDefined();
      expect(typeof hint?.label === "string" && hint.label !== "", path).toBe(true);
      expect(typeof hint?.help === "string" && hint.help !== "", path).toBe(true);
    }
  });

  it("marks every env value sensitive, not the map itself", () => {
    // The host redacts a map value when `<map>.*` is sensitive; a sensitive map would collapse into one sentinel.
    expect(hints[`${backend}.env.*`]?.sensitive).toBe(true);
    expect(hints[`${backend}.env`]?.sensitive).not.toBe(true);
  });

  it("puts the limits under advanced", () => {
    expect(hints[`${backend}.maxConcurrentTurns`]?.advanced).toBe(true);
    expect(hints[`${backend}.maxProcesses`]?.advanced).toBe(true);
    expect(hints[`${backend}.command`]?.advanced).not.toBe(true);
  });
});

describe("settings form hints (uiHints)", () => {
  it("names only paths the schema has", () => {
    for (const path of Object.keys(hints)) {
      const [root = "", key, rest, ...extra] = path.split(".");
      expect(extra, path).toEqual([]);
      expect(Object.hasOwn(manifest.configSchema.properties, root), path).toBe(true);
      if (key === undefined) continue;
      const section = sectionOf(root);
      expect(Object.hasOwn(section.properties, key), path).toBe(true);
      if (rest !== undefined) {
        expect(rest, path).toBe("*");
        expect(section.properties[key].additionalProperties, path).toBeDefined();
      }
    }
  });
});

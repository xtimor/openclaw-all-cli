import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const manifest = JSON.parse(readFileSync(new URL("../openclaw.plugin.json", import.meta.url), "utf8"));
const section = manifest.configSchema.properties["cursor-cli"];
const hints: Record<string, Record<string, unknown>> = manifest.uiHints;

describe("settings form hints (uiHints)", () => {
  it("gives every cursor-cli field a label and help", () => {
    const paths = ["cursor-cli", ...Object.keys(section.properties).map((key) => `cursor-cli.${key}`)];
    for (const path of paths) {
      const hint = hints[path];
      expect(hint, path).toBeDefined();
      expect(typeof hint?.label === "string" && hint.label !== "", path).toBe(true);
      expect(typeof hint?.help === "string" && hint.help !== "", path).toBe(true);
    }
  });

  it("marks every env value sensitive, not the map itself", () => {
    // The host redacts a map value when `<map>.*` is sensitive; a sensitive map would collapse into one sentinel.
    expect(hints["cursor-cli.env.*"]?.sensitive).toBe(true);
    expect(hints["cursor-cli.env"]?.sensitive).not.toBe(true);
  });

  it("puts the limits under advanced", () => {
    expect(hints["cursor-cli.maxConcurrentTurns"]?.advanced).toBe(true);
    expect(hints["cursor-cli.maxProcesses"]?.advanced).toBe(true);
    expect(hints["cursor-cli.command"]?.advanced).not.toBe(true);
  });

  it("names only paths the schema has", () => {
    for (const path of Object.keys(hints)) {
      const [root, key, rest] = path.split(".");
      expect(root, path).toBe("cursor-cli");
      if (key === undefined) continue;
      expect(section.properties[key], path).toBeDefined();
      if (rest !== undefined) {
        expect(rest, path).toBe("*");
        expect(section.properties[key].additionalProperties, path).toBeDefined();
      }
    }
  });
});

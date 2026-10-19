import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema, buildConfigSchema, capsOf, readBackendConfig } from "./config.ts";

describe("config", () => {
  it("accepts a command per backend and rejects unknown keys", () => {
    const schema = buildConfigSchema(["acme-cli"]);
    expect(schema.safeParse({ "acme-cli": { command: "/bin/acme" } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ "acme-cli": { command: "" } }).success).toBe(false);
    expect(schema.safeParse({ "acme-cli": { extra: 1 } }).success).toBe(false);
    expect(schema.safeParse({ other: {} }).success).toBe(false);
  });

  it("accepts an env of strings for the CLI process and rejects other values", () => {
    expect(readBackendConfig({ "acme-cli": { env: { ACME_KEY: "k" } } }, "acme-cli", () => {})).toEqual({ env: { ACME_KEY: "k" } });
    const warnings: string[] = [];
    expect(readBackendConfig({ "acme-cli": { env: { ACME_KEY: 5 } } }, "acme-cli", (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(1);
  });

  it("falls back to defaults and warns on invalid settings", () => {
    const warnings: string[] = [];
    expect(readBackendConfig({ "acme-cli": { command: 5 } }, "acme-cli", (m) => warnings.push(m))).toEqual({});
    expect(warnings).toHaveLength(1);
    expect(readBackendConfig(undefined, "acme-cli", () => {})).toEqual({});
    expect(readBackendConfig({ "acme-cli": { command: "x" } }, "acme-cli", () => {})).toEqual({ command: "x" });
  });

  it("matches the manifest's configSchema", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.configSchema).toEqual(buildConfigJsonSchema(manifest.cliBackends));
  });

  describe("caps", () => {
    const valid = [{}, { maxConcurrentTurns: 1 }, { maxConcurrentTurns: 4, maxProcesses: 4 }, { maxConcurrentTurns: 64, maxProcesses: 64 }, { maxProcesses: 64 }];
    it.each(valid)("accepts %j", (settings) => {
      expect(buildConfigSchema(["acme-cli"]).safeParse({ "acme-cli": settings }).success).toBe(true);
    });

    const invalid = [
      { maxConcurrentTurns: 0 },
      { maxConcurrentTurns: 65 },
      { maxProcesses: 0 },
      { maxProcesses: 65 },
      { maxConcurrentTurns: 1.5 },
      { maxConcurrentTurns: "4" },
      { maxConcurrentTurns: 5, maxProcesses: 4 },
      // The default of 8 processes is below 9 turns.
      { maxConcurrentTurns: 9 },
      // The default of 4 turns is above 3 processes.
      { maxProcesses: 3 },
    ];
    it.each(invalid)("rejects %j and falls back to the defaults with a warning", (settings) => {
      expect(buildConfigSchema(["acme-cli"]).safeParse({ "acme-cli": settings }).success).toBe(false);
      const warnings: string[] = [];
      const read = readBackendConfig({ "acme-cli": settings }, "acme-cli", (m) => warnings.push(m));
      expect(read).toEqual({});
      expect(warnings).toHaveLength(1);
      expect(capsOf(read)).toEqual({ maxTurns: 4, maxProcesses: 8 });
    });

    it("keeps the command and resets only the caps when only the caps are at fault", () => {
      const warnings: string[] = [];
      const read = readBackendConfig(
        { "acme-cli": { command: "/opt/acme", maxConcurrentTurns: 6, maxProcesses: 2 } },
        "acme-cli",
        (m) => warnings.push(m),
      );
      expect(read).toEqual({ command: "/opt/acme" });
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toMatch(/caps/);
      expect(capsOf(read)).toEqual({ maxTurns: 4, maxProcesses: 8 });
      // An out-of-range cap is handled the same when it reaches the plugin.
      expect(readBackendConfig({ "acme-cli": { command: "x", maxProcesses: 99 } }, "acme-cli", () => {})).toEqual({ command: "x" });
    });

    it("drops everything when something other than the caps is invalid too", () => {
      expect(readBackendConfig({ "acme-cli": { command: 5, maxProcesses: 99 } }, "acme-cli", () => {})).toEqual({});
    });

    it("resolves the caps from the settings, with defaults of 4 turns and 8 processes", () => {
      expect(capsOf({})).toEqual({ maxTurns: 4, maxProcesses: 8 });
      expect(capsOf({ maxConcurrentTurns: 2 })).toEqual({ maxTurns: 2, maxProcesses: 8 });
      expect(capsOf({ maxConcurrentTurns: 3, maxProcesses: 5 })).toEqual({ maxTurns: 3, maxProcesses: 5 });
    });
  });
});

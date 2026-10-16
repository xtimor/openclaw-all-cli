import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildConfigJsonSchema, buildConfigSchema, readBackendConfig } from "./config.ts";

describe("config", () => {
  it("accepts a command per backend and rejects unknown keys", () => {
    const schema = buildConfigSchema(["acme-cli"]);
    expect(schema.safeParse({ "acme-cli": { command: "/bin/acme" } }).success).toBe(true);
    expect(schema.safeParse({}).success).toBe(true);
    expect(schema.safeParse({ "acme-cli": { command: "" } }).success).toBe(false);
    expect(schema.safeParse({ "acme-cli": { extra: 1 } }).success).toBe(false);
    expect(schema.safeParse({ other: {} }).success).toBe(false);
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
});

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTurnTarget, SETTINGS_PATH_ENV } from "./mcp-target.ts";

describe("readTurnTarget", () => {
  const dir = mkdtempSync(join(tmpdir(), "oac-target-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return { [SETTINGS_PATH_ENV]: file };
  };
  const openclaw = (server: Record<string, unknown>) => ({ mcp: { allowed: ["openclaw"] }, mcpServers: { openclaw: server } });

  it("reads the url and headers of mcpServers.openclaw", async () => {
    const env = write(
      "ok.json",
      openclaw({
        type: "http",
        url: "http://127.0.0.1:4711/mcp",
        headers: { Authorization: "Bearer t", "x-openclaw-cli-capture-key": "k", bad: 1 },
      }),
    );
    await expect(readTurnTarget(env)).resolves.toEqual({
      ok: true,
      target: {
        url: "http://127.0.0.1:4711/mcp",
        headers: { Authorization: "Bearer t", "x-openclaw-cli-capture-key": "k" },
      },
    });
  });

  it("accepts httpUrl", async () => {
    const env = write("http-url.json", openclaw({ httpUrl: "http://127.0.0.1:1/mcp" }));
    await expect(readTurnTarget(env)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:1/mcp", headers: {} } });
  });

  it.each(["", "   "])("falls back to url when httpUrl is blank (%j)", async (blank) => {
    const env = write(`blank-${blank.length}.json`, openclaw({ httpUrl: blank, url: "http://127.0.0.1:2/mcp" }));
    await expect(readTurnTarget(env)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:2/mcp" } });
  });

  it("prefers httpUrl over url when both are set", async () => {
    const env = write("both.json", openclaw({ httpUrl: "http://127.0.0.1:3/mcp", url: "http://127.0.0.1:4/mcp" }));
    await expect(readTurnTarget(env)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:3/mcp" } });
  });

  it.each([
    ["the variable unset", {}],
    ["the variable empty", { [SETTINGS_PATH_ENV]: " " }],
    ["a missing file", { [SETTINGS_PATH_ENV]: "/nonexistent/settings.json" }],
  ])("fails without throwing for %s", async (_name, env) => {
    await expect(readTurnTarget(env)).resolves.toMatchObject({ ok: false });
  });

  it.each([
    ["invalid JSON", "{nope"],
    ["no mcpServers", {}],
    ["no openclaw server", { mcpServers: { other: { url: "http://127.0.0.1:1/mcp" } } }],
    ["no url", openclaw({ headers: {} })],
    ["a non-URL", openclaw({ url: "not a url" })],
    ["a remote host", openclaw({ url: "http://example.com/mcp", headers: { Authorization: "Bearer secret-token" } })],
    ["https", openclaw({ url: "https://127.0.0.1:1/mcp" })],
  ])("fails for %s and never echoes a header value", async (name, value) => {
    const result = await readTurnTarget(write(`bad-${name.replaceAll(" ", "-")}.json`, value));
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-token");
  });
});

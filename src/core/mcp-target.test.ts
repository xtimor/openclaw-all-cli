import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { readTurnTarget, splitMcpArgs } from "./mcp-target.ts";

describe("readTurnTarget", () => {
  const dir = mkdtempSync(join(tmpdir(), "oac-target-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));
  const write = (name: string, value: unknown) => {
    const file = join(dir, name);
    writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
    return file;
  };
  const openclaw = (server: Record<string, unknown>) => ({ mcp: { allowed: ["openclaw"] }, mcpServers: { openclaw: server } });

  it("reads the url and headers of mcpServers.openclaw", async () => {
    const file = write(
      "ok.json",
      openclaw({
        type: "http",
        url: "http://127.0.0.1:4711/mcp",
        headers: { Authorization: "Bearer t", "x-openclaw-cli-capture-key": "k", bad: 1 },
      }),
    );
    await expect(readTurnTarget(file)).resolves.toEqual({
      ok: true,
      target: {
        url: "http://127.0.0.1:4711/mcp",
        headers: { Authorization: "Bearer t", "x-openclaw-cli-capture-key": "k" },
      },
    });
  });

  it("accepts httpUrl", async () => {
    const file = write("http-url.json", openclaw({ httpUrl: "http://127.0.0.1:1/mcp" }));
    await expect(readTurnTarget(file)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:1/mcp", headers: {} } });
  });

  it.each(["", "   "])("falls back to url when httpUrl is blank (%j)", async (blank) => {
    const file = write(`blank-${blank.length}.json`, openclaw({ httpUrl: blank, url: "http://127.0.0.1:2/mcp" }));
    await expect(readTurnTarget(file)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:2/mcp" } });
  });

  it.each([
    ["invalid", "not a url"],
    ["remote", "http://example.com/mcp"],
    ["https", "https://127.0.0.1:1/mcp"],
  ])("falls back to url when httpUrl is %s", async (name, httpUrl) => {
    const file = write(`bad-http-${name}.json`, openclaw({ httpUrl, url: "http://127.0.0.1:5/mcp" }));
    await expect(readTurnTarget(file)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:5/mcp" } });
  });

  it("prefers httpUrl over url when both are set", async () => {
    const file = write("both.json", openclaw({ httpUrl: "http://127.0.0.1:3/mcp", url: "http://127.0.0.1:4/mcp" }));
    await expect(readTurnTarget(file)).resolves.toMatchObject({ ok: true, target: { url: "http://127.0.0.1:3/mcp" } });
  });

  it.each([
    ["no path", undefined],
    ["an empty path", ""],
    ["a missing file", "/nonexistent/mcp.json"],
  ])("fails without throwing for %s", async (_name, path) => {
    await expect(readTurnTarget(path)).resolves.toMatchObject({ ok: false });
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

describe("splitMcpArgs", () => {
  it("takes the host's MCP flags out of the launch args and returns the config path", () => {
    expect(splitMcpArgs(["acp", "--strict-mcp-config", "--mcp-config", "/tmp/a/mcp.json", "--disallowedTools", "WebSearch,mcp__openclaw__x", "--keep"])).toEqual({
      args: ["acp", "--keep"],
      mcpConfigPath: "/tmp/a/mcp.json",
    });
  });

  it.each([
    ["the = spelling", ["acp", "--mcp-config=/tmp/b/mcp.json", "--disallowed-tools=WebSearch"]],
    ["a flag after the value", ["acp", "--mcp-config", "/tmp/b/mcp.json", "--strict-mcp-config", "--disallowed-tools", "WebSearch"]],
  ])("handles %s", (_name, args) => {
    expect(splitMcpArgs(args)).toEqual({ args: ["acp"], mcpConfigPath: "/tmp/b/mcp.json" });
  });

  it("reads every value of a variadic flag but returns the first path, and keeps args that follow a non-flag", () => {
    expect(splitMcpArgs(["acp", "--mcp-config", "/tmp/one.json", "/tmp/two.json", "--model", "x"])).toEqual({
      args: ["acp", "--model", "x"],
      mcpConfigPath: "/tmp/one.json",
    });
  });

  it("returns no path and the same args when the host added nothing", () => {
    expect(splitMcpArgs(["acp"])).toEqual({ args: ["acp"], mcpConfigPath: undefined });
    expect(splitMcpArgs(["acp", "--mcp-config"])).toEqual({ args: ["acp"], mcpConfigPath: undefined });
    expect(splitMcpArgs(["acp", "--mcp-config="])).toEqual({ args: ["acp"], mcpConfigPath: undefined });
  });
});

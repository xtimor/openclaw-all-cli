import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import type { CliSession, NormalizedEvent } from "../../core/ports.ts";
import { PARITY_ROWS } from "../../core/ports.ts";
import { cursorAdapter, parseStatusOutput } from "./index.ts";
import { cursorManifest } from "./manifest.ts";

const open: CliSession[] = [];
afterEach(async () => {
  await Promise.all(open.splice(0).map((session) => session.close()));
});

describe("cursor adapter", () => {
  it("reads cursor-agent status output", () => {
    expect(parseStatusOutput("Logged in as me@example.com")).toBe("available");
    expect(parseStatusOutput("Logged in (unable to fetch user details)")).toBe("available");
    expect(parseStatusOutput("Not logged in")).toBe("missing");
    expect(parseStatusOutput("You are not currently logged in")).toBe("missing");
    expect(parseStatusOutput("You have been logged out")).toBe("missing");
    expect(parseStatusOutput("Not authenticated. Run cursor-agent login")).toBe("missing");
    expect(parseStatusOutput("Signed out")).toBe("missing");
    expect(parseStatusOutput("something else")).toBe("unreadable");
  });

  it("probes the login through `status`", async () => {
    const probe = (extra: Record<string, string>) =>
      cursorAdapter.probeAuth({ command: FAKE_CURSOR_AGENT, env: fakeEnv(extra) });
    await expect(probe({})).resolves.toBe("available");
    await expect(probe({ FAKE_CURSOR_LOGGED_IN: "0" })).resolves.toBe("missing");
    await expect(
      cursorAdapter.probeAuth({ command: "/nonexistent/cursor-agent", env: fakeEnv() }),
    ).resolves.toBe("missing");
  });

  it("accepts CURSOR_API_KEY as a login without running the CLI", async () => {
    await expect(
      cursorAdapter.probeAuth({ command: "/nonexistent/cursor-agent", env: { CURSOR_API_KEY: "key" } }),
    ).resolves.toBe("available");
  });

  it("opens a read-only ACP session and answers a turn", async () => {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "auto",
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt("say:hi")) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "hi" });
  });

  it("selects a named model and leaves `auto` to Cursor", async () => {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "fake-fast",
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt("hello")) events.push(event);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: expect.stringContaining("model fake-fast") });
  });

  it("sends no model change for cursor-cli/auto, even when the session starts on another model", async () => {
    const dir = mkdtempSync(join(tmpdir(), "oac-cursor-"));
    try {
      const file = join(dir, "requests.jsonl");
      const session = await cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_LOG: file, FAKE_CURSOR_DEFAULT_MODEL: "fake-fast" }),
        modelId: "auto",
        onPermissionRequest: async () => "reject_once",
      });
      open.push(session);
      const methods = readFileSync(file, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).method);
      expect(methods).not.toContain("session/set_config_option");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("refuses to run without Cursor's read-only mode", async () => {
    await expect(
      cursorAdapter.open({
        command: FAKE_CURSOR_AGENT,
        args: cursorAdapter.launchArgs,
        cwd: process.cwd(),
        env: fakeEnv({ FAKE_CURSOR_NO_ASK_MODE: "1" }),
        modelId: "auto",
        onPermissionRequest: async () => "reject_once",
      }),
    ).rejects.toMatchObject({ code: "capability_mismatch" });
  });

  it("has a manifest row for every parity row", () => {
    expect(Object.keys(cursorManifest.rows)).toEqual([...PARITY_ROWS]);
    expect(cursorManifest.rows.P4.status).toBe("match");
    expect(cursorManifest.rows.P6.status).toBe("gap");
  });
});

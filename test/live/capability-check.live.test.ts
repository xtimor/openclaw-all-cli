import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT } from "../fixtures/paths.ts";
import { LIVE_TIMEOUT_MS, describeLive, openclaw, replyLines } from "./harness.ts";

// AD-10 with parity rows P5 (session resume) and P7 (HTTP MCP): the core fails a turn, before any chat or
// prompt, when the CLI does not report what the manifest needs. A fake `cursor-agent` that reports
// less drives the failure through the real OpenClaw; real Cursor must pass the same check.
// Run `npm run dev:install` first. The real turn needs a Cursor login or CURSOR_API_KEY.
describeLive("capability check at open (AD-10, P5, P7)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-caps-"));
  const CONFIG_COMMAND = "plugins.entries.openclaw-all-cli.config.cursor-cli.command";
  const stamp = Date.now();

  afterAll(() => {
    openclaw(["config", "unset", CONFIG_COMMAND]);
    rmSync(root, { recursive: true, force: true });
  });

  /** A shim that runs the fake agent with the capabilities it reports and a request log. */
  function fakeShim(name: string, caps: object, log: string): string {
    const file = join(root, name);
    writeFileSync(
      file,
      `#!/bin/sh\nexport FAKE_CURSOR_CAPS='${JSON.stringify(caps)}'\nexport FAKE_CURSOR_LOG="${log}"\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`,
    );
    chmodSync(file, 0o755);
    return file;
  }

  const methods = (log: string): string[] =>
    existsSync(log)
      ? readFileSync(log, "utf8")
          .trim()
          .split("\n")
          .map((line) => (JSON.parse(line) as { method: string }).method)
      : [];

  function turnWith(name: string, caps: object) {
    const log = join(root, `${name}.jsonl`);
    expect(openclaw(["config", "set", CONFIG_COMMAND, fakeShim(name, caps, log)]).status).toBe(0);
    // A fresh session id every run: no stored binding to resume.
    const run = openclaw(
      ["agent", "--local", "--model", "cursor-cli/auto", "--session-id", `live-caps-${name}-${stamp}`, "--message", "Say hi"],
      { timeoutMs: 240_000 },
    );
    return { output: run.stdout + run.stderr, log };
  }

  it("fails the turn naming P7, before any prompt, when the CLI reports no HTTP MCP", () => {
    const { output, log } = turnWith("no-http", { mcpCapabilities: { http: false } });
    expect(output).toContain("Capability mismatch");
    expect(output).toContain("P7");
    // The transport fails right after the handshake: no chat is created.
    expect(methods(log)).not.toContain("session/new");
    expect(methods(log)).not.toContain("session/prompt");
  }, LIVE_TIMEOUT_MS);

  it("fails the turn naming P5, before any prompt, when the CLI reports no session load", () => {
    const { output, log } = turnWith("no-load", { loadSession: false });
    expect(output).toContain("Capability mismatch");
    expect(output).toContain("P5");
    expect(methods(log)).not.toContain("session/new");
    expect(methods(log)).not.toContain("session/prompt");
  }, LIVE_TIMEOUT_MS);

  it("lets real cursor-agent through the check and answers", () => {
    expect(openclaw(["config", "unset", CONFIG_COMMAND]).status).toBe(0);
    const run = openclaw(
      ["agent", "--local", "--model", "cursor-cli/auto", "--session-id", `live-caps-real-${stamp}`, "--message", "Say hi"],
      { timeoutMs: 240_000 },
    );
    expect(run.status).toBe(0);
    expect(run.stderr + run.stdout).not.toMatch(/Capability mismatch/);
    expect(replyLines(run.stdout).length).toBeGreaterThan(0);
  }, LIVE_TIMEOUT_MS);
});

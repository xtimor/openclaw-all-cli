import { execFile, spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { CURSOR_MANAGED_INSTALL } from "../src/adapters/cursor/install.ts";
import { matchTurnEvents } from "../src/adapters/cursor/usage.ts";
// @ts-expect-error -- a plain .mjs script, no types
import { VERIFIED_FILE, checkDownload, installPinned, loadPin, pinnedPackage, platformKey } from "../scripts/install-cursor-agent.mjs";
// @ts-expect-error -- a plain .mjs script, no types
import { conversationsOf, sumRun } from "../scripts/live-tokens.mjs";
import { sha256, testPackage } from "./fixtures/package-stub.ts";

// The live regression tier's own parts (epic-regression-gate ticket 4.5), offline: the pinned install, the turn meter,
// the token sum, the tier's result fields, and the tier's first step without a key. The tier itself needs Cursor.
const ROOT = fileURLToPath(new URL("..", import.meta.url));
const METER = join(ROOT, "test", "live", "turn-meter.mjs");
const RESULT = join(ROOT, "scripts", "regression-result.mjs");
const REGRESSION = join(ROOT, "scripts", "regression.sh");

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) rmSync(dirs.pop()!, { recursive: true, force: true });
});
const tempDir = () => {
  const dir = mkdtempSync(join(tmpdir(), "oac-live-tier-"));
  dirs.push(dir);
  return dir;
};
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST"))) as Record<string, string>;
function exec(file: string, args: string[], env: Record<string, string>): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(file, args, { env, timeout: 20_000 }, (error, stdout, stderr) => done({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr }));
  });
}

describe("scripts/install-cursor-agent.mjs (the pinned cursor-agent for the live tier)", () => {
  const VERSION = "2026.11.11-test123";
  const pinFor = (pkg: Buffer, overrides: { sha?: string; bytes?: number } = {}) => ({
    version: VERSION,
    origin: "https://pkg.test",
    platforms: { "linux-x64": { url: "https://pkg.test/agent-cli-package.tar.gz", sha256: overrides.sha ?? sha256(pkg), bytes: overrides.bytes ?? pkg.length } },
    stripComponents: 1,
    launcher: "cursor-agent",
  });
  const fetchOf = (pkg: Buffer, calls: string[] = []) => async (url: string) => {
    calls.push(url);
    return new Response(new Uint8Array(pkg));
  };

  it("reads the pin from src/adapters/cursor/install.ts itself, not a copy", async () => {
    const pin = await loadPin();
    expect(pin).toEqual(CURSOR_MANAGED_INSTALL);
    expect(pinnedPackage(pin, "linux-x64")).toEqual({
      url: CURSOR_MANAGED_INSTALL.platforms["linux-x64"]!.url,
      sha256: CURSOR_MANAGED_INSTALL.platforms["linux-x64"]!.sha256,
      bytes: CURSOR_MANAGED_INSTALL.platforms["linux-x64"]!.bytes,
    });
    expect(platformKey("linux", "x64")).toBe("linux-x64");
  });

  it("refuses a platform with no pin and a package address off the pinned origin", () => {
    const pin = pinFor(Buffer.from("x"));
    expect(() => pinnedPackage(pin, "win32-x64")).toThrow(/no cursor-agent package is pinned for win32-x64/);
    const moved = { ...pin, platforms: { "linux-x64": { ...pin.platforms["linux-x64"], url: "https://elsewhere.test/p.tar.gz" } } };
    expect(() => pinnedPackage(moved, "linux-x64")).toThrow(/not an https address on https:\/\/pkg.test/);
  });

  it("installs the package whose sha256 matches, checks the launcher's version, and reuses a verified install", async () => {
    const pkg = testPackage({ version: VERSION, launcher: "cursor-agent" });
    const dir = tempDir();
    const calls: string[] = [];
    const launcher = await installPinned({ dir, pin: pinFor(pkg), platform: "linux-x64", fetch: fetchOf(pkg, calls), log: () => {} });
    expect(launcher).toBe(join(dir, VERSION, "cursor-agent"));
    expect(readFileSync(join(dir, VERSION, VERIFIED_FILE), "utf8").trim()).toBe(sha256(pkg));
    expect(existsSync(join(dir, VERSION, "lib", "data.txt"))).toBe(true);
    expect(calls).toHaveLength(1);
    expect(await installPinned({ dir, pin: pinFor(pkg), platform: "linux-x64", fetch: fetchOf(pkg, calls), log: () => {} })).toBe(launcher);
    expect(calls).toHaveLength(1);
  });

  it("fails on a sha256 or size mismatch and unpacks nothing", async () => {
    const pkg = testPackage({ version: VERSION, launcher: "cursor-agent" });
    const dir = tempDir();
    await expect(installPinned({ dir, pin: pinFor(pkg, { sha: "0".repeat(64) }), platform: "linux-x64", fetch: fetchOf(pkg), log: () => {} })).rejects.toThrow(
      /sha256 mismatch: the pin has 0{64}, the download [0-9a-f]{64}; nothing was unpacked/,
    );
    expect(existsSync(join(dir, VERSION))).toBe(false);
    await expect(installPinned({ dir, pin: pinFor(pkg, { bytes: pkg.length + 10 }), platform: "linux-x64", fetch: fetchOf(pkg), log: () => {} })).rejects.toThrow(/size mismatch/);
    await expect(installPinned({ dir, pin: pinFor(pkg, { bytes: pkg.length - 10 }), platform: "linux-x64", fetch: fetchOf(pkg), log: () => {} })).rejects.toThrow(/larger than the pinned/);
    expect(existsSync(join(dir, VERSION))).toBe(false);
    expect(() => checkDownload({ bytes: 3, sha256: "b".repeat(64) }, { bytes: 3, sha256: "a".repeat(64) })).toThrow(/sha256 mismatch/);
  });

  it("fails when the unpacked launcher does not report the pinned version", async () => {
    const pkg = testPackage({ version: "1.0.0-other", launcher: "cursor-agent" });
    await expect(installPinned({ dir: tempDir(), pin: pinFor(pkg), platform: "linux-x64", fetch: fetchOf(pkg), log: () => {} })).rejects.toThrow(
      `does not report version ${VERSION}`,
    );
  });
});

describe("test/live/turn-meter.mjs (every live turn counted, none past the cap)", () => {
  /** A stand-in for cursor-agent: `--version`, and `acp` answering every request (a prompt ends `end_turn`). */
  function stubAgent(dir: string): string {
    const file = join(dir, "agent.mjs");
    writeFileSync(
      file,
      [
        "#!/usr/bin/env node",
        'if (process.argv.includes("--version")) { console.log("9.9.9-stub"); process.exit(0); }',
        'let buf = "";',
        'process.stdin.on("data", (chunk) => {',
        "  buf += chunk;",
        "  let end;",
        '  while ((end = buf.indexOf("\\n")) >= 0) {',
        "    const message = JSON.parse(buf.slice(0, end));",
        "    buf = buf.slice(end + 1);",
        '    if (message.method === "session/prompt") {',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", method: "session/update", params: { sessionId: message.params.sessionId } }) + "\\n");',
        '      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: { stopReason: "end_turn" } }) + "\\n");',
        '    } else if (message.id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }) + "\\n");',
        "  }",
        "});",
        "",
      ].join("\n"),
    );
    chmodSync(file, 0o755);
    return file;
  }

  async function acpRun(env: Record<string, string>, lines: object[]): Promise<{ out: any[]; code: number | null }> {
    const child = spawn(process.execPath, [METER, "acp"], { env: { ...cleanEnv(), ...env } });
    let stdout = "";
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    for (const line of lines) child.stdin.write(`${JSON.stringify(line)}\n`);
    // Every request gets one answer; then the client hangs up.
    const answers = lines.length;
    for (let n = 0; n < 200 && stdout.split("\n").filter((line) => line.includes('"id"')).length < answers; n += 1) await new Promise((resolve) => setTimeout(resolve, 25));
    child.stdin.end();
    const code = await new Promise<number | null>((resolve) => child.once("close", resolve));
    return { out: stdout.split("\n").filter(Boolean).map((line) => JSON.parse(line)), code };
  }

  it("passes the agent's lines through, logs each prompt and its answer, and refuses prompts past the cap", async () => {
    const dir = tempDir();
    const log = join(dir, "turns.jsonl");
    const env = { OAC_LIVE_REAL_AGENT: stubAgent(dir), OAC_LIVE_TURN_LOG: log, OAC_LIVE_TURN_CAP: "2" };
    const prompt = (id: number, sessionId: string) => ({ jsonrpc: "2.0", id, method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: "secret words" }] } });
    const first = await acpRun(env, [{ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }, prompt(2, "s-1")]);
    expect(first.code).toBe(0);
    expect(first.out.find((line) => line.id === 2)).toEqual({ jsonrpc: "2.0", id: 2, result: { stopReason: "end_turn" } });
    expect(first.out.some((line) => line.method === "session/update")).toBe(true);
    // A second process of the same run shares the count.
    const second = await acpRun(env, [prompt(1, "s-2"), prompt(2, "s-2")]);
    expect(second.out.find((line) => line.id === 1)?.result).toEqual({ stopReason: "end_turn" });
    expect(second.out.find((line) => line.id === 2)).toEqual({ jsonrpc: "2.0", id: 2, error: { code: -32603, message: "turn cap 2 reached" } });
    const entries = readFileSync(log, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const kinds = entries.map((entry) => [entry.kind, entry.sessionId]);
    expect(kinds.slice(0, 3)).toEqual([
      ["prompt", "s-1"],
      ["done", "s-1"],
      ["prompt", "s-2"],
    ]);
    // The refusal is written at once; the agent's answer to the counted prompt may come before or after it.
    expect(kinds.slice(3).sort()).toEqual([
      ["done", "s-2"],
      ["refused", "s-2"],
    ]);
    expect(entries.find((entry) => entry.kind === "done")?.stopReason).toBe("end_turn");
    // No prompt text in the log.
    expect(readFileSync(log, "utf8")).not.toContain("secret words");
  });

  it("runs anything but `acp` as the real launcher, unmetered", async () => {
    const dir = tempDir();
    const log = join(dir, "turns.jsonl");
    const result = await exec(process.execPath, [METER, "--version"], { ...cleanEnv(), OAC_LIVE_REAL_AGENT: stubAgent(dir), OAC_LIVE_TURN_LOG: log, OAC_LIVE_TURN_CAP: "1" });
    expect(result).toMatchObject({ code: 0, stdout: "9.9.9-stub\n" });
    expect(existsSync(log)).toBe(false);
  });
});

describe("scripts/live-tokens.mjs (the run's Cursor tokens)", () => {
  const log = (entries: object[]) => entries.map((entry) => JSON.stringify(entry)).join("\n");
  const SINCE = 1_000;
  const event = (conversationId: string, timestamp: number, tokens: Record<string, number>) => ({ conversationId, timestamp: String(timestamp), tokenUsage: tokens });

  it("sums only the run's conversations, from the run's start on", () => {
    const conversations = conversationsOf(
      log([
        { kind: "prompt", sessionId: "a" },
        { kind: "done", sessionId: "a", stopReason: "end_turn" },
        { kind: "prompt", sessionId: "b" },
        { kind: "done", sessionId: "b", stopReason: "end_turn" },
      ]),
    );
    const events = [
      event("a", 2_000, { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 }),
      event("a", 3_000, { inputTokens: 1, outputTokens: 1, cacheWriteTokens: 7 }),
      event("b", 2_500, { inputTokens: 3, outputTokens: 2 }),
      event("owner", 2_000, { inputTokens: 999_999 }),
      event("a", 500, { inputTokens: 999_999 }),
    ];
    expect(sumRun(events, conversations, SINCE, matchTurnEvents)).toEqual({
      input: 14,
      output: 8,
      cacheRead: 100,
      cacheWrite: 7,
      total: 129,
      conversations: 2,
      matched: 2,
      missing: 0,
      events: 3,
    });
  });

  it("gives an unknown total (null, never 0) while a finished turn's conversation has no event, or nothing matched", () => {
    const conversations = conversationsOf(
      log([
        { kind: "prompt", sessionId: "a" },
        { kind: "done", sessionId: "a", stopReason: "end_turn" },
        { kind: "prompt", sessionId: "late" },
        { kind: "done", sessionId: "late", stopReason: "end_turn" },
        { kind: "prompt", sessionId: "cut" },
        { kind: "done", sessionId: "cut", stopReason: "cancelled" },
        { kind: "refused", sessionId: "capped" },
      ]),
    );
    expect([...conversations.finished]).toEqual(["a", "late"]);
    const partial = sumRun([event("a", 2_000, { inputTokens: 10 })], conversations, SINCE, matchTurnEvents);
    expect(partial).toMatchObject({ input: 10, total: null, missing: 1, matched: 1, missingConversations: ["late"] });
    expect(sumRun([], conversations, SINCE, matchTurnEvents)).toMatchObject({ total: null, matched: 0 });
    const complete = sumRun([event("a", 2_000, { inputTokens: 10 }), event("late", 4_000, { outputTokens: 4 })], conversations, SINCE, matchTurnEvents);
    expect(complete).toMatchObject({ total: 14, missing: 0 });
  });

  it("does not expect a ledger event for a turn that ended inside a window a test marked unbilled", () => {
    const conversations = conversationsOf(
      log([
        { at: 1_000, kind: "prompt", sessionId: "a" },
        { at: 1_500, kind: "done", sessionId: "a", stopReason: "end_turn" },
        { at: 2_000, kind: "prompt", sessionId: "refused-host" },
        { at: 2_100, kind: "done", sessionId: "refused-host", stopReason: "end_turn" },
        { at: 2_200, kind: "unbilled", from: 1_900, to: 2_150 },
      ]),
    );
    expect([...conversations.all]).toEqual(["a", "refused-host"]);
    expect([...conversations.finished]).toEqual(["a"]);
  });
});

describe("scripts/regression-result.mjs --tier live (tries, turns, tokens)", () => {
  it("adds per-test tries, per-file results, retried tests, turns, the cap, tokens and measurements; failures carry their last message", async () => {
    const dir = tempDir();
    const report = join(dir, "r.vitest.json");
    writeFileSync(
      report,
      JSON.stringify({
        testResults: [
          // The report joins the titles with spaces; the tries reporter with " > " and keeps the message.
          { name: "/w/test/live/a.live.test.ts", status: "failed", message: "", assertionResults: [{ fullName: "group a red", status: "failed" }, { fullName: "group a flaky", status: "passed" }] },
          { name: "/w/test/live/b.live.test.ts", status: "passed", message: "", assertionResults: [{ fullName: "b green", status: "passed" }] },
          // A file the tries reporter never saw keeps the report's entry.
          { name: "/w/test/live/c.live.test.ts", status: "failed", message: "", assertionResults: [{ fullName: "c red", status: "failed" }] },
        ],
      }),
    );
    const tries = join(dir, "tries.json");
    writeFileSync(
      tries,
      JSON.stringify({
        tests: [
          { file: "test/live/a.live.test.ts", name: "group > a red", state: "failed", tries: 3, seconds: 30, message: "expected 1 to be 2" },
          { file: "test/live/a.live.test.ts", name: "group > a flaky", state: "passed", tries: 2, seconds: 20.5 },
          { file: "test/live/b.live.test.ts", name: "b green", state: "passed", tries: 1, seconds: 10 },
        ],
        fileErrors: [],
      }),
    );
    const turns = join(dir, "turns.jsonl");
    writeFileSync(turns, ['{"kind":"prompt","sessionId":"a"}', '{"kind":"done","sessionId":"a"}', '{"kind":"prompt","sessionId":"b"}', '{"kind":"refused","sessionId":"c"}', ""].join("\n"));
    const tokens = join(dir, "tokens.json");
    writeFileSync(tokens, JSON.stringify({ input: 1, output: 2, cacheRead: 3, cacheWrite: 4, total: 10, conversations: 2, matched: 2, missing: 0, events: 2 }));
    const measurements = join(dir, "m.jsonl");
    writeFileSync(measurements, '{"name":"first-reply-ms","value":21000}\n{"name":"first-reply-ms","value":25000}\nnot json\n');
    const out = join(dir, "result.json");
    const args = ["--out", out, "--requested", "latest", "--version", "2026.11.10", "--sha256", "a".repeat(64), "--tier-status", "1", "--exit-code", "1", "--seconds", "3600"];
    const live = ["--tier", "live", "--turn-cap", "2", "--tries", tries, "--turns", turns, "--tokens", tokens, "--measurements", measurements, "--report", report];
    const result = await exec(process.execPath, [RESULT, ...args, ...live], cleanEnv());
    expect(result.code, result.stderr).toBe(0);
    const json = JSON.parse(readFileSync(out, "utf8"));
    expect(json).toMatchObject({ tier: "live", result: "failed", seconds: 3600, turns: 2, refusedTurns: 1, turnCap: 2, measurements: { "first-reply-ms": [21000, 25000] } });
    expect(json.failed).toEqual(["a.live.test.ts > group > a red: expected 1 to be 2", "c.live.test.ts > c red", "turn cap 2 reached: 1 turns refused"]);
    expect(json.files).toEqual([
      { file: "a.live.test.ts", result: "failed", tests: 2, tries: 3, seconds: 50.5 },
      { file: "b.live.test.ts", result: "passed", tests: 1, tries: 1, seconds: 10 },
    ]);
    expect(json.neededRetries).toEqual(["a.live.test.ts > group > a flaky (tries 2)"]);
    expect(json.tokens.total).toBe(10);

    // An unknown total stays null, never 0; refused turns fail a run whose tests all passed.
    writeFileSync(tokens, JSON.stringify({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: null }));
    const green = ["--out", out, "--requested", "latest", "--version", "2026.11.10", "--tier-status", "0", "--exit-code", "0", "--seconds", "1"];
    await exec(process.execPath, [RESULT, ...green, "--tier", "live", "--turn-cap", "2", "--turns", turns, "--tokens", tokens], cleanEnv());
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ result: "failed", tokens: null, refusedTurns: 1 });
  });
});

describe("scripts/regression.sh live without a key", () => {
  it("fails first with the one clear line, before any install or turn, and still writes its result", async () => {
    const out = join(tempDir(), "result.json");
    const env = { ...cleanEnv(), CURSOR_API_KEY: "" };
    const started = Date.now();
    const result = await exec(REGRESSION, ["live", "--openclaw", "2026.11.10", "--result", out], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("CURSOR_API_KEY is not set: the live tier needs the `regression` environment");
    expect(result.stdout).not.toContain("==>");
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(JSON.parse(readFileSync(out, "utf8"))).toMatchObject({ tier: "live", result: "error", exitCode: 1, turns: null, tokens: null });
  });

  it("refuses a turn cap that is not a positive whole number", async () => {
    const result = await exec(REGRESSION, ["live", "--turn-cap", "0"], { ...cleanEnv(), CURSOR_API_KEY: "" });
    expect(result.code).toBe(2);
    expect(result.stderr).toContain("--turn-cap: not a positive whole number: '0'");
  });
});

describe("scripts/scrub-key.mjs (no key in the live tier's artifacts)", () => {
  const SCRUB = join(ROOT, "scripts", "scrub-key.mjs");

  it("replaces the key in every file under the directories, leaves the others alone, and never prints the key", async () => {
    const dir = tempDir();
    const key = "key_test.0123+/=abc";
    writeFileSync(join(dir, "a.log"), `before ${key} middle ${key} after\n`);
    writeFileSync(join(dir, "b.log"), "nothing here\n");
    const nested = join(dir, "nested");
    mkdirSync(nested);
    writeFileSync(join(nested, "c.jsonl"), Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(` ${key}`)]));
    const result = await exec(process.execPath, [SCRUB, dir, join(dir, "missing")], { ...cleanEnv(), CURSOR_API_KEY: ` ${key}\n` });
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain(key);
    expect(result.stdout).toContain("2 file(s)");
    expect(readFileSync(join(dir, "a.log"), "utf8")).toBe("before <CURSOR_API_KEY> middle <CURSOR_API_KEY> after\n");
    expect(readFileSync(join(dir, "b.log"), "utf8")).toBe("nothing here\n");
    expect(readFileSync(join(nested, "c.jsonl"))).toEqual(Buffer.concat([Buffer.from([0xff, 0x00]), Buffer.from(" <CURSOR_API_KEY>")]));
  });

  it("changes nothing without a key, and needs a directory", async () => {
    const dir = tempDir();
    writeFileSync(join(dir, "a.log"), "text\n");
    expect((await exec(process.execPath, [SCRUB, dir], { ...cleanEnv(), CURSOR_API_KEY: "" })).code).toBe(0);
    expect(readFileSync(join(dir, "a.log"), "utf8")).toBe("text\n");
    expect((await exec(process.execPath, [SCRUB], cleanEnv())).code).toBe(2);
  });
});

import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { closeListings } from "../src/core/listings.ts";
import { inspectProcess } from "../src/core/pid-locks.ts";
import { createStreamHook, flattenContext, type AssistantMessageEvent, type StreamContext } from "../src/core/stream.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

/**
 * The provider's stream hook (OpenClaw's own runtime: Test connection, skill review, companion "ask"),
 * with the fake `cursor-agent` as the CLI: the I/O matrix of plan test-connection-through-cli.
 */
const PLUGIN_ID = "openclaw-all-cli";
const scratch = mkdtempSync(join(tmpdir(), "oac-stream-test-"));
afterAll(() => rmSync(scratch, { recursive: true, force: true }));

let logCount = 0;
const newLog = () => join(scratch, `log-${(logCount += 1)}.jsonl`);
const readLog = (file: string): Array<Record<string, any>> =>
  existsSync(file) ? readFileSync(file, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) : [];

const config = (command: string, env: Record<string, string> = {}) => ({
  plugins: { entries: { [PLUGIN_ID]: { config: { "cursor-cli": { command, env } } } } },
});
const model = (id = "auto") => ({ id, api: "openai-completions", provider: "cursor-cli" });
const ask = (text: string): StreamContext => ({ messages: [{ role: "user", content: text }] });

async function run(params: {
  context: StreamContext;
  timeoutMs?: number;
  apiKey?: string;
  modelId?: string;
  gatewayEnv?: Record<string, string>;
  command?: string;
  pluginEnv?: Record<string, string>;
  signal?: AbortSignal;
  onEvent?: (event: AssistantMessageEvent) => void;
}) {
  const hook = createStreamHook(cursorAdapter, PLUGIN_ID, { env: () => params.gatewayEnv ?? fakeEnv(), ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}) });
  const streamFn = hook.createStreamFn!({ config: config(params.command ?? FAKE_CURSOR_AGENT, params.pluginEnv) });
  const stream = streamFn(model(params.modelId), params.context, {
    ...(params.apiKey !== undefined ? { apiKey: params.apiKey } : {}),
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const events: AssistantMessageEvent[] = [];
  for await (const event of stream) {
    events.push(event);
    params.onEvent?.(event);
  }
  return { events, final: await stream.result(), hook };
}

/** The failover reason OpenClaw gets for a failed stream, through the provider's own hook. */
const reasonOf = (hook: ReturnType<typeof createStreamHook>, code: string | undefined) =>
  hook.classifyFailoverReason!({ code, errorMessage: "" });

describe("Test connection through the CLI (createStreamFn)", () => {
  it("answers with the CLI's reply text, in ask mode, in a throwaway home it removes", async () => {
    const log = newLog();
    const { events, final } = await run({ context: ask("say:OK"), apiKey: "key-123", gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(events.map((event) => event.type)).toEqual(["start", "text_start", "text_delta", "text_end", "done"]);
    expect(final).toMatchObject({ role: "assistant", stopReason: "stop", content: [{ type: "text", text: "OK" }], provider: "cursor-cli", model: "auto" });
    expect(final.errorMessage).toBeUndefined();
    const lines = readLog(log);
    const init = lines.find((line) => line.method === "initialize")!;
    expect(init.keyed).toBe(true);
    const configDir: string = init.env.CURSOR_CONFIG_DIR;
    expect(configDir).toMatch(/oac-complete-/);
    expect(init.env.XDG_CONFIG_HOME.startsWith(dirname(configDir))).toBe(true);
    expect(existsSync(dirname(configDir))).toBe(false);
    // Read-only mode, no MCP server.
    expect(lines.find((line) => line.method === "session/set_mode")?.params.modeId).toBe("ask");
    expect(lines.find((line) => line.method === "session/new")?.params.mcpServers).toEqual([]);
    expect(lines.some((line) => line.method === "authenticate")).toBe(false);
  });

  it("uses the requested model", async () => {
    const log = newLog();
    const { final } = await run({ context: ask("hello"), apiKey: "k", modelId: "fake-fast", gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(final.content[0]?.text).toContain("model fake-fast[speed=fast,fast=true]");
  });

  it("a key Cursor refuses is an auth failure", async () => {
    const refused = await run({ context: ask("[[error]]\n\nError: ConnectError: [unauthenticated] Invalid API key"), apiKey: "bad" });
    expect(refused.final.stopReason).toBe("error");
    expect(refused.final.errorMessage).toMatch(/authentication failed/);
    expect(reasonOf(refused.hook, refused.final.errorCode)).toBe("auth");
    expect(refused.events.at(-1)).toMatchObject({ type: "error", reason: "error" });

    const atStart = await run({
      context: ask("hello"),
      apiKey: "bad",
      gatewayEnv: fakeEnv({ FAKE_CURSOR_NEW_ERROR: JSON.stringify({ code: -32000, message: "Authentication required" }) }),
    });
    expect(atStart.final.errorMessage).toMatch(/Authentication required/);
    expect(reasonOf(atStart.hook, atStart.final.errorCode)).toBe("auth");
  });

  it("no key anywhere is an auth failure, and no process starts", async () => {
    const log = newLog();
    const { final, hook } = await run({ context: ask("hello"), apiKey: "", gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/no API key/);
    expect(reasonOf(hook, final.errorCode)).toBe("auth");
    expect(readLog(log)).toEqual([]);
  });

  it("a key in the plugin config also works", async () => {
    const log = newLog();
    const fromConfig = await run({ context: ask("say:cfg"), pluginEnv: { CURSOR_API_KEY: "cfg-key" }, gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(fromConfig.final.content[0]?.text).toBe("cfg");
    expect(readLog(log).find((line) => line.method === "initialize")?.keyed).toBe(true);
  });

  it("the CLI's own login is no key: auth, and no process starts", async () => {
    const log = newLog();
    const { final, hook } = await run({ context: ask("say:native"), apiKey: "openclaw:cursor-cli-native-auth", gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/needs one/);
    expect(reasonOf(hook, final.errorCode)).toBe("auth");
    expect(readLog(log)).toEqual([]);
  });

  it("a missing CLI says so, and is not a timeout", async () => {
    const { final, hook } = await run({ context: ask("hello"), apiKey: "k", command: join(scratch, "no-such-cursor-agent") });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/Could not find the CLI binary/);
    const reason = reasonOf(hook, final.errorCode);
    expect(reason).toBe("unclassified");
    expect(reason).not.toBe("timeout");
  });

  it("a model the account lacks is model_not_found, named in the message", async () => {
    const { final, hook } = await run({ context: ask("hello"), apiKey: "k", modelId: "no-such-model" });
    expect(final.errorMessage).toMatch(/no model "no-such-model"/);
    expect(reasonOf(hook, final.errorCode)).toBe("model_not_found");
  });

  it("abort stops the process and leaves no temp home", async () => {
    const log = newLog();
    const controller = new AbortController();
    const { final, events } = await run({
      context: ask("say:x [[hang]]"),
      apiKey: "k",
      gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }),
      signal: controller.signal,
      onEvent: (event) => {
        if (event.type === "start") setTimeout(() => controller.abort(), 300);
      },
    });
    expect(final.stopReason).toBe("aborted");
    expect(events.at(-1)).toMatchObject({ type: "error", reason: "aborted" });
    const init = readLog(log).find((line) => line.method === "initialize")!;
    expect(existsSync(dirname(init.env.CURSOR_CONFIG_DIR))).toBe(false);
    expect((await inspectProcess(init.pid)).kind).toBe("gone");
  });

  it("the plugin's unload aborts a running request", async () => {
    const log = newLog();
    const { final } = await run({
      context: ask("[[hang]]"),
      apiKey: "k",
      gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }),
      onEvent: (event) => {
        if (event.type === "start") setTimeout(() => void closeListings(3_000), 300);
      },
    });
    expect(final.stopReason).toBe("aborted");
    const init = readLog(log).find((line) => line.method === "initialize")!;
    expect(existsSync(dirname(init.env.CURSOR_CONFIG_DIR))).toBe(false);
    expect((await inspectProcess(init.pid)).kind).toBe("gone");
  });

  it("a request past the time limit fails as a timeout and stops the process", async () => {
    const log = newLog();
    const { final, hook } = await run({ context: ask("[[hang]]"), apiKey: "k", timeoutMs: 400, gatewayEnv: fakeEnv({ FAKE_CURSOR_LOG: log }) });
    expect(final.stopReason).toBe("error");
    expect(final.errorMessage).toMatch(/did not finish/);
    expect(reasonOf(hook, final.errorCode)).toBe("timeout");
    const init = readLog(log).find((line) => line.method === "initialize")!;
    expect((await inspectProcess(init.pid)).kind).toBe("gone");
  });

  it("a closing event after a bare end() still settles the result", async () => {
    const hook = createStreamHook(cursorAdapter, PLUGIN_ID, { env: () => fakeEnv() });
    const stream = hook.createStreamFn!({ config: config(FAKE_CURSOR_AGENT) })(model(), ask("say:late"), { apiKey: "k" });
    stream.end();
    const final = await stream.result();
    expect(final.stopReason).toBe("stop");
    expect(final.content[0]?.text).toBe("late");
  });

  it("only classifies its own error codes", () => {
    const hook = createStreamHook(cursorAdapter, PLUGIN_ID);
    expect(hook.classifyFailoverReason!({ code: "openclaw-all-cli:rate_limit" })).toBe("rate_limit");
    expect(hook.classifyFailoverReason!({ code: "RATE_LIMIT" })).toBeUndefined();
    expect(hook.classifyFailoverReason!({})).toBeUndefined();
  });
});

describe("flattenContext", () => {
  it("keeps the system prompt and the roles in order, text parts only", () => {
    const prompt = flattenContext({
      systemPrompt: "Be brief.",
      messages: [
        { role: "user", content: "First question" },
        { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "First answer" } as never, { type: "toolCall" }] },
        { role: "toolResult", toolName: "read", content: [{ type: "text", text: "file body" } as never] },
        { role: "user", content: [{ type: "text", text: "Second" } as never, { type: "image" }, { type: "text", text: " question" } as never] },
      ],
      tools: [{ name: "exec" }],
    });
    expect(prompt).toBe(
      "System:\nBe brief.\n\nUser:\nFirst question\n\nAssistant:\nFirst answer\n\nTool result (read):\nfile body\n\nUser:\nSecond question",
    );
  });

  it("an empty request fails as format, without a process", async () => {
    const { final, hook } = await run({ context: { messages: [] }, apiKey: "k" });
    expect(final.errorMessage).toMatch(/no text/);
    expect(reasonOf(hook, final.errorCode)).toBe("format");
  });
});

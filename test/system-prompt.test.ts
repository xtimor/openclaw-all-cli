import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { CONTINUITY_NOTE } from "../src/core/execute.ts";
import { createManifest } from "../src/core/ports.ts";
import { SYSTEM_PROMPT_TRANSPORT_MARKER, systemPromptBlock } from "../src/core/system-prompt.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

// AD-15 / P12 through buildCliBackend -> prepareExecution -> execute, against the fake agent.
describe("system prompt delivery (P12)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-system-prompt-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const settings = join(scratch, "settings.json");
  writeFileSync(settings, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));

  let counter = 0;
  const fresh = (name: string) => ({ agentDir: join(scratch, `${name}-${(counter += 1)}`), log: join(scratch, `${name}-${counter}.jsonl`) });
  const backend = buildCliBackend(cursorAdapter, { settings: {} });

  type TurnOptions = {
    backend?: ReturnType<typeof buildCliBackend>;
    systemPrompt?: string;
    sessionId?: string;
    useResume?: boolean;
    executionMode?: "agent" | "side-question";
    env?: Record<string, string>;
  };
  async function turn(agentDir: string, log: string, prompt: string, options: TurnOptions = {}) {
    const prepared = await (options.backend ?? backend).prepareExecution!({
      agentDir,
      ...(options.executionMode ? { executionMode: options.executionMode } : {}),
    } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      cwd: workspace,
      env: fakeEnv({ FAKE_CURSOR_LOG: log, ...options.env }),
      prompt,
      modelId: "auto",
      systemPrompt: options.systemPrompt ?? "",
      useResume: options.useResume ?? false,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.executionMode ? { executionMode: options.executionMode } : {}),
      timeoutMs: 10_000,
      requestToolPermission: async () => ({ behavior: "deny", message: "no" }),
      requestUserInput: async () => ({ status: "cancelled", message: "no" }),
    })) {
      records.push(record);
    }
    const sessionId = records.find((record) => record.type === "system" || record.sessionId)?.sessionId as string | undefined;
    return { records, sessionId };
  }

  const logLines = (log: string) =>
    readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { method: string; params: { prompt?: Array<{ text: string }> }; argv?: string[] });
  const rawPrompts = (log: string) =>
    logLines(log)
      .filter((line) => line.method === "session/prompt")
      .map((line) => line.params.prompt!.map((part) => part.text).join(""));
  /** The prompts without the continuity note, which every fresh agent chat with the proxy also gets (P15). */
  const prompts = (log: string) => rawPrompts(log).map((text) => text.replace(`${CONTINUITY_NOTE}\n\n`, ""));

  const S = "You are the OpenClaw agent.\nSkills: <available_skills>x</available_skills>";

  it("puts the block first on a fresh chat, before the continuity note and the prompt", async () => {
    const { agentDir, log } = fresh("fresh");
    await turn(agentDir, log, "say:pong", { systemPrompt: S, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings } });
    const sent = rawPrompts(log);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toBe(`${systemPromptBlock(S)}\n\n${CONTINUITY_NOTE}\n\nsay:pong`);
  });

  it("sends the block verbatim once the system prompt is trimmed", async () => {
    const { agentDir, log } = fresh("trim");
    await turn(agentDir, log, "say:pong", { systemPrompt: `\n  ${S}  \n\n` });
    expect(prompts(log)[0]).toBe(`${systemPromptBlock(S)}\n\nsay:pong`);
  });

  it("sends no block again to a resumed chat with the same system prompt, and a new one when it changes", async () => {
    const { agentDir, log } = fresh("resume");
    const store = mkdtempSync(join(scratch, "store-"));
    const env = { FAKE_CURSOR_STORE: store };
    const first = await turn(agentDir, log, "say:one", { systemPrompt: S, env });
    const chat = { sessionId: first.sessionId!, useResume: true, env };
    await turn(agentDir, log, "say:two", { ...chat, systemPrompt: S });
    const changed = `${S}\nModel: other`;
    await turn(agentDir, log, "say:three", { ...chat, systemPrompt: changed });
    await turn(agentDir, log, "say:four", { ...chat, systemPrompt: changed });
    await turn(agentDir, log, "say:five", { ...chat, systemPrompt: S });
    const sent = prompts(log);
    expect(sent[0]).toContain(systemPromptBlock(S));
    expect(sent[1]).toBe("say:two");
    expect(sent[2]).toBe(`${systemPromptBlock(changed)}\n\nsay:three`);
    expect(sent[3]).toBe("say:four");
    expect(sent[4]).toBe(`${systemPromptBlock(S)}\n\nsay:five`);
    // The same chat all along: the resumes loaded the first turn's id.
    expect(logLines(log).filter((line) => line.method === "session/load")).toHaveLength(4);
  });

  it("gives a side question the block every time and leaves the chat's delivery alone", async () => {
    const { agentDir, log } = fresh("side");
    const store = mkdtempSync(join(scratch, "store-"));
    const env = { FAKE_CURSOR_STORE: store };
    const first = await turn(agentDir, log, "say:one", { systemPrompt: S, env });
    const side = { executionMode: "side-question" as const, systemPrompt: S, env };
    await turn(agentDir, log, "say:btw1", side);
    await turn(agentDir, log, "say:btw2", side);
    await turn(agentDir, log, "say:two", { sessionId: first.sessionId!, useResume: true, systemPrompt: S, env });
    const sent = prompts(log);
    expect(sent[1]).toBe(`${systemPromptBlock(S)}\n\nsay:btw1`);
    expect(sent[2]).toBe(`${systemPromptBlock(S)}\n\nsay:btw2`);
    // The chat already had S: the side questions neither re-sent nor reset it.
    expect(sent[3]).toBe("say:two");
  });

  it("sends no block for an empty or blank system prompt, and records nothing", async () => {
    const { agentDir, log } = fresh("empty");
    const store = mkdtempSync(join(scratch, "store-"));
    const env = { FAKE_CURSOR_STORE: store };
    const first = await turn(agentDir, log, "say:one", { systemPrompt: "", env });
    await turn(agentDir, log, "say:two", { sessionId: first.sessionId!, useResume: true, systemPrompt: " \n\t ", env });
    await turn(agentDir, log, "say:three", { sessionId: first.sessionId!, useResume: true, systemPrompt: S, env });
    expect(prompts(log)).toEqual(["say:one", "say:two", `${systemPromptBlock(S)}\n\nsay:three`]);
  });

  it("records nothing for a turn that crashes, so the next turn sends the block again", async () => {
    const { agentDir, log } = fresh("crash");
    const store = mkdtempSync(join(scratch, "store-"));
    const env = { FAKE_CURSOR_STORE: store };
    const crashed = await turn(agentDir, log, "[[crash]]", { systemPrompt: S, env });
    expect(crashed.records.at(-1)).toMatchObject({ type: "result", is_error: true });
    await turn(agentDir, log, "say:again", { sessionId: crashed.sessionId!, useResume: true, systemPrompt: S, env });
    const sent = prompts(log);
    expect(sent[0]).toBe(`${systemPromptBlock(S)}\n\n[[crash]]`);
    expect(sent[1]).toBe(`${systemPromptBlock(S)}\n\nsay:again`);
  });

  it("keeps a delivery per agent home: two agents with the same native id each get the block", async () => {
    const a = fresh("home-a");
    const b = fresh("home-b");
    const first = await turn(a.agentDir, a.log, "say:a", { systemPrompt: S });
    const second = await turn(b.agentDir, b.log, "say:b", { systemPrompt: S });
    // The fake numbers its sessions per process, so both homes hold the same native id.
    expect(second.sessionId).toBe(first.sessionId);
    expect(prompts(a.log)[0]).toContain(systemPromptBlock(S));
    expect(prompts(b.log)[0]).toContain(systemPromptBlock(S));
  });

  describe("with P12 undecided", () => {
    const undecided = buildCliBackend(
      { ...cursorAdapter, manifest: createManifest("1", { ...cursorAdapter.manifest.rows, P12: { status: "spike", note: "" } }) },
      { settings: {} },
    );

    it("declares no system-prompt field and sends no block", async () => {
      expect(undecided.config).not.toHaveProperty("systemPromptArg");
      expect(undecided.config).not.toHaveProperty("systemPromptWhen");
      const { agentDir, log } = fresh("undecided");
      await turn(agentDir, log, "say:pong", { backend: undecided, systemPrompt: S });
      expect(prompts(log)).toEqual(["say:pong"]);
    });
  });

  it("declares the marker for the host and never launches Cursor with it", async () => {
    expect(backend.config).toMatchObject({ systemPromptArg: SYSTEM_PROMPT_TRANSPORT_MARKER, systemPromptWhen: "always" });
    const { agentDir, log } = fresh("argv");
    await turn(agentDir, log, "say:pong", { systemPrompt: S });
    const initialize = logLines(log).find((line) => line.method === "initialize")!;
    expect(initialize.argv).toEqual(["acp"]);
    expect(JSON.stringify(initialize.argv)).not.toContain(SYSTEM_PROMPT_TRANSPORT_MARKER);
  });
});

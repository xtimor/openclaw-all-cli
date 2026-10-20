import { createHash } from "node:crypto";
import { existsSync, mkdirSync, utimesSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { cursorAdapter } from "../src/adapters/cursor/index.ts";
import { buildCliBackend } from "../src/core/backend.ts";
import { CONTINUITY_NOTE } from "../src/core/execute.ts";
import { createManifest } from "../src/core/ports.ts";
import { systemPromptBlock } from "../src/core/system-prompt.ts";
import { FAKE_CURSOR_AGENT, fakeEnv } from "./fixtures/paths.ts";

const calls = vi.hoisted(() => ({ options: [] as Array<Record<string, unknown>> }));
vi.mock("../src/core/images.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/core/images.ts")>();
  return {
    ...actual,
    takeHostImages: (prompt: string, options: Record<string, unknown>) => {
      calls.options.push(options);
      return actual.takeHostImages(prompt, options);
    },
  };
});

// P13 through buildCliBackend -> prepareExecution -> execute, against the fake agent and an injected image root.
describe("images (P13)", () => {
  const scratch = mkdtempSync(join(tmpdir(), "oac-images-turn-"));
  afterAll(() => rmSync(scratch, { recursive: true, force: true }));
  const workspace = join(scratch, "workspace");
  mkdirSync(workspace);
  const root = join(scratch, "openclaw", "openclaw-cli-images");
  mkdirSync(root, { recursive: true, mode: 0o700 });
  const settings = join(scratch, "settings.json");
  writeFileSync(settings, JSON.stringify({ mcpServers: { openclaw: { url: "http://127.0.0.1:1/mcp", headers: {} } } }));

  const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(120, 7)]);
  const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(60, 9)]);
  let counter = 0;
  function image(bytes: Buffer, ext = "png"): string {
    counter += 1;
    const file = join(root, `${createHash("sha256").update(`img-${counter}`).digest("hex")}.${ext}`);
    writeFileSync(file, bytes, { mode: 0o600 });
    return file;
  }
  const withImages = (text: string, ...files: string[]) => `${text}\n\n${files.join("\n")}`;

  const freshDir = (name: string) => ({ agentDir: join(scratch, `${name}-${(counter += 1)}`), log: join(scratch, `${name}-${counter}.jsonl`) });
  const warnings: string[] = [];
  let onWarn: ((message: string) => void) | undefined;
  const make = (adapter = cursorAdapter) =>
    buildCliBackend(adapter, {
      settings: {},
      execute: { imageRoots: [root] },
      warn: (message) => {
        warnings.push(message);
        onWarn?.(message);
      },
    });
  const backend = make();
  const undecided = make({
    ...cursorAdapter,
    manifest: createManifest(cursorAdapter.manifest.minVersion, { ...cursorAdapter.manifest.rows, P13: { status: "spike", note: "", requires: ["imagePrompts"] } }),
  });

  type TurnOptions = {
    backend?: ReturnType<typeof buildCliBackend>;
    systemPrompt?: string;
    sessionId?: string;
    useResume?: boolean;
    executionMode?: "agent" | "side-question";
    env?: Record<string, string>;
    signal?: AbortSignal;
  };
  async function turn(agentDir: string, log: string, prompt: string, options: TurnOptions = {}) {
    const prepared = await (options.backend ?? backend).prepareExecution!({ agentDir, ...(options.executionMode ? { executionMode: options.executionMode } : {}) } as never);
    const records: Record<string, unknown>[] = [];
    for await (const record of prepared!.execute!({
      command: FAKE_CURSOR_AGENT,
      args: ["acp"],
      ...(options.signal ? { abortSignal: options.signal } : {}),
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
    const sessionId = records
      .map((record) => record.event as { kind?: string; sessionId?: string } | undefined)
      .find((event) => event?.kind === "sessionId")?.sessionId;
    const text = records
      .map((record) => record.event as { kind?: string; text?: string } | undefined)
      .filter((event) => event?.kind === "text")
      .map((event) => event!.text)
      .join("");
    return { records, sessionId, text };
  }

  type Block = { type: string; text?: string; mimeType?: string; bytes?: number; sha256?: string };
  const logLines = (log: string) =>
    readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { method: string; params: { prompt?: Block[] } });
  const rawPrompts = (log: string) => logLines(log).filter((line) => line.method === "session/prompt").map((line) => line.params.prompt!);
  /** The prompts without the continuity note, which every fresh agent chat also gets (P15). */
  const sentPrompts = (log: string) =>
    rawPrompts(log).map((blocks) =>
      blocks.flatMap((block) => {
        if (block.type !== "text") return [block];
        const text = block.text!.replace(`${CONTINUITY_NOTE}\n\n`, "").replace(CONTINUITY_NOTE, "");
        return text ? [{ ...block, text }] : [];
      }),
    );
  const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

  it("sends the image as an image block after the text, without the path", async () => {
    const { agentDir, log } = freshDir("one");
    const file = image(PNG);
    await turn(agentDir, log, withImages("What is this?", file));
    expect(sentPrompts(log)).toEqual([
      [
        { type: "text", text: "What is this?" },
        { type: "image", mimeType: "image/png", bytes: PNG.length, sha256: sha(PNG) },
      ],
    ]);
  });

  it("sends several images in path order and the type from the bytes", async () => {
    const { agentDir, log } = freshDir("many");
    const { text } = await turn(agentDir, log, withImages("[[images]]", image(PNG), image(JPEG, "png"), image(PNG, "webp")));
    expect(text).toBe(`images:3:image/png/${PNG.length},image/jpeg/${JPEG.length},image/png/${PNG.length}`);
  });

  it("sends only image blocks when the prompt is only the path block", async () => {
    const { agentDir, log } = freshDir("only");
    await turn(agentDir, log, image(PNG));
    expect(sentPrompts(log)).toEqual([[{ type: "image", mimeType: "image/png", bytes: PNG.length, sha256: sha(PNG) }]]);
  });

  it("puts the system block, note, and prompt in one text block, then the images", async () => {
    const { agentDir, log } = freshDir("full");
    const system = "You are the OpenClaw agent.";
    const file = image(PNG);
    await turn(agentDir, log, withImages("say:pong", file), { systemPrompt: system, env: { GEMINI_CLI_SYSTEM_SETTINGS_PATH: settings } });
    const [prompt] = rawPrompts(log);
    expect(prompt).toHaveLength(2);
    expect(prompt![0]).toEqual({ type: "text", text: `${systemPromptBlock(system)}\n\n${CONTINUITY_NOTE}\n\nsay:pong` });
    expect(prompt![1]).toMatchObject({ type: "image", mimeType: "image/png" });
    expect(JSON.stringify(prompt)).not.toContain(file);
  });

  it("delivers the image of a resumed chat's turn and does not resend earlier ones", async () => {
    const { agentDir, log } = freshDir("resume");
    const store = mkdtempSync(join(scratch, "store-"));
    const env = { FAKE_CURSOR_STORE: store };
    const first = await turn(agentDir, log, withImages("say:one", image(PNG)), { env });
    await turn(agentDir, log, "say:two", { sessionId: first.sessionId!, useResume: true, env });
    await turn(agentDir, log, withImages("[[images]]", image(JPEG)), { sessionId: first.sessionId!, useResume: true, env });
    const prompts = sentPrompts(log);
    expect(prompts[1]).toEqual([{ type: "text", text: "say:two" }]);
    expect(prompts[2]!.filter((block) => block.type === "image")).toHaveLength(1);
    expect(logLines(log).filter((line) => line.method === "session/load")).toHaveLength(2);
    // The fake keeps text only, as Cursor keeps the pixels itself: nothing was resent.
    expect(prompts.flat().filter((block) => block.type === "image")).toHaveLength(2);
  });

  it("delivers a side question's image", async () => {
    const { agentDir, log } = freshDir("side");
    const { text, sessionId } = await turn(agentDir, log, withImages("[[images]]", image(PNG)), { executionMode: "side-question" });
    expect(text).toBe(`images:1:image/png/${PNG.length}`);
    expect(sessionId).toBeUndefined();
  });

  it("leaves the prompt and sends no image block while P13 is undecided", async () => {
    const { agentDir, log } = freshDir("spike");
    const file = image(PNG);
    const prompt = withImages("look", file);
    await turn(agentDir, log, prompt, { backend: undecided });
    expect(sentPrompts(log)).toEqual([[{ type: "text", text: prompt }]]);
  });

  it("notes an image it cannot send and still sends the rest", async () => {
    const { agentDir, log } = freshDir("note");
    const bad = image(Buffer.from("not an image"));
    await turn(agentDir, log, withImages("see", bad, image(PNG)));
    const [prompt] = sentPrompts(log);
    expect(prompt![0]!.text).toBe("see\n\n[OpenClaw] An attached image was not passed to the model: unsupported type. Tell the user it could not be used.");
    expect(prompt!.filter((block) => block.type === "image")).toHaveLength(1);
    expect(prompt![0]!.text).not.toContain(root);
  });

  it("leaves a foreign path block alone and reads nothing", async () => {
    const { agentDir, log } = freshDir("foreign");
    const prompt = `${withImages("see", `${root}/../${"a".repeat(64)}.png`)}`;
    await turn(agentDir, log, prompt);
    expect(sentPrompts(log)).toEqual([[{ type: "text", text: prompt }]]);
  });

  it("sends no prompt when the turn is aborted while the images are read", async () => {
    const { agentDir, log } = freshDir("abort");
    const controller = new AbortController();
    const junk = image(Buffer.from("not an image"));
    onWarn = () => controller.abort();
    try {
      await expect(turn(agentDir, log, withImages("see", junk, image(PNG)), { signal: controller.signal })).rejects.toThrow();
    } finally {
      onWarn = undefined;
    }
    expect(existsSync(log) && logLines(log).some((line) => line.method === "session/prompt")).toBe(false);
  });

  it("sends no prompt when the abort lands after the last image was read", async () => {
    const { agentDir, log } = freshDir("abort-last");
    const controller = new AbortController();
    const junk = image(Buffer.from("not an image"));
    onWarn = () => controller.abort();
    try {
      await expect(turn(agentDir, log, withImages("see", junk), { signal: controller.signal })).rejects.toThrow();
    } finally {
      onWarn = undefined;
    }
    expect(existsSync(log) && logLines(log).some((line) => line.method === "session/prompt")).toBe(false);
  });

  it("hands the reader the turn's abort signal, the injected root, and a freshness bound", async () => {
    const { agentDir, log } = freshDir("options");
    const controller = new AbortController();
    const before = Date.now();
    calls.options.length = 0;
    await turn(agentDir, log, withImages("see", image(PNG)), { signal: controller.signal });
    expect(calls.options).toHaveLength(1);
    const options = calls.options[0]!;
    expect(options.signal).toBe(controller.signal);
    expect(options.roots).toEqual([root]);
    expect(options.notBefore as number).toBeLessThanOrEqual(before);
    expect(options.notBefore as number).toBeGreaterThan(before - 10 * 60_000);
  });

  it("leaves a typed path to an old cache file as text (not the host's block for this turn)", async () => {
    const { agentDir, log } = freshDir("typed");
    const file = image(PNG);
    const old = new Date(Date.now() - 60 * 60_000);
    utimesSync(file, old, old);
    const prompt = withImages("please look at this", file);
    await turn(agentDir, log, prompt);
    expect(sentPrompts(log)).toEqual([[{ type: "text", text: prompt }]]);
  });

  it("leaves a typed path to a missing cache file as text, with no note", async () => {
    const { agentDir, log } = freshDir("typed-gone");
    const file = image(PNG);
    rmSync(file);
    const prompt = withImages("please look at this", file);
    await turn(agentDir, log, prompt);
    expect(sentPrompts(log)).toEqual([[{ type: "text", text: prompt }]]);
  });

  it("never writes base64, image data, or the cache path to a log, a warning, or a record", async () => {
    const { agentDir, log } = freshDir("secret");
    const files = [image(PNG), image(Buffer.from("junk")), image(PNG)];
    const before = warnings.length;
    const { records } = await turn(agentDir, log, withImages("[[images]]", ...files));
    const everything = [readFileSync(log, "utf8"), JSON.stringify(records), warnings.slice(before).join("\n")].join("\n");
    expect(warnings.length).toBeGreaterThan(before);
    expect(everything).not.toContain(PNG.toString("base64"));
    expect(everything).not.toContain(root);
    for (const file of files) expect(everything).not.toContain(file.split("/").at(-1)!);
    // The fake's own log line shows size and hash only.
    expect(logLines(log).some((line) => line.params?.prompt?.some((block) => block.type === "image" && "data" in block))).toBe(false);
  });

  it("writes nothing into the workspace, the root, or the agent home", async () => {
    const { agentDir, log } = freshDir("nowrite");
    image(PNG);
    const filesBefore = readdirSync(root).sort();
    await turn(agentDir, log, withImages("see", image(PNG)));
    const after = readdirSync(root).sort();
    expect(after).toHaveLength(filesBefore.length + 1);
    expect(readdirSync(workspace)).toEqual([]);
    const names = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => (entry.isDirectory() ? names(join(dir, entry.name)) : [entry.name]));
    expect(names(agentDir).filter((name) => /\.(png|jpe?g|gif|webp|bmp)$/.test(name))).toEqual([]);
  });

  it("declares no compaction or image field and no config field for P13", () => {
    const keys = JSON.stringify(Object.keys(backend.config));
    for (const name of ["ownsNativeCompaction", "manualCompaction", "imageArg", "imageMode", "imagePathScope"]) {
      expect(keys).not.toContain(name);
      expect(JSON.stringify(backend)).not.toContain(`"${name}"`);
    }
    // The decided row changes the execute option and the catalog, not the backend's config.
    expect(backend.config).toEqual(undecided.config);
  });

  it("declares image input on the catalog rows only while P13 is decided", async () => {
    const rows = async (adapter: typeof cursorAdapter) => {
      const entry = (await import("../src/core/synthetic-auth.ts")).createSyntheticAuthProvider(adapter, (await import("../src/core/catalog.ts")).createModelCatalog(adapter)) as unknown as {
        catalog: { run: (context: unknown) => Promise<{ provider: { models: Array<{ input: string[] }> } } | null> };
      };
      return entry.catalog.run({ config: {}, env: fakeEnv() });
    };
    const quick = { ...cursorAdapter, listModels: async () => [{ name: "auto", label: "Auto", id: "default[]" }] };
    expect((await rows(quick))?.provider.models.every((model) => model.input.includes("image"))).toBe(true);
    const spike = { ...quick, manifest: createManifest(quick.manifest.minVersion, { ...quick.manifest.rows, P13: { status: "spike", note: "" } }) };
    expect((await rows(spike))?.provider.models.every((model) => !model.input.includes("image"))).toBe(true);
  });
});

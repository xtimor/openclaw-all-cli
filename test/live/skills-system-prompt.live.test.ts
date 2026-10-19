import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT } from "../fixtures/paths.ts";
import { LIVE_TIMEOUT_MS, describeLive, openclaw } from "./harness.ts";

// AD-15 with parity rows P11 (skills) and P12 (system prompt). Real Cursor sees OpenClaw's system
// prompt: a reply rule that lives only in the workspace's SOUL.md (OpenClaw injects it, Cursor does not
// load it natively), and a workspace skill that Cursor reads with its native read. A fake agent shows
// that a changed tool list keeps the chat and that the new block reaches it.
// Run `npm run dev:install` first. The real turns need a Cursor login or CURSOR_API_KEY.
describeLive("skills and system prompt (P11, P12)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-sysprompt-"));
  const CONFIG_COMMAND = "plugins.entries.openclaw-all-cli.config.cursor-cli.command";
  const stamp = Date.now();
  const agent = "oac-skills";
  const workspace = join(root, "workspace");
  const skill = `oac-greeting-${stamp}`;
  const RULE_TOKEN = `SP-${stamp}`;
  const SKILL_WORD = `SK-${stamp}`;

  beforeAll(() => {
    mkdirSync(join(workspace, "skills", skill), { recursive: true });
    expect(openclaw(["agents", "add", agent, "--non-interactive", "--workspace", workspace, "--model", "cursor-cli/auto"]).status).toBe(0);
    // `agents add` seeds the bootstrap files: drop the first-run ritual and write our own.
    rmSync(join(workspace, "BOOTSTRAP.md"), { force: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# Agent\nAnswer briefly.\n");
    writeFileSync(join(workspace, "SOUL.md"), `# Soul\nEnd every reply with the token ${RULE_TOKEN} on its own line.\n`);
    writeFileSync(
      join(workspace, "skills", skill, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Gives the ${skill} greeting. Use when the user asks for the ${skill} greeting.\n---\n\n# ${skill}\n\nWhen asked for this greeting, include the code word ${SKILL_WORD} in your reply.\n`,
    );
  }, 120_000);

  afterAll(() => {
    openclaw(["config", "unset", "tools.deny"]);
    openclaw(["config", "unset", CONFIG_COMMAND]);
    openclaw(["agents", "delete", agent, "--force"]);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  type Turn = { reply: string; tools: string[]; status: number | null; raw: string };

  function ask(session: string, message: string): Turn {
    const run = openclaw(["agent", "--local", "--agent", agent, "--session-id", session, "--message", message, "--json", "--timeout", "240"], {
      timeoutMs: 280_000,
    });
    let reply = "";
    let tools: string[] = [];
    try {
      const json = JSON.parse(run.stdout.slice(run.stdout.indexOf("{"))) as {
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      reply = (json.payloads ?? json.result?.payloads ?? []).map((payload) => payload.text ?? "").join("\n");
      tools = json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [];
    } catch {
      reply = run.stdout;
    }
    return { reply, tools, status: run.status, raw: run.stdout + run.stderr };
  }

  const readers = (turn: Turn) => turn.tools.filter((name) => ["read", "grep", "glob"].includes(name));

  // One chat for (a)-(c).
  const chat = `live-sysprompt-${stamp}`;

  it("follows a SOUL.md rule on the first turn without reading any file (a)", () => {
    const turn = ask(chat, "Name one color. Do not use any tools.");
    expect(turn.status, turn.raw).toBe(0);
    expect(turn.reply).toContain(RULE_TOKEN);
    expect(readers(turn)).toEqual([]);
  }, LIVE_TIMEOUT_MS);

  it("reads a workspace skill's SKILL.md natively and follows it (b)", () => {
    const turn = ask(chat, `Give me the ${skill} greeting.`);
    expect(turn.status, turn.raw).toBe(0);
    expect(turn.reply).toContain(SKILL_WORD);
    expect(turn.tools).toContain("read");
  }, LIVE_TIMEOUT_MS);

  it("still follows the rule on a later turn, without a resend (c)", () => {
    const turn = ask(chat, "Name one fruit.");
    expect(turn.status, turn.raw).toBe(0);
    expect(turn.reply).toContain(RULE_TOKEN);
  }, LIVE_TIMEOUT_MS);

  it("writes no Cursor file into the workspace (d)", () => {
    expect(existsSync(join(workspace, ".cursor"))).toBe(false);
    expect(readdirSync(workspace).filter((name) => name.startsWith(".cursor"))).toEqual([]);
  });

  it("keeps the chat when the tool list changes, and sends the new block (e)", () => {
    const log = join(root, "drift.jsonl");
    const store = join(root, "drift-store");
    mkdirSync(store);
    const shim = join(root, "fake-cursor.sh");
    writeFileSync(
      shim,
      `#!/bin/sh\nexport FAKE_CURSOR_LOG="${log}"\nexport FAKE_CURSOR_STORE="${store}"\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@"\n`,
    );
    chmodSync(shim, 0o755);
    expect(openclaw(["config", "set", CONFIG_COMMAND, shim]).status).toBe(0);
    const session = `live-sysprompt-drift-${stamp}`;
    const entries = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; params?: { sessionId?: string; prompt?: Array<{ text: string }> } })
        : [];
    const first = ask(session, "Say hi");
    expect(first.status, first.raw).toBe(0);
    const before = entries().length;
    const promptsOf = (items: ReturnType<typeof entries>) =>
      items.filter((item) => item.method === "session/prompt").map((item) => item.params!.prompt!.map((part) => part.text).join(""));
    expect(promptsOf(entries())[0]).toMatch(/^\[OpenClaw system instructions\]/);
    expect(openclaw(["config", "set", "tools.deny", '["agents_list"]', "--strict-json"]).status).toBe(0);
    const second = ask(session, "Say hi again");
    expect(second.status, second.raw).toBe(0);
    const later = entries().slice(before);
    const methods = later.map((item) => item.method);
    // The chat is resumed, not replaced: a load of the first turn's chat, and no new one.
    const chats = readdirSync(store).map((name) => name.replace(/\.json$/, ""));
    expect(chats).toHaveLength(1);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(later.find((item) => item.method === "session/load")!.params!.sessionId).toBe(chats[0]);
    // The changed prompt reaches the resumed chat, as a block that replaces the earlier one.
    const resent = promptsOf(later);
    expect(resent).toHaveLength(1);
    expect(resent[0]).toMatch(/^\[OpenClaw system instructions\]/);
    expect(resent[0]).toContain("replace any earlier OpenClaw system instructions");
  }, LIVE_TIMEOUT_MS);
});

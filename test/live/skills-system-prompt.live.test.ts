import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT } from "../fixtures/paths.ts";
import { ISOLATED_STATE_DIR, LIVE_TIMEOUT_MS, describeLive, openclaw } from "./harness.ts";

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
  const managedSkills = join(ISOLATED_STATE_DIR, "skills");
  const skillDir = join(managedSkills, skill);

  beforeAll(() => {
    // The skill lives in OpenClaw's managed skills directory, outside the workspace and the Cursor
    // process's cwd: only the catalog in the system prompt can tell Cursor it exists.
    mkdirSync(skillDir, { recursive: true });
    mkdirSync(workspace, { recursive: true });
    expect(openclaw(["agents", "add", agent, "--non-interactive", "--workspace", workspace, "--model", "cursor-cli/auto"]).status).toBe(0);
    // `agents add` seeds the bootstrap files: drop the first-run ritual and write our own.
    rmSync(join(workspace, "BOOTSTRAP.md"), { force: true });
    writeFileSync(join(workspace, "AGENTS.md"), "# Agent\nAnswer briefly.\n");
    writeFileSync(join(workspace, "SOUL.md"), `# Soul\nEnd every reply with the token ${RULE_TOKEN} on its own line.\n`);
    writeFileSync(
      join(skillDir, "SKILL.md"),
      `---\nname: ${skill}\ndescription: Gives the ${skill} greeting. Use when the user asks for the ${skill} greeting.\n---\n\n# ${skill}\n\nWhen asked for this greeting, include the code word ${SKILL_WORD} in your reply.\n`,
    );
  }, 120_000);

  afterAll(() => {
    openclaw(["config", "unset", "tools.deny"]);
    openclaw(["config", "unset", CONFIG_COMMAND]);
    openclaw(["agents", "delete", agent, "--force"]);
    rmSync(skillDir, { recursive: true, force: true });
    if (existsSync(managedSkills) && readdirSync(managedSkills).length === 0) rmSync(managedSkills, { recursive: true, force: true });
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

  // A model can answer wrong once, so a step gets up to three tries (each (a) try in a fresh chat).
  const TRIES = 3;
  let chat = "";

  it("follows a SOUL.md rule on the first turn without reading any file (a)", () => {
    // The token exists only in SOUL.md, which OpenClaw injects and Cursor does not load natively,
    // so a reply with it shows the system prompt reached Cursor.
    const seen: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      chat = `live-sysprompt-${stamp}-${n}`;
      const turn = ask(chat, "Name one color. Do not use any tools.");
      expect(turn.status, turn.raw).toBe(0);
      if (turn.reply.includes(RULE_TOKEN) && readers(turn).length === 0) return;
      seen.push(`reply=${JSON.stringify(turn.reply)} tools=${turn.tools.join(",")}`);
    }
    expect.fail(`no try followed the rule without reading: ${seen.join(" | ")}`);
  }, LIVE_TIMEOUT_MS * TRIES);

  it("finds a skill outside the workspace in the catalog, reads its SKILL.md natively, and follows it (b)", () => {
    const seen: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      const turn = ask(chat, `Give me the ${skill} greeting.`);
      expect(turn.status, turn.raw).toBe(0);
      if (turn.reply.includes(SKILL_WORD) && turn.tools.includes("read")) return;
      seen.push(`reply=${JSON.stringify(turn.reply)} tools=${turn.tools.join(",")}`);
    }
    expect.fail(`no try read and followed the skill: ${seen.join(" | ")}`);
  }, LIVE_TIMEOUT_MS * TRIES);

  it("still follows the rule on a later turn of the chat (c)", () => {
    // Whether the block was resent is not visible with real Cursor: row (e) proves that with a log.
    const seen: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      const turn = ask(chat, "Name one fruit.");
      expect(turn.status, turn.raw).toBe(0);
      if (turn.reply.includes(RULE_TOKEN)) return;
      seen.push(JSON.stringify(turn.reply));
    }
    expect.fail(`no try followed the rule: ${seen.join(" | ")}`);
  }, LIVE_TIMEOUT_MS * TRIES);

  it("writes no Cursor file into the workspace (d)", () => {
    expect(existsSync(join(workspace, ".cursor"))).toBe(false);
    expect(readdirSync(workspace).filter((name) => name.startsWith(".cursor"))).toEqual([]);
  });

  it("sends the block once for an unchanged prompt, keeps the chat when the tool list changes, and sends the new block (e)", () => {
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
    type Entry = { method: string; params?: { sessionId?: string; prompt?: Array<{ text: string }> } };
    const entries = (): Entry[] =>
      existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as Entry) : [];
    const promptsOf = (items: Entry[]) =>
      items.filter((item) => item.method === "session/prompt").map((item) => item.params!.prompt!.map((part) => part.text).join(""));
    const startsWithBlock = (text: string) => text.startsWith("[OpenClaw system instructions]");

    // Two `--local` runs are two processes: an unchanged prompt must not be sent again.
    const first = ask(session, "Say hi");
    expect(first.status, first.raw).toBe(0);
    const second = ask(session, "Say hi again");
    expect(second.status, second.raw).toBe(0);
    const unchanged = promptsOf(entries());
    expect(unchanged).toHaveLength(2);
    expect(startsWithBlock(unchanged[0]!)).toBe(true);
    expect(startsWithBlock(unchanged[1]!)).toBe(false);

    const before = entries().length;
    expect(openclaw(["config", "set", "tools.deny", '["agents_list"]', "--strict-json"]).status).toBe(0);
    const third = ask(session, "Say hi once more");
    expect(third.status, third.raw).toBe(0);
    const later = entries().slice(before);
    const methods = later.map((item) => item.method);
    // The chat is resumed, not replaced: a load of the first turn's chat, and no new one.
    const chats = readdirSync(store).map((name) => name.replace(/\.json$/, ""));
    expect(chats).toHaveLength(1);
    expect(methods).toContain("session/load");
    expect(methods).not.toContain("session/new");
    expect(later.find((item) => item.method === "session/load")!.params!.sessionId).toBe(chats[0]);
    // The changed prompt reaches the resumed chat as a block that replaces the earlier one, and the
    // difference is the denied tool: block one lists it, block two does not.
    const resent = promptsOf(later);
    expect(resent).toHaveLength(1);
    expect(startsWithBlock(resent[0]!)).toBe(true);
    expect(resent[0]).toContain("replace any earlier OpenClaw system instructions");
    expect(resent[0]).not.toBe(unchanged[0]);
    expect(unchanged[0]).toContain("agents_list");
    expect(resent[0]).not.toContain("agents_list");
  }, LIVE_TIMEOUT_MS * 2);
});

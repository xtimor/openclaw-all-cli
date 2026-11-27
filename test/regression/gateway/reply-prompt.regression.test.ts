import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { shellNote } from "../../../src/core/turn-prompt.ts";
import { replyLines } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  chatMessageText,
  chatPids,
  chatSend,
  configure,
  describeRegression,
  fakeCommand,
  finishRegression,
  freePort,
  gatewayAgentTurn,
  gatewayCall,
  linesOf,
  promptText,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// Gateway scenarios for past turn and prompt bugs (epic-regression-gate ticket 3): what the Gateway sends back and
// stores for a turn, and what the CLI receives. One Gateway for the file, the packed plugin, fake-cursor-agent as the
// CLI. Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway scenarios: replies, prompts, and errors of a turn", () => {
  let root: string | undefined;
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;
  let stopGateway: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    root = mkdtempSync(join(tmpdir(), "oac-regression-reply-"));
    // Unique Cursor chat IDs, as real Cursor gives (see turn-process.regression.test.ts). Sessions start in Cursor's
    // "ask" mode, so a turn shows whether the plugin switched it to "agent".
    mkdirSync(join(root, "store"));
    fake = fakeCommand(root, "cursor-agent", { FAKE_CURSOR_STORE: join(root, "store"), FAKE_CURSOR_START_MODE: "ask" });
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort(), { onStarted: (stop) => (stopGateway = stop) });
  }, REGRESSION_TIMEOUT_MS);

  afterAll(() => finishRegression({ stop: stopGateway, fakes: [fake], root }), 120_000);

  const nonce = () => randomUUID().slice(0, 8);
  const sessionKey = (name: string) => `agent:main:explicit:${name}`;

  // #13: a webchat turn was reported to show the reply twice (streamed, then again as a completed block). Closed with
  // no plugin change: the host sets the final text from the result once. The Control UI's path is `chat.send`; what
  // it keeps is the session transcript that `chat.history` reads.
  it(
    "#13: one `chat.send` turn gives exactly one final chat frame and one assistant row with the reply in the transcript",
    async () => {
      const id = nonce();
      const reply = `once${id}`;
      const key = sessionKey(`regression-once-${randomUUID().slice(0, 8)}`);
      const sent = await chatSend(gateway!.port, key, `say:${reply}`);
      const frames = JSON.stringify(sent.frames, null, 1);
      expect(sent.runId, JSON.stringify(sent.seen, null, 1)).toBeTypeOf("string");
      const finals = sent.frames.filter((frame) => frame.payload?.state === "final");
      expect(finals, frames).toHaveLength(1);
      expect(chatMessageText(finals[0]!.payload?.message).split(reply).length - 1, frames).toBe(1);
      expect(sent.frames.some((frame) => frame.payload?.state === "error"), frames).toBe(false);

      const history = gatewayCall(gateway!.port, "chat.history", { sessionKey: key });
      const messages = (history?.messages ?? []) as Array<{ role?: string }>;
      const rows = JSON.stringify(messages.map((message) => ({ role: message.role, text: chatMessageText(message) })), null, 1);
      const assistant = messages.filter((message) => message.role === "assistant");
      expect(assistant, `chat.history rows:\n${rows}`).toHaveLength(1);
      expect(chatMessageText(assistant[0]).split(reply).length - 1, `chat.history rows:\n${rows}`).toBe(1);
      // In no other row either (a second copy in another row kind would still show); the user's own row holds the request.
      const others = messages.filter((message) => message.role !== "user").map((message) => chatMessageText(message));
      expect(others.join("\n").split(reply).length - 1, `chat.history rows:\n${rows}`).toBe(1);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #76: with OpenClaw's `exec` served (agent mode), Cursor's native shell is denied by its config and the model got
  // only Cursor's generic refusal. The first prompt of the process now says where commands run.
  it(
    "#76: an agent-mode turn where the host serves `exec` sends the native-shell-disabled note and sets mode `agent`",
    async () => {
      const id = nonce();
      const logFrom = readFakeLog(fake!.log).length;
      const run = await gatewayAgentTurn(gateway!.port, `regression-shell-${id}`, `say:shell${id}`);
      const output = `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(replyLines(run.stdout), output).toEqual([`shell${id}`]);
      const all = readFakeLog(fake!.log).slice(logFrom);
      const methods = all.map((line) => `${line.method}${line.method === "session/set_mode" ? ` ${line.params?.modeId}` : ""} pid=${line.pid}`).join("\n");
      // The turn's process is the one its prompt reached; a model-listing process may log lines in the same window.
      const chats = chatPids(all, `say:shell${id}`);
      expect(chats, methods).toHaveLength(1);
      const lines = linesOf(all, chats[0]!);
      const prompts = lines.filter((line) => line.method === "session/prompt");
      expect(prompts, methods).toHaveLength(1);
      const text = promptText(prompts[0]!);
      // The host serves exec and process in agent mode, so the note is the variant that names `process`.
      const note = shellNote(true);
      const at = text.indexOf("native shell");
      expect(text, `prompt around "native shell": ${at < 0 ? "(absent)" : JSON.stringify(text.slice(Math.max(0, at - 200), at + 400))}`).toContain(note);
      expect(note).toMatch(/OpenClaw `exec`/);
      const modes = lines.filter((line) => line.method === "session/set_mode").map((line) => line.params?.modeId);
      expect(modes, methods).toEqual(["agent"]);
    },
    REGRESSION_TIMEOUT_MS,
  );

  // #99: Cursor's transient throttle (`RetriableError`, Connect code `resource_exhausted`) was reported as a spent
  // plan quota ("usage limit"). The Gateway's error for the turn must read as a temporary rate limit.
  it(
    "#99: a Cursor `resource_exhausted` throttle reaches `chat.send` as a temporary rate limit, not a spent plan quota",
    async () => {
      const throttle = "\n\nError: RetriableError: [resource_exhausted] Too many requests, please slow down";
      const key = sessionKey(`regression-throttle-${nonce()}`);
      const sent = await chatSend(gateway!.port, key, `[[error-json:${JSON.stringify(throttle)}]]`);
      const frames = JSON.stringify(sent.frames, null, 1);
      expect(sent.frames.some((frame) => frame.payload?.state === "final"), frames).toBe(false);
      const errors = sent.frames.filter((frame) => frame.payload?.state === "error" && typeof frame.payload?.errorKind === "string");
      expect(errors, frames).toHaveLength(1);
      const error = errors[0]!.payload as { errorMessage?: string; errorKind?: string };
      // `rate_limit` is the host's failover reason for a limit that passes (it tells the user to try again later).
      expect(error.errorKind, frames).toBe("rate_limit");
      expect(error.errorMessage, frames).toMatch(/temporary rate limit/i);
      expect(error.errorMessage, frames).toContain("[resource_exhausted]");
      expect(error.errorMessage, frames).not.toMatch(/usage limit|quota|upgrade your plan/i);
    },
    REGRESSION_TIMEOUT_MS,
  );
});

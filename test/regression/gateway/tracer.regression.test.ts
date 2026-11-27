import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { replyLines, waitFor } from "../../live/harness.ts";
import {
  CURSOR_COMMAND_KEY,
  REGRESSION_TIMEOUT_MS,
  chatSend,
  configure,
  describeRegression,
  fakeCommand,
  freePort,
  gatewayAgentTurn,
  killFakes,
  liveFakes,
  promptText,
  readFakeLog,
  startRegressionGateway,
  type FakeCommand,
  type RegressionGateway,
} from "../harness.ts";

// The tracer of the Gateway tier: the packed plugin in a fresh OpenClaw answers one plain turn through a real
// Gateway, over `openclaw agent` and over `chat.send` (the Control UI's path), with fake-cursor-agent as the CLI.
// Run with `scripts/regression.sh gateway [--openclaw <version>]`.
describeRegression("Gateway tier tracer: a plain turn through the packed plugin", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-regression-tracer-"));
  let fake: FakeCommand | undefined;
  let gateway: RegressionGateway | undefined;

  beforeAll(async () => {
    fake = fakeCommand(root, "cursor-agent");
    configure({ [CURSOR_COMMAND_KEY]: fake.command, "agents.defaults.model.primary": "cursor-cli/auto" });
    gateway = await startRegressionGateway(await freePort());
  }, REGRESSION_TIMEOUT_MS);

  afterAll(async () => {
    await gateway?.stop();
    if (fake) {
      // The plugin stops its CLI processes when the Gateway shuts down; whatever is left after a moment is killed.
      const left = fake;
      await waitFor(() => liveFakes(left).length === 0, 10_000, 250);
      const leftover = liveFakes(left);
      if (leftover.length > 0) console.warn(`fake cursor-agent processes left after the Gateway stopped: ${leftover.join(", ")}`);
      killFakes(left);
    }
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  const prompts = () => readFakeLog(fake!.log).filter((entry) => entry.method === "session/prompt");
  // OpenClaw wraps the user's message: a timestamp before it on the `openclaw agent` path, and its own
  // messaging hints after it on both paths. The message is the end of exactly one line of the prompt.
  const messageLines = (text: string, message: string) => text.split("\n").filter((line) => line.trimEnd().endsWith(message));

  it(
    "answers `openclaw agent` through the Gateway with the CLI's reply",
    async () => {
      const nonce = `tracer${randomUUID().slice(0, 8)}`;
      const message = `say:${nonce}`;
      const before = prompts().length;
      const run = await gatewayAgentTurn(gateway!.port, `regression-tracer-${nonce}`, message);
      const output = `exit ${run.status}\n--- stdout\n${run.stdout}\n--- stderr\n${run.stderr}`;
      expect(run.status, output).toBe(0);
      expect(replyLines(run.stdout), output).toEqual([nonce]);
      const sent = prompts().slice(before);
      expect(sent, output).toHaveLength(1);
      expect(messageLines(promptText(sent[0]!), message), promptText(sent[0]!)).toHaveLength(1);
    },
    REGRESSION_TIMEOUT_MS,
  );

  it(
    "answers `chat.send` with exactly one final chat frame",
    async () => {
      const nonce = `tracer${randomUUID().slice(0, 8)}`;
      const message = `say:${nonce}`;
      const before = prompts().length;
      const sent = await chatSend(gateway!.port, `agent:main:explicit:regression-tracer-${nonce}`, message);
      const seen = JSON.stringify(sent.seen, null, 1);
      expect(sent.runId, seen).toBeTypeOf("string");
      const finals = sent.frames.filter((frame) => frame.payload?.state === "final");
      expect(finals, seen).toHaveLength(1);
      const text = JSON.stringify(finals[0]!.payload?.message ?? finals[0]!.payload);
      expect(text.split(nonce).length - 1, seen).toBe(1);
      expect(sent.frames.some((frame) => frame.payload?.state === "error"), seen).toBe(false);
      const prompted = prompts().slice(before);
      expect(prompted, seen).toHaveLength(1);
      expect(messageLines(promptText(prompted[0]!), message), promptText(prompted[0]!)).toHaveLength(1);
    },
    REGRESSION_TIMEOUT_MS,
  );
});

#!/usr/bin/env node
// A stand-in for `cursor-agent` that speaks just enough ACP for tests. It is not Cursor: it
// proves the plugin's own wiring (spawn, handshake, mode, resume, streaming, abort) on a host
// without a Cursor login. Behavior is steered by env vars and by the prompt text.
//
//   FAKE_CURSOR_LOGGED_IN=0     `status` reports "Not logged in"
//   FAKE_CURSOR_NO_ASK_MODE=1   the agent lists no "ask" mode
//   FAKE_CURSOR_LOG=<file>      append one JSON line per request the agent receives; the
//                               `initialize` line also carries CURSOR_CONFIG_DIR/CURSOR_DATA_DIR
//   FAKE_CURSOR_DEFAULT_MODEL=m the model a new session starts with (default "auto")
//   FAKE_CURSOR_IGNORE_CANCEL=1 session/cancel does nothing
//   FAKE_CURSOR_IGNORE_TERM=1   SIGTERM does nothing (only SIGKILL stops the process)
//   FAKE_CURSOR_IGNORE_STDIN_EOF=1  the process stays up when stdin closes
//   FAKE_CURSOR_NO_INIT=1       `initialize` is never answered (a hanging handshake)
//
// Prompt text steers a turn: "[[ask-permission]]" requests a shell permission, "[[ask-json]]<json>"
// requests the permission the JSON describes ({toolCall, announce?, options?}; `announce` is sent first
// as a `tool_call` update, like Cursor does), "[[hang]]" never
// finishes until cancelled, "[[refuse]]" ends with stopReason refusal, "[[crash]]" exits, "say:<text>" replies with <text>.
import { appendFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify(entry)}\n`);
};

if (args[0] === "--version") {
  console.log("2026.10.14-fake");
  process.exit(0);
}
if (args[0] === "status") {
  if (process.env.FAKE_CURSOR_LOGGED_IN === "0") {
    console.log("Not logged in");
    process.exit(1);
  }
  console.log("Logged in as fake@example.com");
  process.exit(0);
}
if (args[0] !== "acp") {
  console.error(`fake-cursor-agent: unsupported arguments ${args.join(" ")}`);
  process.exit(2);
}

if (process.env.FAKE_CURSOR_IGNORE_TERM === "1") process.on("SIGTERM", () => {});

const sessions = new Map();
let nextSession = 1;
let nextRequestId = 1000;
const waitingForClient = new Map();
const cancelled = new Set();

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message) => send({ id, error: { code, message } });
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });

const modes = () => ({
  currentModeId: "agent",
  availableModes: [
    { id: "agent", name: "Agent" },
    { id: "plan", name: "Plan" },
    ...(process.env.FAKE_CURSOR_NO_ASK_MODE === "1" ? [] : [{ id: "ask", name: "Ask" }]),
  ],
});
const configOptions = (session) => [
  {
    id: "model",
    name: "Model",
    category: "model",
    type: "select",
    currentValue: session.model,
    options: [
      { value: "auto", name: "Auto" },
      { value: "fake-fast", name: "Fake Fast" },
    ],
  },
];

async function runPrompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  cancelled.delete(params.sessionId);
  session.prompts += 1;
  update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  if (text.includes("[[crash]]")) process.exit(3);
  if (text.includes("[[refuse]]")) return reply(id, { stopReason: "refusal" });
  if (text.includes("[[hang]]")) {
    await new Promise((resolve) => {
      const timer = setInterval(() => {
        if (cancelled.has(params.sessionId)) {
          clearInterval(timer);
          resolve();
        }
      }, 20);
    });
    return reply(id, { stopReason: "cancelled" });
  }
  if (text.includes("[[ask-json]]")) {
    const spec = JSON.parse(text.slice(text.indexOf("[[ask-json]]") + "[[ask-json]]".length));
    if (spec.announce) {
      update(params.sessionId, { sessionUpdate: "tool_call", status: "pending", ...spec.announce });
    }
    const requestId = nextRequestId++;
    send({
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { status: "pending", ...spec.toolCall },
        options: spec.options ?? [
          { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
          { optionId: "allow-always", name: "Allow always", kind: "allow_always" },
          { optionId: "reject-once", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    const outcome = await new Promise((resolve) => waitingForClient.set(requestId, resolve));
    update(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `permission:${JSON.stringify(outcome)}` },
    });
    return reply(id, { stopReason: "end_turn" });
  }
  if (text.includes("[[ask-permission]]")) {
    const requestId = nextRequestId++;
    send({
      id: requestId,
      method: "session/request_permission",
      params: {
        sessionId: params.sessionId,
        toolCall: { toolCallId: "call-1", title: "Run shell command", kind: "execute" },
        options: [
          { optionId: "allow", name: "Allow", kind: "allow_once" },
          { optionId: "reject", name: "Reject", kind: "reject_once" },
        ],
      },
    });
    const outcome = await new Promise((resolve) => waitingForClient.set(requestId, resolve));
    update(params.sessionId, {
      sessionUpdate: "agent_message_chunk",
      content: { type: "text", text: `permission:${JSON.stringify(outcome)}` },
    });
    return reply(id, { stopReason: "end_turn" });
  }
  const say = /say:(.*)/.exec(text)?.[1];
  const answer = say ?? `Hi from fake cursor (model ${session.model}, prompt ${session.prompts})`;
  for (const piece of answer.match(/.{1,12}/g) ?? [answer]) {
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: piece } });
  }
  return reply(id, { stopReason: "end_turn", ...(process.env.FAKE_CURSOR_USAGE === "1" ? { usage: { totalTokens: 7, inputTokens: 3, outputTokens: 4 } } : {}) });
}

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  if (!line.trim()) return;
  const message = JSON.parse(line);
  if (message.method === undefined) {
    // A response to a request the agent sent.
    waitingForClient.get(message.id)?.(message.result?.outcome);
    waitingForClient.delete(message.id);
    return;
  }
  log({
    method: message.method,
    params: message.params,
    ...(message.method === "initialize"
      ? { env: { CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR } }
      : {}),
  });
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      if (process.env.FAKE_CURSOR_NO_INIT === "1") return;
      return reply(id, {
        protocolVersion: Number(process.env.FAKE_CURSOR_PROTOCOL ?? 1),
        agentCapabilities: { loadSession: true, promptCapabilities: { image: true } },
        authMethods: [{ id: "cursor_login", name: "Cursor login" }],
        agentInfo: { name: "fake-cursor-agent", version: "0" },
      });
    case "authenticate":
      return reply(id, {});
    case "session/new": {
      const sessionId = `fake-session-${nextSession++}`;
      const session = { model: process.env.FAKE_CURSOR_DEFAULT_MODEL ?? "auto", mode: "agent", prompts: 0 };
      sessions.set(sessionId, session);
      return reply(id, { sessionId, modes: modes(), configOptions: configOptions(session) });
    }
    case "session/load": {
      const session = { model: "auto", mode: "agent", prompts: 0, loaded: true };
      sessions.set(params.sessionId, session);
      // Like a real agent, replay history as updates before answering.
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HISTORY" } });
      return reply(id, { modes: modes(), configOptions: configOptions(session) });
    }
    case "session/set_mode":
      sessions.get(params.sessionId).mode = params.modeId;
      return reply(id, {});
    case "session/set_config_option":
      if (params.configId === "model") sessions.get(params.sessionId).model = params.value;
      return reply(id, { configOptions: configOptions(sessions.get(params.sessionId)) });
    case "session/prompt":
      return void runPrompt(id, params);
    case "session/cancel":
      if (process.env.FAKE_CURSOR_IGNORE_CANCEL !== "1") cancelled.add(params.sessionId);
      return;
    default:
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }
});
rl.on("close", () => {
  if (process.env.FAKE_CURSOR_IGNORE_STDIN_EOF !== "1") process.exit(0);
});

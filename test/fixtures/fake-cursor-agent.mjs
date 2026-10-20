#!/usr/bin/env node
// A stand-in for `cursor-agent` that speaks just enough ACP for tests. It is not Cursor: it
// proves the plugin's own wiring (spawn, handshake, mode, resume, streaming, abort) on a host
// without a Cursor login. Behavior is steered by env vars and by the prompt text.
//
//   FAKE_CURSOR_LOGGED_IN=0     `status` reports "Not logged in"
//   FAKE_CURSOR_NO_ASK_MODE=1   the agent lists no "ask" mode
//   FAKE_CURSOR_START_MODE=<id> the mode a session starts in (default "agent"); prompt "[[mode]]" replies "mode:<current mode>"
//   FAKE_CURSOR_LOG=<file>      append one JSON line per request the agent receives (with `t`, the epoch ms); the `initialize` line also carries
//                               the process `argv` and CURSOR_CONFIG_DIR/CURSOR_DATA_DIR
//   FAKE_CURSOR_LOG_END=1       also log a `prompt/end` line when a prompt ends
//   FAKE_CURSOR_VERSION=<text>  what `--version` prints (default "2026.10.14-fake")
//   FAKE_CURSOR_VERSION_EXIT=<n> `--version` exits with this code after printing
//   FAKE_CURSOR_DEFAULT_MODEL=m the exact model ID a new session starts with (default "default[]", Cursor's Auto)
//   FAKE_CURSOR_MODEL_SURFACE=s how the agent reports its models: "both" (default; the `models` state and a
//                               configOptions select, like cursor-agent), "state" (only `models`, switched
//                               with session/set_model), or "options" (only the configOptions select)
//   FAKE_CURSOR_NO_MODELS=1     the agent reports no models at all
//   FAKE_CURSOR_IGNORE_CANCEL=1 session/cancel does nothing
//   FAKE_CURSOR_IGNORE_TERM=1   SIGTERM does nothing (only SIGKILL stops the process)
//   FAKE_CURSOR_IGNORE_STDIN_EOF=1  the process stays up when stdin closes
//   FAKE_CURSOR_NO_INIT=1       `initialize` is never answered (a hanging handshake)
//   FAKE_CURSOR_STORE=<dir>     a chat store, like a Cursor home: `session/new` saves the session as a file there
//                               (with a unique ID), every prompt is appended to it, and `session/load` of an ID with
//                               no file fails with "Invalid params". Point two agents at two dirs to model two homes.
//   FAKE_CURSOR_CAPS=<json>     shallow-merged into `initialize`'s agentCapabilities (default: the real report, `loadSession`,
//                               `mcpCapabilities{http,sse}`, `promptCapabilities{image}`); e.g. {"mcpCapabilities":{"http":false}}
//   FAKE_CURSOR_AUTH_METHODS=<json> replaces `initialize`'s authMethods (default `[{id:"cursor_login"}]`); `null` reports none at all
//   (session/new also creates `<CURSOR_CONFIG_DIR>/acp-sessions/<id>`, like Cursor)
//   FAKE_CURSOR_LOAD_ERROR=<json> `session/load` fails with the JSON-RPC error {code, message, data?}
//   FAKE_CURSOR_NEW_ERROR=<json> `session/new` fails with the JSON-RPC error {code, message, data?}
//   FAKE_CURSOR_LOAD_CRASH=1    the process exits while `session/load` runs
//   FAKE_CURSOR_LOAD_RENAMES=1  `session/load` answers with `sessionId: "<id>-moved"`, the way an agent that moved the chat would
//
// Prompt text steers a turn: "[[ask-permission]]" requests a shell permission, "[[ask-json]]<json>"
// requests the permission the JSON describes ({toolCall, announce?, options?}; `announce` is sent first
// as a `tool_call` update, like Cursor does), "[[hang]]" never
// finishes until cancelled, "[[refuse]]" ends with stopReason refusal, "[[crash]]" exits, "say:<text>" replies with <text>.
// "[[error]]<text>" sends <text> as the one and only reply chunk (a failed Cursor turn: "\n\nError: ...") and ends with end_turn.
// "[[sleep:<ms>]]" waits <ms> before the reply (a turn that takes a while), then answers like any other prompt.
// "[[images]]" replies "images:<n>:<mime>/<bytes>,..." for the image blocks of the prompt. The log's `session/prompt` line shows each
// image block as {type, mimeType, bytes, sha256}, never its data, and the history keeps text only.
// "[[recall]]" replies with the prompts the session has seen before this one ("recall:a|b"), including those from before a
// `session/load` when FAKE_CURSOR_STORE is set.
// "[[mcp-call]]<json>" calls tools on the session's own MCP server (the first `mcpServers` entry), as a model would:
// `{"tool":"exec","arguments":{...}}` or an array of such calls, run at the same time. It sends `initialize`,
// `notifications/initialized` and `tools/call`, with the headers the server was given, then replies with each
// tool's text joined by "|" (`mcp-error:<status>` for an HTTP error, `mcp-aborted` when `session/cancel`
// arrived first; an `isError` result is prefixed `tool-error:`).
// "[[updates]]<json array>" sends each item as a `session/update` body, in order, a few ms apart, then ends the
// turn. An item `{"$":"say","text":"..."}` sends a message chunk, `{"$":"crash"}` exits, `{"$":"ask","toolCall":{...}}` sends a permission request and waits for the answer, `{"$":"hang"}` waits for a
// cancel and answers `cancelled`, `{"$":"end","stopReason":"..."}` answers at once with that stop reason, `{"$":"wait","ms":n}` pauses. Use it to script tool calls the way Cursor sends them.
import { createHash, randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const log = (entry) => {
  if (process.env.FAKE_CURSOR_LOG) appendFileSync(process.env.FAKE_CURSOR_LOG, `${JSON.stringify({ ...entry, t: Date.now() })}\n`);
};

if (args[0] === "--version") {
  console.log(process.env.FAKE_CURSOR_VERSION ?? "2026.10.14-fake");
  process.exit(Number(process.env.FAKE_CURSOR_VERSION_EXIT ?? 0));
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

const storeDir = process.env.FAKE_CURSOR_STORE;
const storeFile = (id) => join(storeDir, `${id}.json`);
const saveSession = (id, session) => {
  if (storeDir) writeFileSync(storeFile(id), JSON.stringify({ history: session.history }));
};
const sessions = new Map();
let nextSession = 1;
let nextRequestId = 1000;
const waitingForClient = new Map();
const cancelled = new Set();
const mcpServers = new Map();
const mcpAborts = new Map();

/** One JSON-RPC call to the session's MCP server; the body may start with keepalive newlines or be an SSE `data:` frame. */
async function mcpRpc(server, body, signal) {
  const headers = { "Content-Type": "application/json", Accept: "application/json, text/event-stream" };
  for (const header of server.headers ?? []) headers[header.name] = header.value;
  const res = await fetch(server.url, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", ...body }), signal });
  const text = (await res.text()).trim();
  if (!res.ok) return { status: res.status };
  if (!text) return { status: res.status };
  const data = text.startsWith("data:") ? text.split("\n").find((line) => line.startsWith("data:")).slice(5) : text;
  return { status: res.status, message: JSON.parse(data) };
}

async function mcpCall(sessionId, call, signal) {
  const server = mcpServers.get(sessionId)?.[0];
  if (!server) return "mcp-error:no-server";
  try {
    const init = await mcpRpc(server, { id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "fake-cursor", version: "0" } } }, signal);
    if (init.status >= 400) return `mcp-error:${init.status}`;
    await mcpRpc(server, { method: "notifications/initialized" }, signal);
    const result = await mcpRpc(server, { id: 2, method: "tools/call", params: { name: call.tool, arguments: call.arguments ?? {} } }, signal);
    if (result.status >= 400) return `mcp-error:${result.status}`;
    const out = result.message?.result;
    const text = (out?.content ?? []).map((block) => block.text ?? "").join("");
    return out?.isError ? `tool-error:${text}` : text;
  } catch (error) {
    return signal.aborted ? "mcp-aborted" : `mcp-error:${error.message}`;
  }
}

const send = (message) => process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
const reply = (id, result) => send({ id, result });
const fail = (id, code, message, data) => send({ id, error: { code, message, ...(data === undefined ? {} : { data }) } });
const update = (sessionId, body) => send({ method: "session/update", params: { sessionId, update: body } });

const modes = () => ({
  currentModeId: process.env.FAKE_CURSOR_START_MODE ?? "agent",
  availableModes: [
    { id: "agent", name: "Agent" },
    { id: "plan", name: "Plan" },
    ...(process.env.FAKE_CURSOR_NO_ASK_MODE === "1" ? [] : [{ id: "ask", name: "Ask" }]),
  ],
});
// Exact IDs carry brackets and commas, like Cursor's. Two share a base name to test unique naming.
const MODELS = [
  { modelId: "default[]", name: "Auto" },
  { modelId: "fake-fast[speed=fast,fast=true]", name: "fake-fast" },
  { modelId: "fake-slow[context=1m,effort=high]", name: "fake-slow" },
  { modelId: "twin[effort=low]", name: "twin" },
  { modelId: "twin[effort=high]", name: "twin" },
];
const surface = process.env.FAKE_CURSOR_MODEL_SURFACE ?? "both";
const noModels = process.env.FAKE_CURSOR_NO_MODELS === "1";
const modelsState = (session) => ({ currentModelId: session.model, availableModels: MODELS });
const configOptions = (session) =>
  noModels || surface === "state"
    ? []
    : [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: session.model,
          options: MODELS.map((model) => ({ value: model.modelId, name: model.name })),
        },
      ];
const modelFields = (session) => (noModels || surface === "options" ? {} : { models: modelsState(session) });
// The log never holds image data: an image block is logged as its size and hash.
const summarizePrompt = (params) => ({
  ...params,
  prompt: (params?.prompt ?? []).map((block) =>
    block?.type === "image"
      ? { type: "image", mimeType: block.mimeType, bytes: Buffer.from(block.data ?? "", "base64").length, sha256: createHash("sha256").update(Buffer.from(block.data ?? "", "base64")).digest("hex") }
      : block,
  ),
});
const knownModel = (value) => MODELS.some((model) => model.modelId === value);

async function runPrompt(id, params) {
  const session = sessions.get(params.sessionId);
  const text = params.prompt.map((block) => block.text ?? "").join("\n");
  cancelled.delete(params.sessionId);
  session.prompts += 1;
  const before = [...session.history];
  session.history.push(text);
  saveSession(params.sessionId, session);
  update(params.sessionId, { sessionUpdate: "agent_thought_chunk", content: { type: "text", text: "thinking" } });
  const sleep = /\[\[sleep:(\d+)\]\]/.exec(text);
  if (sleep) await new Promise((resolve) => setTimeout(resolve, Number(sleep[1])));
  if (text.includes("[[crash]]")) process.exit(3);
  if (text.includes("[[refuse]]")) return reply(id, { stopReason: "refusal" });
  if (text.includes("[[error]]")) {
    // Like Cursor's failed turn: the error text is the one and only reply chunk, then a normal end.
    const failure = text.slice(text.indexOf("[[error]]") + "[[error]]".length);
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: failure } });
    return reply(id, { stopReason: "end_turn" });
  }
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
  if (text.includes("[[mcp-call]]")) {
    const spec = JSON.parse(text.slice(text.indexOf("[[mcp-call]]") + "[[mcp-call]]".length));
    const controller = new AbortController();
    mcpAborts.set(params.sessionId, controller);
    const results = await Promise.all((Array.isArray(spec) ? spec : [spec]).map((call) => mcpCall(params.sessionId, call, controller.signal)));
    mcpAborts.delete(params.sessionId);
    if (controller.signal.aborted) return reply(id, { stopReason: "cancelled" });
    update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: results.join("|") } });
    return reply(id, { stopReason: "end_turn" });
  }
  if (text.includes("[[updates]]")) {
    const items = JSON.parse(text.slice(text.indexOf("[[updates]]") + "[[updates]]".length));
    for (const item of items) {
      if (item.$ === "crash") process.exit(3);
      if (item.$ === "end") return reply(id, { stopReason: item.stopReason });
      if (item.$ === "wait") {
        await new Promise((resolve) => setTimeout(resolve, item.ms));
      } else if (item.$ === "hang") {
        await new Promise((resolve) => {
          const timer = setInterval(() => {
            if (cancelled.has(params.sessionId)) {
              clearInterval(timer);
              resolve();
            }
          }, 20);
        });
        return reply(id, { stopReason: "cancelled" });
      } else if (item.$ === "ask") {
        // A permission request for `item.toolCall`, answered before the next item is sent.
        const requestId = nextRequestId++;
        send({
          id: requestId,
          method: "session/request_permission",
          params: {
            sessionId: params.sessionId,
            toolCall: { status: "pending", ...item.toolCall },
            options: [
              { optionId: "allow", name: "Allow", kind: "allow_once" },
              { optionId: "reject", name: "Reject", kind: "reject_once" },
            ],
          },
        });
        await new Promise((resolve) => waitingForClient.set(requestId, resolve));
      } else if (item.$ === "say") {
        update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: item.text } });
      } else {
        update(params.sessionId, item);
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return reply(id, { stopReason: "end_turn" });
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
  const imageBlocks = params.prompt.filter((block) => block.type === "image");
  const say = text.includes("[[mode]]")
    ? `mode:${session.mode}`
    : text.includes("[[images]]")
      ? `images:${imageBlocks.length}:${imageBlocks.map((block) => `${block.mimeType}/${Buffer.from(block.data ?? "", "base64").length}`).join(",")}`
      : text.includes("[[recall]]")
      ? `recall:${before.join("|")}`
      : /say:(.*)/.exec(text)?.[1];
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
    params: message.method === "session/prompt" ? summarizePrompt(message.params) : message.params,
    ...(message.method === "initialize"
      ? { pid: process.pid, argv: args, env: { CURSOR_CONFIG_DIR: process.env.CURSOR_CONFIG_DIR, CURSOR_DATA_DIR: process.env.CURSOR_DATA_DIR } }
      : {}),
  });
  const { id, method, params } = message;
  switch (method) {
    case "initialize":
      if (process.env.FAKE_CURSOR_NO_INIT === "1") return;
      return reply(id, {
        protocolVersion: Number(process.env.FAKE_CURSOR_PROTOCOL ?? 1),
        // The shape real cursor-agent 2026.10.16 reports (no agentInfo).
        agentCapabilities: {
          loadSession: true,
          mcpCapabilities: { http: true, sse: true },
          promptCapabilities: { audio: false, embeddedContext: false, image: true },
          sessionCapabilities: { list: {} },
          ...(process.env.FAKE_CURSOR_CAPS ? JSON.parse(process.env.FAKE_CURSOR_CAPS) : {}),
        },
        authMethods: process.env.FAKE_CURSOR_AUTH_METHODS
          ? JSON.parse(process.env.FAKE_CURSOR_AUTH_METHODS)
          : [{ id: "cursor_login", name: "Cursor login" }],
      });
    case "authenticate":
      return reply(id, {});
    case "session/new": {
      if (process.env.FAKE_CURSOR_NEW_ERROR) {
        const error = JSON.parse(process.env.FAKE_CURSOR_NEW_ERROR);
        return fail(id, error.code, error.message, error.data);
      }
      const sessionId = storeDir ? `fake-session-${randomUUID().slice(0, 8)}` : `fake-session-${nextSession++}`;
      const session = { model: process.env.FAKE_CURSOR_DEFAULT_MODEL ?? "default[]", mode: process.env.FAKE_CURSOR_START_MODE ?? "agent", prompts: 0, history: [] };
      sessions.set(sessionId, session);
      mcpServers.set(sessionId, params.mcpServers ?? []);
      saveSession(sessionId, session);
      // Like real Cursor: every ACP session leaves a directory in the config dir.
      if (process.env.CURSOR_CONFIG_DIR) mkdirSync(join(process.env.CURSOR_CONFIG_DIR, "acp-sessions", sessionId), { recursive: true });
      return reply(id, { sessionId, modes: modes(), configOptions: configOptions(session), ...modelFields(session) });
    }
    case "session/load": {
      if (process.env.FAKE_CURSOR_LOAD_CRASH === "1") process.exit(3);
      if (process.env.FAKE_CURSOR_LOAD_ERROR) {
        const error = JSON.parse(process.env.FAKE_CURSOR_LOAD_ERROR);
        return fail(id, error.code, error.message, error.data);
      }
      // Like real Cursor: bare "Invalid params" with the reason in `data`.
      if (storeDir && !existsSync(storeFile(params.sessionId))) {
        return fail(id, -32602, "Invalid params", { message: `Session "${params.sessionId}" not found` });
      }
      const history = storeDir ? JSON.parse(readFileSync(storeFile(params.sessionId), "utf8")).history : [];
      const session = { model: process.env.FAKE_CURSOR_DEFAULT_MODEL ?? "default[]", mode: process.env.FAKE_CURSOR_START_MODE ?? "agent", prompts: 0, history, loaded: true };
      const moved = process.env.FAKE_CURSOR_LOAD_RENAMES === "1" ? `${params.sessionId}-moved` : undefined;
      sessions.set(moved ?? params.sessionId, session);
      mcpServers.set(moved ?? params.sessionId, params.mcpServers ?? []);
      if (moved) saveSession(moved, session);
      // Like a real agent, replay history as updates before answering.
      update(params.sessionId, { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "HISTORY" } });
      return reply(id, {
        ...(moved ? { sessionId: moved } : {}),
        modes: modes(),
        configOptions: configOptions(session),
        ...modelFields(session),
      });
    }
    case "session/set_mode":
      sessions.get(params.sessionId).mode = params.modeId;
      return reply(id, {});
    case "session/set_model":
      if (noModels || surface === "options" || !knownModel(params.modelId)) {
        return fail(id, -32602, "Invalid params");
      }
      sessions.get(params.sessionId).model = params.modelId;
      return reply(id, {});
    case "session/set_config_option":
      if (params.configId === "model") {
        if (!knownModel(params.value)) return fail(id, -32602, `Invalid model value: ${params.value}`);
        sessions.get(params.sessionId).model = params.value;
      }
      return reply(id, { configOptions: configOptions(sessions.get(params.sessionId)) });
    case "session/prompt":
      return void runPrompt(id, params).then(() => {
        if (process.env.FAKE_CURSOR_LOG_END === "1") log({ method: "prompt/end", params: { sessionId: params.sessionId } });
      });
    case "session/cancel":
      if (process.env.FAKE_CURSOR_IGNORE_CANCEL !== "1") {
        cancelled.add(params.sessionId);
        mcpAborts.get(params.sessionId)?.abort();
      }
      return;
    default:
      if (id !== undefined) fail(id, -32601, `method not found: ${method}`);
  }
});
rl.on("close", () => {
  if (process.env.FAKE_CURSOR_IGNORE_STDIN_EOF !== "1") process.exit(0);
});

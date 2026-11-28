#!/usr/bin/env node
// The live tier's turn meter (epic-regression-gate ticket 4.5): `scripts/regression.sh live` puts a `cursor-agent`
// shim first on PATH (and in CURSOR_AGENT_BIN) that runs this file in front of the pinned cursor-agent. Every live
// test reaches Cursor through it, whatever the path (the Gateway, `openclaw agent --local`, or a test's own ACP
// client), so it sees every real turn.
//
//   OAC_LIVE_REAL_AGENT=<launcher> OAC_LIVE_TURN_LOG=<file> OAC_LIVE_TURN_CAP=<n> node turn-meter.mjs <args...>
//
// Any run but `acp` (`--version`, `status`, `about`, `models`) execs the real launcher unchanged. An `acp` run is a
// line proxy: client lines go to the real agent's stdin, its stdout lines come back unchanged. Each `session/prompt`
// request is one turn: it appends `{kind: "prompt", at, pid, sessionId}` to the log (JSON lines, shared by every
// process of the run) and its answer `{kind: "done", at, sessionId, stopReason | error}`. Once the log holds the cap's
// number of turns, a further prompt is not sent: it is answered with the JSON-RPC error "turn cap <n> reached" and
// logged as `{kind: "refused"}`. An OpenClaw tool call (Cursor's title `openclaw: <tool>`) that ends is logged as
// `{kind: "tool", sessionId, tool, status}`. Nothing in the log is secret: no prompt text, no tool input, no key.
import { spawn } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";

const real = process.env.OAC_LIVE_REAL_AGENT;
const logFile = process.env.OAC_LIVE_TURN_LOG;
const cap = Number(process.env.OAC_LIVE_TURN_CAP ?? "0");
if (!real || !logFile) {
  process.stderr.write("turn-meter: OAC_LIVE_REAL_AGENT and OAC_LIVE_TURN_LOG must be set\n");
  process.exit(2);
}
const args = process.argv.slice(2);
const proxy = args.includes("acp");

const log = (entry) => {
  try {
    appendFileSync(logFile, `${JSON.stringify({ at: Date.now(), pid: process.pid, ...entry })}\n`);
  } catch {
    // A meter that cannot write must not break the turn.
  }
};

/** Turns started so far by every process of the run. */
const turnsSoFar = () => {
  try {
    return readFileSync(logFile, "utf8")
      .split("\n")
      .filter((line) => line.includes('"kind":"prompt"')).length;
  } catch {
    return 0;
  }
};

const child = spawn(real, args, { stdio: [proxy ? "pipe" : "inherit", proxy ? "pipe" : "inherit", "inherit"] });
for (const signal of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(signal, () => {
    try {
      child.kill(signal);
    } catch {
      // Already gone.
    }
  });
}
child.on("error", (error) => {
  process.stderr.write(`turn-meter: could not start ${real}: ${error.message}\n`);
  process.exit(127);
});
child.on("exit", (code, signal) => {
  if (signal) {
    process.removeAllListeners(signal);
    process.kill(process.pid, signal);
  } else {
    process.exit(code ?? 1);
  }
});

if (proxy) {
  /** JSON-RPC ids of the prompts in flight, with their session ids. */
  const pending = new Map();
  /** A `data` handler that calls `onLine` per complete line (with its newline); `.flush()` hands over the rest. */
  const splitLines = (onLine) => {
    let buffered = "";
    const handler = (chunk) => {
      buffered += chunk.toString("utf8");
      let end;
      while ((end = buffered.indexOf("\n")) >= 0) {
        onLine(buffered.slice(0, end + 1));
        buffered = buffered.slice(end + 1);
      }
    };
    handler.flush = () => {
      if (buffered) onLine(buffered);
      buffered = "";
    };
    return handler;
  };
  const parse = (line) => {
    try {
      return JSON.parse(line);
    } catch {
      return undefined;
    }
  };

  child.stdin.on("error", () => {});
  const fromClient = splitLines((line) => {
    const message = line.includes('"session/prompt"') ? parse(line) : undefined;
    if (message?.method === "session/prompt" && message.id !== undefined) {
      const sessionId = typeof message.params?.sessionId === "string" ? message.params.sessionId : undefined;
      if (cap > 0 && turnsSoFar() >= cap) {
        log({ kind: "refused", sessionId, cap });
        process.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", id: message.id, error: { code: -32603, message: `turn cap ${cap} reached` } })}\n`);
        return;
      }
      pending.set(JSON.stringify(message.id), sessionId);
      log({ kind: "prompt", sessionId });
    }
    child.stdin.write(line);
  });
  process.stdin.on("data", fromClient);
  process.stdin.on("end", () => {
    fromClient.flush();
    child.stdin.end();
  });

  /** OpenClaw tool calls seen, by ACP tool call id: the tool's name, once Cursor's update names it. */
  const openclawCalls = new Map();
  /** Logs `{kind: "tool", sessionId, tool, status}` when an OpenClaw tool call ends (#102: which tool did the work). */
  const watchToolCall = (line) => {
    const message = parse(line);
    const update = message?.params?.update;
    if (message?.method !== "session/update" || typeof update?.toolCallId !== "string") return;
    // Only during a prompt: `session/load` replays an earlier turn's tool calls as updates too.
    if (![...pending.values()].includes(message.params.sessionId)) return;
    // Cursor titles an MCP call `<server>: <tool>`; only the plugin's server name and a plain tool name are logged.
    const named = typeof update.title === "string" ? /^openclaw: ([a-z_]+)$/.exec(update.title)?.[1] : undefined;
    if (named) openclawCalls.set(update.toolCallId, named);
    const tool = openclawCalls.get(update.toolCallId);
    if (tool && (update.status === "completed" || update.status === "failed")) {
      openclawCalls.delete(update.toolCallId);
      log({ kind: "tool", sessionId: message.params.sessionId, tool, status: update.status });
    }
  };

  const fromAgent = splitLines((line) => {
    process.stdout.write(line);
    if (line.includes('"session/update"') && line.includes('"toolCallId"')) watchToolCall(line);
    if (pending.size === 0 || line.includes('"method"')) return;
    const message = parse(line);
    const key = message && message.id !== undefined ? JSON.stringify(message.id) : undefined;
    if (key === undefined || !pending.has(key) || message.method !== undefined) return;
    const sessionId = pending.get(key);
    pending.delete(key);
    log(message.error ? { kind: "done", sessionId, error: String(message.error.message ?? "error").slice(0, 200) } : { kind: "done", sessionId, stopReason: message.result?.stopReason });
  });
  child.stdout.on("data", fromAgent);
  child.stdout.on("end", () => fromAgent.flush());
}

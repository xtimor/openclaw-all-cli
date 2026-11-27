import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, sep } from "node:path";
import { describe } from "vitest";
import { FAKE_CURSOR_AGENT } from "../fixtures/paths.ts";
import { openclaw, openclawAsync, startGateway, waitFor, type OpenClawResult, type TestGateway } from "../live/harness.ts";

/**
 * The Gateway regression tier (epic-regression-gate): the packed plugin in a fresh OpenClaw of a chosen
 * version, a real Gateway, and `fake-cursor-agent` as the CLI. Run it with `scripts/regression.sh gateway`,
 * which prepares `.regression/openclaw-<version>` and sets `SPIKE_DIR` to it; the files run only with
 * `OPENCLAW_ALL_CLI_REGRESSION=1`, so `npm test` skips them and starts no Gateway.
 */
export const REGRESSION = process.env.OPENCLAW_ALL_CLI_REGRESSION === "1";

/** Per-test timeout: a Gateway start, the plugin's catalog load, and a few fake turns. */
export const REGRESSION_TIMEOUT_MS = 300_000;

/** The plugin's config key for the CLI command. */
export const CURSOR_COMMAND_KEY = "plugins.entries.openclaw-all-cli.config.cursor-cli.command";

/**
 * `describe` when the tier is enabled, `describe.skip` otherwise. Enabled, it refuses to run against any
 * OpenClaw but one under `.regression/`: the dev setup (`.spike/`) and `~/.openclaw` are never touched.
 */
export const describeRegression: typeof describe = REGRESSION ? guardedDescribe() : (describe.skip as typeof describe);

function guardedDescribe(): typeof describe {
  const spike = process.env.SPIKE_DIR ?? "";
  if (!spike.includes(`${sep}.regression${sep}`)) {
    throw new Error(`The Gateway regression tier runs only through scripts/regression.sh (SPIKE_DIR under .regression/, got '${spike}').`);
  }
  return describe;
}

/** A free TCP port on the loopback interface. */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export type FakeCommand = {
  /** The executable shim to set as `cursor-cli.command`. */
  command: string;
  /** The fake's request log (`FAKE_CURSOR_LOG`), one JSON line per request. */
  log: string;
  /** One line per process the shim started (its pid), so a test can stop what the Gateway left. */
  pids: string;
};

const shellQuote = (value: string): string => `'${value.replace(/'/g, `'\\''`)}'`;

/**
 * Writes an executable shim `<root>/<name>` that runs `fake-cursor-agent` with a request log and the
 * given `FAKE_CURSOR_*` knobs. The shim execs the fake, so the pid it records is the fake's own.
 */
export function fakeCommand(root: string, name: string, env: Record<string, string> = {}): FakeCommand {
  const command = join(root, name);
  const log = join(root, `${name}.jsonl`);
  const pids = join(root, `${name}.pids`);
  const exports = Object.entries({ ...env, FAKE_CURSOR_LOG: log })
    .map(([key, value]) => `export ${key}=${shellQuote(value)}\n`)
    .join("");
  writeFileSync(
    command,
    `#!/bin/sh\n${exports}echo $$ >> ${shellQuote(pids)}\nexec ${shellQuote(process.execPath)} ${shellQuote(FAKE_CURSOR_AGENT)} "$@"\n`,
  );
  chmodSync(command, 0o755);
  return { command, log, pids };
}

/** One request the fake logged, with the pid of the process that logged it. */
export type FakeLogEntry = { method?: string; params?: any; t: number; pid?: number; [key: string]: unknown };

/** The fake's request log, parsed; empty when the fake never ran. */
export function readFakeLog(file: string): FakeLogEntry[] {
  if (!existsSync(file)) return [];
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as FakeLogEntry);
}

/** The text of a logged `session/prompt` (its text blocks, joined as the fake joins them). */
export function promptText(entry: FakeLogEntry): string {
  const blocks = (entry.params?.prompt ?? []) as Array<{ text?: string }>;
  return blocks.map((block) => block.text ?? "").join("\n");
}

/** Sets config values with `openclaw config set`: strings as they are, anything else as strict JSON. */
export function configure(entries: Record<string, unknown>): void {
  for (const [key, value] of Object.entries(entries)) {
    const args =
      typeof value === "string" ? ["config", "set", key, value] : ["config", "set", key, JSON.stringify(value), "--strict-json"];
    const result = openclaw(args, { timeoutMs: 30_000 });
    if (result.status !== 0) throw new Error(`openclaw config set ${key} failed:\n${result.stdout}${result.stderr}`);
  }
}

type ProcessRow = { pid: number; ppid: number; pgid: number; args: string };

/** Every process on the host now (pid, parent, group, command line), from one `ps` snapshot. */
function processTable(): Map<number, ProcessRow> {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid=,pgid=,args="], { encoding: "utf8" });
  const table = new Map<number, ProcessRow>();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (match) table.set(Number(match[1]), { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4]! });
  }
  return table;
}

/** SIGKILL to one process, ignoring one that is already gone. */
function killPid(pid: number): void {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // Gone in between.
  }
}

/** The pids the shim recorded, read from its file. */
function recordedPids(fake: FakeCommand): number[] {
  if (!existsSync(fake.pids)) return [];
  return readFileSync(fake.pids, "utf8")
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0);
}

/**
 * The recorded pids that still run fake-cursor-agent. A pid whose command line no longer names the fake was
 * recycled by an unrelated process and is left alone.
 */
export function liveFakes(fake: FakeCommand): number[] {
  const table = processTable();
  return recordedPids(fake).filter((pid) => table.get(pid)?.args.includes(FAKE_CURSOR_AGENT) === true);
}

/** SIGKILL to every recorded process that is still the fake (see `liveFakes`), one process at a time. */
export function killFakes(fake: FakeCommand): void {
  for (const pid of liveFakes(fake)) killPid(pid);
}

/**
 * The end of a scenario file (its `afterAll`): stops the Gateway, waits a moment for the plugin to stop the fake's
 * processes, SIGKILLs any left (with a warning naming them), and removes the file's temp dir.
 */
export async function finishRegression(parts: { stop?: () => Promise<void>; fakes?: Array<FakeCommand | undefined>; root?: string }): Promise<void> {
  // The fakes are killed and the temp dir removed even when the stop throws; the stop's error still fails the hook.
  try {
    await parts.stop?.();
  } finally {
    for (const fake of parts.fakes ?? []) {
      if (!fake) continue;
      await waitFor(() => liveFakes(fake).length === 0, 10_000, 250);
      const leftover = liveFakes(fake);
      if (leftover.length > 0) console.warn(`fake cursor-agent processes left after the Gateway stopped: ${leftover.join(", ")}`);
      killFakes(fake);
    }
    if (parts.root) rmSync(parts.root, { recursive: true, force: true });
  }
}

/** The text of a chat message: a string, or the text parts of its `content` (string or parts), or its `text`. */
export function chatMessageText(message: any): string {
  if (typeof message === "string") return message;
  if (typeof message?.content === "string") return message.content;
  if (Array.isArray(message?.content)) return message.content.map((part: { text?: unknown }) => (typeof part?.text === "string" ? part.text : "")).join("");
  return typeof message?.text === "string" ? message.text : "";
}

export type RegressionGateway = TestGateway & {
  /**
   * What the readiness wait saw: `cursor-cli` (the catalog listed a cursor-cli model) or `empty` (this
   * OpenClaw listed no model at all, so the catalog could not show readiness; see `startRegressionGateway`).
   */
  catalog: "cursor-cli" | "empty";
  /** The file that holds the Gateway's console log (stdout and stderr), when one was asked for; see `gatewayLog`. */
  log?: string;
  /** Stops the Gateway's process group, then SIGKILLs every process of its tree that is still there. */
  stop(): Promise<void>;
};

/** The Gateway's process tree and process group (the Gateway included), from one snapshot. */
function gatewayProcesses(root: number): ProcessRow[] {
  const table = processTable();
  const found = new Map<number, ProcessRow>();
  const queue = [root];
  while (queue.length > 0) {
    const pid = queue.shift()!;
    const row = table.get(pid);
    if (row && !found.has(pid)) found.set(pid, row);
    for (const child of table.values()) if (child.ppid === pid && !found.has(child.pid)) queue.push(child.pid);
  }
  for (const row of table.values()) if (row.pgid === root) found.set(row.pid, row);
  return [...found.values()];
}

/**
 * One `models.list` call: the IDs of the `cursor-cli` rows and the number of all rows, or why the call failed. A
 * cursor-cli row is listed only while the plugin's catalog says the CLI's login works (OpenClaw 2026.10.3).
 */
export function cursorCatalog(port: number): { cursor: string[]; all: number } | { error: string } {
  const listed = openclaw(["gateway", "call", "models.list", "--params", "{}", "--port", String(port), "--json", "--timeout", "10000"], {
    timeoutMs: 15_000,
  });
  if (listed.status !== 0) return { error: `exit ${listed.status}: ${listed.stdout}${listed.stderr}`.slice(0, 2_000) };
  try {
    const models = (JSON.parse(listed.stdout) as { models?: Array<{ provider?: string; id?: string }> }).models;
    if (!Array.isArray(models)) return { error: `no models array: ${listed.stdout.slice(0, 2_000)}` };
    return { cursor: models.filter((model) => model.provider === "cursor-cli").map((model) => String(model.id)), all: models.length };
  } catch {
    return { error: `not JSON: ${listed.stdout.slice(0, 2_000)}` };
  }
}

/**
 * `startGateway`, then a wait until the Gateway's catalog lists a `cursor-cli/` model: the plugin's catalog
 * loads several seconds after the port opens (about 12 s on OpenClaw 2026.10.3), and a turn before it sees no
 * plugin rows. Throws (after stopping the Gateway) when other providers are listed but cursor-cli never is, or
 * when `models.list` keeps failing.
 *
 * An OpenClaw whose successful `models.list` calls list no model at all for `emptyMs` (2026.11.10 offline: its
 * catalog comes from catalog.openclaw.ai, so the list is empty for every provider) cannot show readiness this
 * way: the wait then ends with `catalog: "empty"` and the turns themselves are the check.
 *
 * Budget: the health wait and the readiness wait take at most `timeoutMs` each, plus one call and a stop, so
 * the whole start stays well under a 300 s hook. `onStarted` gets the stop function as soon as the Gateway
 * answers, so a caller's `afterAll` can stop it even when the readiness wait is cut short.
 */
export async function startRegressionGateway(
  port: number,
  options: { timeoutMs?: number; emptyMs?: number; logFile?: string; onStarted?: (stop: () => Promise<void>) => void } = {},
): Promise<RegressionGateway> {
  const { timeoutMs = 90_000, emptyMs = 30_000, logFile } = options;
  // No secret reaches the tier: the fake CLI needs no key, and a real one must not leak into a fresh state.
  const gateway = await startGateway(port, {
    timeoutMs,
    omitEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"],
    ...(logFile === undefined ? {} : { logFile }),
  });
  let stopped: Promise<void> | undefined;
  const stop = () =>
    (stopped ??= (async () => {
      // OpenClaw starts workers (and the plugin its CLIs) in process groups of their own: note the tree first.
      const before = gatewayProcesses(gateway.pid);
      await gateway.stop();
      const now = processTable();
      // Only a pid that still runs the same command line is ours; a recycled pid is left alone.
      for (const row of before) if (now.get(row.pid)?.args === row.args) killPid(row.pid);
    })());
  options.onStarted?.(stop);
  try {
    const started = Date.now();
    let sawModels = false;
    let lastError: string | undefined;
    let catalog: RegressionGateway["catalog"] | undefined;
    while (catalog === undefined && Date.now() - started < timeoutMs) {
      const rows = cursorCatalog(port);
      if ("error" in rows) lastError = rows.error;
      else if (rows.cursor.length > 0) catalog = "cursor-cli";
      else if (rows.all > 0) sawModels = true;
      else if (!sawModels && Date.now() - started >= emptyMs) catalog = "empty";
      if (catalog === undefined) await new Promise((resolve) => setTimeout(resolve, 2_000));
    }
    if (catalog === undefined) {
      throw new Error(
        sawModels
          ? `The Gateway on port ${port} never listed a cursor-cli model: the plugin's catalog did not load.`
          : `The Gateway on port ${port} gave no usable models.list answer. Last failure: ${lastError ?? "none"}`,
      );
    }
    if (catalog === "empty") console.warn(`The Gateway on port ${port} lists no model at all; the turns alone show whether the plugin works.`);
    return { ...gateway, catalog, stop, ...(logFile === undefined ? {} : { log: logFile }) };
  } catch (error) {
    await stop();
    throw error;
  }
}

/** The Gateway's console log so far (see `startRegressionGateway`'s `logFile`), without color codes; empty when there is none. */
export function gatewayLog(gateway: RegressionGateway): string {
  if (gateway.log === undefined || !existsSync(gateway.log)) return "";
  // eslint-disable-next-line no-control-regex
  return readFileSync(gateway.log, "utf8").replace(/\u001b\[[0-9;]*m/g, "");
}

/**
 * One Gateway RPC with `openclaw gateway call <method> --json`: the parsed answer, or a thrown error that carries
 * the CLI's output. `timeoutMs` is the call's own limit (default 15 s; `models.probe` runs a CLI turn and needs more).
 */
export function gatewayCall(port: number, method: string, params: unknown = {}, timeoutMs = 15_000): any {
  const called = openclaw(["gateway", "call", method, "--params", JSON.stringify(params), "--port", String(port), "--json", "--timeout", String(timeoutMs)], {
    timeoutMs: timeoutMs + 15_000,
  });
  const output = `openclaw gateway call ${method} ${JSON.stringify(params)}: exit ${called.status}\n--- stdout\n${called.stdout}\n--- stderr\n${called.stderr}`;
  if (called.status !== 0) throw new Error(output.slice(0, 4_000));
  try {
    return JSON.parse(called.stdout);
  } catch {
    throw new Error(`not JSON: ${output.slice(0, 4_000)}`);
  }
}

/**
 * The pids of the chat processes in these log lines: the processes that received a `session/prompt` (whose text
 * holds `marker`, when given), each once, in the order of their first prompt. A process that never got a prompt,
 * such as the catalog's model listing (it opens ACP sessions of its own, with `initialize` and `session/new`), is
 * not one.
 */
export function chatPids(lines: readonly FakeLogEntry[], marker?: string): number[] {
  const pids = lines
    .filter((line) => line.method === "session/prompt" && typeof line.pid === "number")
    .filter((line) => marker === undefined || promptText(line).includes(marker))
    .map((line) => line.pid as number);
  return [...new Set(pids)];
}

/** The log lines of one process (by the pid the fake logs on every line). */
export function linesOf(lines: readonly FakeLogEntry[], pid: number): FakeLogEntry[] {
  return lines.filter((line) => line.pid === pid);
}

/** Whether `pid` still runs fake-cursor-agent (a recycled pid that runs something else counts as gone). */
export function fakeAlive(pid: number): boolean {
  return processTable().get(pid)?.args.includes(FAKE_CURSOR_AGENT) === true;
}

/** One turn through the Gateway with `openclaw agent` (the CLI reaches it through `OPENCLAW_GATEWAY_PORT`). */
export function gatewayAgentTurn(port: number, sessionId: string, message: string, timeoutMs = 180_000): Promise<OpenClawResult> {
  return openclawAsync(["agent", "--session-id", sessionId, "--message", message], {
    timeoutMs,
    env: { OPENCLAW_GATEWAY_PORT: String(port) },
  });
}

/** One `event` frame from the Gateway. */
export type ChatFrame = { event: string; payload: any };

export type ChatSendResult = {
  /** The `chat.send` response payload (it carries the run's `runId`). */
  response: any;
  runId: string | undefined;
  /** Every `chat` frame of this run, in receive order. */
  frames: ChatFrame[];
  /** Every event frame the client saw while the run went on, for failure messages. */
  seen: ChatFrame[];
};

/**
 * Sends one message the way the Control UI does: an operator ws client (scopes read, write, admin) calls
 * `chat.send` `{sessionKey, message, idempotencyKey}` and collects the run's `chat` frames until one with
 * `state` `final`, `error`, or `aborted` (plus `settleMs`, to catch a second final), or until `timeoutMs`
 * passes (then it resolves with what it saw). Needs a Gateway started with `--auth none`.
 */
export async function chatSend(
  port: number,
  sessionKey: string,
  message: string,
  options: { timeoutMs?: number; settleMs?: number } = {},
): Promise<ChatSendResult> {
  const { timeoutMs = 180_000, settleMs = 2_000 } = options;
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const seen: ChatFrame[] = [];
  const result: ChatSendResult = { response: undefined, runId: undefined, frames: [], seen };
  const sendId = "chat-send";
  const ofRun = (frame: ChatFrame) =>
    frame.event === "chat" &&
    (result.runId === undefined ? frame.payload?.sessionKey === sessionKey : frame.payload?.runId === result.runId);
  const ended = (frames: ChatFrame[]) => frames.some((frame) => ["final", "error", "aborted"].includes(frame.payload?.state));
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => resolve(), timeoutMs);
      let settle: ReturnType<typeof setTimeout> | undefined;
      const finish = (error?: Error) => {
        clearTimeout(timer);
        clearTimeout(settle);
        if (error) reject(error);
        else resolve();
      };
      const endSoon = () => {
        settle ??= setTimeout(() => finish(), settleMs);
      };
      ws.onerror = () => finish(new Error("The chat client could not reach the Gateway."));
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string; ok?: boolean; payload?: any; error?: unknown };
        if (frame.type === "event" && frame.event === "connect.challenge") {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "connect",
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: { id: "gateway-client", version: "0", platform: "linux", mode: "backend" },
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.admin"],
                caps: [],
                auth: {},
              },
            }),
          );
        } else if (frame.type === "res" && frame.id === "connect") {
          if (!frame.ok) return finish(new Error(`The Gateway refused the chat client: ${JSON.stringify(frame.error)}`));
          ws.send(
            JSON.stringify({
              type: "req",
              id: sendId,
              method: "chat.send",
              params: { sessionKey, message, idempotencyKey: `regression-${Date.now()}-${Math.random().toString(36).slice(2)}` },
            }),
          );
        } else if (frame.type === "res" && frame.id === sendId) {
          if (!frame.ok) return finish(new Error(`chat.send failed: ${JSON.stringify(frame.error)}`));
          result.response = frame.payload;
          if (typeof frame.payload?.runId === "string") {
            result.runId = frame.payload.runId;
            // Frames that came before the response belong to the run only when they carry its id.
            result.frames = result.frames.filter((item) => item.payload?.runId === result.runId);
          }
          if (ended(result.frames)) endSoon();
        } else if (frame.type === "event" && frame.event !== undefined) {
          const item = { event: frame.event, payload: frame.payload };
          seen.push(item);
          if (ofRun(item)) result.frames.push(item);
          if (result.response !== undefined && ended(result.frames)) endSoon();
        }
      };
    });
  } finally {
    ws.close();
  }
  return result;
}

/** One step a setup wizard showed, as `wizard.next` returned it. */
export type WizardStep = { id?: string; type?: string; message?: string; title?: string; sensitive?: boolean; [key: string]: unknown };

export type AuthLoginResult = {
  /** The `models.authLogin` response (`ok`, `payload` or `error`). */
  start: any;
  /** Every step the wizard showed, in order. */
  steps: WizardStep[];
  /** The last `wizard.next` payload (`done`, `status`, `error` when the method failed). */
  final: any;
};

/**
 * Runs a provider login the way the Control UI's Connect provider dialog does: an operator ws client (admin scope)
 * calls `models.authLogin` `{sessionId, authChoice}`, then `wizard.next` until the wizard is done. A text step gets
 * `text` (the key: give a dummy, never a real one), a confirm step "no", any other step is acknowledged. Needs a
 * Gateway started with `--auth none`.
 */
export async function authLogin(port: number, authChoice: string, text: string, timeoutMs = 120_000): Promise<AuthLoginResult> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const pending = new Map<string, (frame: any) => void>();
  let seq = 0;
  const call = (method: string, params: unknown) =>
    new Promise<any>((resolve) => {
      const id = `auth-${++seq}`;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const result: AuthLoginResult = { start: undefined, steps: [], final: undefined };
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`The login did not finish within ${timeoutMs} ms: ${JSON.stringify(result).slice(0, 2_000)}`)), timeoutMs);
      const finish = (error?: Error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      };
      ws.onerror = () => finish(new Error("The login client could not reach the Gateway."));
      ws.onmessage = (event) => {
        const frame = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string; ok?: boolean; payload?: any; error?: unknown };
        if (frame.type === "event" && frame.event === "connect.challenge") {
          ws.send(
            JSON.stringify({
              type: "req",
              id: "connect",
              method: "connect",
              params: {
                minProtocol: 4,
                maxProtocol: 4,
                client: { id: "gateway-client", version: "0", platform: "linux", mode: "backend" },
                role: "operator",
                scopes: ["operator.read", "operator.write", "operator.admin"],
                caps: [],
                auth: {},
              },
            }),
          );
        } else if (frame.type === "res" && frame.id === "connect") {
          if (!frame.ok) return finish(new Error(`The Gateway refused the login client: ${JSON.stringify(frame.error)}`));
          void (async () => {
            const sessionId = `regression-login-${Date.now()}-${Math.random().toString(36).slice(2)}`;
            result.start = await call("models.authLogin", { sessionId, authChoice });
            if (!result.start?.ok) return finish();
            let answer: { stepId: string; value: unknown } | undefined;
            for (let round = 0; round < 20; round += 1) {
              const next = await call("wizard.next", { sessionId, ...(answer ? { answer } : {}) });
              result.final = next?.ok ? next.payload : next;
              const step = next?.payload?.step as WizardStep | undefined;
              if (!next?.ok || next.payload?.done || !step?.id) return finish();
              result.steps.push(step);
              answer = { stepId: step.id, value: step.type === "text" ? text : step.type === "confirm" ? false : true };
            }
            finish(new Error(`The login wizard did not end after 20 steps: ${JSON.stringify(result.steps).slice(0, 2_000)}`));
          })().catch((error: unknown) => finish(error instanceof Error ? error : new Error(String(error))));
        } else if (frame.type === "res" && frame.id !== undefined) {
          pending.get(frame.id)?.(frame);
          pending.delete(frame.id);
        }
      };
    });
  } finally {
    ws.close();
  }
  return result;
}

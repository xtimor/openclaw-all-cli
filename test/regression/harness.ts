import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
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

/** One request the fake logged. */
export type FakeLogEntry = { method?: string; params?: any; t: number; [key: string]: unknown };

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
    const result = openclaw(args);
    if (result.status !== 0) throw new Error(`openclaw config set ${key} failed:\n${result.stdout}${result.stderr}`);
  }
}

/** Whether a process (or, with a negative pid, a process group) exists. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** SIGKILL to every process the shim recorded and to the group it leads, when still there. */
export function killFakes(fake: FakeCommand): void {
  if (!existsSync(fake.pids)) return;
  for (const pid of readFileSync(fake.pids, "utf8").split(/\s+/).map(Number).filter((value) => value > 0)) {
    for (const target of [-pid, pid]) {
      if (!alive(target)) continue;
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Gone in between.
      }
    }
  }
}

/** The pids of the shim's processes that are still running. */
export function liveFakes(fake: FakeCommand): number[] {
  if (!existsSync(fake.pids)) return [];
  return readFileSync(fake.pids, "utf8")
    .split(/\s+/)
    .map(Number)
    .filter((pid) => pid > 0 && alive(pid));
}

export type RegressionGateway = TestGateway & {
  /**
   * What the readiness wait saw: `cursor-cli` (the catalog listed a cursor-cli model) or `empty` (this
   * OpenClaw listed no model at all, so the catalog could not show readiness; see `startRegressionGateway`).
   */
  catalog: "cursor-cli" | "empty";
  /** Stops the Gateway's process group, then SIGKILLs every process of its tree that is still there. */
  stop(): Promise<void>;
};

/** Every descendant of `pid` (children, their children, ...), from one `ps` snapshot. */
function descendants(pid: number): number[] {
  const listed = spawnSync("ps", ["-A", "-o", "pid=,ppid="], { encoding: "utf8" });
  const children = new Map<number, number[]>();
  for (const line of (listed.stdout ?? "").split("\n")) {
    const [child, parent] = line.trim().split(/\s+/).map(Number);
    if (!child || parent === undefined) continue;
    children.set(parent, [...(children.get(parent) ?? []), child]);
  }
  const found: number[] = [];
  const queue = [pid];
  while (queue.length > 0) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child);
      queue.push(child);
    }
  }
  return found;
}

/** The number of `cursor-cli` rows and of all rows in the Gateway's model catalog; undefined when the call failed. */
function catalogRows(port: number): { cursor: number; all: number } | undefined {
  const listed = openclaw(["gateway", "call", "models.list", "--params", "{}", "--port", String(port), "--json", "--timeout", "20000"], {
    timeoutMs: 30_000,
  });
  if (listed.status !== 0) return undefined;
  try {
    const models = (JSON.parse(listed.stdout) as { models?: Array<{ provider?: string }> }).models ?? [];
    return { cursor: models.filter((model) => model.provider === "cursor-cli").length, all: models.length };
  } catch {
    return undefined;
  }
}

/**
 * `startGateway`, then a wait until the Gateway's catalog lists a `cursor-cli/` model: the plugin's catalog
 * loads several seconds after the port opens (about 12 s on OpenClaw 2026.10.3), and a turn before it sees no
 * plugin rows. Throws (after stopping the Gateway) when other providers are listed but cursor-cli never is.
 *
 * An OpenClaw that lists no model at all for `emptyMs` (2026.11.10 offline: its catalog comes from
 * catalog.openclaw.ai, so `models.list` is empty for every provider) cannot show readiness this way: the wait
 * then ends with `catalog: "empty"` and the turns themselves are the check.
 */
export async function startRegressionGateway(
  port: number,
  options: { timeoutMs?: number; emptyMs?: number } = {},
): Promise<RegressionGateway> {
  const { timeoutMs = 120_000, emptyMs = 30_000 } = options;
  // No secret reaches the tier: the fake CLI needs no key, and a real one must not leak into a fresh state.
  const gateway = await startGateway(port, { omitEnv: ["CURSOR_API_KEY", "CURSOR_AUTH_TOKEN"] });
  const stop = async () => {
    // OpenClaw starts workers (and the plugin its CLIs) in process groups of their own: note the whole tree first.
    const tree = descendants(gateway.pid);
    await gateway.stop();
    for (const target of [-gateway.pid, ...tree]) {
      if (!alive(target)) continue;
      try {
        process.kill(target, "SIGKILL");
      } catch {
        // Gone in between.
      }
    }
  };
  const started = Date.now();
  let sawAny = false;
  let catalog: RegressionGateway["catalog"] | undefined;
  await waitFor(
    () => {
      const rows = catalogRows(port);
      if (rows && rows.cursor > 0) catalog = "cursor-cli";
      else if (rows && rows.all > 0) sawAny = true;
      else if (!sawAny && Date.now() - started >= emptyMs) catalog = "empty";
      return catalog !== undefined;
    },
    timeoutMs,
    2_000,
  );
  if (catalog === undefined) {
    await stop();
    throw new Error(`The Gateway on port ${port} never listed a cursor-cli model: the plugin's catalog did not load.`);
  }
  if (catalog === "empty") console.warn(`The Gateway on port ${port} lists no model at all; the turns alone show whether the plugin works.`);
  return { ...gateway, catalog, stop };
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

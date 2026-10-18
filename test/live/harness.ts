import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";
import type { LiveSessionCapability, LiveSessionHandle } from "../../src/core/sdk-types.ts";

/**
 * Live tests drive the real `cursor-agent` through the isolated OpenClaw. They run only with
 * `OPENCLAW_ALL_CLI_LIVE=1`, on a host with a Cursor login, outside any sandbox that hides it.
 * One live test per parity row (AD, conventions): name the row in the `describeLive` title.
 */
/** Per-test timeout for live tests: a cold OpenClaw start plus a real model turn. */
export const LIVE_TIMEOUT_MS = 300_000;

export const LIVE = process.env.OPENCLAW_ALL_CLI_LIVE === "1";

export const describeLive: typeof describe = LIVE ? describe : (describe.skip as typeof describe);

const DEV_SCRIPT = fileURLToPath(new URL("../../scripts/dev-openclaw.sh", import.meta.url));

export type OpenClawResult = { status: number | null; stdout: string; stderr: string };

/** Runs `openclaw <args>` in the isolated setup from `scripts/dev-openclaw.sh`. */
export function openclaw(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {},
): OpenClawResult {
  // OpenClaw mutes its output when it sees a test runner's variables.
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "NODE_ENV")),
    ...options.env,
  };
  const result = spawnSync(DEV_SCRIPT, ["run", ...args], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180_000,
    env,
    ...(options.input === undefined ? {} : { input: options.input }),
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Like `openclaw`, for calls that run at the same time as others or as the test. */
export function openclawAsync(
  args: string[],
  options: { timeoutMs?: number; env?: Record<string, string>; input?: string } = {},
): Promise<OpenClawResult> {
  const env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "NODE_ENV")),
    ...options.env,
  };
  return new Promise((resolve) => {
    const child = spawn(DEV_SCRIPT, ["run", ...args], { env });
    let stdout = "";
    let stderr = "";
    if (options.input !== undefined) child.stdin.end(options.input);
    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString("utf8")));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString("utf8")));
    const timer = setTimeout(() => child.kill("SIGKILL"), options.timeoutMs ?? 180_000);
    child.once("close", (status) => {
      clearTimeout(timer);
      resolve({ status, stdout, stderr });
    });
  });
}

/** Polls until `condition` holds or `timeoutMs` passes. Returns whether it held. */
export async function waitFor(condition: () => boolean | Promise<boolean>, timeoutMs: number, stepMs = 200): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await condition()) return true;
    if (Date.now() >= deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
}

/** The reply lines of `openclaw agent` output: everything that is not a log line. */
export function replyLines(output: string): string[] {
  // eslint-disable-next-line no-control-regex
  const plain = output.replace(/\u001b\[[0-9;]*m/g, "");
  return plain
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("["));
}

/** The test process's env without the test runner's variables, for a spawned CLI. */
export function liveHostEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("VITEST")) env[key] = value;
  }
  return env;
}

/** The host's live-session capability, reduced to what `createExecute` uses. */
export function makeLiveSession(): LiveSessionCapability {
  let current: LiveSessionHandle | undefined;
  return {
    fingerprint: "live-fp",
    current: () => current,
    restart: async () => {
      current?.close("restart");
      current = undefined;
    },
    register: (handle) => {
      current = handle;
    },
    activate: () => {},
    remove: (handle) => {
      if (current === handle) current = undefined;
    },
  };
}

/** Writes the settings file OpenClaw would write for a run: its loopback URL, token, and capture key. */
export function writeSettingsFile(dir: string, name: string, url: string, token: string, capture: string): string {
  const file = join(dir, `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify({
      mcp: { allowed: ["openclaw"] },
      mcpServers: {
        openclaw: { type: "http", url, headers: { Authorization: `Bearer ${token}`, "x-openclaw-cli-capture-key": capture } },
      },
    }),
  );
  return file;
}

/** The isolated OpenClaw's state directory (`.spike/state`), where agent homes live. */
export const ISOLATED_STATE_DIR = fileURLToPath(new URL("../../.spike/state", import.meta.url));

export type TestGateway = {
  port: number;
  env: Record<string, string>;
  /** The Gateway process ID (the dev script execs into OpenClaw, so it is the same process). */
  pid: number;
  /** SIGTERM to the whole process group, then wait for the exit (15 s at most). */
  stop(): Promise<void>;
  /** SIGTERM to the Gateway process alone, not its group (a plain `kill <pid>`), then wait for the exit. */
  terminate(): Promise<void>;
  /** SIGKILL to the Gateway process alone, not its group, then wait for the exit. */
  kill(): Promise<void>;
};

/**
 * Runs an isolated Gateway and waits until it answers. Chat commands reach it through
 * `OPENCLAW_GATEWAY_PORT`; `models list` and `/model` read the catalog it prepares. The plugin
 * loads at startup only when the config names it, for example as the default model
 * (OpenClaw #148584), so set `agents.defaults.model.primary` first.
 */
export async function startGateway(
  port: number,
  options: { timeoutMs?: number; env?: Record<string, string> } = {},
): Promise<TestGateway> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined && !entry[0].startsWith("VITEST") && entry[0] !== "NODE_ENV"),
    ),
    ...options.env,
  };
  const child = spawn(DEV_SCRIPT, ["run", "gateway", "run", "--allow-unconfigured", "--auth", "none", "--port", String(port)], {
    env,
    stdio: "ignore",
    // Its own process group, so one signal reaches every process the Gateway started.
    detached: true,
  });
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  const stop = async () => {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        // Already gone.
      }
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 15_000))]);
  };
  const signalPid = (signal: NodeJS.Signals) => async () => {
    if (child.exitCode === null && child.pid) {
      try {
        process.kill(child.pid, signal);
      } catch {
        // Already gone.
      }
    }
    await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 30_000))]);
  };
  const kill = signalPid("SIGKILL");
  const terminate = signalPid("SIGTERM");
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const probe = openclaw(["gateway", "call", "health", "--port", String(port), "--json", "--timeout", "5000"], { timeoutMs: 15_000 });
    if (probe.status === 0) return { port, env: { OPENCLAW_GATEWAY_PORT: String(port) }, pid: child.pid!, stop, terminate, kill };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await stop();
  throw new Error(`The isolated Gateway did not answer on port ${port}.`);
}

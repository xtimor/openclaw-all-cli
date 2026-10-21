import { spawn, spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { connect, type Socket } from "node:net";
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

/** The isolated OpenClaw's config file (`.spike/openclaw.json`). */
export const ISOLATED_CONFIG_PATH = fileURLToPath(new URL("../../.spike/openclaw.json", import.meta.url));

export type TestGateway = {
  port: number;
  env: Record<string, string>;
  /** The Gateway process ID (the dev script execs into OpenClaw, so it is the same process). */
  pid: number;
  /** SIGTERM to the whole process group, then wait for the exit (15 s at most). */
  stop(): Promise<void>;
  /** SIGTERM to the Gateway process alone, not its group (a plain `kill <pid>`), then wait for the exit. */
  terminate(): Promise<void>;
  /** SIGINT to the Gateway process alone, not its group (Ctrl-C on the Gateway), then wait for the exit. */
  interrupt(): Promise<void>;
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
  options: { timeoutMs?: number; env?: Record<string, string>; omitEnv?: string[] } = {},
): Promise<TestGateway> {
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(
        (entry): entry is [string, string] =>
          entry[1] !== undefined && !entry[0].startsWith("VITEST") && entry[0] !== "NODE_ENV" && !(options.omitEnv ?? []).includes(entry[0]),
      ),
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
  const interrupt = signalPid("SIGINT");
  const deadline = Date.now() + (options.timeoutMs ?? 120_000);
  while (Date.now() < deadline) {
    const probe = openclaw(["gateway", "call", "health", "--port", String(port), "--json", "--timeout", "5000"], { timeoutMs: 15_000 });
    if (probe.status === 0) return { port, env: { OPENCLAW_GATEWAY_PORT: String(port) }, pid: child.pid!, stop, terminate, interrupt, kill };
    await new Promise((resolve) => setTimeout(resolve, 2_000));
  }
  await stop();
  throw new Error(`The isolated Gateway did not answer on port ${port}.`);
}

export type ApprovalClient = {
  /** The pending exec approvals the Gateway holds. */
  list(): Promise<Array<{ id: string; request: { command?: string; [key: string]: unknown } }>>;
  resolve(id: string, decision: "allow-once" | "allow-always" | "deny"): Promise<void>;
  close(): void;
};

/**
 * An operator client that counts as an exec approval surface (`approvals` capability, admin scope).
 * With one connected, OpenClaw holds a command that needs approval as pending instead of denying it
 * as a headless run. Needs a Gateway started with `--auth none`, as `startGateway` does.
 */
export async function connectApprovalClient(port: number, timeoutMs = 15_000): Promise<ApprovalClient> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  let seq = 0;
  const pending = new Map<string, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  const send = (method: string, params: unknown) =>
    new Promise<any>((resolve, reject) => {
      const id = String(++seq);
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ type: "req", id, method, params }));
    });
  const connected = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("The Gateway did not accept the approval client.")), timeoutMs);
    ws.onerror = () => reject(new Error("The approval client could not reach the Gateway."));
    ws.onmessage = (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; event?: string; id?: string; ok?: boolean; payload?: unknown; error?: unknown };
      if (message.type === "event" && message.event === "connect.challenge") {
        send("connect", {
          minProtocol: 4,
          maxProtocol: 4,
          client: { id: "gateway-client", version: "0", platform: "linux", mode: "backend" },
          role: "operator",
          scopes: ["operator.read", "operator.write", "operator.approvals", "operator.admin"],
          caps: ["approvals"],
          auth: {},
        }).then(
          () => {
            clearTimeout(timer);
            resolve();
          },
          reject,
        );
      } else if (message.type === "res" && message.id !== undefined) {
        const waiting = pending.get(message.id);
        pending.delete(message.id);
        if (message.ok) waiting?.resolve(message.payload);
        else waiting?.reject(new Error(JSON.stringify(message.error)));
      }
    };
  });
  await connected;
  return {
    list: () => send("exec.approval.list", {}),
    resolve: async (id, decision) => {
      await send("exec.approval.resolve", { id, decision });
    },
    close: () => ws.close(),
  };
}

export type ToggleProxy = {
  /** `http://127.0.0.1:<port>`, for `HTTPS_PROXY`. */
  url: string;
  /** Answer `403 Forbidden` to every CONNECT to a matching host from now on. */
  block(): void;
  /** Tunnel every CONNECT again. */
  allow(): void;
  /** The `host:port` of each CONNECT it saw, and whether it let it through. */
  seen: Array<{ target: string; blocked: boolean }>;
  close(): Promise<void>;
};

/**
 * A CONNECT proxy for a CLI's HTTPS traffic that a test can switch to failing midway. It chains to the
 * environment's own `HTTPS_PROXY` (a sandbox's egress proxy) when there is one, else connects direct.
 * `blockedHost` picks what `block()` refuses. The default is the host of the model turn
 * (`agentn.*.cursor.sh`): `session/new` talks to other hosts, so blocking it fails the turn after the
 * session started, which is when Cursor reports an error as a reply chunk (cursor-agent 2026.10.19).
 */
export async function startToggleProxy(blockedHost: RegExp = /^agentn\..*\.cursor\.sh$/): Promise<ToggleProxy> {
  let blocked = false;
  const seen: ToggleProxy["seen"] = [];
  const upstream = process.env.HTTPS_PROXY || process.env.https_proxy;
  const tunnels = new Set<Socket>();
  const server: Server = createServer((req, res) => {
    // Only CONNECT tunnels are served; note anything else so a CLI that does not tunnel shows up.
    seen.push({ target: `${req.method} ${req.url}`, blocked: false });
    res.writeHead(405).end();
  });
  server.on("connect", (req, client: Socket, head) => {
    const target = req.url ?? "";
    const host = target.replace(/:\d+$/, "");
    const refuse = blocked && blockedHost.test(host);
    seen.push({ target, blocked: refuse });
    client.on("error", () => {});
    tunnels.add(client);
    client.on("close", () => tunnels.delete(client));
    if (refuse) {
      client.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const finish = (remote: Socket, leftover?: Buffer) => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      if (leftover?.length) client.write(leftover);
      if (head.length) remote.write(head);
      remote.pipe(client);
      client.pipe(remote);
    };
    if (!upstream) {
      const [name, port] = [host, Number(target.slice(host.length + 1)) || 443];
      const remote = connect(port, name, () => finish(remote));
      remote.on("error", () => client.destroy());
      client.on("close", () => remote.destroy());
      return;
    }
    const proxy = new URL(upstream);
    const remote = connect(Number(proxy.port) || 80, proxy.hostname, () => {
      const auth = proxy.username
        ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString("base64")}\r\n`
        : "";
      remote.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${auth}\r\n`);
    });
    remote.on("error", () => client.destroy());
    client.on("close", () => remote.destroy());
    let buffered = Buffer.alloc(0);
    const onData = (chunk: Buffer) => {
      buffered = Buffer.concat([buffered, chunk]);
      const end = buffered.indexOf("\r\n\r\n");
      if (end < 0) return;
      remote.off("data", onData);
      remote.pause();
      const status = /^HTTP\/1\.[01] (\d{3})/.exec(buffered.subarray(0, end).toString("latin1"))?.[1];
      if (status === "200") {
        finish(remote, buffered.subarray(end + 4));
        remote.resume();
      } else {
        client.end(`HTTP/1.1 ${status ?? "502"} Upstream proxy refused\r\nContent-Length: 0\r\n\r\n`);
        remote.destroy();
      }
    };
    remote.on("data", onData);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  return {
    url: `http://127.0.0.1:${port}`,
    block: () => {
      blocked = true;
    },
    allow: () => {
      blocked = false;
    },
    seen,
    close: () =>
      new Promise<void>((resolve) => {
        // A CONNECT socket leaves the HTTP server's care: close the tunnels ourselves.
        for (const tunnel of tunnels) tunnel.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CURSOR_PERMISSIONS } from "../../src/adapters/cursor/index.ts";
import {
  ISOLATED_STATE_DIR,
  LIVE_TIMEOUT_MS,
  connectApprovalClient,
  describeLive,
  openclaw,
  openclawAsync,
  startGateway,
  waitFor,
  type ApprovalClient,
  type TestGateway,
} from "./harness.ts";

const PORT = 18_931;
const WORKSPACE = join(ISOLATED_STATE_DIR, "workspace");
const HOME_CONFIG = join(ISOLATED_STATE_DIR, "agents", "main", "agent", "openclaw-all-cli", "cursor-cli", "cli-config.json");
const CONFIG_KEYS = ["agents.defaults.model.primary", "tools.exec", "tools.deny"] as const;

// Parity rows P8 and P10 (OpenClaw's own `exec` and `process` served to the model; AD-9). Real
// cursor-agent behind one isolated Gateway; needs `npm run dev:install` and CURSOR_API_KEY. The
// plugin writes no exec code: these tests show that OpenClaw's exec policy (approvals, security,
// timeout, abort) governs what the model runs. Every command is a script in a temp dir that
// leaves a marker file, so "ran" and "did not run" are checked on disk, not in the model's words.
describeLive("OpenClaw exec is the model's shell (P8, P10)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-exec-"));
  let gateway: TestGateway;
  const prior = new Map<string, string | undefined>();
  let counter = 0;

  const token = () => randomBytes(8).toString("hex");
  const sessionId = (label: string) => `live-exec-${label}-${Date.now()}`;
  const path = (name: string) => join(root, name);

  /** A script the model runs through `exec`: its output is unguessable, and the marker proves the run. */
  function script(name: string, body: string): string {
    const file = path(`${name}-${counter++}.sh`);
    writeFileSync(file, `#!/bin/sh\n${body}\n`, { mode: 0o755 });
    return file;
  }

  type Turn = { reply: string; tools: string[]; status: number | null; raw: string };

  /** One `openclaw agent` turn through the Gateway. */
  async function ask(id: string, message: string): Promise<Turn> {
    const result = await openclawAsync(["agent", "--session-id", id, "--message", message, "--json", "--timeout", "240"], {
      env: gateway.env,
      timeoutMs: 280_000,
    });
    let reply = "";
    let tools: string[] = [];
    try {
      const start = result.stdout.indexOf("{");
      const json = JSON.parse(result.stdout.slice(start)) as {
        payloads?: Array<{ text?: string }>;
        result?: { payloads?: Array<{ text?: string }>; meta?: { toolSummary?: { tools?: string[] } } };
        meta?: { toolSummary?: { tools?: string[] } };
      };
      const payloads = json.payloads ?? json.result?.payloads ?? [];
      reply = payloads.map((payload) => payload.text ?? "").join("\n");
      tools = json.meta?.toolSummary?.tools ?? json.result?.meta?.toolSummary?.tools ?? [];
    } catch {
      reply = result.stdout;
    }
    return { reply, tools, status: result.status, raw: result.stdout + result.stderr };
  }

  const runIt = (file: string, note = "") =>
    `Use the OpenClaw exec tool to run exactly this command: sh ${file}\n${note}Then reply with what the command printed.`;

  function setConfig(key: string, value: string, json = false) {
    const result = openclaw(["config", "set", key, value, ...(json ? ["--strict-json"] : [])]);
    expect(result.status, result.stderr).toBe(0);
  }

  function readConfig(key: string): string | undefined {
    const result = openclaw(["config", "get", key, "--json"]);
    return result.status === 0 ? result.stdout.trim() : undefined;
  }

  function restoreConfig() {
    for (const key of CONFIG_KEYS) {
      const value = prior.get(key);
      if (value === undefined) openclaw(["config", "unset", key]);
      else openclaw(["config", "set", key, value, "--strict-json"]);
    }
  }

  const isAlive = (pid: number): boolean => {
    try {
      // A zombie is gone for our purposes: its parent has not reaped it yet.
      return !/^\d+ \(.*\) Z /.test(readFileSync(`/proc/${pid}/stat`, "utf8"));
    } catch {
      return false;
    }
  };

  beforeAll(async () => {
    expect(process.env.CURSOR_API_KEY, "CURSOR_API_KEY is needed").toBeTruthy();
    for (const key of CONFIG_KEYS) prior.set(key, readConfig(key));
    setConfig("agents.defaults.model.primary", "cursor-cli/auto");
    // Start from the default exec policy whatever the isolated state held before.
    openclaw(["config", "unset", "tools.exec"]);
    openclaw(["config", "unset", "tools.deny"]);
    gateway = await startGateway(PORT);
  }, LIVE_TIMEOUT_MS);

  // Leave nothing behind: every config key, the Gateway, the temp dir.
  afterAll(async () => {
    await gateway?.stop();
    restoreConfig();
    rmSync(root, { recursive: true, force: true });
  }, 180_000);

  it(
    "runs a command through OpenClaw exec in the workspace, while Cursor's home still denies Shell",
    async () => {
      const secret = token();
      const file = script("plain", `printf '%s' ${secret} > ${path("plain.marker")}\necho "out:${secret}:$(pwd)"`);
      const turn = await ask(sessionId("plain"), runIt(file));
      expect(turn.status, turn.raw).toBe(0);
      expect(readFileSync(path("plain.marker"), "utf8")).toBe(secret);
      expect(turn.reply).toContain(secret);
      expect(turn.reply).toContain(WORKSPACE);
      expect(turn.tools).toContain("mcp__openclaw__exec");
      // The static home is untouched: the host's exec is the only shell.
      const home = JSON.parse(readFileSync(HOME_CONFIG, "utf8")) as { permissions: unknown };
      expect(home.permissions).toEqual(CURSOR_PERMISSIONS);
      expect(CURSOR_PERMISSIONS.deny).toContain("Shell(*)");
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "keeps Cursor's native shell and write blocked in agent mode",
    async () => {
      const shellMarker = path("native-shell.marker");
      const writeMarker = path("native-write.marker");
      const shell = await ask(
        sessionId("native-shell"),
        `Do not use MCP or OpenClaw tools. Use only your built-in Shell tool to run exactly: touch ${shellMarker} . Then say what happened.`,
      );
      expect(shell.status, shell.raw).toBe(0);
      const write = await ask(
        sessionId("native-write"),
        `Do not use MCP or OpenClaw tools. Use only your built-in file write tool to create the file ${writeMarker} containing "hi". Then say what happened.`,
      );
      expect(write.status, write.raw).toBe(0);
      expect(existsSync(shellMarker)).toBe(false);
      expect(existsSync(writeMarker)).toBe(false);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "holds a command for approval when tools.exec.ask is always, runs it after allow-once, and never runs it after deny",
    async () => {
      setConfig("tools.exec.ask", "always");
      const client: ApprovalClient = await connectApprovalClient(PORT);
      try {
        for (const decision of ["allow-once", "deny"] as const) {
          const secret = token();
          const marker = path(`approval-${decision}.marker`);
          const file = script(`approval-${decision}`, `printf '%s' ${secret} > ${marker}\necho "out:${secret}"`);
          const turn = ask(sessionId(`approval-${decision}`), runIt(file));
          let id: string | undefined;
          const appeared = await waitFor(async () => {
            id = (await client.list()).find((entry) => entry.request.command?.includes(file))?.id;
            return id !== undefined;
          }, 200_000, 1_000);
          expect(appeared, "no pending approval for the command").toBe(true);
          // Pending means not run yet.
          expect(existsSync(marker)).toBe(false);
          await client.resolve(id!, decision);
          const done = await turn;
          expect(done.status, done.raw).toBe(0);
          if (decision === "allow-once") {
            expect(readFileSync(marker, "utf8")).toBe(secret);
            expect(done.reply).toContain(secret);
          } else {
            expect(existsSync(marker)).toBe(false);
            expect(done.reply).not.toContain(secret);
          }
        }
      } finally {
        client.close();
        openclaw(["config", "unset", "tools.exec"]);
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "never runs a command when tools.exec.security is deny, and the model gets OpenClaw's denial",
    async () => {
      setConfig("tools.exec.security", "deny");
      try {
        const secret = token();
        const marker = path("security-deny.marker");
        const file = script("security-deny", `printf '%s' ${secret} > ${marker}\necho "out:${secret}"`);
        const turn = await ask(sessionId("security-deny"), runIt(file));
        expect(turn.status, turn.raw).toBe(0);
        // The model did call exec; it is OpenClaw that said no.
        expect(turn.tools).toContain("mcp__openclaw__exec");
        expect(existsSync(marker)).toBe(false);
        expect(turn.reply).not.toContain(secret);
        expect(turn.reply.length).toBeGreaterThan(0);
      } finally {
        openclaw(["config", "unset", "tools.exec"]);
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "takes exec and process away from the model with tools.deny, and no command runs",
    async () => {
      setConfig("tools.deny", '["exec","process"]', true);
      try {
        const marker = path("tools-deny.marker");
        const file = script("tools-deny", `touch ${marker}`);
        const turn = await ask(sessionId("tools-deny"), runIt(file));
        expect(turn.status, turn.raw).toBe(0);
        expect(turn.tools.filter((name) => /exec|process/.test(name))).toEqual([]);
        expect(existsSync(marker)).toBe(false);
      } finally {
        openclaw(["config", "unset", "tools.deny"]);
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "kills a command that exceeds the exec timeout",
    async () => {
      const started = path("timeout.started");
      const finished = path("timeout.finished");
      const file = script("timeout", `touch ${started}\nsleep 20\ntouch ${finished}`);
      const turn = await ask(sessionId("timeout"), runIt(file, "Set the exec tool's timeout parameter to 3 seconds.\n"));
      expect(turn.status, turn.raw).toBe(0);
      expect(existsSync(started)).toBe(true);
      // The script would finish 20 s after it started: wait past that and see it never did.
      await new Promise((resolve) => setTimeout(resolve, 22_000));
      expect(existsSync(finished)).toBe(false);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "relays a long-running call (20 s) and its output",
    async () => {
      const secret = token();
      const file = script("long", `sleep 20\nprintf '%s' ${secret} > ${path("long.marker")}\necho "out:${secret}"`);
      const turn = await ask(sessionId("long"), runIt(file));
      expect(turn.status, turn.raw).toBe(0);
      expect(readFileSync(path("long.marker"), "utf8")).toBe(secret);
      expect(turn.reply).toContain(secret);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "completes the turn when a command prints about 3 MB",
    async () => {
      const marker = path("huge.marker");
      const file = script("huge", `head -c 3000000 /dev/zero | tr '\\000' x\necho\ntouch ${marker}\necho done-huge`);
      const turn = await ask(sessionId("huge"), runIt(file));
      expect(turn.status, turn.raw).toBe(0);
      expect(existsSync(marker)).toBe(true);
      expect(turn.reply.length).toBeGreaterThan(0);
      // OpenClaw's output cap applies: the reply is a model answer, not 3 MB.
      expect(turn.reply.length).toBeLessThan(100_000);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "reports a non-zero exit code and the output to the model",
    async () => {
      const secret = token();
      const file = script("exit3", `echo "out:${secret}"\nexit 3`);
      const turn = await ask(sessionId("exit3"), runIt(file, "It exits with a non-zero code: report the code too.\n"));
      expect(turn.status, turn.raw).toBe(0);
      expect(turn.reply).toContain(secret);
      expect(turn.reply).toMatch(/\b3\b/);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  it(
    "kills the command when the turn is aborted mid-run",
    async () => {
      const id = sessionId("abort");
      const shPid = path("abort.shpid");
      const sleepPid = path("abort.sleeppid");
      const started = path("abort.started");
      const done = path("abort.done");
      const file = script("abort", `echo $$ > ${shPid}\nsleep 40 &\necho $! > ${sleepPid}\ntouch ${started}\nwait\ntouch ${done}`);
      const turn = ask(id, runIt(file));
      expect(await waitFor(() => existsSync(started), 200_000, 500), "the command never started").toBe(true);
      const startedAt = Date.now();
      const abort = openclaw(["gateway", "call", "sessions.abort", "--params", JSON.stringify({ key: `agent:main:explicit:${id}` }), "--port", String(PORT), "--json"]);
      expect(abort.status, abort.stderr).toBe(0);
      const pids = [Number(readFileSync(shPid, "utf8").trim()), Number(readFileSync(sleepPid, "utf8").trim())];
      const gone = await waitFor(() => pids.every((pid) => !isAlive(pid)), 10_000, 250);
      expect(gone, `the command's processes ${pids.join(", ")} are still alive 10 s after the abort`).toBe(true);
      await turn;
      // The script's follow-up would run when its sleep ended: wait past that.
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, 42_000 - (Date.now() - startedAt))));
      expect(existsSync(done)).toBe(false);
    },
    LIVE_TIMEOUT_MS * 2,
  );

  const docker = spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  it.skipIf(!docker)(
    "runs the command inside the sandbox, or refuses the run, never on the Gateway host",
    async () => {
      setConfig("agents.defaults.sandbox.mode", "all");
      try {
        const marker = path("sandbox.marker");
        const file = script("sandbox", `touch ${marker}\necho sandbox-ran`);
        const turn = await ask(sessionId("sandbox"), runIt(file));
        expect(turn.raw.length).toBeGreaterThan(0);
        // The temp dir is not mounted into a sandbox: a marker here means the command ran on the host.
        expect(existsSync(marker)).toBe(false);
      } finally {
        openclaw(["config", "unset", "agents.defaults.sandbox"]);
      }
    },
    LIVE_TIMEOUT_MS * 2,
  );
  if (!docker) {
    console.info("exec-tool live test: the sandbox row is not run, because `docker info` fails on this host.");
  }
});

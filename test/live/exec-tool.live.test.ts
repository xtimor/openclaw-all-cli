import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { CURSOR_PERMISSIONS } from "../../src/adapters/cursor/index.ts";
import {
  ISOLATED_STATE_DIR,
  LIVE,
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
const PORT_KEYLESS = 18_932;
const WORKSPACE = join(ISOLATED_STATE_DIR, "workspace");
const HOME_CONFIG = join(ISOLATED_STATE_DIR, "agents", "main", "agent", "openclaw-all-cli", "cursor-cli", "cli-config.json");
const CONFIG_KEYS = ["agents.defaults.model.primary", "tools.exec", "tools.deny", "plugins.entries.openclaw-all-cli.config.cursor-cli"] as const;
// Five: a turn can also fail for reasons outside the row (OpenClaw's budget compaction needs an API model).
const TRIES = 5;

// Parity rows P8 and P10 (OpenClaw's own `exec` and `process` served to the model; AD-9). Real
// cursor-agent behind one isolated Gateway; needs `npm run dev:install` and CURSOR_API_KEY. The
// plugin writes no exec code: these tests show that OpenClaw's exec policy (approvals, security,
// timeout, abort) governs what the model runs. Every command is a script in a temp dir that
// leaves a marker file, so "ran" and "did not run" are checked on disk, not in the model's words.
// The model is a language model: a row retries a turn (up to five times) in which it did not do
// what the row needs, such as never calling the tool, and fails loudly if it never does.
describeLive("OpenClaw exec is the model's shell (P8, P10)", () => {
  // Created in beforeAll: a skipped describe still runs its body, and nothing would remove the dir.
  let root = "";
  let gateway: TestGateway;
  const prior = new Map<string, string | undefined>();
  let counter = 0;

  const token = () => randomBytes(8).toString("hex");
  const sessionId = (label: string) => `live-exec-${label}-${Date.now()}-${counter++}`;
  const path = (name: string) => join(root, name);

  /**
   * Shell lines that make an unguessable value when the script runs (the script text never holds
   * it, so a model that merely reads the script cannot quote it).
   */
  const RUNTIME_SECRET = "S=$(od -An -N8 -tx1 /dev/urandom | tr -d ' \\n')";

  /** A script the model runs through `exec`. */
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

  /** Whether the turn called OpenClaw's exec (tools through the MCP proxy show as `mcp__openclaw__<tool>`). */
  const calledExec = (turn: Turn) => turn.tools.includes("mcp__openclaw__exec");

  /**
   * Runs `attempt` up to `TRIES` times, until it returns no complaint. Each try starts from a clean
   * slate (the attempt makes its own script and markers). A complaint after the last try fails the test.
   */
  async function retrying(label: string, attempt: (n: number) => Promise<string | undefined>) {
    const complaints: string[] = [];
    for (let n = 0; n < TRIES; n += 1) {
      const complaint = await attempt(n);
      if (complaint === undefined) return;
      complaints.push(complaint);
    }
    expect.fail(`${label}: no usable try in ${TRIES}: ${complaints.join(" | ")}`);
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
    root = mkdtempSync(join(tmpdir(), "oac-live-exec-"));
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
    if (prior.size > 0) restoreConfig();
    if (root) rmSync(root, { recursive: true, force: true });
  }, 180_000);

  it(
    "runs a command through OpenClaw exec in the workspace, while Cursor's home still denies Shell",
    async () => {
      await retrying("plain", async () => {
        const id = token();
        const marker = path(`plain-${id}.marker`);
        const file = script("plain", `${RUNTIME_SECRET}\nprintf '%s' $S > ${marker}\necho "out:$S:$(pwd)"`);
        const turn = await ask(sessionId("plain"), runIt(file));
        if (!existsSync(marker)) return `the command never ran (tools ${turn.tools.join(",")})`;
        expect(turn.status, turn.raw).toBe(0);
        expect(turn.reply).toContain(readFileSync(marker, "utf8"));
        expect(turn.reply).toContain(WORKSPACE);
        expect(calledExec(turn)).toBe(true);
        // The static home is untouched: the host's exec is the only shell.
        const home = JSON.parse(readFileSync(HOME_CONFIG, "utf8")) as { permissions: unknown };
        expect(home.permissions).toEqual(CURSOR_PERMISSIONS);
        expect(CURSOR_PERMISSIONS.deny).toContain("Shell(*)");
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "keeps Cursor's native shell, write, edit and delete blocked in agent mode, after Cursor really tried them",
    async () => {
      const native = (turn: Turn, name: RegExp) => turn.tools.some((tool) => !tool.startsWith("mcp__") && name.test(tool));
      const cases: Array<{ label: string; tool: RegExp; prepare: () => { prompt: string; blocked: () => boolean } }> = [
        {
          label: "shell",
          tool: /^(exec|shell|bash)$/i,
          prepare: () => {
            const marker = path(`native-shell-${token()}.marker`);
            return {
              prompt: `Do not use MCP or OpenClaw tools. Use only your built-in Shell tool to run exactly: touch ${marker} . Then say what happened.`,
              blocked: () => !existsSync(marker),
            };
          },
        },
        {
          label: "write",
          tool: /^(write|edit)$/i,
          prepare: () => {
            const marker = path(`native-write-${token()}.marker`);
            return {
              prompt: `Do not use MCP or OpenClaw tools. Use only your built-in file write tool to create the file ${marker} containing "hi". Then say what happened.`,
              blocked: () => !existsSync(marker),
            };
          },
        },
        {
          label: "edit",
          tool: /^(edit|write)$/i,
          prepare: () => {
            const file = path(`native-edit-${token()}.txt`);
            writeFileSync(file, "orig");
            return {
              prompt: `Do not use MCP or OpenClaw tools. Use only your built-in file edit tool to replace the text 'orig' with 'changed' in ${file} . Then say what happened.`,
              blocked: () => readFileSync(file, "utf8") === "orig",
            };
          },
        },
        {
          label: "delete",
          tool: /^delete$/i,
          prepare: () => {
            const file = path(`native-delete-${token()}.txt`);
            writeFileSync(file, "keep");
            return {
              prompt: `Do not use MCP or OpenClaw tools. Use only your built-in Delete tool to delete ${file} . Then say what happened.`,
              blocked: () => existsSync(file),
            };
          },
        },
      ];
      for (const entry of cases) {
        await retrying(`native ${entry.label}`, async () => {
          const { prompt, blocked } = entry.prepare();
          const turn = await ask(sessionId(`native-${entry.label}`), prompt);
          // Whatever happened, the effect must not have: checked on every try.
          expect(blocked(), `native ${entry.label} took effect`).toBe(true);
          if (!native(turn, entry.tool)) return `Cursor never attempted a native ${entry.label} (tools ${turn.tools.join(",")})`;
          return undefined;
        });
      }
    },
    LIVE_TIMEOUT_MS * 6,
  );

  it(
    "holds a command for approval when tools.exec.ask is always, runs it after allow-once, and never runs it after deny",
    async () => {
      setConfig("tools.exec.ask", "always");
      const client: ApprovalClient = await connectApprovalClient(PORT);
      try {
        for (const decision of ["allow-once", "deny"] as const) {
          await retrying(`approval ${decision}`, async () => {
            const marker = path(`approval-${decision}-${token()}.marker`);
            const file = script(`approval-${decision}`, `${RUNTIME_SECRET}\nprintf '%s' $S > ${marker}\necho "out:$S"`);
            const turn = ask(sessionId(`approval-${decision}`), runIt(file));
            let id: string | undefined;
            // A pending approval proves the model called exec; none within the wait means it never did.
            await waitFor(async () => {
              id = (await client.list()).find((entry) => entry.request.command?.includes(file))?.id;
              return id !== undefined;
            }, 120_000, 1_000);
            if (id === undefined) {
              await turn;
              return "no pending approval appeared";
            }
            // Pending means not run yet.
            expect(existsSync(marker)).toBe(false);
            await client.resolve(id, decision);
            const done = await turn;
            expect(done.status, done.raw).toBe(0);
            if (decision === "allow-once") {
              expect(done.reply).toContain(readFileSync(marker, "utf8"));
            } else {
              expect(existsSync(marker)).toBe(false);
            }
            return undefined;
          });
        }
      } finally {
        client.close();
        openclaw(["config", "unset", "tools.exec"]);
      }
    },
    LIVE_TIMEOUT_MS * 6,
  );

  it(
    "never runs a command when tools.exec.security is deny, and the model gets OpenClaw's denial",
    async () => {
      setConfig("tools.exec.security", "deny");
      try {
        await retrying("security deny", async () => {
          const marker = path(`security-deny-${token()}.marker`);
          const file = script("security-deny", `${RUNTIME_SECRET}\nprintf '%s' $S > ${marker}\necho "out:$S"`);
          const turn = await ask(sessionId("security-deny"), runIt(file));
          expect(existsSync(marker)).toBe(false);
          if (!calledExec(turn)) return "the model never called exec";
          expect(turn.status, turn.raw).toBe(0);
          // OpenClaw's own denial text reached the model ("exec denied: host=gateway security=deny").
          expect(turn.reply.toLowerCase()).toMatch(/den(y|ied)|not (run|allowed)|refus|blocked|policy/);
          return undefined;
        });
      } finally {
        openclaw(["config", "unset", "tools.exec"]);
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "takes exec and process away from the model with tools.deny, and no command runs",
    async () => {
      setConfig("tools.deny", '["exec","process"]', true);
      try {
        await retrying("tools.deny", async () => {
          const marker = path(`tools-deny-${token()}.marker`);
          const file = script("tools-deny", `touch ${marker}`);
          const turn = await ask(sessionId("tools-deny"), runIt(file));
          // Whatever the model tried, nothing ran.
          expect(existsSync(marker)).toBe(false);
          // With no exec the turn runs in Cursor's ask mode, which has no edit tool: the model cannot
          // have used a native edit, write or delete (the unit tests pin the exact mode).
          expect(turn.tools.filter((name) => /^(edit|write|delete)$/i.test(name))).toEqual([]);
          if (turn.status !== 0) return `the turn did not complete (status ${turn.status})`;
          // The tools are not offered, so the model cannot have called them. A try in which it guessed
          // the tool name anyway tells us about the model, not the policy: retry.
          if (turn.tools.some((name) => /(^|__)(exec|process)$/.test(name) && name.startsWith("mcp__"))) return "the model called a hidden tool by name";
          return undefined;
        });
      } finally {
        openclaw(["config", "unset", "tools.deny"]);
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "kills a command that exceeds the exec timeout and reports the timeout to the model",
    async () => {
      await retrying("timeout", async () => {
        const secret = token();
        const started = path(`timeout-${secret}.started`);
        const finished = path(`timeout-${secret}.finished`);
        const file = script("timeout", `touch ${started}\nsleep 20\ntouch ${finished}`);
        const turn = await ask(sessionId("timeout"), runIt(file, "Set the exec tool's timeout parameter to 3 seconds.\n"));
        expect(turn.status, turn.raw).toBe(0);
        if (!existsSync(started)) return "the command never started";
        // The script would finish 20 s after it started: wait past that and see it never did.
        await new Promise((resolve) => setTimeout(resolve, 22_000));
        expect(existsSync(finished)).toBe(false);
        expect(turn.reply.toLowerCase()).toMatch(/time(d)?[ -]?out|timeout|3 seconds|terminated/);
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "stops a foreground command that runs past Cursor's 60 s call limit, instead of leaving it running",
    async () => {
      // With `process` hidden OpenClaw runs exec synchronously (it ignores yieldMs and background), so
      // the command stays in the foreground, which is the case the proxy's deadline exists for.
      setConfig("tools.deny", '["process"]', true);
      try {
        await retrying("call limit", async () => {
          const secret = token();
          const shPid = path(`limit-${secret}.pid`);
          const done = path(`limit-${secret}.done`);
          const file = script("limit", `echo $$ > ${shPid}\nsleep 100\ntouch ${done}`);
          const turn = await ask(
            sessionId("limit"),
            runIt(file, "Set the exec tool's timeout parameter to 150 seconds. If a tool error comes back, just report it.\n"),
          );
          if (!existsSync(shPid)) return "the command never started";
          const pid = Number(readFileSync(shPid, "utf8").trim());
          // The proxy stopped the call at its deadline, and the host killed the command with it.
          expect(await waitFor(() => !isAlive(pid), 15_000, 250), `the foreground command ${pid} is still running`).toBe(true);
          expect(existsSync(done)).toBe(false);
          expect(turn.reply.toLowerCase()).toMatch(/longer than|stopped|limit|background|cancel|timed out/);
          return undefined;
        });
      } finally {
        openclaw(["config", "unset", "tools.deny"]);
      }
    },
    LIVE_TIMEOUT_MS * 4,
  );

  it(
    "relays a long-running call (20 s) and its output",
    async () => {
      await retrying("long", async () => {
        const marker = path(`long-${token()}.marker`);
        const file = script("long", `sleep 20\n${RUNTIME_SECRET}\nprintf '%s' $S > ${marker}\necho "out:$S"`);
        const turn = await ask(sessionId("long"), runIt(file));
        if (!existsSync(marker)) return "the command never finished";
        expect(turn.status, turn.raw).toBe(0);
        expect(turn.reply).toContain(readFileSync(marker, "utf8"));
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "completes the turn when a command prints about 3 MB, and the reply carries a secret or the cap notice",
    async () => {
      await retrying("huge", async () => {
        const head = token();
        const tail = token();
        const marker = path(`huge-${head}.marker`);
        const file = script("huge", `echo "HEAD:${head}"\nhead -c 3000000 /dev/zero | tr '\\000' x\necho\necho "TAIL:${tail}"\ntouch ${marker}`);
        const turn = await ask(sessionId("huge"), runIt(file, "Quote the HEAD and TAIL values it printed, if you can see them.\n"));
        if (!existsSync(marker)) return "the command never ran";
        // A big result can push the turn over OpenClaw's context budget, and its compaction then needs
        // an API model this host does not have: a host limit, not what the row tests. Try again.
        if (turn.status !== 0 && /compaction failed/i.test(turn.raw)) return "OpenClaw's budget compaction failed the turn";
        expect(turn.status, turn.raw).toBe(0);
        // OpenClaw's output cap keeps one end or both and says so: either secret or the notice must come back.
        expect(turn.reply).toMatch(new RegExp(`${head}|${tail}|truncat|cap|omitted`, "i"));
        // The reply is a model answer, not 3 MB.
        expect(turn.reply.length).toBeLessThan(100_000);
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "reports a non-zero exit code the model was not told",
    async () => {
      await retrying("exit code", async () => {
        const code = 37 + (randomBytes(1)[0]! % 63);
        const marker = path(`exit-${token()}.marker`);
        const file = script("exit", `${RUNTIME_SECRET}\nprintf '%s' $S > ${marker}\necho "out:$S"\nexit ${code}`);
        const turn = await ask(sessionId("exit"), runIt(file, "Report the command's exit code too.\n"));
        if (!calledExec(turn)) return "the model never called exec";
        expect(turn.status, turn.raw).toBe(0);
        expect(turn.reply).toContain(readFileSync(marker, "utf8"));
        expect(turn.reply).toMatch(new RegExp(`\\b${code}\\b`));
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "kills the command when the turn is aborted mid-run",
    async () => {
      await retrying("abort", async () => {
        const id = sessionId("abort");
        const secret = token();
        const shPid = path(`abort-${secret}.shpid`);
        const sleepPid = path(`abort-${secret}.sleeppid`);
        const started = path(`abort-${secret}.started`);
        const done = path(`abort-${secret}.done`);
        const file = script("abort", `echo $$ > ${shPid}\nsleep 40 &\necho $! > ${sleepPid}\ntouch ${started}\nwait\ntouch ${done}`);
        const turn = ask(id, runIt(file));
        if (!(await waitFor(() => existsSync(started), 150_000, 500))) {
          await turn;
          return "the command never started";
        }
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
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 3,
  );

  it(
    "keeps CURSOR_API_KEY away from exec when the key comes from the plugin config, not the Gateway's environment",
    async () => {
      const key = process.env.CURSOR_API_KEY!;
      await gateway.stop();
      setConfig("plugins.entries.openclaw-all-cli.config.cursor-cli", JSON.stringify({ env: { CURSOR_API_KEY: key } }), true);
      // A Gateway whose own environment has no key at all.
      gateway = await startGateway(PORT_KEYLESS, { omitEnv: ["CURSOR_API_KEY"] });
      await retrying("key isolation", async () => {
        const out = path(`keyless-${token()}.txt`);
        const file = script("keyless", `${RUNTIME_SECRET}\nif env | grep -q '^CURSOR_API_KEY='; then echo present > ${out}; else echo absent > ${out}; fi\nprintf '%s' $S > ${out}.secret\necho "out:$S"`);
        const turn = await ask(sessionId("keyless"), runIt(file));
        // The turn itself (Cursor with the key from the plugin config) must have worked.
        if (!existsSync(out)) return `the command never ran (status ${turn.status}, tools ${turn.tools.join(",")})`;
        expect(turn.status, turn.raw).toBe(0);
        expect(turn.reply).toContain(readFileSync(`${out}.secret`, "utf8"));
        expect(readFileSync(out, "utf8").trim()).toBe("absent");
        return undefined;
      });
    },
    LIVE_TIMEOUT_MS * 4,
  );

  // Needs a Docker daemon. Without one the row is not run (and says so), rather than passing vacuously.
  const docker = LIVE && spawnSync("docker", ["info"], { stdio: "ignore", timeout: 15_000 }).status === 0;
  it.skipIf(!docker)(
    "runs the command inside the sandbox, or refuses the run, never on the Gateway host",
    async () => {
      setConfig("agents.defaults.sandbox.mode", "all");
      try {
        await retrying("sandbox", async () => {
          // A file only the host can see: a command that prints it ran on the host.
          const secret = token();
          const hostOnly = path(`hostonly-${secret}.txt`);
          writeFileSync(hostOnly, secret);
          const marker = path(`sandbox-${secret}.marker`);
          const file = script("sandbox", `touch ${marker}\ncat ${hostOnly} 2>/dev/null || echo NOFILE`);
          const turn = await ask(sessionId("sandbox"), runIt(file));
          expect(existsSync(marker), "the command ran on the Gateway host").toBe(false);
          expect(turn.reply).not.toContain(secret);
          expect(turn.raw.length).toBeGreaterThan(0);
          if (!calledExec(turn)) return "the model never called exec (a refused run is also fine, but is not evidence)";
          return undefined;
        });
      } finally {
        openclaw(["config", "unset", "agents.defaults.sandbox"]);
      }
    },
    LIVE_TIMEOUT_MS * 3,
  );
  if (LIVE && !docker) {
    console.info("exec-tool live test: the sandbox row is not run, because `docker info` fails on this host.");
  }
});

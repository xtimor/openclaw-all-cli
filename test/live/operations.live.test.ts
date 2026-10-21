import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { inspectProcess } from "../../src/core/pid-locks.ts";
import { FAKE_CURSOR_AGENT } from "../fixtures/paths.ts";
import {
  ISOLATED_STATE_DIR,
  describeLive,
  openclaw,
  openclawAsync,
  replyLines,
  startGateway,
  waitFor,
  type TestGateway,
} from "./harness.ts";

// Parity rows P17 (caps, timers, clean env, orphans, unload) and P19 (version floor). Real
// cursor-agent for the load, orphan, and unload checks; the fake agent where a check needs a
// scripted or slow turn. Run `npm run dev:install` first. Needs a Cursor login or CURSOR_API_KEY.
describeLive("operations: caps, version floor, orphans, unload, timers (P17, P19)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-ops-"));
  const AGENTS = ["oac-ops-a", "oac-ops-b"];
  const CONFIG_COMMAND = "plugins.entries.openclaw-all-cli.config.cursor-cli.command";
  const stamp = Date.now();
  let port = 18930;
  const gateways: TestGateway[] = [];

  const homeOf = (agent: string) => join(ISOLATED_STATE_DIR, "agents", agent, "agent", "openclaw-all-cli", "cursor-cli");
  const lockPids = (agent: string): number[] => {
    const dir = join(homeOf(agent), "pids");
    return existsSync(dir)
      ? readdirSync(dir)
          .filter((name) => /^\d+\.json$/.test(name))
          .map((name) => Number(name.replace(".json", "")))
      : [];
  };
  const isAlive = async (pid: number) => (await inspectProcess(pid)).kind === "alive";
  const allGone = async (pids: number[]) => (await Promise.all(pids.map(isAlive))).every((alive) => !alive);
  /** Command lines of the processes whose arguments contain `needle`. */
  const processesWith = (needle: string): string[] =>
    (spawnSync("ps", ["-eo", "pid,args"], { encoding: "utf8" }).stdout ?? "")
      .split("\n")
      .filter((line) => line.includes(needle) && !line.includes("ps -eo"));

  /** Every process: pid, process group, and command line. Zombies are not processes. */
  const psRows = (): Array<{ pid: number; pgid: number; args: string }> =>
    (spawnSync("ps", ["-eo", "pid=,pgid=,args="], { encoding: "utf8" }).stdout ?? "")
      .split("\n")
      .flatMap((line) => {
        const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
        return match && !match[3]!.includes("<defunct>") ? [{ pid: Number(match[1]), pgid: Number(match[2]), args: match[3]! }] : [];
      });
  const groupRows = (pgids: number[]) => psRows().filter((row) => pgids.includes(row.pgid));
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  /** Cursor's per-workspace folder under its data dir: its slug is the workspace path with runs of non-alphanumerics as `-`. */
  const projectSlug = (workspace: string) => workspace.replace(/[^A-Za-z0-9]+/g, "-").replace(/^-+|-+$/g, "");

  /**
   * One real turn in `agent`, with Cursor's `worker-server` forced to start (it exits at once when its
   * folder under the data dir is missing, so the folder is created first). Polls during the turn for the
   * worker and returns it with the leaders (lock pids) whose group it joined. The processes stay up
   * after the turn, as the callers' own checks show.
   */
  async function turnWithWorker(gateway: TestGateway | undefined, agent: string, session: string) {
    mkdirSync(join(homeOf(agent), "data", "projects", projectSlug(join(root, `workspace-${agent}`))), { recursive: true });
    const workers = new Set<number>();
    const leaders = new Set<number>();
    let done = false;
    const poll = (async () => {
      while (!done) {
        const locks = lockPids(agent);
        for (const row of psRows()) {
          if (row.args.includes("worker-server") && locks.includes(row.pgid)) {
            workers.add(row.pid);
            leaders.add(row.pgid);
          }
        }
        await sleep(200);
      }
    })();
    const result = await ask(gateway, agent, session, "Reply with the single word ok.");
    done = true;
    await poll;
    return { result, workers: [...workers], leaders: [...leaders] };
  }

  const useCommand = (command: string | undefined) => {
    const result = command ? openclaw(["config", "set", CONFIG_COMMAND, command]) : openclaw(["config", "unset", CONFIG_COMMAND]);
    expect(result.status === 0 || command === undefined).toBe(true);
  };

  /** A shim that runs the fake agent and tags its command line, so a test can find its processes. */
  function fakeShim(name: string, marker: string): string {
    const file = join(root, name);
    writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_CURSOR_AGENT}" "$@" --oac-marker=${marker}\n`);
    chmodSync(file, 0o755);
    return file;
  }

  async function newGateway(env: Record<string, string> = {}): Promise<TestGateway> {
    port += 1;
    const gateway = await startGateway(port, { env });
    gateways.push(gateway);
    return gateway;
  }

  const ask = (gateway: TestGateway | undefined, agent: string, session: string, message: string, extra: string[] = []) =>
    openclawAsync(["agent", ...(gateway ? [] : ["--local"]), "--agent", agent, "--session-id", session, "--message", message, ...extra], {
      timeoutMs: 280_000,
      ...(gateway ? { env: gateway.env } : {}),
    });

  beforeAll(() => {
    // The plugin loads at Gateway startup only when the config names it (OpenClaw #148584).
    expect(openclaw(["config", "set", "agents.defaults.model.primary", "cursor-cli/auto"]).status).toBe(0);
    for (const agent of AGENTS) {
      const workspace = join(root, `workspace-${agent}`);
      mkdirSync(workspace, { recursive: true });
      expect(openclaw(["agents", "add", agent, "--non-interactive", "--workspace", workspace, "--model", "cursor-cli/auto"]).status).toBe(0);
    }
  }, 120_000);

  // A failed test must not leave its Gateway behind: the next test's `--local` run refuses to start beside it.
  afterEach(async () => {
    for (const gateway of gateways.splice(0)) await gateway.stop();
  }, 120_000);

  afterAll(async () => {
    useCommand(undefined);
    openclaw(["config", "unset", "agents.defaults.model.primary"]);
    for (const agent of AGENTS) openclaw(["agents", "delete", agent, "--force"]);
    rmSync(root, { recursive: true, force: true });
  }, 120_000);

  it("runs 20 turns on each of two agents in parallel through one Gateway, all succeeding", async () => {
    useCommand(undefined);
    const gateway = await newGateway();
    const runAgent = async (agent: string) => {
      const session = `live-ops-load-${agent}-${stamp}`;
      const results = [];
      for (let turn = 1; turn <= 20; turn += 1) {
        results.push(await ask(gateway, agent, session, `Reply with the single word ok. Turn ${turn}.`));
      }
      return results;
    };
    const [a, b] = await Promise.all(AGENTS.map(runAgent));
    for (const [index, result] of [...a!, ...b!].entries()) {
      expect({ turn: index, status: result.status, failure: /cli terminal failure/.test(result.stdout + result.stderr) }).toEqual({
        turn: index,
        status: 0,
        failure: false,
      });
      expect(replyLines(result.stdout).length).toBeGreaterThan(0);
    }
    await gateway.stop();
  }, 1_500_000);

  it("serializes two calls to one session: the second prompt starts after the first result (fake agent)", async () => {
    useCommand(fakeShim("fake-queue", `queue-${stamp}`));
    const log = join(root, "queue.jsonl");
    const gateway = await newGateway({ FAKE_CURSOR_LOG: log, FAKE_CURSOR_LOG_END: "1" });
    const session = `live-ops-queue-${stamp}`;
    const entries = () =>
      existsSync(log)
        ? readFileSync(log, "utf8")
            .trim()
            .split("\n")
            .map((line) => JSON.parse(line) as { method: string; t: number; params?: { prompt?: Array<{ text?: string }> } })
        : [];
    const promptWith = (word: string) =>
      entries().find((entry) => entry.method === "session/prompt" && entry.params?.prompt?.some((block) => block.text?.includes(word)));

    const first = ask(gateway, AGENTS[0]!, session, "[[sleep:6000]] first-call");
    expect(await waitFor(() => promptWith("first-call") !== undefined, 90_000)).toBe(true);
    const secondStartedAt = Date.now();
    const second = ask(gateway, AGENTS[0]!, session, "say:second-call");
    const [one, two] = await Promise.all([first, second]);
    expect(one.status).toBe(0);
    expect(two.status).toBe(0);

    const firstEnd = entries().find((entry) => entry.method === "prompt/end")!.t;
    const secondPrompt = promptWith("second-call")!;
    // The second call arrived while the first still ran, and still its prompt came after the first result.
    expect(secondStartedAt).toBeLessThan(firstEnd);
    expect(secondPrompt.t).toBeGreaterThanOrEqual(firstEnd);
    await gateway.stop();
  }, 400_000);

  it("kills the orphans a SIGKILLed Gateway left, worker included, within 30 s of the restart and with no new turn (real Cursor)", async () => {
    useCommand(undefined);
    const agent = AGENTS[1]!;
    const first = await newGateway();
    const { result, workers, leaders } = await turnWithWorker(first, agent, `live-ops-orphan-${stamp}`);
    expect(result.status).toBe(0);
    const recorded = lockPids(agent);
    expect(recorded.length).toBeGreaterThan(0);
    // A worker-server joined the leader's group during the turn, and the lock says so.
    expect(workers.length).toBeGreaterThan(0);
    expect(leaders.every((pid) => recorded.includes(pid))).toBe(true);
    expect(JSON.parse(readFileSync(join(homeOf(agent), "pids", `${leaders[0]}.json`), "utf8"))).toMatchObject({ group: true });
    for (const pid of recorded) expect(await isAlive(pid)).toBe(true);

    await first.kill();
    // cursor-agent ignores the closed pipe: the processes outlive their Gateway.
    for (const pid of recorded) expect(await isAlive(pid)).toBe(true);

    await newGateway();
    expect(await waitFor(async () => (await allGone(recorded)) && lockPids(agent).length === 0, 30_000)).toBe(true);
    // The whole group: the worker and its language servers went with the leader.
    expect(await waitFor(() => groupRows(leaders).length === 0, 30_000)).toBe(true);
  }, 400_000);

  for (const [name, stop] of [
    ["SIGTERM", (gateway: TestGateway) => gateway.terminate()],
    ["SIGINT", (gateway: TestGateway) => gateway.interrupt()],
  ] as const) {
    it(`has every process, and its whole process group, gone when a Gateway ${name} stop completes (real Cursor)`, async () => {
      useCommand(undefined);
      const agent = AGENTS[0]!;
      const gateway = await newGateway();
      const { result, workers, leaders } = await turnWithWorker(gateway, agent, `live-ops-unload-${name}-${stamp}`);
      expect(result.status).toBe(0);
      const recorded = lockPids(agent);
      expect(recorded.length).toBeGreaterThan(0);
      expect(workers.length).toBeGreaterThan(0);
      for (const pid of recorded) expect(await isAlive(pid)).toBe(true);

      await stop(gateway);
      expect(await allGone(recorded)).toBe(true);
      expect(groupRows(leaders)).toEqual([]);
      expect(lockPids(agent)).toEqual([]);
    }, 400_000);
  }

  const mainLocks = () => lockPids("main");
  const refreshModels = (gateway: TestGateway) =>
    openclawAsync(["gateway", "call", "models.list", "--params", '{"refresh":true}', "--port", String(gateway.port), "--json"], {
      timeoutMs: 120_000,
    });

  it("locks the model listing's process in the main agent's home while it runs, and leaves no process or lock (real Cursor)", async () => {
    useCommand(undefined);
    const gateway = await newGateway();
    // The plugin's catalog keeps a listing for a minute and the host passes no refresh flag, so ask
    // again until a call really starts a listing; the lock shows while its process runs.
    const before = new Set(mainLocks());
    let seen: { pid: number; group?: boolean } | undefined;
    let polling = true;
    const watcher = (async () => {
      while (polling && !seen) {
        for (const pid of mainLocks().filter((candidate) => !before.has(candidate))) {
          try {
            seen = { pid, ...(JSON.parse(readFileSync(join(homeOf("main"), "pids", `${pid}.json`), "utf8")) as { group?: boolean }) };
          } catch {
            // The lock was just released: try the next poll.
          }
        }
        await sleep(25);
      }
    })();
    const deadline = Date.now() + 200_000;
    while (!seen && Date.now() < deadline) {
      const result = await refreshModels(gateway);
      expect(result.status).toBe(0);
      if (!seen) await sleep(5_000);
    }
    polling = false;
    await watcher;
    expect(seen).toBeDefined();
    expect(seen).toMatchObject({ group: true });
    const listed = seen!.pid;
    expect(await waitFor(async () => (await allGone([listed])) && mainLocks().every((pid) => before.has(pid)), 20_000)).toBe(true);
    expect(groupRows([listed])).toEqual([]);
  }, 400_000);

  it("stops a hung model listing, and releases its lock, by the time a Gateway SIGTERM completes (fake agent)", async () => {
    const marker = `listing-${stamp}`;
    useCommand(fakeShim("fake-listing", marker));
    // The fake ignores a closed pipe, so when the Gateway dies only the plugin's unload can stop it.
    const gateway = await newGateway({ FAKE_CURSOR_NO_INIT: "1", FAKE_CURSOR_IGNORE_STDIN_EOF: "1" });
    try {
      // The listing never gets an answer to `initialize` and would run for its full 30 s.
      void refreshModels(gateway).catch(() => {});
      expect(await waitFor(() => processesWith(`--oac-marker=${marker}`).length > 0 && mainLocks().length > 0, 90_000, 100)).toBe(true);
      const pids = mainLocks();
      await gateway.terminate();
      expect(processesWith(`--oac-marker=${marker}`)).toEqual([]);
      expect(await allGone(pids)).toBe(true);
      expect(mainLocks()).toEqual([]);
    } finally {
      // A failed run must not leave the stubborn fake behind.
      for (const line of processesWith(`--oac-marker=${marker}`)) {
        try {
          process.kill(Number(line.trim().split(/\s+/)[0]), "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    }
  }, 400_000);

  it("fails a turn with unsupported_version, and starts no ACP session, below the version floor (real Cursor)", async () => {
    const real = spawnSync("sh", ["-c", "command -v cursor-agent"], { encoding: "utf8" }).stdout.trim();
    expect(real).not.toBe("");
    const calls = join(root, "old-calls.log");
    const wrapper = join(root, "old-cursor-agent");
    writeFileSync(
      wrapper,
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 2026.05.01-old; exit 0; fi\necho "$@" >> "${calls}"\nexec "${real}" "$@"\n`,
    );
    chmodSync(wrapper, 0o755);
    useCommand(wrapper);
    const result = await ask(undefined, AGENTS[0]!, `live-ops-old-${stamp}`, "Reply with the single word ok.");
    const output = result.stdout + result.stderr;
    expect(output).toContain("2026.05.01");
    expect(output).toContain("2026.07.06");
    expect(output).toContain("cursor-agent update");
    // `status` (the auth probe) may call the wrapper; `acp` never does.
    const invoked = existsSync(calls) ? readFileSync(calls, "utf8") : "";
    expect(invoked).not.toMatch(/\bacp\b/);
  }, 300_000);

  it("ends a hung turn with the host timeout and leaves no process (fake agent, --timeout 10)", async () => {
    const marker = `timeout-${stamp}`;
    useCommand(fakeShim("fake-timeout", marker));
    const started = Date.now();
    const result = await ask(undefined, AGENTS[0]!, `live-ops-timeout-${stamp}`, "[[hang]] never ends", ["--timeout", "10"]);
    const output = (result.stdout + result.stderr).toLowerCase();
    expect(Date.now() - started).toBeLessThan(120_000);
    expect(result.status === 0 && !/time/.test(output)).toBe(false);
    expect(output).toMatch(/time(d)? ?out/);
    expect(await waitFor(() => processesWith(`--oac-marker=${marker}`).length === 0, 20_000)).toBe(true);
  }, 300_000);
});

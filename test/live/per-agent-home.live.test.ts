import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect, it } from "vitest";
import { cursorAdapter } from "../../src/adapters/cursor/index.ts";
import { homeDirFor } from "../../src/core/home.ts";
import type { NormalizedEvent, PermissionRequest } from "../../src/core/ports.ts";
import { AcpSession } from "../../src/transports/acp/session.ts";
import { LIVE_TIMEOUT_MS, describeLive } from "./harness.ts";

// Parity rows P8 (native shell and writers are not available) and P10 (static per-agent
// permissions). The adapter's own sessions run in `ask` mode; this test opens the session in
// `agent` mode, where Cursor would apply edits, to prove the prepared home denies them.
// Needs a Cursor login (or CURSOR_API_KEY) and a host where `cursor-agent` can reach its servers.
describeLive("per-agent Cursor home denies native writes in agent mode (P8, P10)", () => {
  const root = mkdtempSync(join(tmpdir(), "oac-live-home-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  async function turn(session: AcpSession, text: string): Promise<string> {
    let reply = "";
    let last: NormalizedEvent | undefined;
    for await (const event of session.prompt(text)) {
      if (event.kind === "text") reply += event.text;
      last = event;
    }
    expect(last?.kind).toBe("result");
    return reply;
  }

  it(
    "creates no file for a write request while grep still answers",
    async () => {
      const workspace = join(root, "workspace");
      mkdirSync(workspace);
      writeFileSync(join(workspace, "seed.txt"), "needle-7f3a\n");
      const home = homeDirFor(join(root, "agent"), "cursor-cli");
      const homeEnv = await cursorAdapter.prepareHome(home);

      const env: Record<string, string> = {};
      for (const [key, value] of Object.entries(process.env)) {
        if (value !== undefined && !key.startsWith("VITEST")) env[key] = value;
      }
      const requests: PermissionRequest[] = [];
      const session = await AcpSession.open({
        command: process.env.CURSOR_AGENT_BIN ?? cursorAdapter.command,
        args: cursorAdapter.launchArgs,
        cwd: workspace,
        env: { ...env, ...homeEnv },
        ...(env.CURSOR_API_KEY?.trim() ? {} : { authMethodId: "cursor_login" }),
        requiredModeId: "agent",
        onPermissionRequest: async (request) => {
          requests.push(request);
          return "reject_once";
        },
      });
      try {
        await turn(session, "Create a new file named oac-live-probe.txt in the current directory containing the word probe.");
        expect(existsSync(join(workspace, "oac-live-probe.txt"))).toBe(false);
        expect(requests).toEqual([]);

        const reply = await turn(
          session,
          "Use grep to find which file here contains the text needle-7f3a. Answer with the file name only.",
        );
        expect(reply).toContain("seed.txt");
        expect(readdirSync(workspace).sort()).toEqual(["seed.txt"]);
      } finally {
        await session.close();
      }
    },
    LIVE_TIMEOUT_MS,
  );
});

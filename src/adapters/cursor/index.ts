import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { AcpSession } from "../../transports/acp/session.ts";
import { readJsonObject, writeJsonAtomic } from "../../transports/files.ts";
import { runCommand } from "../../transports/process.ts";
import type { AuthProbeParams, AuthStatus, CliAdapter, CliSession, HomeEnv, OpenParams } from "../../core/ports.ts";
import { cursorManifest } from "./manifest.ts";

const PROBE_TIMEOUT_MS = 5_000;

/** The Cursor model that means "let Cursor choose". The ACP session already starts there. */
const AUTO_MODEL = "auto";

/** Reads `cursor-agent status` output: negations ("not ...", "logged out") first, then "logged in", "signed in", or "authenticated". */
export function parseStatusOutput(output: string): AuthStatus {
  // Negations first: "not logged in", "not currently logged in", "logged out", "not authenticated".
  if (/\bnot\b[^.\n]*\b(logged\s+in|authenticated|signed\s+in)\b/i.test(output)) return "missing";
  if (/\b(logged|signed)\s+out\b/i.test(output)) return "missing";
  if (/\b(logged\s+in|authenticated|signed\s+in)\b/i.test(output)) return "available";
  return "unreadable";
}

async function probeAuth(params: AuthProbeParams): Promise<AuthStatus> {
  if (params.env.CURSOR_API_KEY?.trim()) return "available";
  const result = await runCommand(params.command, ["status"], {
    env: params.env,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.kind === "spawn-error") return "missing";
  if (result.kind === "timeout") return "unreadable";
  if (result.code !== 0) return "missing";
  return parseStatusOutput(`${result.stdout}\n${result.stderr}`);
}

/** AD-9: the same for every agent. Native read, grep, and glob stay open; the MCP proxy is allowed. */
export const CURSOR_PERMISSIONS = {
  allow: ["Read(**)", "Mcp(openclaw:*)"],
  deny: ["Shell(*)", "Write(**)", "WebFetch(*)"],
} as const;

const CONFIG_FILE = "cli-config.json";

/**
 * Points Cursor's config and chat store at the per-agent home (AD-6) and writes the static
 * permissions there. Keys Cursor wrote stay; the file is rewritten only when its permissions
 * differ, and always by atomic rename so parallel turns never leave a partial file.
 */
async function prepareHome(home: string): Promise<HomeEnv> {
  const file = join(home, CONFIG_FILE);
  const existing = (await readJsonObject(file)) ?? {};
  if (!isDeepStrictEqual(existing.permissions, CURSOR_PERMISSIONS)) {
    await writeJsonAtomic(file, { ...existing, permissions: CURSOR_PERMISSIONS });
  }
  return { CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: join(home, "data") };
}

function open(params: OpenParams): Promise<CliSession> {
  return AcpSession.open({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    // With an API key Cursor needs no login step; `authenticate{cursor_login}` would try a browser login and fail.
    ...(params.env.CURSOR_API_KEY?.trim() ? {} : { authMethodId: "cursor_login" }),
    // The per-agent permissions deny shell, write, and fetch; until permission routing (entry 4)
    // lands, the session also runs in Cursor's read-only mode as a second lock.
    requiredModeId: "ask",
    ...(params.modelId === AUTO_MODEL ? {} : { modelId: params.modelId }),
    ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
    onPermissionRequest: params.onPermissionRequest,
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

export const cursorAdapter: CliAdapter = {
  id: "cursor",
  displayName: "Cursor CLI",
  command: "cursor-agent",
  launchArgs: ["acp"],
  defaultModel: "cursor-cli/auto",
  manifest: cursorManifest,
  probeAuth,
  prepareHome,
  open,
};

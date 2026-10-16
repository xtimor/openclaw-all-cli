import { AcpSession } from "../../transports/acp/session.ts";
import { runCommand } from "../../transports/process.ts";
import type { AuthProbeParams, AuthStatus, CliAdapter, CliSession, OpenParams } from "../../core/ports.ts";
import { cursorManifest } from "./manifest.ts";

const PROBE_TIMEOUT_MS = 5_000;

/** The Cursor model that means "let Cursor choose". The ACP session already starts there. */
const AUTO_MODEL = "auto";

/** Reads `cursor-agent status` output. Only the logged-in wording is relied on. */
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

function open(params: OpenParams): Promise<CliSession> {
  return AcpSession.open({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    authMethodId: "cursor_login",
    // Until the per-agent permissions (entry 2) and permission routing (entry 4) land, the
    // session runs in Cursor's read-only mode so a native edit or shell command cannot act.
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
  open,
};

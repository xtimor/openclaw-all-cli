import { join } from "node:path";
import { reapOnce } from "./pid-locks.ts";
import { CliError, type CliAdapter, type HomeEnv } from "./ports.ts";

/** A prepared per-agent CLI home (AD-6). */
export type AgentHome = {
  dir: string;
  /** Env additions that point the CLI at `dir`. */
  env: HomeEnv;
};

/** `<agentDir>/openclaw-all-cli/<backendId>/`: the one path rule for every adapter. */
export function homeDirFor(agentDir: string, backendId: string): string {
  return join(agentDir, "openclaw-all-cli", backendId);
}

/**
 * Derives the home from OpenClaw's `agentDir` and lets the adapter set it up. Without an
 * `agentDir` it throws: a shared home would let agents share config and chats. The first use of
 * a home waits for the kill of the processes a dead Gateway left in it (AD-14), so a turn never
 * opens beside an orphan.
 */
export async function prepareAgentHome(
  adapter: CliAdapter,
  backendId: string,
  agentDir: string | undefined,
  warn: (message: string) => void = () => {},
): Promise<AgentHome> {
  if (!agentDir?.trim()) {
    throw new CliError({
      code: "unclassified",
      message: "OpenClaw gave no agent directory, so the CLI has no per-agent home to run in.",
    });
  }
  const dir = homeDirFor(agentDir, backendId);
  await reapOnce(dir, warn);
  try {
    return { dir, env: await adapter.prepareHome(dir) };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      {
        code: "unclassified",
        message: `Could not prepare the CLI home "${dir}": ${error instanceof Error ? error.message : String(error)}`,
      },
      { cause: error },
    );
  }
}

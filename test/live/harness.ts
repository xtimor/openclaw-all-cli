import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe } from "vitest";

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
export function openclaw(args: string[], options: { timeoutMs?: number } = {}): OpenClawResult {
  // OpenClaw mutes its output when it sees a test runner's variables.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("VITEST") && key !== "NODE_ENV"),
  );
  const result = spawnSync(DEV_SCRIPT, ["run", ...args], {
    encoding: "utf8",
    timeout: options.timeoutMs ?? 180_000,
    env,
  });
  return { status: result.status, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
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

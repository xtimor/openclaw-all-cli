import { spawn } from "node:child_process";

export type CommandResult =
  | { kind: "exit"; code: number | null; stdout: string; stderr: string }
  | { kind: "spawn-error"; error: NodeJS.ErrnoException }
  | { kind: "timeout" };

const MAX_OUTPUT_CHARS = 64 * 1024;

/** Runs a short CLI command and collects bounded output. It never throws. */
export function runCommand(
  command: string,
  args: readonly string[],
  options: { env: Record<string, string | undefined>; timeoutMs: number; signal?: AbortSignal; cwd?: string },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    if (options.signal?.aborted) return resolve({ kind: "timeout" });
    const child = spawn(command, [...args], {
      env: options.env as NodeJS.ProcessEnv,
      cwd: options.cwd,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let done = false;
    const finish = (result: CommandResult) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };
    const stop = () => {
      child.kill("SIGKILL");
      finish({ kind: "timeout" });
    };
    const onAbort = () => stop();
    const timer = setTimeout(stop, options.timeoutMs);
    options.signal?.addEventListener("abort", onAbort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      stdout = (stdout + chunk.toString("utf8")).slice(0, MAX_OUTPUT_CHARS);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString("utf8")).slice(0, MAX_OUTPUT_CHARS);
    });
    child.once("error", (error) => finish({ kind: "spawn-error", error }));
    child.once("close", (code) => finish({ kind: "exit", code, stdout, stderr }));
  });
}

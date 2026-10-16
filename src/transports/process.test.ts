import { describe, expect, it } from "vitest";
import { runCommand } from "./process.ts";

const env = { PATH: process.env.PATH ?? "" };
const node = (code: string, options: { timeoutMs?: number; signal?: AbortSignal } = {}) =>
  runCommand(process.execPath, ["-e", code], { env, timeoutMs: options.timeoutMs ?? 5_000, ...(options.signal ? { signal: options.signal } : {}) });

describe("runCommand", () => {
  it("collects output and the exit code", async () => {
    await expect(node('console.log("out"); console.error("err"); process.exit(3)')).resolves.toEqual({
      kind: "exit",
      code: 3,
      stdout: "out\n",
      stderr: "err\n",
    });
  });

  it("reports a missing binary as a spawn error", async () => {
    const result = await runCommand("/nonexistent/cmd", [], { env, timeoutMs: 1_000 });
    expect(result).toMatchObject({ kind: "spawn-error", error: { code: "ENOENT" } });
  });

  it("kills a command that outlives its timeout", async () => {
    const started = Date.now();
    await expect(node("setTimeout(() => {}, 30000)", { timeoutMs: 100 })).resolves.toEqual({ kind: "timeout" });
    expect(Date.now() - started).toBeLessThan(5_000);
  });

  it("stops on abort", async () => {
    const controller = new AbortController();
    const result = node("setTimeout(() => {}, 30000)", { signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    await expect(result).resolves.toEqual({ kind: "timeout" });
    await expect(node("1", { signal: controller.signal })).resolves.toEqual({ kind: "timeout" });
  });

  it("caps the output it keeps", async () => {
    const result = await node('process.stdout.write("x".repeat(200000))');
    expect(result.kind).toBe("exit");
    if (result.kind === "exit") expect(result.stdout.length).toBe(64 * 1024);
  });
});

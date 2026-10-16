import { fileURLToPath } from "node:url";

/** The stand-in `cursor-agent` that speaks ACP. See the header of the script. */
export const FAKE_CURSOR_AGENT = fileURLToPath(new URL("./fake-cursor-agent.mjs", import.meta.url));

/** A clean env for a spawned fake CLI, with test knobs layered on top. */
export function fakeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("FAKE_CURSOR_")) env[key] = value;
  }
  return { ...env, ...extra };
}

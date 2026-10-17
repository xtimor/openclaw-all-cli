import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** The stand-in `cursor-agent` that speaks ACP. See the header of the script. */
export const FAKE_CURSOR_AGENT = fileURLToPath(new URL("./fake-cursor-agent.mjs", import.meta.url));

/**
 * A clean env for a spawned fake CLI (no real Cursor key), with test knobs layered on top. The
 * fake gets a fresh, empty `CURSOR_CONFIG_DIR` unless the caller names one in `extra`, so what a test runs
 * (such as the listing's cleanup) never touches the developer's real `~/.cursor`.
 */
export function fakeEnv(extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined && !key.startsWith("FAKE_CURSOR_") && key !== "CURSOR_API_KEY") env[key] = value;
  }
  // Never inherit a real CURSOR_CONFIG_DIR from the developer's shell.
  return { ...env, CURSOR_CONFIG_DIR: mkdtempSync(join(tmpdir(), "oac-fake-cursor-")), ...extra };
}

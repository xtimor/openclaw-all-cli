import { readFile } from "node:fs/promises";
import type { McpTarget } from "./mcp-proxy.ts";

/** The env variable through which the host names the turn's MCP settings file (`bundleMcpMode: "gemini-system-settings"`). */
export const SETTINGS_PATH_ENV = "GEMINI_CLI_SYSTEM_SETTINGS_PATH";

/** The MCP server name the host uses for its tools, in the settings file and towards the CLI. */
export const OPENCLAW_MCP_SERVER = "openclaw";

export type TurnTarget = { ok: true; target: McpTarget } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the turn's target from the settings file the host wrote for this run: the loopback
 * URL (`url` or `httpUrl`) and the headers of `mcpServers.openclaw`. The reason it returns on
 * failure never holds a header value or a token.
 */
export async function readTurnTarget(env: Readonly<Record<string, string | undefined>>): Promise<TurnTarget> {
  const path = env[SETTINGS_PATH_ENV]?.trim();
  if (!path) return { ok: false, reason: `${SETTINGS_PATH_ENV} is not set` };

  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `the settings file could not be read (${code ?? "invalid JSON"})` };
  }

  const servers = isRecord(settings) ? settings.mcpServers : undefined;
  const server = isRecord(servers) ? servers[OPENCLAW_MCP_SERVER] : undefined;
  if (!isRecord(server)) return { ok: false, reason: `the settings file has no mcpServers.${OPENCLAW_MCP_SERVER}` };

  // `httpUrl` wins, but a candidate that is blank, invalid, or not loopback does not hide a good `url`.
  let url: URL | undefined;
  let rejected: string | undefined;
  for (const candidate of [server.httpUrl, server.url]) {
    if (typeof candidate !== "string" || !candidate.trim()) continue;
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      rejected ??= `mcpServers.${OPENCLAW_MCP_SERVER}.url is not a URL`;
      continue;
    }
    // The host serves its tools on loopback; the proxy must not carry its token anywhere else.
    if (parsed.protocol !== "http:" || !LOOPBACK_HOSTS.has(parsed.hostname)) {
      rejected ??= `mcpServers.${OPENCLAW_MCP_SERVER}.url is not a loopback http URL`;
      continue;
    }
    url = parsed;
    break;
  }
  if (!url) return { ok: false, reason: rejected ?? `mcpServers.${OPENCLAW_MCP_SERVER} has no url` };

  const headers: Record<string, string> = {};
  if (isRecord(server.headers)) {
    for (const [name, value] of Object.entries(server.headers)) {
      if (typeof value === "string") headers[name] = value;
    }
  }
  return { ok: true, target: { url: url.toString(), headers } };
}

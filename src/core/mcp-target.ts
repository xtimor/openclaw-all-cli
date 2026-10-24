import { readFile } from "node:fs/promises";
import type { McpTarget } from "./mcp-proxy.ts";

/**
 * The launch flag through which the host names the turn's MCP config file (`bundleMcpMode:
 * "claude-config-file"`). The host's live-session fingerprint ignores this flag's value, so a new
 * file per turn does not restart the process.
 */
export const MCP_CONFIG_FLAG = "--mcp-config";

/** Host flags that take values (the host reads values up to the next flag), and that no CLI of ours knows. */
const HOST_VALUE_FLAGS = new Set([MCP_CONFIG_FLAG, "--disallowedTools", "--disallowed-tools"]);

/** Host flags without a value. */
const HOST_SWITCHES = new Set(["--strict-mcp-config"]);

/** The MCP server name the host uses for its tools, in the MCP config file and towards the CLI. */
export const OPENCLAW_MCP_SERVER = "openclaw";

/**
 * Takes the host's MCP flags out of the launch args, as the host reads them (`--flag=value` or
 * `--flag value...`), and returns the first config path. The CLI must never see these flags.
 */
export function splitMcpArgs(args: readonly string[]): { args: string[]; mcpConfigPath: string | undefined } {
  const kept: string[] = [];
  let mcpConfigPath: string | undefined;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    const name = equals < 0 ? arg : arg.slice(0, equals);
    if (HOST_SWITCHES.has(name)) continue;
    if (!HOST_VALUE_FLAGS.has(name)) {
      kept.push(arg);
      continue;
    }
    const values: string[] = [];
    if (equals >= 0) values.push(arg.slice(equals + 1));
    else while (typeof args[index + 1] === "string" && !args[index + 1]!.startsWith("-")) values.push(args[++index]!);
    if (name === MCP_CONFIG_FLAG) mcpConfigPath ??= values.map((value) => value.trim()).find(Boolean);
  }
  return { args: kept, mcpConfigPath };
}

export type TurnTarget = { ok: true; target: McpTarget } | { ok: false; reason: string };

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Reads the turn's target from the config file the host wrote for this run (the path from
 * `splitMcpArgs`): the loopback URL (`url` or `httpUrl`) and the headers of `mcpServers.openclaw`.
 * The reason it returns on failure never holds a header value or a token.
 */
export async function readTurnTarget(path: string | undefined): Promise<TurnTarget> {
  if (!path) return { ok: false, reason: `the launch arguments name no ${MCP_CONFIG_FLAG} file` };

  let settings: unknown;
  try {
    settings = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { ok: false, reason: `the MCP config file could not be read (${code ?? "invalid JSON"})` };
  }

  const servers = isRecord(settings) ? settings.mcpServers : undefined;
  const server = isRecord(servers) ? servers[OPENCLAW_MCP_SERVER] : undefined;
  if (!isRecord(server)) return { ok: false, reason: `the MCP config file has no mcpServers.${OPENCLAW_MCP_SERVER}` };

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

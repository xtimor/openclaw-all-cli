import { isDeepStrictEqual } from "node:util";
import { rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { AcpSession } from "../../transports/acp/session.ts";
import { readJsonObject, writeJsonAtomic } from "../../transports/files.ts";
import { runCommand } from "../../transports/process.ts";
import {
  CliError,
  type AuthProbeParams,
  type AuthStatus,
  type CliAdapter,
  type CliModel,
  type CliSession,
  type HomeEnv,
  type ListModelsParams,
  type McpServerSpec,
  type OpenParams,
} from "../../core/ports.ts";
import { cursorManifest } from "./manifest.ts";
import { buildCursorCatalog, selectCursorModel } from "./models.ts";
import { CURSOR_ALWAYS_ON_NATIVE_TOOLS, toCanonicalRequest } from "./permissions.ts";
import { describeCursorToolCall } from "./tool-display.ts";

const PROBE_TIMEOUT_MS = 5_000;

/** Longest a model listing may take: `cursor-agent acp` needs a few seconds to start a session. */
const LIST_MODELS_TIMEOUT_MS = 30_000;

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
  // Only a missing or invalid file starts fresh; an unreadable one must not drop Cursor's keys.
  const existing =
    (await readJsonObject(file).catch((error: unknown) => {
      throw new CliError(
        {
          code: "unclassified",
          message: `Could not read "${file}": ${error instanceof Error ? error.message : String(error)}`,
        },
        { cause: error },
      );
    })) ?? {};
  if (!isDeepStrictEqual(existing.permissions, CURSOR_PERMISSIONS)) {
    await writeJsonAtomic(file, { ...existing, permissions: CURSOR_PERMISSIONS });
  }
  return { CURSOR_CONFIG_DIR: home, CURSOR_DATA_DIR: join(home, "data") };
}

/** The ACP `McpServer` shape for an HTTP server: headers are a name/value list. */
function toAcpMcpServer(server: McpServerSpec) {
  return {
    type: "http" as const,
    name: server.name,
    url: server.url,
    headers: Object.entries(server.headers).map(([name, value]) => ({ name, value })),
  };
}

function open(params: OpenParams): Promise<CliSession> {
  return AcpSession.open({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    // With an API key Cursor needs no login step; `authenticate{cursor_login}` would try a browser login and fail.
    ...authMethodFor(params.env),
    // Cursor applies native edits without asking in agent mode, so only the per-agent `Write(**)`
    // deny stops them. `ask` mode has no edit tool at all and still asks for (and runs) what the
    // host approves, so it stays as the second lock (checked against cursor-agent 2026.10.16).
    requiredModeId: "ask",
    // The turn's model name maps onto the exact ID Cursor reports (brackets and commas included).
    selectModel: (offered) => {
      const id = selectCursorModel(params.modelId, offered);
      // Name the model in the error: the transport only knows the agent's IDs.
      if (id === undefined && offered.length > 0) {
        throw new CliError({
          code: "model_not_found",
          message: `Cursor has no model "${params.modelId}" for this account. List the models with \`openclaw models list --provider cursor-cli\`.`,
        });
      }
      return id;
    },
    ...(params.resumeSessionId ? { resumeSessionId: params.resumeSessionId } : {}),
    ...(params.mcpServers?.length ? { mcpServers: params.mcpServers.map(toAcpMcpServer) } : {}),
    describeToolCall: describeCursorToolCall,
    // A request the mapping cannot name goes to the core unnamed: the core rejects it after its
    // turn check, so a late one is `cancelled`.
    onPermissionRequest: async (request) =>
      params.onPermissionRequest(
        toCanonicalRequest(request) ?? {
          title: request.title,
          ...(request.kind ? { kind: request.kind } : {}),
          toolCallId: request.toolCallId,
        },
      ),
    ...(params.signal ? { signal: params.signal } : {}),
  });
}

/** The ACP `authenticate` step is needed only without an API key: with one, the login would open a browser. */
function authMethodFor(env: Record<string, string | undefined>): { authMethodId?: string } {
  return env.CURSOR_API_KEY?.trim() ? {} : { authMethodId: "cursor_login" };
}

/**
 * Lists the account's models from a throwaway ACP session: `session/new` reports them, and no
 * prompt is sent, so no model runs and no tokens are spent. The session starts in the temp
 * directory so it never touches a project (AD-7).
 */
async function listModels(params: ListModelsParams): Promise<readonly CliModel[]> {
  const timeout = AbortSignal.timeout(params.timeoutMs ?? LIST_MODELS_TIMEOUT_MS);
  const signal = params.signal ? AbortSignal.any([params.signal, timeout]) : timeout;
  let session: CliSession | undefined;
  let sessionId: string | undefined;
  try {
    const opened = await AcpSession.open({
      command: params.command,
      args: params.args,
      cwd: tmpdir(),
      env: params.env,
      ...authMethodFor(params.env),
      onPermissionRequest: async () => "cancelled",
      signal,
    });
    session = opened;
    sessionId = opened.sessionId;
    return buildCursorCatalog(opened.models);
  } catch (error) {
    if (error instanceof CliError) throw error;
    if (timeout.aborted && !params.signal?.aborted) {
      throw new CliError({ code: "timeout", message: "Listing the Cursor models timed out.", retryable: true }, { cause: error });
    }
    throw error;
  } finally {
    await session?.close();
    if (sessionId) await removeListingSession(params.env, sessionId);
  }
}

/**
 * Cursor stores every ACP session under `<config dir>/acp-sessions/<id>`. A listing's throwaway
 * session would pile up there on every refresh, so its directory, and only that one, is removed.
 * Failures are ignored: a leftover directory is harmless.
 */
async function removeListingSession(env: Record<string, string | undefined>, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return;
  const configDir = env.CURSOR_CONFIG_DIR?.trim() || join(homedir(), ".cursor");
  await rm(join(configDir, "acp-sessions", sessionId), { recursive: true, force: true }).catch(() => {});
}

export const cursorAdapter: CliAdapter = {
  id: "cursor",
  displayName: "Cursor CLI",
  command: "cursor-agent",
  launchArgs: ["acp"],
  defaultModel: "cursor-cli/auto",
  // Cursor's own spellings of Auto. Every other name comes from the account's model list.
  modelAliases: { "default[]": "auto", default: "auto" },
  manifest: cursorManifest,
  alwaysOnNativeTools: CURSOR_ALWAYS_ON_NATIVE_TOOLS,
  probeAuth,
  prepareHome,
  open,
  listModels,
};

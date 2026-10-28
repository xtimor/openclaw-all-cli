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
  type CheckVersionParams,
  type CliAdapter,
  type CliModel,
  type CliSession,
  type ExecutionMode,
  type HomeEnv,
  type ListModelsParams,
  type McpServerSpec,
  type OpenParams,
} from "../../core/ports.ts";
import { CURSOR_MIN_VERSION, cursorManifest } from "./manifest.ts";
import { buildCursorCatalog, cursorContextCeiling, selectCursorModel } from "./models.ts";
import { CURSOR_ALWAYS_ON_NATIVE_TOOLS, toCanonicalRequest } from "./permissions.ts";
import { classifyCursorReplyError } from "./errors.ts";
import { describeCursorToolCall } from "./tool-display.ts";
import { createCursorUsageReader, USAGE_URL_ENV } from "./usage.ts";

const PROBE_TIMEOUT_MS = 5_000;

/** Longest a model listing may take: `cursor-agent acp` needs a few seconds to start a session. */
const LIST_MODELS_TIMEOUT_MS = 30_000;

/**
 * Env keys the host removes from a turn's env (AD-14): endpoint overrides, harness and debug
 * switches, and telemetry exporters that would redirect or change a turn (seen in the 2026.10.16
 * bundle). `CURSOR_API_KEY` and `CURSOR_AUTH_TOKEN` are logins (P2) and stay. `CURSOR_CONFIG_DIR`
 * and `CURSOR_DATA_DIR` go because the per-agent home sets them (AD-6).
 */
export const CURSOR_CLEAR_ENV: readonly string[] = [
  "CURSOR_API_BASE_URL",
  "CURSOR_API_ENDPOINT",
  "CURSOR_WEBSITE_URL",
  "CURSOR_CONVERSATION_ID",
  "CURSOR_REQUEST_ID",
  "CURSOR_AGENT_PERSIST_SESSION",
  "CURSOR_AGENT_DEBUG_PORT",
  "CURSOR_AGENT_DEBUG_LIVE_BG",
  "CURSOR_AGENT_COMPLETED_PATH",
  "CURSOR_AGENT_CLI_LOCAL_MODE",
  "CURSOR_AGENT_CLI_AUTHLESS_MODE",
  "CURSOR_LOCAL_AGENT_HEADERS",
  "CURSOR_STATSIG_OVERRIDES",
  "CURSOR_HARNESS_TEST_NAME",
  "CURSOR_HARNESS_RUN_ID",
  "CURSOR_HARNESS_PROMPT_CATEGORY",
  "CURSOR_ASKPASS_SOCKET",
  "CURSOR_ASKPASS_SECRET",
  "CURSOR_CLI",
  // Moves the usage ledger calls, which carry the API key (tests only): a Gateway env must not redirect it.
  USAGE_URL_ENV,
  "CURSOR_CONFIG_DIR",
  "CURSOR_DATA_DIR",
  "NODE_OPTIONS",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_LOGS_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_SDK_DISABLED",
  "OTEL_TRACES_EXPORTER",
];

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

/** `YYYY.MM.DD` from `cursor-agent --version` (`2026.10.16-e3cb207`), as numbers. */
function parseVersion(text: string): [number, number, number] | undefined {
  const match = /\b(\d{4})\.(\d{1,2})\.(\d{1,2})\b/.exec(text);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : undefined;
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    const diff = (a[i] ?? 0) - (b[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

/**
 * AD-14: runs `cursor-agent --version` and compares it with the manifest's floor. A missing binary
 * and a version below the floor fail the turn; a version that cannot be read only warns, because
 * the install may print something this check does not know.
 */
async function checkVersion(params: CheckVersionParams): Promise<"ok" | { warning: string }> {
  const result = await runCommand(params.command, ["--version"], {
    env: params.env,
    timeoutMs: PROBE_TIMEOUT_MS,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  if (result.kind === "spawn-error") {
    if (result.error.code === "ENOENT") {
      throw new CliError({
        code: "cli_not_found",
        message: `Could not find the CLI binary "${params.command}". Install it or set its path in the plugin config.`,
      });
    }
    return { warning: `Could not run "${params.command} --version" (${result.error.message}), so its version is not checked.` };
  }
  if (result.kind === "timeout") {
    return { warning: `"${params.command} --version" did not answer in time, so its version is not checked.` };
  }
  const output = `${result.stdout}\n${result.stderr}`;
  const found = result.code === 0 ? parseVersion(output) : undefined;
  if (!found) {
    return { warning: `Could not read the version of "${params.command}", so it is not checked against ${CURSOR_MIN_VERSION}.` };
  }
  const floor = parseVersion(CURSOR_MIN_VERSION)!;
  if (compareVersions(found, floor) < 0) {
    const text = found.map((part, index) => (index === 0 ? String(part) : String(part).padStart(2, "0"))).join(".");
    throw new CliError({
      code: "unsupported_version",
      message: `cursor-agent ${text} is too old: this plugin needs ${CURSOR_MIN_VERSION} or newer. Run \`cursor-agent update\`.`,
    });
  }
  return "ok";
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

/**
 * The Cursor mode for a turn. `agent` only when OpenClaw's `exec` is actually offered to the model
 * in this turn (`hostShell`: the core read it from the host's tool list, after all tool policy): in
 * `ask` mode the model refuses any command that changes files, even through OpenClaw's `exec` (live:
 * 2 of 3 refused), so `exec` needs `agent`. Everything else stays in `ask`, which has no edit tool: a
 * side question, and a normal run without `exec` (exec host `node`, `tools.deny` or `tools.allow`
 * leaving it out, a rooted run, or a tool list the core could not read). `agent` mode makes the model
 * far more eager (a trivial turn used about 105k tokens in one probe), so it is not the default.
 *
 * `agent` is safe because the static home blocks the native shell, write, edit and delete without
 * asking (checked live in `agent` mode). `WebFetch(*)` has no effect: a native web fetch asks the
 * host in either mode, and OpenClaw's tool policy decides.
 */
function modeFor(executionMode: ExecutionMode, hostShell: boolean): string {
  return executionMode === "agent" && hostShell ? "agent" : "ask";
}

const DISPLAY_NAME = "Cursor CLI";
// Distinct from the older `@jeehou/openclaw-cursor-cli` plugin, which is also listed as "Cursor CLI".
const PROVIDER_LABEL = "OAC / Cursor-CLI";

function open(params: OpenParams): Promise<CliSession> {
  const executionMode = params.executionMode ?? "agent";
  // The core already hands a side question neither; the adapter does not rely on it.
  const sideQuestion = executionMode === "side-question";
  return AcpSession.open({
    command: params.command,
    args: params.args,
    cwd: params.cwd,
    env: params.env,
    // With an API key Cursor needs no login step; `authenticate{cursor_login}` would try a browser login and fail.
    ...authMethodFor(params.env),
    // Cursor applies native edits without asking in agent mode, so only the per-agent `Write(**)`
    // deny stops them (checked against cursor-agent 2026.10.16). `ask` mode has no edit tool and is
    // the second lock whenever the host serves no `exec`.
    requiredModeId: modeFor(executionMode, params.hostShell === true),
    displayName: DISPLAY_NAME,
    ...(params.requiredCapabilities?.length ? { requiredCapabilities: params.requiredCapabilities } : {}),
    // The turn's model name maps onto the exact ID Cursor reports (brackets and commas included).
    selectModel: (offered) => {
      const id = selectCursorModel(params.modelId, offered, params.thinkingLevel);
      // Name the model in the error: the transport only knows the agent's IDs.
      if (id === undefined && offered.length > 0) {
        throw new CliError({
          code: "model_not_found",
          message: `Cursor has no model "${params.modelId}" for this account. List the models with \`openclaw models list --provider cursor-cli\`.`,
        });
      }
      return id;
    },
    contextCeilingOf: cursorContextCeiling,
    ...(params.onProcessStart ? { onProcessStart: params.onProcessStart } : {}),
    ...(params.onPhase ? { onPhase: params.onPhase } : {}),
    ...(params.resumeSessionId && !sideQuestion ? { resumeSessionId: params.resumeSessionId } : {}),
    ...(params.mcpServers?.length && !sideQuestion ? { mcpServers: params.mcpServers.map(toAcpMcpServer) } : {}),
    describeToolCall: describeCursorToolCall,
    // Cursor reports a failed turn as its last reply chunk (see errors.ts).
    classifyReplyError: classifyCursorReplyError,
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
      classifyReplyError: classifyCursorReplyError,
      onPermissionRequest: async () => "cancelled",
      ...(params.onProcessStart ? { onProcessStart: params.onProcessStart } : {}),
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
 * Cursor stores every ACP session under `<config dir>/acp-sessions/<id>`. A throwaway session (a
 * listing's, or a new chat the core refused) would pile up there, so its directory, and only that
 * one, is removed.
 * Failures are ignored: a leftover directory is harmless.
 */
async function removeListingSession(env: Record<string, string | undefined>, sessionId: string): Promise<void> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(sessionId)) return;
  const configDir = env.CURSOR_CONFIG_DIR?.trim() || join(env.HOME?.trim() || homedir(), ".cursor");
  await rm(join(configDir, "acp-sessions", sessionId), { recursive: true, force: true }).catch(() => {});
}

/** One reader per plugin: its token cache and cooldowns outlive a turn. */
const usageReader = createCursorUsageReader();

export const cursorAdapter: CliAdapter = {
  id: "cursor",
  displayName: DISPLAY_NAME,
  providerLabel: PROVIDER_LABEL,
  command: "cursor-agent",
  launchArgs: ["acp"],
  defaultModel: "cursor-cli/auto",
  // Cursor's own spellings of Auto. Every other name comes from the account's model list.
  modelAliases: { "default[]": "auto", default: "auto" },
  manifest: cursorManifest,
  alwaysOnNativeTools: CURSOR_ALWAYS_ON_NATIVE_TOOLS,
  // Cursor's MCP client gives up on a tool call after 60 s and never hangs up (live probe).
  mcpCallTimeoutMs: 60_000,
  clearEnv: CURSOR_CLEAR_ENV,
  apiKeyEnvVar: "CURSOR_API_KEY",
  loginCommand: "cursor-agent login",
  checkVersion,
  probeAuth,
  prepareHome,
  open,
  listModels,
  discardSession: ({ env, sessionId }) => removeListingSession(env, sessionId),
  readUsage: usageReader.read,
};

import * as acp from "@agentclientprotocol/sdk";
import { CliError, capabilityMismatch, type CliCapability, type CliErrorCode } from "../../core/ports.ts";
import type { AcpModelInfo, AcpSessionOptions } from "./session.ts";
import { isRecord } from "./tool-calls.ts";

/**
 * The ACP handshake: initialize, log in, then start or resume a session in the right mode and
 * model. It knows no CLI; the options the adapter passes decide everything CLI-specific.
 */

export function toCliError(error: unknown, fallback: CliErrorCode, context: string): CliError {
  if (error instanceof CliError) return error;
  return new CliError({ code: fallback, message: `${context}: ${withDataMessage(error)}` }, { cause: error });
}

/**
 * The error's message plus the JSON-RPC `data.message` when it adds something. An agent answers a
 * failed start with a bare `Internal error` and the reason in `data.message`; without it the user
 * only sees the generic text.
 */
function withDataMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const data = (error as { data?: unknown } | null)?.data;
  const detail = isRecord(data) && typeof data.message === "string" ? data.message.trim() : "";
  return detail && !message.includes(detail) ? `${message}: ${detail}` : message;
}

function selectModels(options: acp.SessionConfigSelectOptions): AcpModelInfo[] {
  const models: AcpModelInfo[] = [];
  for (const entry of options) {
    if ("value" in entry) models.push({ id: entry.value, name: entry.name });
    else for (const inner of entry.options) models.push({ id: inner.value, name: inner.name });
  }
  return models;
}

/**
 * The ACP `models` state of a `session/new` or `session/load` result. The SDK's schema does not
 * type it, and agents send it as an extra field (ACP's model selection is still unstable).
 */
type SessionModelState = { currentModelId?: string; availableModels?: Array<{ modelId: string; name: string }> };

function readModelState(result: object): SessionModelState | undefined {
  const models = (result as { models?: unknown }).models;
  return typeof models === "object" && models !== null && !Array.isArray(models) ? (models as SessionModelState) : undefined;
}

/** What the agent says about its models: the `models` state, and a `model` select in `configOptions`. */
function readModelFacts(
  models: SessionModelState | null | undefined,
  configOptions: acp.SessionConfigOption[] | null | undefined,
): { offered: AcpModelInfo[]; currentId?: string; option?: acp.SessionConfigOption & { type: "select" } } {
  const found = configOptions?.find((candidate) => candidate.category === "model");
  const option = found?.type === "select" ? found : undefined;
  const offered: AcpModelInfo[] = (models?.availableModels ?? []).map((model) => ({
    id: model.modelId,
    name: model.name,
  }));
  if (offered.length === 0 && option) offered.push(...selectModels(option.options));
  const currentId = models?.currentModelId ?? option?.currentValue;
  return { offered, ...(currentId ? { currentId } : {}), ...(option ? { option } : {}) };
}

/** The ID an agent answers `session/load` with when it moved the chat; undefined when it did not. */
function readMovedSessionId(result: object): string | undefined {
  const id = (result as { sessionId?: unknown }).sessionId;
  return typeof id === "string" && id.trim() ? id : undefined;
}

/**
 * Whether an error says the *session* is unknown. A bare JSON-RPC `-32602`, or a "not found" about
 * anything else (an API key, a workspace), is not enough: only a phrase tied to "session" counts.
 * The reference CLI answers a missing chat with `Invalid params` and `data.message` `Session "<id>" not
 * found` (checked 2026-10-18), so the detail is read too.
 */
const SESSION_UNKNOWN =
  /\bsession\b[^.\n]{0,200}\b(not found|does not exist|doesn't exist|unknown|no such|expired)\b|\b(no such|unknown|invalid) session\b/i;

function errorDetail(error: unknown): string {
  const parts = [error instanceof Error ? error.message : String(error)];
  const data = (error as { data?: unknown } | null)?.data;
  if (typeof data === "string") parts.push(data);
  else if (isRecord(data)) {
    for (const value of Object.values(data)) if (typeof value === "string") parts.push(value);
  }
  return parts.join(" ");
}

/**
 * A `session/load` that failed. An agent that says it does not know the session (another agent's
 * home, a deleted chat) is `session_expired`, so the host can recover the way its
 * `freshSessionRecovery` says and nothing silently starts a new chat. The message carries
 * "session not found" because the host reads the text to classify the failure. Anything else (a
 * dead pipe, a timeout, a bare invalid-params) is a failed process, not a lost chat.
 */
function resumeError(error: unknown, sessionId: string): CliError {
  if (error instanceof CliError) return error;
  const detail = errorDetail(error);
  if (SESSION_UNKNOWN.test(detail)) {
    return new CliError(
      {
        code: "session_expired",
        message: `CLI session not found: the CLI does not know session "${sessionId}" in this agent's home (the chat belongs to another agent or was deleted), so it cannot resume. ${detail}`,
      },
      { cause: error },
    );
  }
  return toCliError(error, "server_error", "The CLI could not resume the session");
}

/** What the handshake hands back to the session. */
export type Handshake = { sessionId: string; models: AcpModelInfo[]; capabilities: ReadonlySet<CliCapability> };

/** The ACP handshake: initialize, log in, then start or resume a session in the right mode and model. */
export async function setup(connection: acp.ClientSideConnection, options: AcpSessionOptions): Promise<Handshake> {
  const init = await connection.initialize({
    protocolVersion: acp.PROTOCOL_VERSION,
    clientCapabilities: {},
    clientInfo: { name: options.clientName ?? "openclaw-all-cli", version: options.clientVersion ?? "0.0.0" },
  });
  if (init.protocolVersion !== acp.PROTOCOL_VERSION) {
    throw new CliError({
      code: "unsupported_version",
      message: `The CLI speaks ACP protocol ${init.protocolVersion}; this plugin supports ${acp.PROTOCOL_VERSION}.`,
    });
  }
  const capabilities = checkCapabilities(init, options);
  if (options.authMethodId) await authenticate(connection, init.authMethods, options.authMethodId);

  const { sessionId, modes, modelState, configOptions } = await startSession(connection, options);

  if (options.requiredModeId) {
    const wanted = options.requiredModeId;
    if (!modes?.availableModes.some((mode) => mode.id === wanted)) {
      throw new CliError({
        code: "capability_mismatch",
        message: `The CLI offers no "${wanted}" mode, so it cannot run safely.`,
      });
    }
    if (modes.currentModeId !== wanted) {
      await connection.setSessionMode({ sessionId, modeId: wanted });
    }
  }

  const facts = readModelFacts(modelState, configOptions);
  if (options.selectModel || options.modelId) await switchModel(connection, sessionId, facts, options);
  return { sessionId, models: facts.offered, capabilities };
}

/**
 * What the agent reports in `initialize`, in the core's names. Before any login or session: a
 * mismatch costs no chat. A resume needs `loadSession` even when the adapter did not list it.
 */
function checkCapabilities(init: acp.InitializeResponse, options: AcpSessionOptions): ReadonlySet<CliCapability> {
  const caps = init.agentCapabilities;
  const capabilities = new Set<CliCapability>();
  if (caps?.loadSession === true) capabilities.add("resumeSession");
  if (caps?.mcpCapabilities?.http === true) capabilities.add("httpMcp");
  if (caps?.promptCapabilities?.image === true) capabilities.add("imagePrompts");
  const needed = [...(options.requiredCapabilities ?? [])];
  if (options.resumeSessionId && !needed.some((item) => item.capability === "resumeSession")) {
    needed.push({ row: "P5", capability: "resumeSession" });
  }
  const missing = needed.filter((item) => !capabilities.has(item.capability));
  if (missing.length > 0) throw capabilityMismatch(options.displayName ?? "The CLI", missing);
  return capabilities;
}

async function authenticate(connection: acp.ClientSideConnection, methods: acp.AuthMethod[] | undefined, methodId: string): Promise<void> {
  // An absent list is today's behavior: log in. An empty list needs no login. A list without
  // the adapter's method means the login the adapter relies on is gone.
  if (!methods) {
    await login(connection, methodId);
  } else if (methods.length > 0) {
    if (!methods.some((method) => method.id === methodId)) {
      throw new CliError({
        code: "capability_mismatch",
        message: `The CLI offered no "${methodId}" login method (it lists ${methods.map((method) => `"${method.id}"`).join(", ")}). Update the CLI.`,
      });
    }
    await login(connection, methodId);
  }
}

/** Resumes the wanted session, or starts a new one. */
async function startSession(
  connection: acp.ClientSideConnection,
  options: AcpSessionOptions,
): Promise<{
  sessionId: string;
  modes: acp.SessionModeState | null | undefined;
  modelState: SessionModelState | undefined;
  configOptions: acp.SessionConfigOption[] | null | undefined;
}> {
  const base = { cwd: options.cwd, mcpServers: options.mcpServers ?? [] };
  if (options.resumeSessionId) {
    try {
      const loaded = await connection.loadSession({ sessionId: options.resumeSessionId, ...base });
      // ACP's load answers for the ID it was given; an agent that moves the chat to another ID
      // says so in an extra `sessionId` field. The new ID is the one the host must keep.
      return {
        sessionId: readMovedSessionId(loaded) ?? options.resumeSessionId,
        modes: loaded.modes,
        modelState: readModelState(loaded),
        configOptions: loaded.configOptions,
      };
    } catch (error) {
      throw resumeError(error, options.resumeSessionId);
    }
  }
  try {
    const created = await connection.newSession(base);
    return {
      sessionId: created.sessionId,
      modes: created.modes,
      modelState: readModelState(created),
      configOptions: created.configOptions,
    };
  } catch (error) {
    throw toCliError(error, "server_error", "The CLI could not start a session");
  }
}

async function login(connection: acp.ClientSideConnection, methodId: string): Promise<void> {
  try {
    await connection.authenticate({ methodId });
  } catch (error) {
    throw toCliError(error, "auth", "The CLI rejected its login");
  }
}

/**
 * Switches the session to the wanted model. A `model` select in `configOptions` is the standard
 * way; an agent that only reports the `models` state is switched with `session/set_model`. The
 * wanted ID must be one the agent offered, so a stale or unknown name fails as `model_not_found`.
 */
async function switchModel(
  connection: acp.ClientSideConnection,
  sessionId: string,
  facts: ReturnType<typeof readModelFacts>,
  options: AcpSessionOptions,
): Promise<void> {
  const { offered, currentId, option } = facts;
  const wanted = options.selectModel ? options.selectModel(offered, currentId) : options.modelId;
  if (wanted === null) return;
  if (wanted === undefined || !offered.some((model) => model.id === wanted)) {
    const asked = wanted ?? options.modelId ?? "";
    throw new CliError(
      offered.length === 0
        ? {
            code: "capability_mismatch",
            message: `The CLI does not list models, so it cannot switch to a model${asked ? ` "${asked}"` : ""}.`,
          }
        : { code: "model_not_found", message: `The CLI has no model${asked ? ` "${asked}"` : ""} for this account.` },
    );
  }
  if (wanted === currentId) return;
  try {
    if (option) await connection.setSessionConfigOption({ sessionId, configId: option.id, value: wanted });
    else await connection.extMethod("session/set_model", { sessionId, modelId: wanted });
  } catch (error) {
    // An agent that refuses the value says so as invalid params; anything else is a failed process.
    const refused = error instanceof Error && /\b(invalid|unknown|not found|no such)\b/i.test(error.message);
    throw toCliError(error, refused ? "model_not_found" : "server_error", `The CLI could not switch to model "${wanted}"`);
  }
}

/**
 * Core ports: the only module adapters and transports may import from the core (AD-2).
 * It holds no OpenClaw import and names no CLI.
 */

// ---------------------------------------------------------------------------
// Events (AD-3)
// ---------------------------------------------------------------------------

/** Token counts for one turn. Only the fields a CLI reports are set. */
export type NormalizedUsage = {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
};

/**
 * The one event language every adapter speaks.
 * - `text` and `thinking` are deltas.
 * - `usage` is per turn.
 * - `sessionId` is the native session ID to resume.
 * - `result` closes the turn exactly once; `text` is the full reply.
 * - `error` closes the turn exactly once, instead of `result`.
 * - Native tool events are display-only: the host never treats them as tool execution.
 */
export type NormalizedEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolStart"; toolCallId: string; name: string; args?: Record<string, unknown> }
  | { kind: "toolResult"; toolCallId: string; name?: string; isError?: boolean; result?: unknown }
  | { kind: "usage"; usage: NormalizedUsage }
  | { kind: "sessionId"; sessionId: string }
  | { kind: "result"; text: string; stopReason: string }
  | { kind: "error"; error: CliErrorInfo };

// ---------------------------------------------------------------------------
// Errors (AD-11)
// ---------------------------------------------------------------------------

/** OpenClaw's failover reasons, mirrored here so adapters need no OpenClaw import. */
export const FAILOVER_REASONS = [
  "auth",
  "auth_permanent",
  "format",
  "rate_limit",
  "overloaded",
  "billing",
  "server_error",
  "timeout",
  "tls_certificate",
  "context_overflow",
  "model_not_found",
  "session_expired",
  "empty_response",
  "no_error_details",
  "unclassified",
  "unknown",
] as const;
export type FailoverReason = (typeof FAILOVER_REASONS)[number];

/** Codes the architecture adds on top of the failover reasons (AD-10, AD-14, binary lookup). */
export const EXTRA_ERROR_CODES = ["capability_mismatch", "unsupported_version", "cli_not_found"] as const;

export type CliErrorCode = FailoverReason | (typeof EXTRA_ERROR_CODES)[number];

/** How each code reaches OpenClaw's failover logic. The extra codes map to the nearest reason. */
export const FAILOVER_REASON_BY_CODE: Record<CliErrorCode, FailoverReason> = {
  ...Object.fromEntries(FAILOVER_REASONS.map((reason) => [reason, reason])),
  capability_mismatch: "format",
  unsupported_version: "format",
  cli_not_found: "unclassified",
} as Record<CliErrorCode, FailoverReason>;

export type CliErrorInfo = {
  code: CliErrorCode;
  /** False once any tool call started in the turn: a retry could repeat a side effect. */
  retryable: boolean;
  message: string;
};

/** The only error adapters throw. */
export class CliError extends Error implements CliErrorInfo {
  readonly code: CliErrorCode;
  readonly retryable: boolean;

  constructor(info: { code: CliErrorCode; message: string; retryable?: boolean }, options?: { cause?: unknown }) {
    super(info.message, options);
    this.name = "CliError";
    this.code = info.code;
    this.retryable = info.retryable ?? false;
  }

  toInfo(): CliErrorInfo {
    return { code: this.code, retryable: this.retryable, message: this.message };
  }
}

// ---------------------------------------------------------------------------
// Capability manifest (AD-10)
// ---------------------------------------------------------------------------

/** The parity rows of `claude-cli-parity.md`. */
export const PARITY_ROWS = [
  "P1",
  "P2",
  "P3",
  "P4",
  "P5",
  "P6",
  "P7",
  "P8",
  "P9",
  "P10",
  "P11",
  "P12",
  "P13",
  "P14",
  "P15",
  "P16",
  "P17",
  "P18",
  "P19",
] as const;
export type ParityRowId = (typeof PARITY_ROWS)[number];

/** `match` and `approx` and `gap` are decisions; `spike` and `tbd` are open questions. */
export type ParityStatus = "match" | "approx" | "gap" | "spike" | "tbd";

/**
 * What a CLI session can report at open, in the core's own words (AD-2): the transport maps its
 * protocol's fields onto these names.
 */
export type CliCapability = "resumeSession" | "httpMcp" | "imagePrompts";

export type ParityRow = {
  status: ParityStatus;
  note: string;
  /**
   * Capabilities the CLI must report at open while the row is decided (`match` or `approx`).
   * The core fails the turn with `capability_mismatch` when one is missing (AD-10).
   */
  requires?: readonly CliCapability[];
};

export type CapabilityManifest = {
  /** Lowest CLI version the adapter supports. */
  minVersion: string;
  rows: Record<ParityRowId, ParityRow>;
};

const CAPABILITY_LABELS: Record<CliCapability, string> = {
  resumeSession: "session resume",
  httpMcp: "HTTP MCP servers",
  imagePrompts: "image prompts",
};

/** A capability a decided parity row needs from the CLI. */
export type RequiredCapability = { row: ParityRowId; capability: CliCapability };

/** The one `capability_mismatch` error, built by the core and by a transport that checks early (AD-10). */
export function capabilityMismatch(displayName: string, missing: readonly RequiredCapability[]): CliError {
  const what = missing.map((item) => `${CAPABILITY_LABELS[item.capability]} (parity row ${item.row})`).join(" and ");
  return new CliError({
    code: "capability_mismatch",
    message: `Capability mismatch: ${displayName} does not report ${what}, which the plugin's manifest needs. Update the CLI.`,
  });
}

/** Builds a manifest where every row is undecided; an adapter overrides the rows it knows. */
export function createManifest(
  minVersion: string,
  overrides: Partial<Record<ParityRowId, ParityRow>>,
): CapabilityManifest {
  const rows = Object.fromEntries(
    PARITY_ROWS.map((id) => [id, overrides[id] ?? { status: "tbd", note: "not researched" }]),
  ) as CapabilityManifest["rows"];
  return { minVersion, rows };
}

// ---------------------------------------------------------------------------
// Adapter port (AD-11)
// ---------------------------------------------------------------------------

/**
 * A CLI permission request, already named in OpenClaw's terms by the adapter (AD-2). The core
 * hands `toolName` and `toolInput` to the host, which owns approval authority.
 */
export type PermissionRequest = {
  /** What the CLI wants to do, as the CLI names it. For logs and display only. */
  title: string;
  /** The CLI's tool kind, for example `execute` or `edit`. */
  kind?: string;
  toolCallId?: string;
  /**
   * The canonical OpenClaw tool name: `exec`, `write`, `edit`, `delete`, `web_fetch`, `web_search`,
   * `read`, `grep`, `glob`, or `mcp__<server>__<tool>` for an MCP tool. Absent when the adapter
   * cannot name the call; the core then rejects it without asking the host.
   */
  toolName?: string;
  /** The action's input, shaped like the input of OpenClaw's tool of that name. */
  toolInput?: Record<string, unknown>;
};

/** The core's answer to a CLI permission request. */
export type PermissionDecision = "allow_once" | "reject_once" | "cancelled";

/** An HTTP MCP server the CLI session is given. The core hands over only its own proxy (AD-12). */
export type McpServerSpec = {
  name: string;
  url: string;
  headers: Readonly<Record<string, string>>;
};

/**
 * What a turn is for. `agent` is the chat itself. `side-question` is a throwaway question beside
 * it: no OpenClaw tools, every permission request rejected, never resumed (parity row P18).
 */
export type ExecutionMode = "agent" | "side-question";

export type OpenParams = {
  /** The CLI binary, absolute or on PATH. */
  command: string;
  /** The adapter's `launchArgs`, as OpenClaw passes them back. */
  args: readonly string[];
  /** Working directory of the turn. OpenClaw's. */
  cwd: string;
  env: Record<string, string>;
  modelId: string;
  /**
   * OpenClaw's thinking level for the turn (`off`, `low`, `medium`, `high`, ...), absent when the user
   * set none. An adapter whose model has an effort setting picks the matching variant at open.
   */
  thinkingLevel?: string;
  /** Defaults to `agent`. A side question has no `resumeSessionId` and no `mcpServers`. */
  executionMode?: ExecutionMode;
  /**
   * Whether the host really offers its own shell tool (`exec`) to the model in this turn (read from its tool list). When it does
   * not, the CLI has no shell at all, and an adapter should keep its most restrictive mode.
   */
  hostShell?: boolean;
  /** The native session ID to resume. Set only when OpenClaw says to resume. */
  resumeSessionId?: string;
  /** MCP servers for the native session, given at both new and resumed sessions. */
  mcpServers?: readonly McpServerSpec[];
  /**
   * What the manifest's decided rows need from the CLI (AD-10). A transport that learns the CLI's
   * capabilities before it creates a session should fail with `capabilityMismatch` right then.
   * The core checks the session's report again after the open, for transports that do not.
   */
  requiredCapabilities?: readonly RequiredCapability[];
  /** Answers a CLI permission request. */
  onPermissionRequest: (request: PermissionRequest) => Promise<PermissionDecision>;
  /**
   * Called once with the process ID as soon as the process exists, before any handshake, so the
   * core can record it (AD-14). Not called when the process could not be started. `info` says how
   * the process is stopped; an adapter that does not pass it leaves the core with the pid alone.
   */
  onProcessStart?: (pid: number, info?: ProcessStartInfo) => void;
  signal?: AbortSignal;
};

/**
 * What a transport tells the core about a process it started. `processGroup`: the process leads
 * its own process group (POSIX), and the transport stops the whole group wherever it stops the
 * process, so children the CLI starts (a worker, language servers) go with it.
 */
export type ProcessStartInfo = { processGroup: boolean };

/** One image for a prompt (parity row P13): its type from the file's first bytes, and its bytes in base64. Never logged. */
export type PromptImage = { mimeType: string; data: string };

/** One live conversation with a CLI process. */
export interface CliSession {
  /** The native session ID. */
  readonly sessionId: string;
  /** The OS process ID, when the session runs in its own process. */
  readonly pid?: number;
  /** False once the process exited or the session was closed. */
  readonly alive: boolean;
  /** What the CLI reported at open. Absent: the session reports nothing and is not checked. */
  readonly capabilities?: ReadonlySet<CliCapability>;
  /**
   * Sends one prompt and yields the turn's events. The last event is `result` or `error`. The images
   * follow the text in the CLI's protocol; an empty text sends no text.
   */
  prompt(text: string, images?: readonly PromptImage[]): AsyncIterable<NormalizedEvent>;
  /** Asks the CLI to stop the running turn and answers pending permission requests `cancelled`. */
  cancel(): Promise<void>;
  /** Ends the process. Safe to call twice. */
  close(): Promise<void>;
  /** Resolves when the process has exited. */
  waitForExit(): Promise<void>;
}

/** Environment variables an adapter adds so its CLI keeps its state in the per-agent home. */
export type HomeEnv = Readonly<Record<string, string>>;

export type AuthStatus = "available" | "missing" | "unreadable";

export type AuthProbeParams = {
  command: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
};

/** One model the CLI offers the account, as the plugin names it. */
export type CliModel = {
  /** The stable, readable name: `<backendId>/<name>` is the model ref the user types. */
  name: string;
  /** What `/model` shows. */
  label: string;
  /** The CLI's exact ID for the model (it may hold brackets and commas). The adapter maps `name` onto it. */
  id: string;
  /** True when the CLI shows the model has a reasoning-effort setting. Absent: it does not. */
  reasoning?: boolean;
};

export type ListModelsParams = {
  command: string;
  args: readonly string[];
  env: Record<string, string>;
  /** Longest the listing may take. */
  timeoutMs?: number;
  /** As `OpenParams.onProcessStart`: lets the core record the listing's process (AD-14). */
  onProcessStart?: (pid: number, info?: ProcessStartInfo) => void;
  signal?: AbortSignal;
};

export type CheckVersionParams = {
  command: string;
  env: Record<string, string | undefined>;
  signal?: AbortSignal;
};

/** What the core tells an adapter about a finished turn, to look up its usage (times are epoch ms). */
export type UsageQuery = {
  /** The native session id the turn ran in. */
  sessionId: string;
  /** Just before the prompt was sent. */
  startedAt: number;
  /** When the CLI reported the turn's result. */
  endedAt: number;
  /** The turn's env: the host's plus the per-agent home's. */
  env: Readonly<Record<string, string | undefined>>;
  /** Aborts when the host cancels the turn; the wait ends at once. */
  signal?: AbortSignal;
};

/** `usage` is absent when the adapter has none; `warning` is a short log line (no secrets, no response bodies). */
export type UsageReport = { usage?: NormalizedUsage; warning?: string };

/** What one CLI provider supplies to the core. Adapters import only this module and transports. */
export interface CliAdapter {
  /** Short CLI name, for example `acme`. The backend ID is `<id>-cli`. */
  readonly id: string;
  readonly displayName: string;
  /** Default binary name. */
  readonly command: string;
  /** Arguments that start the CLI in its session mode, for example `["acp"]`. */
  readonly launchArgs: readonly string[];
  /** The model ref to use for a quick check, for example `acme-cli/auto`. */
  readonly defaultModel: string;
  /** Maps an OpenClaw model ID onto a CLI model ID where they differ. */
  readonly modelAliases?: Readonly<Record<string, string>>;
  readonly manifest: CapabilityManifest;
  /**
   * Native tools (canonical names, see `PermissionRequest.toolName`) the CLI keeps available in
   * every turn and the adapter cannot switch off per turn, for example a reader its permission
   * file allows. The core claims exact tool-availability enforcement only for a run whose native
   * selection contains all of them.
   */
  readonly alwaysOnNativeTools: readonly string[];
  /**
   * How long the CLI's MCP client waits for one tool call before it gives up without hanging up, in
   * ms. When set, the core's proxy stops a call 5 s before that (see `StartMcpProxyOptions`).
   */
  readonly mcpCallTimeoutMs?: number;
  /**
   * Env keys the host removes from the Gateway's env before a turn, and the core removes before
   * it lists models or probes the login: endpoint overrides, harness and debug switches. Never a
   * key that carries the CLI's login.
   */
  readonly clearEnv: readonly string[];
  /**
   * Checks the installed CLI against `manifest.minVersion` (AD-14). Resolves `"ok"`, or a
   * warning when the version cannot be read (the turn still runs). Throws `CliError`:
   * `unsupported_version` for a version below the floor, `cli_not_found` for a missing binary.
   */
  checkVersion(params: CheckVersionParams): Promise<"ok" | { warning: string }>;
  /** Asks the CLI whether its own login works, without reading token material. */
  probeAuth(params: AuthProbeParams): Promise<AuthStatus>;
  /**
   * Sets up the per-agent home (AD-6): the directory is the core's choice, the CLI's variable
   * names and file format are the adapter's. Writes only static permissions (AD-9), safe to call
   * for the same home from parallel turns. Returns the env additions that point the CLI at it.
   */
  prepareHome(home: string): Promise<HomeEnv>;
  /** Starts the process and the native session. Throws `CliError` only. */
  open(params: OpenParams): Promise<CliSession>;
  /**
   * Lists the account's models from the CLI itself, without spending tokens or running a turn.
   * `name` is unique and stable; `open` accepts it as `OpenParams.modelId`. Throws `CliError` only.
   * It settles only after the process it started has exited (the core releases the process's lock
   * then), also when `signal` aborts.
   */
  listModels(params: ListModelsParams): Promise<readonly CliModel[]>;
  /**
   * Optional. Looks up the turn's token usage for a CLI that does not report it in-session. The
   * core calls it once per turn that ended with `result` and has no `usage` event, after the
   * closing tool records. The adapter bounds its own time (AD-11) and answers `{}` when it has no
   * usage; by contract it does not throw, and the core treats a throw as no usage.
   */
  readUsage?(query: UsageQuery): Promise<UsageReport>;
  /**
   * Optional. Removes what the CLI stored for a throwaway native session: one that was created and
   * then refused (a capability mismatch the transport could not see earlier), and a side
   * question's, once its process has exited. The core calls it only for a session it opened as a
   * new chat, never for a resumed one. Failures are ignored.
   */
  discardSession?(params: { env: Record<string, string>; sessionId: string }): Promise<void>;
}

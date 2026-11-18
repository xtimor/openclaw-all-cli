import { backendIdFor } from "./backend.ts";
import { readBackendConfig } from "./config.ts";
import { withoutKeys } from "./env.ts";
import { trackListing } from "./listings.ts";
import { FAILOVER_REASON_BY_CODE, type CliAdapter, type CliErrorCode, type CliErrorInfo, type FailoverReason, type NormalizedEvent, type NormalizedUsage } from "./ports.ts";

/**
 * OpenClaw's own runtime (not the CLI backend) serves some requests for a provider: the Control UI's
 * Test connection (`models.probe`), the skill review, and the session companion's "ask" all force it.
 * That runtime would send an HTTP request to the catalog's placeholder URL, so the provider gives it a
 * stream of its own: one text-only turn through the adapter's `complete`. The shapes below are
 * OpenClaw's (2026.10.3 and 2026.11.x), reduced to the fields the plugin reads or sets.
 */

type TextPart = { type: "text"; text: string };
type ContextMessage = { role: string; content: string | ReadonlyArray<{ type: string }>; toolName?: string };
/** The request: system prompt, then the conversation so far. Tools are ignored. */
export type StreamContext = { systemPrompt?: string; messages: ContextMessage[]; tools?: unknown[] };
export type StreamModel = { id: string; api: string; provider: string };
export type StreamOptions = { apiKey?: string; signal?: AbortSignal };

type StopReason = "stop" | "length" | "toolUse" | "error" | "aborted";
type Usage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
};
export type AssistantMessage = {
  role: "assistant";
  content: TextPart[];
  api: string;
  provider: string;
  model: string;
  usage: Usage;
  stopReason: StopReason;
  errorMessage?: string;
  errorCode?: string;
  timestamp: number;
};
export type AssistantMessageEvent =
  | { type: "start"; partial: AssistantMessage }
  | { type: "text_start"; contentIndex: number; partial: AssistantMessage }
  | { type: "text_delta"; contentIndex: number; delta: string; partial: AssistantMessage }
  | { type: "text_end"; contentIndex: number; content: string; partial: AssistantMessage }
  | { type: "done"; reason: "stop"; message: AssistantMessage }
  | { type: "error"; reason: "aborted" | "error"; error: AssistantMessage };

/** OpenClaw's `AssistantMessageEventStreamContract`: the events, then the final message. */
export type AssistantMessageEventStream = AsyncIterable<AssistantMessageEvent> & {
  push(event: AssistantMessageEvent): void;
  /** Completes the stream, optionally with the final message. */
  end(result?: AssistantMessage): void;
  result(): Promise<AssistantMessage>;
};
export type StreamFn = (model: StreamModel, context: StreamContext, options?: StreamOptions) => AssistantMessageEventStream;

/** `ProviderCreateStreamFnContext`, reduced to what the plugin reads. */
type CreateStreamFnContext = {
  config?: { plugins?: { entries?: Record<string, { config?: Record<string, unknown> } | undefined> } };
};
/** `ProviderFailoverErrorContext`, reduced to what the plugin reads. */
type FailoverErrorContext = { code?: string; errorMessage?: string };

export type StreamHookDeps = {
  /** The Gateway's environment (tests). Default: `process.env`. */
  env?: () => Readonly<Record<string, string | undefined>>;
  /** The time limit of one request (tests). Default: `COMPLETE_TIMEOUT_MS`. */
  timeoutMs?: number;
};

/** Longest one request may run when the host gives no signal that ends it sooner. */
export const COMPLETE_TIMEOUT_MS = 120_000;

/** Role labels of the flattened prompt. */
const ROLE_LABELS: Readonly<Record<string, string>> = { user: "User", assistant: "Assistant", toolResult: "Tool result" };

function textOf(content: ContextMessage["content"]): string {
  if (typeof content === "string") return content;
  return content
    .filter((part): part is TextPart => part.type === "text" && typeof (part as Partial<TextPart>).text === "string")
    .map((part) => part.text)
    .join("");
}

/**
 * The request as one prompt: the system prompt, then every message in order under its role label,
 * text parts only (images, thinking and tool calls are dropped; the CLI runs without tools here).
 */
export function flattenContext(context: StreamContext): string {
  const sections: string[] = [];
  const system = context.systemPrompt?.trim();
  if (system) sections.push(`System:\n${system}`);
  for (const message of context.messages ?? []) {
    const label = ROLE_LABELS[message.role];
    const text = textOf(message.content).trim();
    if (!label || !text) continue;
    sections.push(`${message.role === "toolResult" && message.toolName ? `${label} (${message.toolName})` : label}:\n${text}`);
  }
  return sections.join("\n\n");
}

/** The prefix of an `errorCode` the plugin sets, so its `classifyFailoverReason` knows its own codes. */
function errorCodePrefix(pluginId: string): string {
  return `${pluginId}:`;
}

/**
 * A pushable event stream with a final result, as OpenClaw's stream consumers read it. A plain object
 * with its methods as own properties: OpenClaw's stream wrappers copy and rebind them.
 */
function createEventStream(): AssistantMessageEventStream {
  const queue: AssistantMessageEvent[] = [];
  let waiting: (() => void) | undefined;
  /** No more events but a closing one (after `end()`). */
  let ended = false;
  /** The final message is settled. */
  let closed = false;
  let settle!: (message: AssistantMessage) => void;
  const final = new Promise<AssistantMessage>((resolve) => {
    settle = resolve;
  });
  const isLast = (event: AssistantMessageEvent) => event.type === "done" || event.type === "error";
  return {
    push(event) {
      if (closed) return;
      if (isLast(event)) {
        // A closing event settles the result even after a bare `end()`.
        closed = true;
        settle(event.type === "done" ? event.message : event.type === "error" ? event.error : (undefined as never));
      }
      if (!ended || isLast(event)) queue.push(event);
      waiting?.();
    },
    end(result) {
      // Ends the event flow; a result given here settles the final message. Without one, a later
      // closing event still settles it.
      ended = true;
      if (result && !closed) {
        closed = true;
        settle(result);
      }
      waiting?.();
    },
    result: () => final,
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          if (isLast(next)) return;
          continue;
        }
        if (closed || ended) return;
        await new Promise<void>((resolve) => {
          waiting = resolve;
        });
        waiting = undefined;
      }
    },
  };
}

const zeroUsage = (): Usage => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function toUsage(usage: NormalizedUsage): Usage {
  const input = usage.input ?? 0;
  const output = usage.output ?? 0;
  const cacheRead = usage.cacheRead ?? 0;
  const cacheWrite = usage.cacheWrite ?? 0;
  return { ...zeroUsage(), input, output, cacheRead, cacheWrite, totalTokens: usage.total ?? input + output + cacheRead + cacheWrite };
}

/**
 * The provider hooks that let OpenClaw's own runtime reach the CLI: `createStreamFn`, and
 * `classifyFailoverReason`, which maps the stream's error codes onto failover reasons so a check
 * shows auth, rate limit, model not found, or a missing CLI, never a timeout that was none. Empty
 * for an adapter without `complete`.
 */
export function createStreamHook(adapter: CliAdapter, pluginId: string, deps: StreamHookDeps = {}) {
  if (!adapter.complete) return {};
  const complete = adapter.complete.bind(adapter);
  const backendId = backendIdFor(adapter);
  const prefix = errorCodePrefix(pluginId);
  return {
    createStreamFn(ctx: CreateStreamFnContext): StreamFn {
      const settings = readBackendConfig(ctx.config?.plugins?.entries?.[pluginId]?.config, backendId, () => {});
      const command = settings.command ?? adapter.command;
      return (model, context, options) => {
        const stream = createEventStream();
        const message = (stopReason: StopReason, text: string, usage: Usage): AssistantMessage => ({
          role: "assistant",
          content: text ? [{ type: "text", text }] : [],
          api: model.api,
          provider: model.provider,
          model: model.id,
          usage,
          stopReason,
          timestamp: Date.now(),
        });
        void (async () => {
          const signal = options?.signal;
          /** The run's signal: the host's, the unload, and the time limit. */
          let runSignal: AbortSignal | undefined = signal;
          let timeLimit: AbortSignal | undefined;
          let text = "";
          let usage = zeroUsage();
          const fail = (info: CliErrorInfo | undefined) => {
            // The time limit is a failure (timeout); the host's abort or the unload is an abort.
            const timedOut = timeLimit?.aborted === true && signal?.aborted !== true;
            if (timedOut) info = { code: "timeout", retryable: true, message: `${adapter.displayName} did not finish the request within ${Math.round((deps.timeoutMs ?? COMPLETE_TIMEOUT_MS) / 1000)} s.` };
            const aborted = runSignal?.aborted === true && !timedOut;
            const failed = message(aborted ? "aborted" : "error", text, usage);
            failed.errorMessage = aborted ? "The request was aborted." : info?.message || `${adapter.displayName} failed without a message.`;
            if (!aborted && info) failed.errorCode = `${prefix}${info.code}`;
            stream.push({ type: "error", reason: aborted ? "aborted" : "error", error: failed });
          };
          try {
            stream.push({ type: "start", partial: message("stop", "", usage) });
            const keyVar = adapter.apiKeyEnvVar;
            const gatewayEnv = deps.env?.() ?? process.env;
            const base = { ...withoutKeys(gatewayEnv, adapter.clearEnv), ...settings.env };
            // OpenClaw's key for the request wins; a marker (the CLI's own login) is no key: the check
            // runs in a throwaway home, which never reads the CLI's own login.
            const hostKey = options?.apiKey?.trim();
            const given = hostKey && !hostKey.startsWith("openclaw:") ? hostKey : undefined;
            // Then the same places a turn reads: the plugin config's `env`, the Gateway's environment.
            const key = given ?? (keyVar ? base[keyVar]?.trim() || undefined : undefined);
            if (keyVar && !key) {
              fail({
                code: "auth",
                retryable: false,
                message: `${adapter.displayName} has no API key (unauthorized): this check needs one, the CLI's own login is not used. Save a key with the provider's API key method, or set ${keyVar} in the plugin config's ${backendId}.env.`,
              });
              return;
            }
            const env = Object.fromEntries(
              Object.entries({ ...base, ...(keyVar && key ? { [keyVar]: key } : {}) }).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
            );
            const prompt = flattenContext(context);
            if (!prompt) {
              fail({ code: "format", retryable: false, message: "The request has no text to send." });
              return;
            }
            let started = false;
            // The closing event goes out after the loop: leaving it awaits the adapter's cleanup (process gone, home removed).
            let closing: NormalizedEvent | undefined;
            // The plugin's unload (`closeListings`) and a time limit stop the run too, not only the host's signal.
            const unload = new AbortController();
            let finish!: () => void;
            const untrack = trackListing({
              abort: () => unload.abort(),
              done: new Promise<void>((resolve) => {
                finish = resolve;
              }),
            });
            timeLimit = AbortSignal.timeout(deps.timeoutMs ?? COMPLETE_TIMEOUT_MS);
            const stops = [unload.signal, timeLimit, ...(signal ? [signal] : [])];
            runSignal = AbortSignal.any(stops);
            try {
              for await (const event of complete({
                command,
                args: [...adapter.launchArgs],
                env,
                modelId: model.id,
                prompt,
                signal: runSignal,
              })) {
                if (event.kind === "text" && event.text) {
                  if (!started) {
                    started = true;
                    stream.push({ type: "text_start", contentIndex: 0, partial: message("stop", "", usage) });
                  }
                  text += event.text;
                  stream.push({ type: "text_delta", contentIndex: 0, delta: event.text, partial: message("stop", text, usage) });
                } else if (event.kind === "usage") {
                  usage = toUsage(event.usage);
                } else if (event.kind === "result" || event.kind === "error") {
                  closing = event;
                  break;
                }
              }
            } finally {
              finish();
              untrack();
            }
            if (started) stream.push({ type: "text_end", contentIndex: 0, content: text, partial: message("stop", text, usage) });
            if (closing?.kind === "result" && !runSignal?.aborted) stream.push({ type: "done", reason: "stop", message: message("stop", text, usage) });
            else if (closing?.kind === "error") fail(closing.error);
            else fail(runSignal?.aborted ? undefined : { code: "empty_response", retryable: false, message: `${adapter.displayName} ended the turn without a result.` });
          } catch (error) {
            fail({ code: "unknown", retryable: false, message: error instanceof Error ? error.message : String(error) });
          }
        })();
        return stream;
      };
    },
    /** The failover reason of an error this stream raised; anything else is left to OpenClaw. */
    classifyFailoverReason(ctx: FailoverErrorContext): FailoverReason | undefined {
      const code = ctx.code?.startsWith(prefix) ? (ctx.code.slice(prefix.length) as CliErrorCode) : undefined;
      return code ? FAILOVER_REASON_BY_CODE[code] : undefined;
    },
  };
}

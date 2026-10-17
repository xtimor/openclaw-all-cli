import type * as acp from "@agentclientprotocol/sdk";
import type { NormalizedEvent } from "../../core/ports.ts";

/**
 * Per-turn bookkeeping for ACP tool calls. The agent reports one call as a `tool_call` and then
 * any number of `tool_call_update` messages with the same ID; the core's event language has one
 * `toolStart` and one `toolResult` per call. The table folds the first into the second and
 * knows no CLI: the adapter names and filters calls through `DescribeToolCall`.
 */

/** What the agent has said about a call so far, handed to the adapter each time it decides. */
export type AcpToolCallView = {
  toolCallId: string;
  title: string;
  /** The agent's programmatic tool name, when it sends one. */
  name?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  paths: string[];
};

/** How a call shows up in the host: its display name and arguments. */
export type AcpToolDisplay = { name: string; args?: Record<string, unknown> };

/**
 * Names a call for display; it cannot hide a call. It is called at the call's first update and,
 * while it returns `undefined`, again at the next one. `undefined` defers the start because an
 * agent may announce a call before it knows its title and arguments; the deferral is honored
 * once. `final` is true on the update that must decide (the second, a terminal status, or the
 * turn's end), and an `undefined` there falls back to the default display: the agent's name,
 * title, or kind. Without a hook the call shows at its first update that way.
 */
export type DescribeToolCall = (call: AcpToolCallView, final: boolean) => AcpToolDisplay | undefined;

/** A tool update as the transport receives it: the union of `tool_call` and `tool_call_update`. */
export type AcpToolUpdate = {
  toolCallId: string;
  title?: string | null;
  name?: string | null;
  kind?: string | null;
  status?: string | null;
  content?: readonly acp.ToolCallContent[] | null;
  locations?: ReadonlyArray<{ path: string }> | null;
  rawInput?: unknown;
  rawOutput?: unknown;
};

/** Display-only results are capped: a file read would otherwise travel through the host whole. */
export const MAX_TOOL_RESULT_CHARS = 8_000;

type CallState = {
  title: string;
  name?: string;
  kind?: string;
  rawInput?: Record<string, unknown>;
  paths: string[];
  content?: readonly acp.ToolCallContent[];
  /** The display name the call started under; set once its `toolStart` went out. */
  shown?: string;
  /** Updates seen so far, for the adapter's one-update wait. */
  seen: number;
  finished: boolean;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncate(text: string): string {
  return text.length > MAX_TOOL_RESULT_CHARS ? `${text.slice(0, MAX_TOOL_RESULT_CHARS)}... [truncated]` : text;
}

/** The text a finished call produced: its raw output, else the text blocks it attached. */
function resultOf(call: CallState, rawOutput: unknown): unknown {
  if (rawOutput !== undefined && rawOutput !== null) {
    if (typeof rawOutput === "string") return truncate(rawOutput);
    let json: string | undefined;
    try {
      json = JSON.stringify(rawOutput);
    } catch {
      json = undefined;
    }
    if (json === undefined) return undefined;
    return json.length > MAX_TOOL_RESULT_CHARS ? truncate(json) : rawOutput;
  }
  const parts: string[] = [];
  for (const block of call.content ?? []) {
    if (block.type === "content" && block.content.type === "text") parts.push(block.content.text);
    else if (block.type === "diff") parts.push(`diff: ${block.path}`);
  }
  return parts.length > 0 ? truncate(parts.join("\n")) : undefined;
}

function defaultDisplay(call: AcpToolCallView): AcpToolDisplay {
  const name = call.name?.trim() || call.title.trim() || call.kind || "tool";
  return { name, ...(call.rawInput ? { args: call.rawInput } : {}) };
}

function viewOf(toolCallId: string, call: CallState): AcpToolCallView {
  return {
    toolCallId,
    title: call.title,
    ...(call.name ? { name: call.name } : {}),
    ...(call.kind ? { kind: call.kind } : {}),
    ...(call.rawInput ? { rawInput: call.rawInput } : {}),
    paths: [...call.paths],
  };
}

export class ToolCallTable {
  /** True once any call was seen in the turn. A retry could repeat its side effect (AD-11). */
  started = false;
  private readonly calls = new Map<string, CallState>();

  constructor(private readonly describe?: DescribeToolCall) {}

  /**
   * Folds one update in and returns the events due now: a `toolStart` once the call shows, a
   * `toolResult` when it completes or fails. Later updates of a call that already finished add
   * nothing.
   */
  update(update: AcpToolUpdate): NormalizedEvent[] {
    this.started = true;
    let call = this.calls.get(update.toolCallId);
    if (!call) {
      call = { title: "", paths: [], seen: 0, finished: false };
      this.calls.set(update.toolCallId, call);
    }
    if (call.finished) return [];

    if (typeof update.title === "string" && update.title) call.title = update.title;
    if (typeof update.name === "string" && update.name) call.name = update.name;
    if (update.kind) call.kind = update.kind;
    if (isRecord(update.rawInput) && Object.keys(update.rawInput).length > 0) call.rawInput = update.rawInput;
    for (const location of update.locations ?? []) {
      if (!call.paths.includes(location.path)) call.paths.push(location.path);
    }
    if (update.content) call.content = update.content;
    call.seen += 1;

    const events: NormalizedEvent[] = [];
    const terminal = update.status === "completed" || update.status === "failed";
    const name = this.show(update.toolCallId, call, call.seen > 1 || terminal, events);
    if (terminal) {
      call.finished = true;
      // A finished call is always shown: the adapter's wait ends at a terminal status.
      const result = resultOf(call, update.rawOutput);
      events.push({
        kind: "toolResult",
        toolCallId: update.toolCallId,
        name: name ?? defaultDisplay(viewOf(update.toolCallId, call)).name,
        isError: update.status === "failed",
        ...(result !== undefined ? { result } : {}),
      });
    }
    return events;
  }

  /**
   * Asks the adapter how the call shows, once, and emits its `toolStart`. Returns the name the
   * call shows under, or `undefined` while the adapter is still waiting.
   */
  private show(toolCallId: string, call: CallState, final: boolean, events: NormalizedEvent[]): string | undefined {
    if (call.shown !== undefined) return call.shown;
    const view = viewOf(toolCallId, call);
    // The adapter had its wait; a call it still cannot name shows as the agent called it.
    const display = (this.describe ? this.describe(view, final) : defaultDisplay(view)) ?? (final ? defaultDisplay(view) : undefined);
    if (!display) return undefined;
    call.shown = display.name;
    const args = display.args && Object.keys(display.args).length > 0 ? display.args : undefined;
    events.push({ kind: "toolStart", toolCallId, name: display.name, ...(args ? { args } : {}) });
    return display.name;
  }

  /**
   * Closing results for calls still open, so the host leaves nothing pending. A call that never
   * got past the adapter's wait starts now, then closes.
   */
  closeOpen(): NormalizedEvent[] {
    const events: NormalizedEvent[] = [];
    for (const [toolCallId, call] of this.calls) {
      if (call.finished) continue;
      const name = this.show(toolCallId, call, true, events);
      call.finished = true;
      events.push({
        kind: "toolResult",
        toolCallId,
        name: name ?? toolCallId,
        isError: true,
        result: { aborted: true },
      });
    }
    return events;
  }
}

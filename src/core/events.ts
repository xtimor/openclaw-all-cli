import type { NormalizedEvent, NormalizedUsage } from "./ports.ts";

/**
 * The wire between the core's `execute` and its `parseJsonlEvent`. OpenClaw serializes every
 * record `execute` yields to one JSON line and hands it to `parseJsonlEvent`, so the core is the
 * only module that writes or reads this shape.
 *
 * Result records carry `type: "result"` because the host watches that field to know a turn ended.
 */
export const RECORD_MARKER = "openclaw-all-cli";

export type CoreRecord = {
  type: "oac-event" | "result";
  oac: typeof RECORD_MARKER;
  is_error?: boolean;
  subtype?: string;
  event: NormalizedEvent;
  /** Set on a result record: the turn's usage and native session ID, gathered by the core. */
  usage?: NormalizedUsage;
  sessionId?: string;
};

/** What the core gathered during a turn and attaches to the closing record. */
export type TurnSummary = { usage?: NormalizedUsage; sessionId?: string };

export function toRecord(event: NormalizedEvent, summary: TurnSummary = {}): CoreRecord {
  if (event.kind === "result") {
    return {
      type: "result",
      oac: RECORD_MARKER,
      subtype: "success",
      is_error: false,
      event,
      ...(summary.usage ? { usage: summary.usage } : {}),
      ...(summary.sessionId ? { sessionId: summary.sessionId } : {}),
    };
  }
  if (event.kind === "error") {
    return { type: "result", oac: RECORD_MARKER, subtype: "error_cli", is_error: true, event };
  }
  return { type: "oac-event", oac: RECORD_MARKER, event };
}

/** What OpenClaw's JSONL parser hook returns. Mirrors `CliBackendParsedJsonlEvent`. */
export type ParsedEvent =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string }
  | { kind: "toolStart"; toolCallId: string; name: string; args?: Record<string, unknown> }
  | { kind: "toolResult"; toolCallId: string; name?: string; isError?: boolean; result?: unknown }
  | {
      kind: "result";
      text?: string;
      sessionId?: string;
      usage?: NormalizedUsage;
      errorText?: string;
    }
  | { kind: "sessionId"; sessionId: string };

function isCoreRecord(value: unknown): value is CoreRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { oac?: unknown }).oac === RECORD_MARKER &&
    typeof (value as { event?: unknown }).event === "object" &&
    (value as { event?: unknown }).event !== null
  );
}

/**
 * `parseJsonlEvent` for every backend. It returns `null` for a line it does not own, so
 * OpenClaw's built-in parsers still get a chance at it. It keeps no state: one function serves
 * every concurrent session.
 */
export function parseJsonlEvent(line: string): ParsedEvent | readonly ParsedEvent[] | null {
  if (!line.includes(RECORD_MARKER)) return null;
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isCoreRecord(value)) return null;
  const { event } = value;
  switch (event.kind) {
    case "text":
    case "thinking":
    case "toolStart":
    case "toolResult":
    case "sessionId":
      return event;
    case "usage":
      // Usage is reported once, on the result record.
      return [];
    case "result":
      return {
        kind: "result",
        text: event.text,
        ...(value.sessionId ? { sessionId: value.sessionId } : {}),
        ...(value.usage ? { usage: value.usage } : {}),
      };
    case "error":
      return { kind: "result", errorText: event.error.message };
  }
}

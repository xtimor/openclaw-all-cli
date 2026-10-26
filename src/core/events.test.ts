import { describe, expect, it } from "vitest";
import { parseJsonlEvent, toRecord } from "./events.ts";
import type { NormalizedEvent } from "./ports.ts";

const line = (event: NormalizedEvent, summary = {}) => JSON.stringify(toRecord(event, summary));

describe("core records", () => {
  it("round-trips streaming events", () => {
    expect(parseJsonlEvent(line({ kind: "text", text: "hi" }))).toEqual({ kind: "text", text: "hi" });
    expect(parseJsonlEvent(line({ kind: "thinking", text: "hm" }))).toEqual({ kind: "thinking", text: "hm" });
    expect(parseJsonlEvent(line({ kind: "sessionId", sessionId: "s1" }))).toEqual({ kind: "sessionId", sessionId: "s1" });
    expect(parseJsonlEvent(line({ kind: "toolStart", toolCallId: "t", name: "grep" }))).toMatchObject({
      kind: "toolStart",
      name: "grep",
    });
  });

  it("closes a turn with a result record that carries usage and the session ID", () => {
    const record = toRecord(
      { kind: "result", text: "done", stopReason: "end_turn" },
      { usage: { input: 1, output: 2 }, sessionId: "s1" },
    );
    expect(record).toMatchObject({ type: "result", is_error: false, subtype: "success" });
    expect(parseJsonlEvent(JSON.stringify(record))).toEqual({
      kind: "result",
      text: "done",
      sessionId: "s1",
      usage: { input: 1, output: 2 },
    });
  });

  it("sends a usage that is no context size with the host's `contextUsage: unavailable` marker (issue #40)", () => {
    const record = toRecord(
      { kind: "result", text: "done", stopReason: "end_turn" },
      { usage: { input: 100_000, output: 86_800, cacheRead: 5_400_000, contextUnknown: true } },
    );
    expect(parseJsonlEvent(JSON.stringify(record))).toEqual({
      kind: "result",
      text: "done",
      usage: { input: 100_000, output: 86_800, cacheRead: 5_400_000, contextUsage: { state: "unavailable" } },
    });
  });

  it("closes a failed turn with an error result", () => {
    const record = toRecord({ kind: "error", error: { code: "auth", retryable: false, message: "log in" } });
    expect(record).toMatchObject({ type: "result", is_error: true });
    expect(parseJsonlEvent(JSON.stringify(record))).toEqual({ kind: "result", errorText: "log in" });
  });

  it("reports usage only on the result", () => {
    expect(parseJsonlEvent(line({ kind: "usage", usage: { input: 1 } }))).toEqual([]);
  });

  it("leaves lines it does not own to OpenClaw's parsers", () => {
    expect(parseJsonlEvent('{"type":"assistant"}')).toBeNull();
    expect(parseJsonlEvent("not json openclaw-all-cli")).toBeNull();
    expect(parseJsonlEvent('{"oac":"other","event":{}}')).toBeNull();
    expect(parseJsonlEvent('{"oac":"openclaw-all-cli","event":null}')).toBeNull();
  });
});

describe("tool events for the host", () => {
  it("passes a tool start and result with the fields OpenClaw reads", () => {
    const start: NormalizedEvent = { kind: "toolStart", toolCallId: "c1", name: "exec", args: { command: "ls" } };
    const result: NormalizedEvent = { kind: "toolResult", toolCallId: "c1", name: "exec", isError: true, result: "boom" };
    expect(parseJsonlEvent(line(start))).toEqual(start);
    expect(parseJsonlEvent(line(result))).toEqual(result);
    expect(toRecord(start)).toMatchObject({ type: "oac-event" });
  });
});

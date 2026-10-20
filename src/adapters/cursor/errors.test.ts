import { afterEach, describe, expect, it } from "vitest";
import { FAKE_CURSOR_AGENT, fakeEnv } from "../../../test/fixtures/paths.ts";
import type { CliSession, NormalizedEvent } from "../../core/ports.ts";
import { classifyCursorReplyError } from "./errors.ts";
import { cursorAdapter } from "./index.ts";

const RETRIABLE = "\n\nError: RetriableError: [internal] HTTPS proxy CONNECT failed: 403 Forbidden";

describe("classifyCursorReplyError", () => {
  it("reads a named internal error as a retryable server error and quotes Cursor's text", () => {
    expect(classifyCursorReplyError(RETRIABLE)).toEqual({
      code: "server_error",
      retryable: true,
      message: `Cursor internal server error: ${RETRIABLE.trim()}`,
    });
  });

  it("does not make a NonRetriableError retryable", () => {
    expect(classifyCursorReplyError("\n\nError: NonRetriableError: [internal] boom")).toMatchObject({ code: "server_error", retryable: false });
  });

  it.each([
    ["unauthenticated", "auth", /unauthorized/],
    ["permission_denied", "auth", /unauthorized/],
    ["resource_exhausted", "rate_limit", /rate limit/],
    ["unavailable", "overloaded", /overloaded/],
    ["deadline_exceeded", "timeout", /timed out/],
    ["invalid_argument", "format", /invalid request format/],
    ["internal", "server_error", /internal server error/],
    ["unknown", "server_error", /internal server error/],
    ["something_new", "server_error", /internal server error/],
    ["failed_precondition", "server_error", /internal server error/],
  ])("maps the connect code [%s] to %s", (code, expected, keyword) => {
    for (const text of [`\n\nError: [${code}] detail`, `\n\nError: NonRetriableError: [${code}] detail`]) {
      const result = classifyCursorReplyError(text);
      expect(result?.code).toBe(expected);
      expect(result?.message).toMatch(keyword);
      expect(result?.message).toContain(text.trim());
    }
  });

  it("reads a named error without a code as a server error", () => {
    expect(classifyCursorReplyError("\n\nError: TypeError: x is not a function")).toMatchObject({ code: "server_error", retryable: false });
  });

  it.each([
    ["Upgrade your plan to continue", "rate_limit", /rate limit/],
    ["Please sign in to continue", "auth", /unauthorized/],
    ["Add a payment method to continue", "billing", /payment required/],
    ["Check your settings to continue", "auth_permanent", /API key revoked/],
  ])("maps the action phrase %j to %s, with or without the blank line", (phrase, expected, keyword) => {
    for (const text of [phrase, `\n\n${phrase}`]) {
      const result = classifyCursorReplyError(text);
      expect(result).toMatchObject({ code: expected, retryable: false });
      expect(result?.message).toMatch(keyword);
      expect(result?.message).toContain(phrase);
    }
  });

  it.each([
    ["ordinary text", "Hello there, how are you"],
    ["an empty chunk", ""],
    ["a bare error line", "\n\nError: something went wrong"],
    ["an error head without the blank line", "Error: RetriableError: [internal] x"],
    ["an error head in the middle", "See below.\n\nError: RetriableError: [internal] x"],
    ["a phrase inside a sentence", "You should Upgrade your plan to continue using it."],
    ["a phrase with more text", "Please sign in to continue. Then retry."],
    ["a lower-case code", "\n\nError: [Internal] x"],
  ])("leaves %s alone", (_name, text) => {
    expect(classifyCursorReplyError(text)).toBeUndefined();
  });
});

describe("Cursor adapter turns with the fake agent", () => {
  const open: CliSession[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((session) => session.close()));
  });

  async function run(prompt: string): Promise<NormalizedEvent[]> {
    const session = await cursorAdapter.open({
      command: FAKE_CURSOR_AGENT,
      args: cursorAdapter.launchArgs,
      cwd: process.cwd(),
      env: fakeEnv(),
      modelId: "auto",
      onPermissionRequest: async () => "reject_once",
    });
    open.push(session);
    const events: NormalizedEvent[] = [];
    for await (const event of session.prompt(prompt)) events.push(event);
    return events;
  }

  it("ends a turn whose last chunk is a Cursor failure as an error, with no result and no text", async () => {
    const events = await run(`[[error]]${RETRIABLE}`);
    expect(events.map((event) => event.kind)).toEqual(["thinking", "error"]);
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "server_error", retryable: true } });
  });

  it("keeps a look-alike that more output follows as ordinary text", async () => {
    const items = [{ $: "say", text: "\n\nError: RetriableError: [internal] quoted" }, { $: "say", text: " and the answer." }];
    const events = await run(`[[updates]]${JSON.stringify(items)}`);
    expect(events.at(-1)).toMatchObject({ kind: "result", text: "\n\nError: RetriableError: [internal] quoted and the answer." });
  });

  it("reads an action phrase as an error", async () => {
    const events = await run("[[error]]Upgrade your plan to continue");
    expect(events.at(-1)).toMatchObject({ kind: "error", error: { code: "rate_limit" } });
  });
});

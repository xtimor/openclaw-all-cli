import { describe, expect, it } from "vitest";
import { RELEASING_REASONS, conversationOf } from "./conversation.ts";

describe("conversationOf", () => {
  // The line as OpenClaw 2026.10.3 writes it into a normal CLI turn's system prompt (probed live).
  const line = "Runtime: agent=main | session=agent:main:explicit:probe-b | host=openclaw | repo=/w | os=Linux 6.18 (x64) | node=v24.22.0";

  it("reads the session key from the host's Runtime line", () => {
    expect(conversationOf(`intro\n\n${line}\nmore`)).toBe("agent:main:explicit:probe-b");
    expect(conversationOf("Runtime: agent=main | session=agent:main:telegram:direct:42 | host=x")).toBe("agent:main:telegram:direct:42");
  });

  it("finds nothing in a prompt without the line", () => {
    expect(conversationOf("")).toBeUndefined();
    expect(conversationOf("Runtime: agent=main | host=openclaw")).toBeUndefined();
    expect(conversationOf("a user note: session=agent:main:x")).toBeUndefined();
  });
});

describe("RELEASING_REASONS", () => {
  it("holds the reasons that end a conversation and none that keep or close everything", () => {
    expect([...RELEASING_REASONS].sort()).toEqual(["daily", "deleted", "idle", "new", "reset"]);
  });
});

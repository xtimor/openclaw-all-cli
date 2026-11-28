import { describe, expect, it } from "vitest";
import { RELEASING_REASONS, conversationOf, releaseConversationEverywhere, shareConversationPool } from "./conversation.ts";

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

describe("releaseConversationEverywhere (issue #105)", () => {
  const pool = (released: number) => {
    const calls: string[] = [];
    return {
      calls,
      releaseConversation: (conversation: string) => {
        calls.push(conversation);
        return released;
      },
    };
  };

  it("releases the conversation in every shared pool and counts the processes", () => {
    const a = pool(1);
    const b = pool(2);
    const stops = [shareConversationPool(a), shareConversationPool(b)];
    try {
      expect(releaseConversationEverywhere("agent:main:explicit:x")).toBe(3);
      expect([a.calls, b.calls]).toEqual([["agent:main:explicit:x"], ["agent:main:explicit:x"]]);
    } finally {
      for (const stop of stops) stop();
    }
  });

  it("no longer reaches a pool once it is taken out, and taking it out twice is harmless", () => {
    const a = pool(1);
    const stop = shareConversationPool(a);
    stop();
    stop();
    expect(releaseConversationEverywhere("k")).toBe(0);
    expect(a.calls).toEqual([]);
  });

  it("goes on past a pool that throws", () => {
    const broken = {
      releaseConversation: (): number => {
        throw new Error("closed copy");
      },
    };
    const b = pool(1);
    const stops = [shareConversationPool(broken), shareConversationPool(b)];
    try {
      expect(releaseConversationEverywhere("k")).toBe(1);
      expect(b.calls).toEqual(["k"]);
    } finally {
      for (const stop of stops) stop();
    }
  });

  it("drops the entries of collected pools when a pool is shared, so frequent reloads do not grow the registry", () => {
    const shared = (globalThis as unknown as Record<symbol, Set<{ deref(): unknown }> | undefined>)[Symbol.for("openclaw-all-cli.conversation-pools")];
    // Shape of a WeakRef whose pool was garbage-collected (no GC is forced in a test).
    const dead = { deref: () => undefined };
    const keep = shareConversationPool(pool(0));
    shared!.add(dead);
    const stop = shareConversationPool(pool(1));
    try {
      expect(shared!.has(dead)).toBe(false);
      expect(releaseConversationEverywhere("k")).toBe(1);
    } finally {
      stop();
      keep();
    }
  });

  it("keeps the registry on globalThis under the plugin's symbol, so another module instance shares it", () => {
    const a = pool(1);
    const stop = shareConversationPool(a);
    try {
      const shared = (globalThis as unknown as Record<symbol, Set<WeakRef<object>> | undefined>)[Symbol.for("openclaw-all-cli.conversation-pools")];
      expect([...(shared ?? [])].some((ref) => ref.deref() === a)).toBe(true);
    } finally {
      stop();
    }
  });
});

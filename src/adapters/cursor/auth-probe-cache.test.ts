import { describe, expect, it } from "vitest";
import { createCursorKeyCheckCache } from "./auth-probe-cache.ts";

describe("createCursorKeyCheckCache (issue #98)", () => {
  it("serves a cached verdict until it expires, then forgets it", () => {
    let time = 0;
    const cache = createCursorKeyCheckCache({ ttlMs: 1_000, now: () => time });
    cache.set("cursor-agent", "key-1", "valid");
    expect(cache.get("cursor-agent", "key-1")).toBe("valid");
    time = 999;
    expect(cache.get("cursor-agent", "key-1")).toBe("valid");
    time = 1_000;
    expect(cache.get("cursor-agent", "key-1")).toBeUndefined();
  });

  it("caches an unknown verdict too, but with its own, shorter TTL", () => {
    // cursor-agent 2026.11.11 answers `unknown` for a refused key (not `invalid`): without this,
    // every single probe of that key would re-pay `checkKey`'s full cost instead of rarely.
    let time = 0;
    const cache = createCursorKeyCheckCache({ ttlMs: 1_000, unknownTtlMs: 100, now: () => time });
    cache.set("cursor-agent", "key-1", "unknown");
    expect(cache.get("cursor-agent", "key-1")).toBe("unknown");
    time = 99;
    expect(cache.get("cursor-agent", "key-1")).toBe("unknown");
    time = 100;
    expect(cache.get("cursor-agent", "key-1")).toBeUndefined();
  });

  it("keeps a different command or key out of the cache", () => {
    const cache = createCursorKeyCheckCache();
    cache.set("cursor-agent", "key-1", "valid");
    expect(cache.get("cursor-agent", "key-2")).toBeUndefined();
    expect(cache.get("/other/cursor-agent", "key-1")).toBeUndefined();
  });

  it("does not let two different keys evict each other's verdict (one cache, several agents)", () => {
    // A single shared slot would have a second agent's probe, with a different key, wipe out the
    // first agent's cached verdict on every call -- defeating the cache for both.
    const cache = createCursorKeyCheckCache();
    cache.set("cursor-agent", "agent-a-key", "valid");
    cache.set("cursor-agent", "agent-b-key", "invalid");
    expect(cache.get("cursor-agent", "agent-a-key")).toBe("valid");
    expect(cache.get("cursor-agent", "agent-b-key")).toBe("invalid");
  });

  it("invalidate clears every cached signature, not only the most recent one", () => {
    const cache = createCursorKeyCheckCache();
    cache.set("cursor-agent", "agent-a-key", "valid");
    cache.set("cursor-agent", "agent-b-key", "valid");
    cache.invalidate();
    expect(cache.get("cursor-agent", "agent-a-key")).toBeUndefined();
    expect(cache.get("cursor-agent", "agent-b-key")).toBeUndefined();
  });
});

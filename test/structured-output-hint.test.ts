import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { structuredOutputNote } from "../src/core/turn-prompt.ts";
import { turnWithHostTools } from "./fixtures/host-tools-turn.ts";

// Issue #75 (ticket 24): a run with an outputSchema succeeds only if the model calls the host's
// `structured_output`; a weaker model answers in prose unless the prompt says otherwise.
describe("structured_output hint", () => {
  it("tells the model to answer through structured_output when the host serves that tool", async () => {
    const { prompts } = await turnWithHostTools(["read", "structured_output"]);
    expect(prompts.join("\n")).toContain("structured_output");
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/final answer.*`structured_output`.*prose alone fails the run/s);
    expect(prompts[0]).toMatch(/do it 0$/);
  });

  it("says nothing without structured_output in the host's tool list", async () => {
    for (const names of [["read", "process"], [], null]) {
      const { prompts } = await turnWithHostTools(names);
      expect(prompts).toEqual(["do it 0"]);
    }
  });

  it("also tells a turn the host did not flag for a shell", async () => {
    const { prompts } = await turnWithHostTools(["structured_output"], { marker: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/`structured_output`/);
    expect(prompts[0]).not.toMatch(/native shell/);
  });

  it("goes after the shell sentence and before the user's text", async () => {
    const { prompts } = await turnWithHostTools(["exec", "structured_output"]);
    const shell = prompts[0]!.indexOf("native shell");
    const structured = prompts[0]!.indexOf("structured_output");
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(structured).toBeGreaterThan(shell);
    expect(prompts[0]).toMatch(/do it 0$/);
  });

  it("sends the sentence once per process, not on every turn", async () => {
    const { prompts, opens } = await turnWithHostTools(["structured_output"], { turns: 3 });
    expect(opens).toHaveLength(1);
    expect(prompts[0]).toMatch(/`structured_output`/);
    expect(prompts.slice(1)).toEqual(["do it 1", "do it 2"]);
  });

  it("still sends it once to a warm process whose first prompt lacked it, when the tool shows up later", async () => {
    const { prompts, opens } = await turnWithHostTools((turn) => (turn >= 1 ? ["read", "structured_output"] : ["read"]), { turns: 3 });
    expect(opens).toHaveLength(1);
    expect(prompts[0]).toBe("do it 0");
    expect(prompts[1]).toMatch(/`structured_output`.*do it 1$/s);
    expect(prompts[2]).toBe("do it 2");
  });

  it("does not name a CLI", () => {
    expect(structuredOutputNote()).not.toMatch(/cursor|acme|claude|gemini/i);
  });
});

describe("the docs say what ships", () => {
  it("docs/providers/cursor.md says the prompt tells the model to answer through structured_output", () => {
    const text = readFileSync(join(import.meta.dirname, "..", "docs/providers/cursor.md"), "utf8");
    expect(text).toMatch(/`structured_output`/);
    expect(text).toMatch(/may still (skip|answer)/);
  });
});

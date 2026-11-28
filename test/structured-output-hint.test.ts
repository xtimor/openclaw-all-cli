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
    expect(prompts[0]).toMatch(/^do it 0\n\n\[OpenClaw\] Give your final answer/);
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

  it("goes after the shell sentence and after the user's text", async () => {
    const { prompts } = await turnWithHostTools(["exec", "structured_output"]);
    const shell = prompts[0]!.indexOf("native shell");
    const user = prompts[0]!.indexOf("do it 0");
    const structured = prompts[0]!.indexOf("structured_output");
    expect(shell).toBeGreaterThanOrEqual(0);
    expect(user).toBeGreaterThan(shell);
    expect(structured).toBeGreaterThan(user);
  });

  it("ends the prompt with the sentence, after the host's appended reply guidance (bug 40)", async () => {
    // A collector child's prompt ends with the host's "reply normally in your final assistant message"; a codex
    // model obeyed that last instruction and never called the tool (live, 2026-11-28).
    const guidance = "For the current source conversation, reply normally in your final assistant message.";
    const { prompts } = await turnWithHostTools(["exec", "structured_output"], { ctx: { promptContext: { appendContext: guidance } } });
    expect(prompts).toHaveLength(1);
    const prompt = prompts[0]!;
    expect(prompt.indexOf("do it 0")).toBeLessThan(prompt.indexOf(guidance));
    expect(prompt.endsWith(structuredOutputNote())).toBe(true);
    expect(prompt.indexOf("native shell")).toBeLessThan(prompt.indexOf("do it 0"));
  });

  it("tells the model a prose final answer fails even where the text before says to reply normally", () => {
    expect(structuredOutputNote()).toMatch(/`structured_output`/);
    expect(structuredOutputNote()).toMatch(/reply normally/);
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
    expect(prompts[1]).toMatch(/^do it 1\n\n.*`structured_output`/s);
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

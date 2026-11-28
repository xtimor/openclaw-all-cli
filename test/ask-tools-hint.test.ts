import { describe, expect, it } from "vitest";
import { askToolsNote } from "../src/core/turn-prompt.ts";
import { turnWithHostTools } from "./fixtures/host-tools-turn.ts";

const NOT_READ_ONLY = /does not make this chat or this session read-only/;

// Issue #102 (backlog bug 33): without OpenClaw `exec` the CLI runs in a mode with no native edit tool, and the model
// took that for a read-only session and refused writes the OpenClaw tools allow, on consecutive turns of one process.
describe("the ask-mode tools hint", () => {
  it("tells the model the chat is not read-only and names the OpenClaw tools that change things, when the host serves no exec", async () => {
    const { prompts, opens } = await turnWithHostTools(["read", "write", "edit", "workboard_comment", "sessions_history"]);
    expect(opens[0]).toMatchObject({ hostShell: false });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(NOT_READ_ONLY);
    expect(prompts[0]).toMatch(/`write`, `edit` and `workboard_comment`/);
    expect(prompts[0]).toMatch(/Never refuse a change/);
    expect(prompts[0]).not.toMatch(/native shell is disabled/);
    expect(prompts[0]).toMatch(/do it 0$/);
  });

  it("sends the sentence on every prompt of the process, not only the first", async () => {
    const { prompts, opens } = await turnWithHostTools(["write", "apply_patch"], { turns: 3 });
    expect(opens).toHaveLength(1);
    expect(prompts).toHaveLength(3);
    for (const [turn, prompt] of prompts.entries()) {
      expect(prompt).toMatch(NOT_READ_ONLY);
      expect(prompt).toMatch(/`write` and `apply_patch`/);
      expect(prompt).toMatch(new RegExp(`do it ${turn}$`));
    }
  });

  it("is sent also when the host flagged a shell that its tool list then left out", async () => {
    const { prompts, opens } = await turnWithHostTools(["write"], { marker: true });
    expect(opens[0]).toMatchObject({ hostShell: false });
    expect(prompts[0]).toMatch(NOT_READ_ONLY);
    const unflagged = await turnWithHostTools(["write"], { marker: false });
    expect(unflagged.prompts[0]).toMatch(NOT_READ_ONLY);
  });

  it("says nothing of the kind when the host serves exec, offers no tool that changes things, or its list cannot be read", async () => {
    const withExec = await turnWithHostTools(["exec", "process", "write", "edit"]);
    expect(withExec.opens[0]).toMatchObject({ hostShell: true });
    expect(withExec.prompts[0]).toMatch(/native shell is disabled/);
    expect(withExec.prompts[0]).not.toMatch(NOT_READ_ONLY);
    for (const names of [["read", "sessions_history", "process"], [], null]) {
      const { prompts } = await turnWithHostTools(names);
      expect(prompts).toEqual(["do it 0"]);
    }
  });
});

describe("askToolsNote", () => {
  it("names only the tools that change files or records, in a fixed order, and nothing when none is listed", () => {
    expect(askToolsNote(["wiki_apply", "read", "edit", "write"])).toMatch(/including `write`, `edit` and `wiki_apply`, which/);
    expect(askToolsNote(["file_write"])).toMatch(/including `file_write`, which/);
    expect(askToolsNote(["read", "sessions_history", "web_fetch", "exec"])).toBeUndefined();
    expect(askToolsNote([])).toBeUndefined();
  });

  it("names no CLI", () => {
    const note = askToolsNote(["write", "edit", "apply_patch", "file_write", "workboard_create", "workboard_comment", "wiki_apply"]);
    expect(note).toBeTypeOf("string");
    expect(note).not.toMatch(/cursor|acme|claude|gemini/i);
    expect(note).toMatch(/^\[OpenClaw\] /);
  });
});

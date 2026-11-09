import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { shellNote } from "../src/core/turn-prompt.ts";
import { turnWithHostTools } from "./fixtures/host-tools-turn.ts";

// Issue #76 (ticket 23): the CLI's own shell is refused by its config, so only the prompt says where commands run.
describe("the native shell hint", () => {
  it("tells the model the native shell is off and OpenClaw exec is the way, when the host serves exec", async () => {
    const { prompts, opens } = await turnWithHostTools(["exec", "process"]);
    expect(opens[0]).toMatchObject({ hostShell: true });
    expect(prompts.join("\n")).toMatch(/exec/);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[0]).toMatch(/`exec`.*background.*`process`/s);
    expect(prompts[0]).toMatch(/do it 0$/);
  });

  it("says nothing about a shell without exec in the host's tool list", async () => {
    for (const names of [["process", "read"], [], null]) {
      const { prompts, opens } = await turnWithHostTools(names);
      expect(opens[0]).toMatchObject({ hostShell: false });
      expect(prompts).toEqual(["do it 0"]);
    }
    // The host did not flag a shell, although exec is listed.
    const unflagged = await turnWithHostTools(["exec", "process"], { marker: false });
    expect(unflagged.prompts).toEqual(["do it 0"]);
  });

  it("does not send the sentence to poll with process when process is not offered", async () => {
    const { prompts } = await turnWithHostTools(["exec"]);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[0]).not.toMatch(/process/);
  });

  it("sends the sentence once per process, not on every turn", async () => {
    const { prompts, opens } = await turnWithHostTools(["exec", "process"], { turns: 2 });
    expect(opens).toHaveLength(1);
    expect(prompts[0]).toMatch(/native shell is disabled/);
    expect(prompts[1]).toBe("do it 1");
  });
});

describe("the docs say what ships", () => {
  const files = [
    "src/adapters/cursor/manifest.ts",
    "_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md",
    "docs/providers/cursor.md",
  ];
  it.each(files)("%s does not claim the host answers a denied native shell call", (file) => {
    const text = readFileSync(join(import.meta.dirname, "..", file), "utf8");
    expect(text).not.toMatch(/Use OpenClaw exec/i);
    expect(text).toMatch(/first prompt of the process/);
  });
});

describe("the shell sentence", () => {
  it.each([true, false])("names no CLI (process listed: %s)", (hasProcess) => {
    expect(shellNote(hasProcess)).not.toMatch(/cursor|acme|claude|gemini/i);
  });
});

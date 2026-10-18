import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { deriveFlags } from "./manifest.ts";
import { PARITY_ROWS, createManifest } from "./ports.ts";

describe("manifest", () => {
  it("starts every row undecided", () => {
    const manifest = createManifest("1", {});
    expect(Object.keys(manifest.rows)).toEqual([...PARITY_ROWS]);
    expect(Object.values(manifest.rows).every((row) => row.status === "tbd")).toBe(true);
  });

  it("derives live session, resume, MCP, and tool-policy flags only from decided rows", () => {
    expect(deriveFlags(createManifest("1", {}))).toEqual({
      liveSession: false,
      resume: false,
      mcp: false,
      toolPolicy: false,
      images: false,
      sideQuestion: false,
    });
    expect(
      deriveFlags(
        createManifest("1", {
          P4: { status: "match", note: "" },
          P5: { status: "approx", note: "" },
          P7: { status: "match", note: "" },
          P10: { status: "approx", note: "" },
          P13: { status: "gap", note: "" },
        }),
      ),
    ).toEqual({ liveSession: true, resume: true, mcp: true, toolPolicy: true, images: false, sideQuestion: false });
    expect(deriveFlags(createManifest("1", { P4: { status: "gap", note: "" }, P5: { status: "spike", note: "" } }))).toEqual({
      liveSession: false,
      resume: false,
      mcp: false,
      toolPolicy: false,
      images: false,
      sideQuestion: false,
    });
  });

  it("derives images from P13 alone", () => {
    expect(deriveFlags(createManifest("1", { P13: { status: "match", note: "" } })).images).toBe(true);
    expect(deriveFlags(createManifest("1", { P13: { status: "approx", note: "" } })).images).toBe(true);
    expect(deriveFlags(createManifest("1", { P13: { status: "spike", note: "" } })).images).toBe(false);
  });

  it("derives side questions from P18 alone", () => {
    expect(deriveFlags(createManifest("1", { P18: { status: "approx", note: "" } })).sideQuestion).toBe(true);
    expect(deriveFlags(createManifest("1", { P18: { status: "spike", note: "" } })).sideQuestion).toBe(false);
  });

  it("keeps PARITY_ROWS in step with the parity matrix", () => {
    const matrix = readFileSync(
      new URL(
        "../../_bmad-output/initiative-openclaw-all-cli/spec-cursor-cli-provider/claude-cli-parity.md",
        import.meta.url,
      ),
      "utf8",
    );
    const ids = [...matrix.matchAll(/^\| (P\d+) \|/gm)].map((match) => match[1]);
    expect(ids).toEqual([...PARITY_ROWS]);
  });
});
